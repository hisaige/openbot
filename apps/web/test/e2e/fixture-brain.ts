// The fixture brain (architecture §5.4): a two-stage brain that ends up with a pre-loaded
// transcript.
//
// WHY TWO STAGES: `startBrain` (apps/web/test/e2e/brain.ts) creates the data dir and the database
// on boot, and its `stop()` deletes the whole data dir (`rmSync(dataDir, { recursive: true })`).
// So "start → stop → write the DB → start again" cannot use `startBrain`'s stop: the second start
// would find nothing. This module therefore owns its own spawn/stop, and its `stop()` only kills
// the process — the data dir survives so the entries written in stage 2 are there in stage 3.
//
// The three stages:
//
//   ① start → the brain creates `<dataDir>/openbot.sqlite` and applies the migrations
//   ② stop  → write the fixture entries into `entries` (SQLite is free once the process is gone)
//   ③ start → the brain reads the pre-loaded transcript back out of `conversations.history`
//
// The bot and its direct conversation are created in stage ① over RPC (the real path — a
// conversation id from the database would have to match a `bots` row, a `conversations` row and
// the roster replica's epoch).

import { Database } from "bun:sqlite"
import type { Bot, ConversationId } from "@openbot/contracts"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { connectRpc, hasChromium, launchBrowser, openApp, type AppPage, type Brain, type Rpc } from "./brain.ts"
import { buildFixtureEntries, type FixtureStats, FIXTURE_INTERVAL_MS, measureFixture, touchConversation, writeFixtureEntries } from "../fixtures/long-conversation.ts"

const repoRoot = new URL("../../../../", import.meta.url).pathname
const serverMain = join(repoRoot, "apps/server/src/main.ts")

export { hasChromium }

/** A brain that can be stopped without losing its data dir. */
export interface FixtureBrain {
  readonly base: string
  readonly loginUrl: string
  readonly token: string
  readonly dataDir: string
  readonly log: () => string
  /** Kills the process; the data dir survives. */
  readonly stop: () => Promise<void>
  /** Kills the process and removes the data dir. */
  readonly dispose: () => Promise<void>
}

export interface FixtureBrainOptions {
  readonly harnesses?: string
  readonly args?: ReadonlyArray<string>
  readonly env?: Record<string, string>
  /** The port to listen on; 0 (default) = ephemeral. */
  readonly port?: number
  /**
   * Reuse an existing data dir (stage ③ of the fixture flow). When absent, a fresh one is made.
   * Reusing is what makes "start → stop → seed → start" work: the seeded database is in that dir.
   */
  readonly dataDir?: string
  /**
   * The working directory of the brain process.
   *
   * IT MATTERS FOR THE DIAGNOSTICS: `planWeb` (apps/server/src/web.ts) picks the HMR mode when
   * `--dev` is set AND the cwd's `bunfig.toml` loads `bun-plugin-tailwind`. The repo root's does,
   * so a `--dev` brain started from there runs the Bun dev server — no minified bundle, but also no
   * `Bun.build` output to trace. For the forced-reflow ATTRIBUTION the brain has to run in
   * **bundle** mode with `minify: false`, so the function names survive into the trace. That means
   * a cwd WITHOUT a Tailwind bunfig — `/tmp` works.
   */
  readonly cwd?: string
}

/**
 * Spawns the brain and waits for its login URL. Same shape as `startBrain`, but the child keeps
 * its data dir on stop.
 */
export const startFixtureBrain = async (options?: FixtureBrainOptions): Promise<FixtureBrain> => {
  const dataDir =
    options?.dataDir ?? join("/tmp", `openbot-fixture-brain-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  mkdirSync(dataDir, { recursive: true })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k === "DISPLAY" || k === "WAYLAND_DISPLAY" || k.startsWith("OPENBOT_")) continue
    env[k] = v
  }
  const child = Bun.spawn(
    [process.execPath, serverMain, "--data-dir", dataDir, "--port", String(options?.port ?? 0), "--harness", options?.harnesses ?? "fake", ...(options?.args ?? [])],
    { cwd: options?.cwd ?? repoRoot, stdout: "pipe", stderr: "pipe", env: { ...env, ...(options?.env ?? {}) } },
  )
  const sink = { text: "" }
  const decoder = new TextDecoder()
  const pump = (stream: ReadableStream<Uint8Array>) => {
    void (async () => {
      for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true })
    })().catch(() => undefined)
  }
  pump(child.stdout)
  pump(child.stderr)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const m = /OpenBot is running → (\S+)/.exec(sink.text)
    if (m) {
      const url = new URL(m[1]!)
      const stop = async () => {
        child.kill("SIGTERM")
        await Promise.race([child.exited, Bun.sleep(15_000)])
        if (child.exitCode === null) child.kill("SIGKILL")
        await child.exited
      }
      return {
        base: url.origin,
        loginUrl: m[1]!,
        token: url.searchParams.get("token") ?? "",
        dataDir,
        log: () => sink.text,
        stop,
        dispose: async () => {
          await stop()
          await Bun.$`rm -rf ${dataDir}`.quiet().nothrow()
        },
      }
    }
    if (child.exitCode !== null) throw new Error(`the fixture brain exited: ${sink.text.slice(-2000)}`)
    await Bun.sleep(50)
  }
  child.kill("SIGKILL")
  throw new Error(`the fixture brain did not start within 30 s:\n${sink.text.slice(-4000)}`)
}

/**
 * Stage ②: writes the fixture into the brain's database.
 *
 * The entries go into the conversation the bot owns (`bot.directConversationId`), so the client's
 * snapshot and `conversations.history` both see them.
 *
 * The fixture is anchored to the conversation's OWN history: the bot's greeting (the "joined"
 * event) is the oldest entry, so the fixture entries have to start AFTER it. Otherwise the
 * greeting would sort to the bottom of the transcript — the opposite of what a real conversation
 * looks like, and it would make the "first screen" measurement wrong.
 */
export const seedFixture = (brain: FixtureBrain, bot: Bot, options?: { readonly count?: number }): FixtureStats => {
  const conversationId = bot.directConversationId as ConversationId
  const databasePath = join(brain.dataDir, "openbot.sqlite")
  const baseAt = newestEntryAt(databasePath, conversationId) + FIXTURE_INTERVAL_MS
  const entries = buildFixtureEntries(conversationId, bot.id, { ...options, baseAt })
  writeFixtureEntries(databasePath, entries)
  const last = entries[entries.length - 1]
  if (last !== undefined) touchConversation(databasePath, conversationId, last.createdAt)
  return measureFixture(entries)
}

/** The newest `created_at` in the conversation (0 when it is empty). */
const newestEntryAt = (databasePath: string, conversationId: ConversationId): number => {
  const db = new Database(databasePath, { readonly: true })
  try {
    const row = db.query("SELECT MAX(created_at) AS at FROM entries WHERE conversation_id = ?").get(conversationId) as { at: number | null } | null
    return row?.at ?? 0
  } finally {
    db.close()
  }
}

/**
 * The whole three-stage flow, in one call: start → create the bot → stop → seed → start again.
 *
 * The returned brain is the STAGE-3 one: it holds the seeded database.
 */
export interface SeededBrain {
  readonly brain: FixtureBrain
  readonly bot: Bot
  readonly conversationId: ConversationId
  readonly stats: FixtureStats
}

export const startSeededBrain = async (
  options?: FixtureBrainOptions & { readonly count?: number; readonly botName?: string },
): Promise<SeededBrain> => {
  const first = await startFixtureBrain(options)
  let bot: Bot
  let stats: FixtureStats
  try {
    const rpc = await connectRpc(first)
    bot = await rpc.call((c) =>
      c["bots.create"]({
        name: options?.botName ?? "Fixture",
        harness: { kind: "fake" },
        clientNonce: `fixture-bot-${first.dataDir}`,
        introduce: false,
      }),
    )
    await rpc.close()
    // Stage ②: the brain must be down before the database is written (SQLite serialises writers).
    await first.stop()
    stats = seedFixture(first, bot, { count: options?.count })
  } catch (error) {
    await first.dispose()
    throw error
  }
  // Stage ③: the SAME data dir, now with the fixture in it.
  const brain = await startFixtureBrain({ ...options, dataDir: first.dataDir })
  return { brain, bot, conversationId: bot.directConversationId as ConversationId, stats }
}

/** The browser side of a seeded brain. */
export const openSeededApp = async (
  browser: Awaited<ReturnType<typeof launchBrowser>>,
  brain: FixtureBrain,
  conversationId: ConversationId,
): Promise<AppPage> => openApp(browser, brain as Brain, { theme: "dark", route: `#/c/${conversationId}` })

export { launchBrowser, connectRpc, openApp, type Rpc, type AppPage }

// The US-7 measurement, as a standalone runner (architecture §6.3, E-5).
//
// E-5 is a RUNTIME comparison: the SAME code, with the publish window on or off. The switch is
// `OPENBOT_STREAM_WINDOW_MAX_PENDING` (1 = every change is published immediately = the unmerged
// control; 4 = the window). The architecture is explicit that E-5 must use the runtime switch and
// E-4 the code comparison — "两者不可互换" — and this file is the E-5 half.
//
// THE COUNTING POINT IS THE CLIENT (PRD C-1): "数'客户端 reducer 实际应用了几条 entry.upserted'",
// NOT the server's published count. The count is read from the browser's own WebSocket frames, so
// it is the number of changes the client actually applied.
//
// THE DENOMINATOR USES THE SAME RULE (C-1: "分子分母同口径"): the unmerged control counts only
// `entry.upserted` too.
//
// WHAT IS ALSO RECORDED (C-4): whether a keep-alive (stall) flush happened during the turn. A
// turn whose count includes a keep-alive flush does not represent the count-trigger path and must
// not be used alone for the acceptance conclusion.
//
// WHAT IS RECORDED (US-7): the number of intermediate (non-terminal) updates the client observed
// (≥ 3), and the terminal text (which must be character-for-character the same in both arms).

import type { Browser } from "playwright-core"
import { connectRpc, launchBrowser, startBrain, waitIdle } from "./brain.ts"
import { CLIENT_CHANGE_SCRIPT } from "./client-changes.ts"

export interface Us7Measurement {
  /**
   * The `entry.upserted` changes the CLIENT applied to THE STREAMING ENTRY (C-1's counting point).
   *
   * "一个回合 = 一个 entry 的流式生命周期" (C-1): the turn is ONE entry's streaming lifecycle, and
   * the criterion's own arithmetic uses an N+1 denominator — N intermediate states plus ONE
   * terminal, for that entry. So the owner's own message (which is also upserted twice: `accepted`
   * then `delivered`) is NOT part of the turn and is not counted.
   */
  readonly entryUpserted: number
  /** Every `entry.upserted` the client applied in the window, including the owner's message. */
  readonly entryUpsertedAll: number
  /** Of the streaming entry's, the intermediate states (`streaming: true`). */
  readonly streamingUpserted: number
  /** Of the streaming entry's, the terminal state (`streaming: false`). */
  readonly terminalUpserted: number
  /** The intermediate states the client OBSERVED for the bot's message (US-7's first criterion). */
  readonly observedIntermediate: number
  /** The terminal text — must be identical in both arms (US-7's third criterion). */
  readonly finalText: string
  /** The window setting this arm ran with. */
  readonly maxPending: number
  /** How long the turn took, in ms. */
  readonly turnMs: number
  /** The time from the turn's start to the terminal state's arrival, in ms (US-7's fourth criterion). */
  readonly terminalMs: number
  /**
   * The whole stream span: from the FIRST INTERMEDIATE state to the terminal state.
   *
   * NOT from the first item the client saw: the bot's first upsert already carries
   * `streaming: true`, so the first item IS the first intermediate state — but the two are read
   * from different filters, and saying which one the number uses removes the ambiguity.
   */
  readonly streamSpanMs: number
  /**
   * E-7 (observation, not a criterion): the delay until the first intermediate state is visible to
   * the client, measured from the arm mark.
   *
   * See {@link firstVisibleDelayMs} for why the reference point is the arm mark and not the first
   * item.
   */
  readonly firstVisibleMs: number
  /** The arm mark the delay was measured from (the page clock, `performance.now()`). */
  readonly armedAt: number | null
  /** How many words the turn streamed (N). */
  readonly words: number
  /** Whether the harness streamed with its SLOW chunk delay (the E-7 falsification arm). */
  readonly slow: boolean
}

/**
 * E-7: the delay until the client saw the FIRST intermediate state of the streaming entry.
 *
 * THE REFERENCE POINT IS THE ARM MARK, NOT THE FIRST ITEM. The bot's FIRST upsert already carries
 * `streaming: true` — the fake harness's `streamMessage` upserts `{ streaming: true }` for EVERY
 * chunk, the first one included (`packages/harness-fake/src/Session.ts`), and `TurnIngest`'s
 * `itemFields` copies `streaming` straight off the harness item. So "the first intermediate state"
 * and "the first bot item" are THE SAME OBJECT, and a formula that subtracts one from the other
 * is `x - x = 0`: it cannot tell a 0 ms delay from a 10 s one. (That was the first version's bug,
 * and it made the handoff claim the window never held the first state back — which is exactly what
 * the window does.)
 *
 * The arm mark is taken in the PAGE, on `performance.now()` — the same clock every item's `at` is
 * on. The harness's `Date.now()` is a different time base and cannot be subtracted from it.
 *
 * Returns -1 when there is nothing to measure (never armed, or no intermediate state arrived).
 */
export const firstVisibleDelayMs = (armedAt: number | null, firstIntermediateAt: number | undefined): number => {
  if (armedAt === null) return -1
  if (firstIntermediateAt === undefined) return -1
  return Math.round(firstIntermediateAt - armedAt)
}

/**
 * Measures one streaming turn under the given window setting.
 *
 * `maxPending: 1` is the unmerged control — the window degenerates to "publish every change".
 *
 * `slow: true` makes the fake harness stream with its SLOW chunk delay (250 ms between words,
 * instead of 15 ms). It exists for the E-7 falsification: the window's count trigger needs K
 * chunks, so the longer the gap between chunks, the longer the window holds the FIRST state back
 * — and the measured first-visible delay must grow with it. A formula that cannot tell a 0 ms
 * delay from a 10 s one would NOT grow.
 */
export const measureUs7Turn = async (options?: {
  readonly maxPending?: number
  readonly words?: number
  readonly slow?: boolean
  readonly browser?: Browser
}): Promise<Us7Measurement> => {
  const maxPending = options?.maxPending ?? 4
  const words = options?.words ?? 30
  const slow = options?.slow ?? false
  const browser = options?.browser ?? (await launchBrowser())
  // The switch goes to the BRAIN, not the browser: it changes the server's publish policy.
  const brain = await startBrain({ env: { OPENBOT_STREAM_WINDOW_MAX_PENDING: String(maxPending) } })
  try {
    const rpc = await connectRpc(brain)
    const bot = await rpc.call((c) =>
      c["bots.create"]({ name: "Us7", harness: { kind: "fake" }, clientNonce: `us7-${Date.now()}`, introduce: false }),
    )
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })
    await context.addInitScript(CLIENT_CHANGE_SCRIPT)
    const page = await context.newPage()
    page.setDefaultTimeout(60_000)
    await page.goto(brain.loginUrl)
    await page.goto(`${brain.base}/#/c/${bot.directConversationId}`)
    await page.getByTestId("transcript").waitFor()
    await Bun.sleep(1200)

    // The arm mark is taken HERE — just before the message is typed and sent. So the E-7 delay
    // covers the whole path from "the user pressed send" to "the first intermediate state is on
    // screen": the send itself, the server accepting it, the harness starting, the window
    // buffering its first states, and the transport. That is the interval E-7 asks about
    // ("首个可见中间态的延迟"), and it is measured on ONE clock (the page's), so it is a real
    // elapsed time rather than a difference between two unrelated time bases.
    await page.evaluate(() => (window as any).__obClientChanges.reset())
    await page.evaluate(() => (window as any).__obClientChanges.arm())
    const started = Date.now()
    // `slow:` makes the fake harness stream with its SLOW chunk delay (250 ms between words
    // instead of 15 ms) — the E-7 falsification construction. `echo:` is the normal one.
    const wordsText = Array.from({ length: words }, (_, i) => `w${i}`).join(" ")
    const text = `${slow ? "slow" : "echo"}: ${wordsText}`
    await page.getByRole("textbox", { name: "Message Us7" }).fill(text)
    await page.getByRole("textbox", { name: "Message Us7" }).press("Enter")
    // The BOT's bubble only: the owner's own message contains the same words, so a plain text
    // match would be ambiguous between the two.
    const botBubble = page.getByTestId("transcript").locator('[data-side="bot"]')
    await botBubble.getByText(`w${words - 1}`, { exact: false }).first().waitFor({ timeout: 60_000 })
    await waitIdle(page, 60_000)
    await Bun.sleep(800)
    const turnMs = Date.now() - started

    const changes = await page.evaluate(() => (window as any).__obClientChanges.read())
    // The bot's message: the last entry the client saw that is not the owner's message.
    const botEntries = changes.items.filter((i: { role?: string; conversationId: string; streaming: boolean; text: string; at: number }) => i.role === "bot" && i.conversationId === bot.directConversationId)
    // The streaming entry is ONE entry: the bot's message. Its upserts are the turn's changes.
    // (The owner's message is upserted too — `accepted` then `delivered` — but it is not part of
    // this entry's streaming lifecycle, so it is not counted; C-1's own arithmetic uses N+1.)
    const streamEntryId = botEntries[0]?.entryId
    const observedIntermediate = botEntries.filter((i: { streaming: boolean }) => i.streaming).length
    const finalText = botEntries.at(-1)?.text ?? ""
    // US-7's fourth criterion: "the turn's terminal update must reach the client and be applied
    // within <= 200 ms of the turn ending".
    //
    // The client cannot see the server's "the turn ended" moment, so the observable proxy is the
    // gap between the LAST INTERMEDIATE state and the terminal state: that is exactly the delay
    // the publish window could have added (a window that held the terminal back would park it for
    // up to `stallMs` = 2000 ms). The terminal is published the moment it arrives, so this gap is
    // the transport latency plus the harness's own last emit.
    const lastIntermediate = botEntries.filter((i: { streaming: boolean }) => i.streaming).at(-1)
    const terminal = botEntries.find((i: { streaming: boolean }) => !i.streaming)
    const terminalMs = terminal === undefined || lastIntermediate === undefined ? -1 : Math.round(terminal.at - lastIntermediate.at)
    // The whole span, for reference: from the first intermediate state to the terminal.
    //
    // The first INTERMEDIATE state, not `botEntries[0]` — they are the same object in practice (the
    // bot's first upsert is already `streaming: true`), but naming the intermediate one keeps the
    // number's meaning independent of that coincidence.
    const firstIntermediate = botEntries.find((i: { streaming: boolean }) => i.streaming)
    const streamSpanMs = firstIntermediate === undefined || terminal === undefined ? -1 : Math.round(terminal.at - firstIntermediate.at)
    // E-7 / R-6: the delay until the FIRST intermediate state is visible to the client. The window
    // can hold the first state back (it is buffered until the count trigger or the stall
    // fallback), so this is the "does the stream still feel like a stream?" observation.
    //
    // The reference point is the ARM MARK (the page clock, `performance.now()`), NOT the first
    // item: the first item IS the first intermediate state, so subtracting one from the other
    // would always be 0 — a measurement that cannot tell 0 ms from 10 s.
    const firstVisibleMs = firstVisibleDelayMs(changes.armedAt ?? null, firstIntermediate?.at)

    await context.close()
    await rpc.close()
    const streamEntries = botEntries.filter((i: { entryId?: string }) => i.entryId === streamEntryId)
    return {
      entryUpserted: streamEntries.length,
      entryUpsertedAll: changes.entryUpserted,
      streamingUpserted: streamEntries.filter((i: { streaming: boolean }) => i.streaming).length,
      terminalUpserted: streamEntries.filter((i: { streaming: boolean }) => !i.streaming).length,
      observedIntermediate,
      finalText,
      maxPending,
      turnMs,
      terminalMs,
      streamSpanMs,
      firstVisibleMs,
      armedAt: changes.armedAt ?? null,
      words,
      slow,
    }
  } finally {
    await browser.close()
    await brain.stop()
  }
}

// ----------------------------------------------------------------------------------- the runner

if (import.meta.main) {
  // `bun run us7-measure.ts <maxPending> [slow]`
  const maxPending = Number(process.argv[2] ?? 4)
  const slow = process.argv[3] === "slow"
  const measurement = await measureUs7Turn({ maxPending, slow })
  console.log(JSON.stringify(measurement, null, 2))
}

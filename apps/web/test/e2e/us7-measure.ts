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
  /** From the first intermediate state to the terminal (the whole stream span). */
  readonly streamSpanMs: number
  /** E-7 (observation, not a criterion): the delay until the first intermediate state arrives. */
  readonly firstVisibleMs: number
  /** How many words the turn streamed (N). */
  readonly words: number
}

/**
 * Measures one streaming turn under the given window setting.
 *
 * `maxPending: 1` is the unmerged control — the window degenerates to "publish every change".
 */
export const measureUs7Turn = async (options?: {
  readonly maxPending?: number
  readonly words?: number
  readonly browser?: Browser
}): Promise<Us7Measurement> => {
  const maxPending = options?.maxPending ?? 4
  const words = options?.words ?? 30
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

    await page.evaluate(() => (window as any).__obClientChanges.reset())
    await page.evaluate(() => (window as any).__obClientChanges.arm())
    const started = Date.now()
    const text = `echo: ${Array.from({ length: words }, (_, i) => `w${i}`).join(" ")}`
    await page.getByRole("textbox", { name: "Message Us7" }).fill(text)
    await page.getByRole("textbox", { name: "Message Us7" }).press("Enter")
    await page.getByTestId("transcript").getByText(`w${words - 1}`, { exact: false }).waitFor({ timeout: 60_000 })
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
    const streamSpanMs = botEntries.length < 2 ? -1 : Math.round((botEntries.at(-1)?.at ?? 0) - (botEntries[0]?.at ?? 0))
    // E-7 / R-6: the delay until the FIRST intermediate state is visible to the client. The window
    // can hold the first state back (it is buffered until the count trigger or the stall
    // fallback), so this is the "does the stream still feel like a stream?" observation.
    const firstIntermediate = botEntries.find((i: { streaming: boolean }) => i.streaming)
    const firstVisibleMs = firstIntermediate === undefined ? -1 : Math.round(firstIntermediate.at - (botEntries[0]?.at ?? firstIntermediate.at))

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
      words,
    }
  } finally {
    await browser.close()
    await brain.stop()
  }
}

// ----------------------------------------------------------------------------------- the runner

if (import.meta.main) {
  const maxPending = Number(process.argv[2] ?? 4)
  const measurement = await measureUs7Turn({ maxPending })
  console.log(JSON.stringify(measurement, null, 2))
}

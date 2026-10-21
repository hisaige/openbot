// The US-6 measurement, as a standalone runner (architecture §6.3, E-4).
//
// WHY A SEPARATE RUNNER: E-4 is a CODE comparison — "the code before the change" against "the
// code after it" — not a runtime switch (the memo has no runtime switch; only the server's
// publish window has one). The comparison therefore needs the SAME measurement code to run
// against two different versions of the app. This module is that measurement; the runner script
// (`/root/ai/devteam/dev_b/measure-us6.sh`) applies the "before" patch, runs this, reverts the
// patch, and runs it again.
//
// WHAT IS MEASURED: during ONE streaming turn, how many times `Markdown`'s body ran (the parse
// counter) and how many DIFFERENT message bodies were re-parsed with an unchanged text.
//
// The counter itself is INSTRUMENTATION, not the optimization: it stays in both arms, so the only
// difference between them is the memo wrapper and the `bots` reference stabilization.

import type { Browser } from "playwright-core"
import { connectRpc, launchBrowser, startBrain, waitIdle } from "./brain.ts"
import { CLIENT_CHANGE_SCRIPT, PARSE_STATS_INIT_SCRIPT } from "./client-changes.ts"

export interface Us6Measurement {
  /** The parse counter: how many times `parseBlocks` ran. */
  readonly parses: number
  /** How many DISTINCT message bodies were parsed with a changed text. */
  readonly changedBodies: number
  /** How many DISTINCT message bodies were parsed with an UNCHANGED text (the re-parse cost). */
  readonly unchangedBodies: number
  /**
   * The `entry.upserted` changes the client applied to THE STREAMING ENTRY (C-1's counting point).
   *
   * "一个回合 = 一个 entry 的流式生命周期" (C-1): the owner's own message is upserted too
   * (`accepted` then `delivered`) but is not part of the turn.
   */
  readonly entryUpserted: number
  /** Every `entry.upserted` the client applied in the window, including the owner's message. */
  readonly entryUpsertedAll: number
  readonly streamingUpserted: number
  readonly terminalUpserted: number
  /** The number of messages already on screen when the turn started (the K of US-6). */
  readonly loadedMessages: number
  /** The final text of the streaming message. */
  readonly finalText: string
}

/**
 * Measures one streaming turn.
 *
 * `history` is how many bot messages are already in the conversation when the turn starts — US-6's
 * "a conversation with K bot messages already loaded (K ≥ 20)". They are created by real turns (the
 * fake harness streams them), so the measurement runs against a realistic transcript.
 */
export const measureStreamingTurn = async (
  options?: { readonly history?: number; readonly words?: number; readonly browser?: Browser },
): Promise<Us6Measurement> => {
  const history = options?.history ?? 20
  const words = options?.words ?? 30
  const browser = options?.browser ?? (await launchBrowser())
  const brain = await startBrain()
  try {
    const rpc = await connectRpc(brain)
    const bot = await rpc.call((c) =>
      c["bots.create"]({ name: "Us6", harness: { kind: "fake" }, clientNonce: `us6-${Date.now()}`, introduce: false }),
    )
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })
    await context.addInitScript(CLIENT_CHANGE_SCRIPT)
    await context.addInitScript(PARSE_STATS_INIT_SCRIPT)
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    await page.goto(brain.loginUrl)
    await page.goto(`${brain.base}/#/c/${bot.directConversationId}`)
    await page.getByTestId("transcript").waitFor()

    // Build the history: real turns, so the transcript looks like a real one.
    for (let i = 0; i < history; i++) {
      await page.getByRole("textbox", { name: "Message Us6" }).fill(`echo: history message number ${i} with a few more words to make it a realistic body`)
      await page.getByRole("textbox", { name: "Message Us6" }).press("Enter")
      // The same wait as the measured turn: wait for the reply to be ON SCREEN, then for the turn
      // to be done. `waitIdle` alone returns before the turn has even started.
      await page.getByTestId("transcript").getByText(`history message number ${i}`, { exact: false }).waitFor({ timeout: 30_000 })
      await waitIdle(page, 30_000)
    }
    const loadedMessages = await page.locator("[data-entry]").count()

    // The measured turn. The change counter's ITEM LOG is reset too — it holds every upsert since
    // the page loaded, including the history turns', and the turn is identified by its entry id.
    await page.evaluate(() => (window as any).__obResetMarkdownParseStats())
    await page.evaluate(() => (window as any).__obClientChanges.reset())
    await page.evaluate(() => (window as any).__obClientChanges.arm())
    const text = `echo: ${Array.from({ length: words }, (_, i) => `w${i}`).join(" ")}`
    await page.getByRole("textbox", { name: "Message Us6" }).fill(text)
    await page.getByRole("textbox", { name: "Message Us6" }).press("Enter")
    // Wait for the turn to be DONE, not for it to be idle: `waitIdle` waits for the Stop button to
    // be detached, and right after the send the turn has not started yet — the button is not there
    // at all, so `waitIdle` returns immediately and the measurement catches half a turn.
    await page.getByTestId("transcript").getByText(`w${words - 1}`, { exact: false }).waitFor({ timeout: 60_000 })
    await waitIdle(page, 60_000)
    await Bun.sleep(800)

    const stats = await page.evaluate(() => (window as any).__obMarkdownParseStats())
    const changes = await page.evaluate(() => (window as any).__obClientChanges.read())
    const finalText = String(Object.values(changes.lastTextByEntry).at(-1) ?? "")
    // The turn is ONE entry's streaming lifecycle (C-1): the bot's message. The owner's message is
    // also upserted (`accepted` then `delivered`) but is not part of the turn.
    const botEntryId = changes.items.find((i: { role?: string }) => i.role === "bot")?.entryId
    const streamUpserts = changes.items.filter((i: { entryId?: string }) => i.entryId === botEntryId)
    await context.close()
    await rpc.close()
    return {
      parses: stats.parses,
      changedBodies: stats.changedBodies,
      unchangedBodies: stats.unchangedBodies,
      entryUpserted: streamUpserts.length,
      entryUpsertedAll: changes.entryUpserted,
      streamingUpserted: changes.streamingUpserted,
      terminalUpserted: changes.terminalUpserted,
      loadedMessages,
      finalText,
    }
  } finally {
    await browser.close()
    await brain.stop()
  }
}

// ----------------------------------------------------------------------------------- the runner

if (import.meta.main) {
  const measurement = await measureStreamingTurn()
  console.log(JSON.stringify(measurement, null, 2))
}

// F-9: the publish window must not break the disconnect/resume path (PRD US-7's reconnect clause,
// architecture §2.3.5, I-3).
//
// THE CLAIM BEING TESTED: "若客户端在合并窗口内断线，重连后其最终状态必须与未断线的客户端一致
// （终态不得因合并而丢失）" — if the client disconnects while the window is still buffering, the
// reconnected client must end up with exactly the same final text as one that never disconnected.
//
// WHY THIS TEST EXISTS: the reviewer and the test engineer both noted that US-7's reconnect clause
// had NO coverage in the repository. The probe that "passed" lived outside the repo, so nothing
// would have caught a regression. A P0 without a regression guard is not a delivered P0.
//
// HOW THE DISCONNECT IS MADE: `context.setOffline(true)` — the browser's network goes away while
// the page stays alive, so the client's socket dies mid-turn. Then `setOffline(false)` brings it
// back, and the client's own resume logic (`packages/client/src/resume.ts`) resubscribes from its
// cursor.
//
// WHAT IS COMPARED: the final text of the bot's message on the DISCONNECTED client against the
// final text of the bot's message on a CONTROL client (same brain, same turn, never disconnected).
// Character for character.
//
// THE WINDOW IS ON: the brain runs with `OPENBOT_STREAM_WINDOW_MAX_PENDING=4`, so the intermediate
// states really are buffered and there really is a window to disconnect inside.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser, BrowserContext, Page } from "playwright-core"
import { connectRpc, hasChromium, launchBrowser, startBrain, type Brain, type Rpc, waitIdle } from "./brain.ts"

/** The window setting the brain runs with: the window is ON, so there is a window to disconnect in. */
const MAX_PENDING = "4"
/** The words the fake harness streams (one chunk per word). */
const WORDS = 30

/**
 * Runs one streaming turn and returns the bot's final message text.
 *
 * `disconnectAfterMs`: how long to wait before taking the network away. `undefined` = the control
 * arm (never disconnects).
 */
const runTurn = async (
  page: Page,
  context: BrowserContext,
  expected: string,
  disconnectAfterMs: number | undefined,
): Promise<{ readonly text: string; readonly textAtDisconnect: number }> => {
  const text = `echo: ${Array.from({ length: WORDS }, (_, i) => `w${i}`).join(" ")}`
  await page.getByRole("textbox", { name: "Message Us7" }).fill(text)
  await page.getByRole("textbox", { name: "Message Us7" }).press("Enter")
  const botBubble = page.getByTestId("transcript").locator('[data-side="bot"]')
  // How much of the reply was on screen when the network went away. -1 in the control arm.
  let textAtDisconnect = -1
  if (disconnectAfterMs !== undefined) {
    // Take the network away while the turn is still streaming. The page stays alive, so the
    // client's socket dies but its state (and its cursor) survive.
    await Bun.sleep(disconnectAfterMs)
    textAtDisconnect = ((await botBubble.allTextContents()).at(-1) ?? "").trim().length
    await context.setOffline(true)
    // Let the client notice the socket is gone and start backing off.
    await Bun.sleep(500)
    await context.setOffline(false)
  }
  // The turn finishes once the network is back. The wait is generous: the client's backoff after
  // a disconnect is up to 5 s, and the re-subscription has to happen on top of that.
  //
  // The BOT's bubble only: the owner's own message contains the same words ("echo: w0 w1 … w29"),
  // so a plain text match would be ambiguous between the two.
  await botBubble.getByText(expected, { exact: false }).first().waitFor({ timeout: 60_000 })
  await waitIdle(page, 60_000)
  await Bun.sleep(1000)
  // The bot's rendered text — the last bot bubble on screen.
  const botText = (await botBubble.allTextContents()).at(-1) ?? ""
  return { text: botText.trim(), textAtDisconnect }
}

describe.skipIf(!hasChromium)("e2e: F-9 — the window does not break the disconnect/resume path", () => {
  let browser: Browser
  let brain: Brain
  let rpc: Rpc
  let controlContext: BrowserContext
  let controlPage: Page
  let droppedContext: BrowserContext
  let droppedPage: Page
  let conversationId: string

  beforeAll(async () => {
    browser = await launchBrowser()
    // The window is ON: `4` means the intermediate states are buffered and published in batches.
    brain = await startBrain({ env: { OPENBOT_STREAM_WINDOW_MAX_PENDING: MAX_PENDING } })
    rpc = await connectRpc(brain)
    const bot = await rpc.call((c) =>
      c["bots.create"]({ name: "Us7", harness: { kind: "fake" }, clientNonce: `us7-resume-${Date.now()}`, introduce: false }),
    )
    conversationId = bot.directConversationId

    controlContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })
    controlPage = await controlContext.newPage()
    controlPage.setDefaultTimeout(60_000)
    await controlPage.goto(brain.loginUrl)
    await controlPage.goto(`${brain.base}/#/c/${conversationId}`)
    await controlPage.getByTestId("transcript").waitFor()
    await Bun.sleep(1200)

    droppedContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })
    droppedPage = await droppedContext.newPage()
    droppedPage.setDefaultTimeout(60_000)
    await droppedPage.goto(brain.loginUrl)
    await droppedPage.goto(`${brain.base}/#/c/${conversationId}`)
    await droppedPage.getByTestId("transcript").waitFor()
    await Bun.sleep(1200)
  }, 180_000)

  afterAll(async () => {
    await controlContext?.close()
    await droppedContext?.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  test("a client that disconnects mid-turn ends up with the same final text as one that does not", async () => {
    const expected = `w${WORDS - 1}`
    // The control arm first: the text the bot's message ends with, with no disconnect at all.
    const control = await runTurn(controlPage, controlContext, expected, undefined)
    expect(control.text).toContain(expected)

    // The dropped arm: the same turn, with the network taken away in the middle of it.
    //
    // 250 ms is chosen to land INSIDE the turn: the fake harness streams one word every 15 ms, so
    // 30 words take ~450 ms, and the window holds the first 4 intermediate states for ~60 ms.
    // A disconnect at 250 ms therefore happens while the window is still buffering.
    const dropped = await runTurn(droppedPage, droppedContext, expected, 250)

    // THE PRECONDITION: the disconnect really landed mid-turn. A test that disconnects after the
    // turn has already finished would pass for the wrong reason — it would be measuring nothing
    // (and it would be green even if the resume path were completely broken). So the reply must
    // have been INCOMPLETE when the network went away.
    expect(dropped.textAtDisconnect).toBeGreaterThan(0)
    expect(dropped.textAtDisconnect).toBeLessThan(control.text.length)

    // THE CRITERION: the final state is the same, character for character.
    expect(dropped.text).toBe(control.text)
    // And the terminal state is really the terminal text, not a frozen intermediate one.
    expect(dropped.text).toContain(`w0`)
    expect(dropped.text).toContain(`w${WORDS - 1}`)
  }, 180_000)
})

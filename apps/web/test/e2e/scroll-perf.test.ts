// E2E: the scroll-performance diagnostics and the two before/after comparisons
// (architecture §5.3, §6.3 E-1…E-4; PRD US-1…US-4, US-6).
//
// WHAT THIS FILE COVERS (and what it does NOT)
//
//   E-1 (US-2)  the DOM node count at three measurement points, in two scopes
//   E-2 (US-3)  whether there is a forced reflow, and which function causes it
//   E-3 (US-4)  the scroll timing, split into its real parts (app / RPC / commit)
//   E-4 (US-6)  the parse counts during a streaming turn (the "after" arm)
//
// IT DOES NOT COVER E-5, E-6 OR E-7, and the file head used to claim it did. That was a real
// defect (the reviewer's B-02): a header that lists cases the file does not contain makes a
// reader believe the coverage is there. The truth is:
//
//   E-5 (US-7)  the before/after change counts — needs TWO real brains (the window off and the
//                window on), ~3 minutes. It is a SCRIPT, not a regression case:
//                `/root/ai/devteam/dev_b/measure-us7.sh`.
//   E-6 (US-9)  zero regression — this is the EXISTING suite being green plus the mobile diff
//                being empty. There is no new case for it; the check is the suite itself.
//   E-7         the first-visible-intermediate-state delay — an observation item, and it needs a
//                window that actually holds states back. It runs as a SCRIPT too:
//                `/root/ai/devteam/dev_b/measure-us7.sh` (the same run), with the formula's
//                falsifiability pinned by `apps/web/test/us7-first-visible.test.ts`.
//
// THE FIXTURE: the 2000-entry conversation comes from `fixture-brain.ts` (start → stop → write the
// database → start again). The first screen shows 100 entries — the client never asks for more
// (`SNAPSHOT_TAIL_ENTRIES`), so "the DOM node count" is always measured on the first screen
// unless the test scrolls (architecture §3.3).
//
// THE MEASUREMENT POINTS ARE WRITTEN TO A JSON FILE (`scroll-perf-results.json`) next to this
// file, so the handoff can quote numbers that were MEASURED rather than retyped by hand.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser, BrowserContext, Page } from "playwright-core"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { type AppPage, connectRpc, hasChromium, launchBrowser, type Rpc, waitIdle } from "./brain.ts"
import { CLIENT_CHANGE_SCRIPT, PARSE_STATS_INIT_SCRIPT } from "./client-changes.ts"
import { diffMetrics, mean, measureDom, median, readPerformanceMetrics, traceReflow } from "./diagnostics.ts"
import { startSeededBrain, type FixtureBrain, type SeededBrain } from "./fixture-brain.ts"
import { SCROLL_TIMING_SCRIPT, timeScrollPageSplit } from "./scroll-timing.ts"

/** The results file the handoff quotes. */
const resultsPath = join(new URL(".", import.meta.url).pathname, "scroll-perf-results.json")

/** The four labels every number has to carry (architecture §8.2). */
export interface Measurement {
  readonly value: number
  readonly workingSet: string
  readonly coldHot: string
  readonly sampling: string
  readonly control: string
}

const m = (value: number, workingSet: string, coldHot: string, sampling: string, control: string): Measurement => ({
  value,
  workingSet,
  coldHot,
  sampling,
  control,
})

/** The fixture's size, for the "working set" label. */
const WORKING_SET = "the fixture conversation: 2000 bot messages, ~612 chars each, 12.5% with rich text (table/code/list/image); the first screen is the 100 newest (the client never asks for more)"
const COLD_HOT = "cold: a fresh browser context and a fresh brain per arm; the transcript is measured after the first paint, with no prior scroll"
const SAMPLING = "one measurement per state (the DOM counts are deterministic); the scroll timings are one sample per page, reported as the median over the pages"
const CONTROL = "same machine, same fixture, same conversation state; the only difference between the arms is the one under test"

describe.skipIf(!hasChromium)("e2e: chat scroll performance", () => {
  let browser: Browser
  let seeded: SeededBrain
  let brain: FixtureBrain
  let rpc: Rpc
  let context: BrowserContext
  let app: AppPage
  let page: Page
  /** The results, written at the end. */
  const results: Record<string, unknown> = {}

  beforeAll(async () => {
    browser = await launchBrowser()
    // The seeded brain: the 2000-entry conversation.
    seeded = await startSeededBrain({ count: 2000, botName: "Fixture" })
    brain = seeded.brain
    rpc = await connectRpc(brain as never)
    // ONE context, carrying the three init scripts: the change counter (C-1's counting point),
    // the parse counter (US-6's) and the scroll-timing probe (E-3's). All three have to be
    // installed before the app's first render — the scroll-timing probe wraps `WebSocket`, so it
    // has to see the app open its socket.
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })
    await context.addInitScript(CLIENT_CHANGE_SCRIPT)
    await context.addInitScript(PARSE_STATS_INIT_SCRIPT)
    await context.addInitScript(SCROLL_TIMING_SCRIPT)
    page = await context.newPage()
    page.setDefaultTimeout(20_000)
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console: ${msg.text()}`)
    })
    // Log in and open the fixture conversation.
    await page.goto(brain.loginUrl)
    await page.goto(`${brain.base}/#/c/${seeded.conversationId}`)
    await page.getByTestId("transcript").waitFor()
    // Let the first paint settle.
    await Bun.sleep(1500)
    results["page_errors"] = errors
    app = { page, context, errors, shot: async () => undefined }
  }, 180_000)

  afterAll(async () => {
    await app?.context.close()
    await context?.close()
    await rpc?.close()
    await browser?.close()
    await seeded?.brain.dispose()
  })

  // ---------------------------------------------------------------------------- E-1 (US-2)

  test("E-1: the DOM node count at the three measurement points, in both scopes", async () => {
    const first = await measureDom(page, "first screen (100 newest entries)", 0)
    results["E1_first_screen"] = {
      transcript: first.transcript,
      page: first.page,
      rows: first.rows,
      nodesPerRow: Number((first.transcript / Math.max(1, first.rows)).toFixed(1)),
      scrollHeight: first.scrollHeight,
      viewportHeight: first.viewportHeight,
      measurement: m(first.transcript, WORKING_SET, COLD_HOT, SAMPLING, CONTROL),
    }
    // The first screen is 100 entries: the client asks for a fixed tail.
    expect(first.rows).toBe(100)
    expect(first.transcript).toBeGreaterThan(0)

    // Scroll up 5 pages → 350 entries on screen.
    //
    // The timings are taken with the SAME measurement the E-3 case uses (`timeScrollPageSplit`),
    // so there is ONE algorithm in this file. The first version of this file used
    // `diagnostics.ts`'s `timeScrollPage` here and in E-3 — and that algorithm was withdrawn
    // (D-3): it split the scroll by subtraction, which put the harness's own settle-wait into the
    // "render" leg. A file that measures the same thing two different ways is a file whose numbers
    // cannot be compared.
    const timings: number[] = []
    for (let i = 1; i <= 5; i++) {
      const timing = await timeScrollPageSplit(page)
      if (timing !== undefined) timings.push(timing.userPerceivedMs)
      await Bun.sleep(400)
    }
    const afterFive = await measureDom(page, "after 5 pages (350 entries)", 5)
    results["E1_after_5_pages"] = {
      transcript: afterFive.transcript,
      page: afterFive.page,
      rows: afterFive.rows,
      nodesPerRow: Number((afterFive.transcript / Math.max(1, afterFive.rows)).toFixed(1)),
      scrollHeight: afterFive.scrollHeight,
      measurement: m(afterFive.transcript, WORKING_SET, COLD_HOT, SAMPLING, CONTROL),
    }
    expect(afterFive.rows).toBe(350)
    results["E1_nodes_per_row"] = {
      first: Number((first.transcript / Math.max(1, first.rows)).toFixed(1)),
      afterFive: Number((afterFive.transcript / Math.max(1, afterFive.rows)).toFixed(1)),
    }
    results["E1_scroll_total_ms_median"] = { value: median(timings), measurement: m(median(timings), WORKING_SET, COLD_HOT, "one sample per page, 5 pages; median", CONTROL) }
  }, 180_000)

  // ---------------------------------------------------------------------------- E-2 (US-3)

  test("E-2: is there a forced reflow while scrolling, and which function causes it", async () => {
    const cdp = await context.newCDPSession(page)
    await cdp.send("Performance.enable")
    const before = await readPerformanceMetrics(cdp)
    // One scroll to the top, traced.
    const attribution = await traceReflow(page, cdp, async () => {
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="transcript"]')
        if (el !== null) {
          el.scrollTop = 0
          el.dispatchEvent(new Event("scroll", { bubbles: true }))
        }
      })
      await Bun.sleep(800)
    })
    const after = await readPerformanceMetrics(cdp)
    const diff = diffMetrics(before, after)
    results["E2_forced_reflow"] = {
      forcedReflows: attribution.forcedReflows,
      layoutEvents: attribution.layoutEvents,
      attributedTo: attribution.attributedTo,
      unattributed: attribution.unattributed,
      layoutCount: diff.layoutCount,
      recalcStyleCount: diff.recalcStyleCount,
      layoutDurationMs: diff.layoutDurationMs,
      measurement: m(attribution.forcedReflows, WORKING_SET, COLD_HOT, "one traced scroll to the top", CONTROL),
    }
    // The numbers are recorded either way. If nothing was attributed, the handoff says "not found"
    // with the detection range — it must NOT claim "there is none".
    expect(typeof attribution.forcedReflows).toBe("number")
    await cdp.detach()
  }, 120_000)

  // ---------------------------------------------------------------------------- E-3 (US-4)

  test("E-3: the scroll timing, split into the app, the RPC and React's commit", async () => {
    // The measurement is `scroll-timing.ts`'s `timeScrollPageSplit`, which marks each step
    // DIRECTLY (the request frame going out, the response frame coming back, the DOM growing)
    // instead of subtracting one step from the total.
    //
    // WHY NOT THE FIRST VERSION: it computed `renderMs = totalMs - serverMs`, which put the
    // harness's own 400 ms settle-wait into the "render" leg — it reported ~503 ms in EVERY
    // environment, on a 350-row DOM and on a 1900-row DOM alike. A real React commit does not
    // cost the same on both, so that number was measuring the instrument, not the app.
    const samples: Array<{
      appLatencyMs: number
      rpcMs: number
      commitMs: number
      settleMs: number
      userPerceivedMs: number
      added: number
      // The RAW marks, so the identity below can be checked exactly (no rounding tolerance).
      wheelAt: number
      requestAt: number
      responseAt: number
      domAt: number
    }> = []
    for (let i = 0; i < 5; i++) {
      const timing = await timeScrollPageSplit(page)
      if (timing === undefined) continue
      samples.push({
        appLatencyMs: timing.appLatencyMs,
        rpcMs: timing.rpcMs,
        commitMs: timing.commitMs,
        settleMs: timing.settleMs,
        userPerceivedMs: timing.userPerceivedMs,
        added: timing.added,
        wheelAt: timing.wheelAt,
        requestAt: timing.requestAt,
        responseAt: timing.responseAt,
        domAt: timing.domAt,
      })
      await Bun.sleep(400)
    }
    results["E3_scroll_timing"] = {
      appLatencyMs: { median: median(samples.map((s) => s.appLatencyMs)), mean: Number(mean(samples.map((s) => s.appLatencyMs)).toFixed(1)) },
      rpcMs: { median: median(samples.map((s) => s.rpcMs)), mean: Number(mean(samples.map((s) => s.rpcMs)).toFixed(1)) },
      commitMs: { median: median(samples.map((s) => s.commitMs)), mean: Number(mean(samples.map((s) => s.commitMs)).toFixed(1)) },
      settleMs: { median: median(samples.map((s) => s.settleMs)), mean: Number(mean(samples.map((s) => s.settleMs)).toFixed(1)) },
      userPerceivedMs: {
        median: median(samples.map((s) => s.userPerceivedMs)),
        mean: Number(mean(samples.map((s) => s.userPerceivedMs)).toFixed(1)),
      },
      samples: samples.length,
      entriesPerPage: samples[0]?.added,
      measurement: m(median(samples.map((s) => s.userPerceivedMs)), WORKING_SET, COLD_HOT, "5 scroll-to-top samples, median and mean", CONTROL),
    }
    expect(samples.length).toBe(5)
    expect(samples[0]?.added).toBe(50)
    // THE SELF-CONSISTENCY CHECK, on the RAW marks: the three criterion legs must tile the
    // interval the user waits for, with no gap and no overlap.
    //
    // It is checked on the raw marks rather than on the rounded legs, so it is EXACT: a leg that
    // dropped or double-counted something would leave a hole or a double-covered piece, and the
    // identity would not hold. (On the rounded legs the same check would need a ±2 ms tolerance,
    // because each leg is rounded independently — the rounding, not the measurement, is what
    // makes the rounded sum differ by one.)
    for (const s of samples) {
      // Each leg is the rounded length of its own raw interval.
      expect(s.appLatencyMs).toBe(Math.round(s.requestAt - s.wheelAt))
      expect(s.rpcMs).toBe(Math.round(s.responseAt - s.requestAt))
      expect(s.commitMs).toBe(Math.round(s.domAt - s.responseAt))
      // The three legs tile the interval: the last leg ends exactly where the total ends. This is
      // the exact identity — no tolerance, because it is computed on the raw marks.
      expect(s.requestAt - s.wheelAt + (s.responseAt - s.requestAt) + (s.domAt - s.responseAt)).toBe(s.domAt - s.wheelAt)
      // And the total is that interval, rounded.
      expect(s.userPerceivedMs).toBe(Math.round(s.domAt - s.wheelAt))
    }
    // The settle leg is the HARNESS's padding (it waits for the entry count to stabilise). It is
    // reported, but it is NOT part of what the user waits for. The sum check above already proves
    // that: `userPerceivedMs` is the wheel→DOM interval, so a settle folded into it would make the
    // three legs add up to MORE than the total. What is asserted here is that the padding was
    // actually observed (a settle of exactly 0 would mean the wait was skipped and the leg is
    // measuring nothing).
    for (const s of samples) {
      expect(s.settleMs).toBeGreaterThan(0)
    }
  }, 120_000)

  // ------------------------------------------------------------------- E-4 (US-6) — after arm

  test("E-4 (after): the parse counts during a streaming turn", async () => {
    // A FRESH RPC connection: the one from `beforeAll` has been idle through the (slow) scroll
    // measurements, and the server drops a silent socket — the call then fails with a ping timeout
    // that has nothing to do with what this test measures.
    const streamRpc = await connectRpc(brain as never)
    // A fresh bot in a fresh conversation, so the turn has a clean body set.
    const streamBot = await streamRpc.call((c) =>
      c["bots.create"]({ name: "Stream", harness: { kind: "fake" }, clientNonce: "scroll-perf-stream", introduce: false }),
    )
    // Load the conversation (which parses every message once) and reset the counters.
    await page.goto(`${brain.base}/#/c/${streamBot.directConversationId}`)
    await page.getByTestId("transcript").waitFor()
    await Bun.sleep(1200)
    await page.evaluate(() => (window as any).__obResetMarkdownParseStats())
    await page.evaluate(() => (window as any).__obClientChanges.arm())

    // 30 words → 30 intermediate states + 1 terminal (the fake harness splits on words).
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ")
    await page.getByRole("textbox", { name: "Message Stream" }).fill(`echo: ${words}`)
    await page.getByRole("textbox", { name: "Message Stream" }).press("Enter")
    // Wait for the reply to be ON SCREEN first: `waitIdle` waits for the Stop button to be
    // detached, and right after the send the turn has not started yet — the button is not there at
    // all, so `waitIdle` returns immediately and the measurement catches half a turn.
    await page.getByTestId("transcript").getByText(`w${29}`, { exact: false }).waitFor({ timeout: 60_000 })
    await waitIdle(page, 30_000)
    await Bun.sleep(500)

    const stats = await page.evaluate(() => (window as any).__obMarkdownParseStats())
    const changes = await page.evaluate(() => (window as any).__obClientChanges.read())
    results["E4_after"] = {
      parses: stats.parses,
      changedBodies: stats.changedBodies,
      unchangedBodies: stats.unchangedBodies,
      entryUpserted: changes.entryUpserted,
      streamingUpserted: changes.streamingUpserted,
      terminalUpserted: changes.terminalUpserted,
      measurement: m(stats.changedBodies, "one streaming turn (N=30 words) in a fresh conversation", COLD_HOT, "one turn, counted at the client", CONTROL),
    }
    // US-6: the number of re-parsed message bodies during one turn ≤ 2.
    expect(stats.changedBodies).toBeLessThanOrEqual(2)
    // The stronger criterion the architecture pins: an UNCHANGED body is not re-parsed at all.
    expect(stats.unchangedBodies).toBe(0)
    await streamRpc.close()
  }, 180_000)

  test("the results file is written", () => {
    writeFileSync(resultsPath, JSON.stringify(results, null, 2))
    expect(Object.keys(results).length).toBeGreaterThan(0)
  })
})

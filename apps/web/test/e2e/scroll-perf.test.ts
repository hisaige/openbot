// E2E: the scroll-performance diagnostics and the two before/after comparisons
// (architecture §5.3, §6.3 E-1…E-7; PRD US-1…US-8).
//
// WHAT THIS FILE MEASURES
//
//   E-1 (US-2)  the DOM node count at three measurement points, in two scopes
//   E-2 (US-3)  whether there is a forced reflow, and which function causes it
//   E-3 (US-4)  the scroll timing split into "waiting for the server" and "rendering locally"
//   E-4 (US-6)  the parse counts before and after the memo change (code comparison)
//   E-5 (US-7)  the change counts before and after the publish window (runtime switch)
//   E-6 (US-9)  zero regression
//   E-7        the first-visible-intermediate-state and terminal-state latencies (observation)
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
import { diffMetrics, mean, measureDom, median, readPerformanceMetrics, timeScrollPage, traceReflow } from "./diagnostics.ts"
import { startSeededBrain, type FixtureBrain, type SeededBrain } from "./fixture-brain.ts"

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
    // ONE context, carrying the two init scripts: the change counter (C-1's counting point) and
    // the parse counter (US-6's). Both have to be installed before the app's first render.
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })
    await context.addInitScript(CLIENT_CHANGE_SCRIPT)
    await context.addInitScript(PARSE_STATS_INIT_SCRIPT)
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
    const timings: number[] = []
    for (let i = 1; i <= 5; i++) {
      const timing = await timeScrollPage(page)
      timings.push(timing.totalMs)
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

  test("E-3: the scroll timing, split into the server leg and the render leg", async () => {
    const samples: Array<{ totalMs: number; serverMs: number; renderMs: number; added: number }> = []
    for (let i = 0; i < 5; i++) {
      const timing = await timeScrollPage(page)
      samples.push({ totalMs: timing.totalMs, serverMs: timing.serverMs, renderMs: timing.renderMs, added: timing.added })
      await Bun.sleep(400)
    }
    const totals = samples.map((s) => s.totalMs)
    const servers = samples.map((s) => s.serverMs)
    const renders = samples.map((s) => s.renderMs)
    results["E3_scroll_timing"] = {
      totalMs: { median: median(totals), mean: Number(mean(totals).toFixed(1)) },
      serverMs: { median: median(servers), mean: Number(mean(servers).toFixed(1)) },
      renderMs: { median: median(renders), mean: Number(mean(renders).toFixed(1)) },
      samples: samples.length,
      entriesPerPage: samples[0]?.added,
      measurement: m(median(totals), WORKING_SET, COLD_HOT, "5 scroll-to-top samples, median and mean", CONTROL),
    }
    expect(samples.length).toBe(5)
    expect(samples[0]?.added).toBe(50)
  }, 120_000)

  // ------------------------------------------------------------------- E-4 (US-6) — after arm

  test("E-4 (after): the parse counts during a streaming turn", async () => {
    // A fresh bot in a fresh conversation, so the turn has a clean body set.
    const streamBot = await rpc.call((c) =>
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
  }, 180_000)

  test("the results file is written", () => {
    writeFileSync(resultsPath, JSON.stringify(results, null, 2))
    expect(Object.keys(results).length).toBeGreaterThan(0)
  })
})

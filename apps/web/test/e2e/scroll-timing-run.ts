// The corrected D-C: the scroll timing split into its real parts.
//
// THIS IS THE SECOND MEASUREMENT OF THE SAME THING, and it exists because the first one
// (`diagnostics.ts`'s `timeScrollPage`) produced a "render leg" of ~503 ms in EVERY environment —
// a 350-row DOM and a 1900-row DOM, dev and prod, all within 500..517 ms. A real React commit does
// not cost the same on 350 rows and on 1900 rows, so that number was measuring the harness's own
// 400 ms settle-wait, not React.
//
// This runner measures the parts directly (see `scroll-timing.ts` for the wire format and the
// marks) and — the point of running it twice — in TWO STATES with very different DOM sizes:
//
//   the shallow state: ~350 rows on screen (the first screen plus 5 pages)
//   the deep state:   ~1900 rows on screen (after scrolling up 30 pages)
//
// If the commit cost really scales with the DOM, the deep state's `commitMs` must be much larger
// than the shallow state's. If they come out the same, the cost is NOT in the commit at all.
//
// USAGE:  bun run test/e2e/scroll-timing-run.ts [dev|prod]
// OUTPUT: /root/ai/devteam/dev_b/scroll-timing-results.json

import type { Browser } from "playwright-core"
import { launchBrowser } from "./brain.ts"
import { startSeededBrain } from "./fixture-brain.ts"
import { SCROLL_TIMING_SCRIPT, timeScrollPageSplit } from "./scroll-timing.ts"

const WORKING_SET =
  "the fixture conversation: 2000 bot messages, ~612 chars each, 12.5% with rich text (table/code/list/image). The first screen is the 100 newest (the client never asks for more)."
const COLD_HOT =
  "cold: a fresh brain and a fresh browser context; the transcript is measured after the first paint, with no prior scroll"
const SAMPLING =
  "5 scroll-to-top samples per state, reported as the median and the mean; the DOM counts are deterministic"
const CONTROL =
  "same machine, same fixture, same conversation; the only difference between the two states is how many pages were already loaded"

const medianOf = (values: number[]): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}
const meanOf = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length
const stat = (values: number[]) => ({
  median: Number(medianOf(values).toFixed(1)),
  mean: Number(meanOf(values).toFixed(1)),
  min: Number(Math.min(...values).toFixed(1)),
  max: Number(Math.max(...values).toFixed(1)),
})

const run = async (browser: Browser) => {
  const seeded = await startSeededBrain({
    args: process.argv[2] === "prod" ? [] : ["--dev"],
    cwd: process.argv[2] === "prod" ? undefined : "/root/ai/openbot",
  })
  const brain = seeded.brain
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(SCROLL_TIMING_SCRIPT)
    const page = await context.newPage()
    page.setDefaultTimeout(60_000)
    await page.goto(brain.loginUrl)
    await page.goto(`${brain.base}/#/c/${seeded.conversationId}`)
    await page.getByTestId("transcript").waitFor()
    await Bun.sleep(2000)

    const states: Array<{ name: string; pages: number }> = [
      { name: "shallow (the first screen + 5 pages)", pages: 5 },
      // 20 pages, NOT 30: the fixture has 2000 entries and the first screen is 100, so 40 pages
      // exhaust it. A state at the very top of the conversation has NOTHING older to load, so the
      // scroll is a no-op — no request goes out, and the state measures nothing.
      { name: "deep (after scrolling up 20 pages)", pages: 20 },
    ]
    const out: Record<string, unknown> = {}

    for (const state of states) {
      // Load the pages, so the DOM is at the size this state is about.
      for (let i = 0; i < state.pages; i++) {
        await timeScrollPageSplit(page)
        await Bun.sleep(300)
      }
      const rows = await page.evaluate(() => document.querySelectorAll("[data-entry]").length)
      const samples: Array<Awaited<ReturnType<typeof timeScrollPageSplit>>> = []
      for (let i = 0; i < 5; i++) {
        const timing = await timeScrollPageSplit(page)
        if (timing !== undefined) samples.push(timing)
        await Bun.sleep(400)
      }
      // A state with NOTHING older to load produces no request and no sample. That is a fact
      // about the state, not a measurement — it is reported as such instead of as zeros.
      if (samples.length === 0) {
        out[state.name] = {
          rows,
          samples: 0,
          note: "nothing older left to load — this state cannot be measured",
          labels: {
            workingSet: WORKING_SET,
            coldHot: COLD_HOT,
            sampling: SAMPLING,
            control: CONTROL,
          },
        }
        continue
      }
      out[state.name] = {
        rows,
        samples: samples.length,
        appLatencyMs: stat(samples.map((s) => s!.appLatencyMs)),
        rpcMs: stat(samples.map((s) => s!.rpcMs)),
        commitMs: stat(samples.map((s) => s!.commitMs)),
        settleMs: stat(samples.map((s) => s!.settleMs)),
        userPerceivedMs: stat(samples.map((s) => s!.userPerceivedMs)),
        labels: {
          workingSet: WORKING_SET,
          coldHot: COLD_HOT,
          sampling: SAMPLING,
          control: CONTROL,
        },
      }
    }
    await context.close()
    return out
  } finally {
    await brain.stop()
  }
}

if (import.meta.main) {
  const browser = await launchBrowser()
  try {
    const results = await run(browser)
    const out = { build: process.argv[2] === "prod" ? "production" : "dev", states: results }
    await Bun.write("/root/ai/devteam/dev_b/scroll-timing-results.json", JSON.stringify(out, null, 2))
    console.log(JSON.stringify(out, null, 2))
  } finally {
    await browser.close()
  }
}

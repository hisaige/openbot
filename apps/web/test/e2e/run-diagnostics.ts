// The three diagnostics, as a standalone runner (architecture §5.3, D-A / D-B / D-C).
//
// WHY A SEPARATE RUNNER: the diagnostic numbers go into the handoff, and they have to be
// MEASURED, not retyped. This runner writes them to a JSON file with the four labels
// (architecture §8.2) attached.
//
// THE DEV BUILD: D-B's attribution needs real function names. The production bundle is minified
// (`apps/server/src/web.ts`: `minify: !options.dev`), so the brain runs with `--dev`. But `--dev`
// plus a cwd whose `bunfig.toml` loads `bun-plugin-tailwind` switches the brain into the Bun dev
// server (HMR) instead of the bundle — and the dev server serves the app unminified but without
// `Bun.build`, so there is no bundle URL to name. The bundle mode with `minify: false` is the one
// that satisfies both: a real bundle AND readable names. That needs a cwd WITHOUT a Tailwind
// bunfig — `/tmp` works (architecture §5.2, constraint 2).

import type { Browser, BrowserContext, Page } from "playwright-core"
import { connectRpc, launchBrowser, type Rpc } from "./brain.ts"
import { diffMetrics, measureDom, readPerformanceMetrics, traceReflow } from "./diagnostics.ts"
import { startSeededBrain, type SeededBrain } from "./fixture-brain.ts"
import { SCROLL_TIMING_SCRIPT, timeScrollPageSplit } from "./scroll-timing.ts"

export interface DiagnosticRun {
  readonly D_A_dom: ReadonlyArray<Record<string, unknown>>
  readonly D_B_reflow: Record<string, unknown>
  readonly D_C_timing: Record<string, unknown>
  readonly fixture: Record<string, unknown>
}

/** The four labels every number carries (architecture §8.2). */
const LABELS = {
  workingSet:
    "the fixture conversation: 2000 bot messages, ~612 chars each, 12.5% with rich text (table / code block / list / image). The first screen is the 100 newest — the client asks for a fixed tail (`SNAPSHOT_TAIL_ENTRIES = 100`) and never for more.",
  coldHot:
    "cold: a fresh brain and a fresh browser context; the transcript is measured after the first paint, with no prior scroll. The scroll timings are the SECOND state (after the pages have been loaded once), so the first paint's cost is not folded in.",
  sampling:
    "the DOM counts are deterministic (one count per measurement point, and the count is exact); the scroll timings are 5 samples per measurement, reported as median and mean",
  control:
    "same machine, same fixture, same conversation state; the only difference between the arms is the one under test (there is no separate control arm for D-A/D-B/D-C — they are baseline measurements of the CURRENT code, which is itself the 'before' for US-6 / US-7)",
} as const

/**
 * Runs the three diagnostics against the fixture conversation.
 *
 * `dev` runs the brain in dev mode (unminified bundle) so D-B can attribute the forced reflows to
 * real function names.
 */
export const runDiagnostics = async (options?: { readonly dev?: boolean; readonly pages?: number }): Promise<DiagnosticRun> => {
  const dev = options?.dev ?? true
  const pages = options?.pages ?? 5
  const browser: Browser = await launchBrowser()
  let seeded: SeededBrain | undefined
  let rpc: Rpc | undefined
  let context: BrowserContext | undefined
  let page: Page | undefined
  try {
    // The dev brain runs from the REPO ROOT: that is the only cwd where the workspace packages
    // resolve (a `/tmp` cwd fails to bundle: "Bundle failed"). From the repo root `--dev` picks
    // the Bun dev server (HMR) — the app is served unminified, so the function names in the
    // forced-reflow attribution are real.
    seeded = await startSeededBrain({
      count: 2000,
      botName: "Fixture",
      ...(dev ? { args: ["--dev"], cwd: "/root/ai/openbot" } : {}),
    })
    rpc = await connectRpc(seeded.brain as never)
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })
    // The scroll-timing probe has to be in the page BEFORE the app loads: it wraps `WebSocket` to
    // see the history RPC's request and response frames.
    await context.addInitScript(SCROLL_TIMING_SCRIPT)
    page = await context.newPage()
    const view = page
    page.setDefaultTimeout(30_000)
    const errors: string[] = []
    view.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
    view.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console: ${msg.text()}`)
    })
    await view.goto(seeded.brain.loginUrl)
    await view.goto(`${seeded.brain.base}/#/c/${seeded.conversationId}`)
    await view.getByTestId("transcript").waitFor()
    await Bun.sleep(2000)

    // ---------------------------------------------------------------- D-A: the DOM node counts
    const dom: Array<Record<string, unknown>> = []
    const first = await measureDom(page, "first screen (100 entries)", 0)
    dom.push({ ...first, state: "first screen (100 entries)", labels: LABELS })
    for (let i = 1; i <= pages; i++) {
      await timeScrollPageSplit(page)
      await Bun.sleep(400)
      const m = await measureDom(page, `after ${i} page(s)`, i)
      dom.push({ ...m, state: `after ${i} page(s)`, labels: LABELS })
    }
    // ---------------------------------------------------------------- D-B: the forced reflows
    const cdp = await context.newCDPSession(view)
    await cdp.send("Performance.enable")
    const before = await readPerformanceMetrics(cdp)
    const attribution = await traceReflow(view, cdp, async () => {
      await view.evaluate(() => {
        const el = document.querySelector('[data-testid="transcript"]')
        if (el !== null) {
          el.scrollTop = 0
          el.dispatchEvent(new Event("scroll", { bubbles: true }))
        }
      })
      await Bun.sleep(1000)
    })
    const after = await readPerformanceMetrics(cdp)
    const diff = diffMetrics(before, after)
    await cdp.detach()

    // ---------------------------------------------------------------- D-C: the scroll timing
    //
    // The parts are measured DIRECTLY (`scroll-timing.ts`), not by subtraction: the withdrawn
    // algorithm computed `renderMs = totalMs - serverMs`, which put the harness's own settle-wait
    // into the "render" leg and reported the same ~503 ms in every environment.
    const samples: Array<{
      appLatencyMs: number
      rpcMs: number
      commitMs: number
      settleMs: number
      userPerceivedMs: number
      added: number
    }> = []
    for (let i = 0; i < 5; i++) {
      const timing = await timeScrollPageSplit(page)
      if (timing !== undefined) {
        samples.push({
          appLatencyMs: timing.appLatencyMs,
          rpcMs: timing.rpcMs,
          commitMs: timing.commitMs,
          settleMs: timing.settleMs,
          userPerceivedMs: timing.userPerceivedMs,
          added: timing.added,
        })
      }
      await Bun.sleep(400)
    }
    const stat = (values: number[]) => ({
      median: Number(medianOf(values).toFixed(1)),
      mean: Number((values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)).toFixed(1)),
      min: Math.min(...values),
      max: Math.max(...values),
    })

    // As far up as the fixture goes: 2000 entries = 40 pages.
    const allPages: Array<Record<string, unknown>> = []
    for (let i = pages + 1; i <= 40; i++) {
      const timing = await timeScrollPageSplit(page)
      if (timing === undefined || timing.added === 0) break
      await Bun.sleep(300)
      if (i % 5 === 0) {
        const m = await measureDom(page, `after ${i} page(s)`, i)
        allPages.push({ ...m, state: `after ${i} page(s)`, labels: LABELS })
      }
    }
    dom.push(...allPages)

    return {
      D_A_dom: dom,
      D_B_reflow: {
        ...attribution,
        layoutCount: diff.layoutCount,
        recalcStyleCount: diff.recalcStyleCount,
        layoutDurationMs: diff.layoutDurationMs,
        scriptDurationMs: diff.scriptDurationMs,
        taskDurationMs: diff.taskDurationMs,
        build: dev ? "dev (unminified bundle) — the function names are readable" : "production (minified) — the names are mangled, so the attribution is NOT usable",
        labels: LABELS,
        pageErrors: errors,
      },
      D_C_timing: {
        samples: samples.length,
        appLatencyMs: stat(samples.map((s) => s.appLatencyMs)),
        rpcMs: stat(samples.map((s) => s.rpcMs)),
        commitMs: stat(samples.map((s) => s.commitMs)),
        settleMs: stat(samples.map((s) => s.settleMs)),
        userPerceivedMs: stat(samples.map((s) => s.userPerceivedMs)),
        entriesPerPage: samples[0]?.added,
        labels: LABELS,
      },
      fixture: { ...seeded.stats, labels: LABELS },
    }
  } finally {
    await context?.close()
    await rpc?.close()
    await browser.close()
    await seeded?.brain.dispose()
  }
}

const medianOf = (values: number[]): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

// ----------------------------------------------------------------------------------- the runner

if (import.meta.main) {
  const run = await runDiagnostics({ dev: process.argv[2] !== "prod" })
  console.log(JSON.stringify(run, null, 2))
}

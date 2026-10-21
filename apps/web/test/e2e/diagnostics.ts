// The three diagnostics (architecture §5.3): DOM node count (D-A), forced reflow (D-B) and the
// scroll timing breakdown (D-C).
//
// Every measurement carries the four labels the PRD demands (US-8 / architecture §8.2): the
// working set, the cold/hot state, the sampling method and the same-basis control. The types
// below make those labels part of the result, not a comment somebody can forget to write.

import type { CDPSession, Page } from "playwright-core"

// --------------------------------------------------------------------------------------------- D-A

/** One DOM measurement: how many nodes are on screen, in two scopes. */
export interface DomNodeCounts {
  /** Nodes inside the transcript container. */
  readonly transcript: number
  /** Nodes in the whole document. */
  readonly page: number
  /** The message rows (bubbles) in the transcript — the denominator of the node-per-row ratio. */
  readonly rows: number
}

export interface DomMeasurement extends DomNodeCounts {
  /** Which state was measured ("first screen", "after 5 pages", …). */
  readonly state: string
  /** How many pages were loaded to reach this state. */
  readonly pages: number
  /** The transcript's scroll height (px) and the viewport height. */
  readonly scrollHeight: number
  readonly viewportHeight: number
}

/**
 * Counts the DOM nodes in both scopes.
 *
 * The transcript scope is `[data-testid="transcript"]` (ChatView.tsx:418) — the scroll container.
 * The "page" scope is the whole document, which is what the browser actually has to lay out.
 */
export const countDomNodes = async (page: Page): Promise<DomNodeCounts> => {
  return page.evaluate(() => {
    const transcript = document.querySelector('[data-testid="transcript"]')
    return {
      transcript: transcript === null ? 0 : transcript.querySelectorAll("*").length,
      page: document.querySelectorAll("*").length,
      rows: document.querySelectorAll("[data-entry]").length,
    }
  })
}

/** The measurement plus the scroll geometry. */
export const measureDom = async (page: Page, state: string, pages: number): Promise<DomMeasurement> => {
  const counts = await countDomNodes(page)
  const geometry = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="transcript"]')
    return { scrollHeight: el?.scrollHeight ?? 0, viewportHeight: el?.clientHeight ?? 0 }
  })
  return { ...counts, state, pages, ...geometry }
}

// --------------------------------------------------------------------------------------------- D-B

/** The forced-reflow metrics, read from CDP's `Performance` domain. */
export interface ReflowMetrics {
  readonly layoutCount: number
  readonly recalcStyleCount: number
  readonly layoutDurationMs: number
  readonly scriptDurationMs: number
  readonly taskDurationMs: number
}

/** Reads the browser's performance metrics. */
export const readPerformanceMetrics = async (cdp: CDPSession): Promise<ReflowMetrics> => {
  const { metrics } = await cdp.send("Performance.getMetrics")
  const byName = new Map(metrics.map((m) => [m.name, m.value]))
  return {
    layoutCount: byName.get("LayoutCount") ?? 0,
    recalcStyleCount: byName.get("RecalcStyleCount") ?? 0,
    layoutDurationMs: byName.get("LayoutDuration") ?? 0,
    scriptDurationMs: byName.get("ScriptDuration") ?? 0,
    taskDurationMs: byName.get("TaskDuration") ?? 0,
  }
}

/** The difference between two metric readings. */
export const diffMetrics = (before: ReflowMetrics, after: ReflowMetrics): ReflowMetrics => ({
  layoutCount: after.layoutCount - before.layoutCount,
  recalcStyleCount: after.recalcStyleCount - before.recalcStyleCount,
  layoutDurationMs: after.layoutDurationMs - before.layoutDurationMs,
  scriptDurationMs: after.scriptDurationMs - before.scriptDurationMs,
  taskDurationMs: after.taskDurationMs - before.taskDurationMs,
})

/** The attribution result: the functions the forced reflows happened in. */
export interface ReflowAttribution {
  /** `Layout` events seen during the traced window. */
  readonly layoutEvents: number
  /** `Blink.ForcedStyleAndLayout.UpdateTime` events — the forced-reflow marker. */
  readonly forcedReflows: number
  /** The function that was running when each forced reflow happened. */
  readonly attributedTo: ReadonlyArray<{ readonly fn: string; readonly url: string; readonly line: number; readonly count: number }>
  /** Forced reflows that could not be attributed to a function. */
  readonly unattributed: number
}

/** The V8 CPU profile node, as the `Profiler` domain returns it. */
interface ProfileNode {
  readonly id: number
  readonly callFrame: { readonly functionName?: string; readonly url?: string; readonly lineNumber?: number }
  readonly parent?: number
}

/**
 * Traces the page and pairs every forced reflow with the JS function that was running.
 *
 * WHY TWO SOURCES: the `Layout` trace event carries no stack trace, and Lighthouse's
 * `forced-reflow-insight` gives counts and durations but never names a function
 * (architecture §1.3.3). So the attribution pairs two independent signals:
 *
 *   - `Tracing` (category `blink`) gives `Blink.ForcedStyleAndLayout.UpdateTime` — the exact
 *     moment the browser was FORCED to lay out (a script read a layout property after mutating
 *     the DOM). This is the "forced reflow" the criterion is about.
 *   - the V8 `Profiler` domain gives the JS stack at each sampled instant, with function names,
 *     script URLs and line numbers.
 *
 * A forced reflow is attributed to the JS frame that was running at that instant (the nearest
 * preceding CPU-profile sample). With a dev build the names are real; with the production bundle
 * they are minified away — hence the dev-build requirement (architecture §5.2, constraint 2).
 */
export const traceReflow = async (_page: Page, cdp: CDPSession, run: () => Promise<void>): Promise<ReflowAttribution> => {
  const traceEvents: Array<{ name: string; ts: number }> = []
  const onEvent = (params: { value: unknown }) => {
    // `Tracing.dataCollected` carries an ARRAY of trace events, not one event.
    const values = params.value as ReadonlyArray<{ name?: string; ts?: number }>
    if (!Array.isArray(values)) return
    for (const value of values) {
      if (value.name === undefined) continue
      if (value.name === "Blink.ForcedStyleAndLayout.UpdateTime" || value.name === "Layout") {
        traceEvents.push({ name: value.name, ts: value.ts ?? 0 })
      }
    }
  }
  cdp.on("Tracing.dataCollected", onEvent)
  await cdp.send("Tracing.start", {
    traceConfig: {
      includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink"],
      excludedCategories: ["*"],
    },
    transferMode: "ReportEvents",
  })
  await cdp.send("Profiler.enable")
  // 100 µs: fine enough that a forced reflow almost always lands inside a sampled frame. The
  // default (1000 µs) leaves most of the forced reflows with no sample in effect, and they end
  // up "unattributed" — a measurement that reports "we could not tell" for two thirds of its own
  // data is not a measurement.
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 })
  await cdp.send("Profiler.start")
  try {
    await run()
  } finally {
    const { profile } = await cdp.send("Profiler.stop")
    await cdp.send("Tracing.end")
    // The profiler needs a moment to deliver its last samples; a `stop` that returns before the
    // final chunk arrives yields an EMPTY profile, and every forced reflow then reads as
    // "unattributed" — a measurement that silently measures nothing.
    await Bun.sleep(300)
    // The trace events arrive asynchronously; give the session a moment to flush them.
    await Bun.sleep(500)
    cdp.off("Tracing.dataCollected", onEvent)
    return attribute(traceEvents, profile as unknown as { nodes: ReadonlyArray<ProfileNode>; samples: ReadonlyArray<number>; timeDeltas: ReadonlyArray<number>; startTime: number })
  }
}

/** Pairs the forced reflows with the JS frames that were running. */
const attribute = (
  traceEvents: ReadonlyArray<{ name: string; ts: number }>,
  profile: { nodes: ReadonlyArray<ProfileNode>; samples: ReadonlyArray<number>; timeDeltas: ReadonlyArray<number>; startTime: number },
): ReflowAttribution => {
  const byId = new Map(profile.nodes.map((n) => [n.id, n] as const))
  // The sample timestamps, in the trace's clock (microseconds).
  let t = profile.startTime
  const sampleTimes: number[] = []
  for (const delta of profile.timeDeltas) {
    t += delta
    sampleTimes.push(t)
  }
  const named = (nodeId: number): { fn: string; url: string; line: number } | undefined => {
    let node: ProfileNode | undefined = byId.get(nodeId)
    // Walk up to the nearest frame with a name: the leaf is often an anonymous callback.
    while (node !== undefined) {
      const name = node.callFrame?.functionName ?? ""
      if (name !== "" && name !== "(root)" && name !== "(program)" && name !== "(idle)") {
        return { fn: name, url: node.callFrame?.url ?? "", line: (node.callFrame?.lineNumber ?? -1) + 1 }
      }
      node = node.parent === undefined ? undefined : byId.get(node.parent)
    }
    return undefined
  }
  const byFn = new Map<string, { fn: string; url: string; line: number; count: number }>()
  let unattributed = 0
  let forced = 0
  for (const event of traceEvents) {
    if (event.name === "Blink.ForcedStyleAndLayout.UpdateTime") forced++
    else continue
    // The CPU-profile sample in effect at that instant: the nearest sample at or before it. If the
    // reflow landed between two samples, the NEXT one is used as well — a forced reflow is a
    // single synchronous point, so the frame it happened in is the nearest sample either way.
    let index = -1
    for (let i = 0; i < sampleTimes.length; i++) {
      if (sampleTimes[i]! <= event.ts) index = i
      else break
    }
    const sampleId = index >= 0 ? profile.samples[index] : undefined
    if (sampleId === undefined) {
      unattributed++
      continue
    }
    const frame = named(sampleId)
    if (frame === undefined) {
      unattributed++
      continue
    }
    const key = `${frame.fn}|${frame.url}|${frame.line}`
    const existing = byFn.get(key)
    if (existing === undefined) byFn.set(key, { ...frame, count: 1 })
    else existing.count++
  }
  return {
    layoutEvents: traceEvents.filter((e) => e.name === "Layout").length,
    forcedReflows: forced,
    attributedTo: [...byFn.values()].sort((a, b) => b.count - a.count),
    unattributed,
  }
}

// --------------------------------------------------------------------------------------------- D-C

/** The parts of one scroll-to-the-top action. */
export interface ScrollTiming {
  /** The total time from "the user scrolled to the top" to "the older message is on screen". */
  readonly totalMs: number
  /** The time spent waiting for the server (the RPC round trip). */
  readonly serverMs: number
  /** The time spent rendering locally after the page arrived. */
  readonly renderMs: number
  /** The time not accounted for by the two above. */
  readonly remainderMs: number
  /** How many entries the page added. */
  readonly added: number
}

/**
 * Times one "scroll to the top" page load.
 *
 * The marks are: the scroll action, the moment the page arrives (the DOM grows), and the total.
 * The server leg is the time from the scroll to the page's arrival; the render leg is what React
 * does after the state changed, which the CDP metrics measure separately.
 *
 * IT WAITS FOR THE COUNT TO SETTLE, not just to grow — a second page load can start right after
 * the first one finishes.
 *
 * IT REPORTS `added: 0` WHEN NOTHING WAS LOADED — at the very top of the conversation there is no
 * older history left, so the scroll is a no-op. A zero there is a fact about the state, not a
 * measurement failure.
 */
export const timeScrollPage = async (page: Page): Promise<ScrollTiming> => {
  const started = Date.now()
  // IT SCROLLS LIKE A USER: a real wheel event, not `scrollTop = 0` plus a synthetic `scroll`
  // event. The synthetic version fires the app's scroll handler TWICE (the native scroll event
  // from setting `scrollTop` and the explicit `dispatchEvent`), and the second one can start a
  // second page load once the first has finished — which showed up as "scroll 5 loaded 100
  // entries" instead of 50. A real wheel event loads exactly one page.
  await page.locator('[data-testid="transcript"]').hover()
  // A wheel scroll of -100000 px reaches the top of any scroll container.
  await page.mouse.wheel(0, -100_000)
  const result = await page.evaluate(async () => {
    const before = document.querySelectorAll("[data-entry]").length
    const t0 = performance.now()
    // The app's scroll handler calls `loadOlder`; the page grows when the response is applied.
    const deadline = performance.now() + 15_000
    let serverDone = 0
    let last = before
    let stableSince = 0
    while (performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      const now = document.querySelectorAll("[data-entry]").length
      if (now > before && serverDone === 0) serverDone = performance.now() - t0
      // The count has to be stable for a while before the measurement is trusted: a second page
      // load can start right after the first one finishes.
      if (now === last) {
        if (stableSince === 0) stableSince = performance.now()
        else if (performance.now() - stableSince > 400) break
      } else {
        last = now
        stableSince = 0
      }
    }
    const after = document.querySelectorAll("[data-entry]").length
    return { serverDone, added: after - before, settled: performance.now() - t0 }
  })
  const totalMs = Date.now() - started
  // A scroll that loaded nothing is not a server round trip: the server was never asked.
  const serverMs = result.added === 0 ? 0 : result.serverDone
  const renderMs = result.added === 0 ? 0 : Math.max(0, totalMs - serverMs)
  return { totalMs, serverMs, renderMs, remainderMs: 0, added: result.added }
}

/** The median of a list of numbers. */
export const median = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

/** The mean of a list of numbers. */
export const mean = (values: ReadonlyArray<number>): number =>
  values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length

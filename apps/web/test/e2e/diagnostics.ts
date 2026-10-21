// The three diagnostics (architecture §5.3): DOM node count (D-A) and forced reflow (D-B).
//
// D-C (the scroll timing) IS NOT HERE — it was withdrawn and replaced by `scroll-timing.ts`. See
// the D-C section at the bottom of this file for why.
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
  readonly attributedTo: ReadonlyArray<{
    readonly fn: string
    readonly url: string
    readonly line: number
    readonly count: number
    /** The whole JS stack at that instant, innermost first. */
    readonly chain: ReadonlyArray<string>
  }>
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
  /**
   * The whole stack of the frame, innermost first.
   *
   * The leaf is usually a framework internal (React's `recursivelyTraverseLayoutEffects`, a
   * `dispatchEvent`), which names the MECHANISM but not the app code that caused it. The app's own
   * frame is further up — so the whole chain is reported, and the caller can see which app
   * function is in it.
   */
  const chainOf = (nodeId: number): ReadonlyArray<{ fn: string; url: string; line: number }> => {
    const out: Array<{ fn: string; url: string; line: number }> = []
    let node: ProfileNode | undefined = byId.get(nodeId)
    while (node !== undefined) {
      const name = node.callFrame?.functionName ?? ""
      if (name !== "" && name !== "(root)" && name !== "(program)" && name !== "(idle)") {
        out.push({ fn: name, url: node.callFrame?.url ?? "", line: (node.callFrame?.lineNumber ?? -1) + 1 })
      }
      node = node.parent === undefined ? undefined : byId.get(node.parent)
    }
    return out
  }
  const byFn = new Map<string, { fn: string; url: string; line: number; count: number; chain: ReadonlyArray<string> }>()
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
    const chain = chainOf(sampleId)
    const frame = chain[0]
    if (frame === undefined) {
      unattributed++
      continue
    }
    const key = `${frame.fn}|${frame.url}|${frame.line}`
    const existing = byFn.get(key)
    if (existing === undefined) byFn.set(key, { ...frame, count: 1, chain: chain.map((c) => c.fn) })
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
//
// THE D-C MEASUREMENT IS NOT HERE. It used to be: `timeScrollPage` split the scroll into "server"
// and "render" by SUBTRACTION (`renderMs = totalMs - serverMs`, where `serverMs` was the moment
// the entry count first grew). That algorithm was WITHDRAWN (handoff §7 D-3) because the
// subtraction put the harness's own 400 ms settle-wait into the "render" leg — it reported
// ~503 ms in EVERY environment, on a 350-row DOM and on a 1900-row DOM alike, and a real React
// commit does not cost the same on both.
//
// The replacement is `scroll-timing.ts`'s `timeScrollPageSplit`, which marks each step DIRECTLY
// (request frame out → response frame in → DOM grows) and reports the settle wait separately.
//
// It is kept out of this file rather than merely deprecated so that no caller can reach for it by
// accident: a withdrawn algorithm that is still exported is one more thing to notice.

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

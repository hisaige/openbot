// The scroll timing, split into its REAL parts (the corrected D-C).
//
// WHY THIS FILE EXISTS: the first version of the measurement (`diagnostics.ts`'s `timeScrollPage`)
// split the scroll into "server" and "render" by SUBTRACTION: `renderMs = totalMs - serverMs`,
// where `serverMs` was the moment the entry count first grew. That produced a "render leg" of
// ~503 ms in EVERY environment — a 350-row DOM and a 1900-row DOM, dev and prod, all within
// 500..517 ms. A real React commit does not cost the same on 350 rows and on 1900 rows, so the
// number was not measuring React. It was measuring this file's own settle-wait: the loop waits
// 400 ms for the count to stabilise before it breaks, and that padding landed entirely in the
// "render" bucket.
//
// SO THIS FILE MEASURES THE PARTS DIRECTLY, with no subtraction and no padding in the numbers:
//
//   t_wheel  the user's wheel event
//   t_req    the `conversations.history` request frame going out on the wire
//   t_resp   the matching response frame coming back
//   t_dom    the entry count growing in the DOM (React's commit)
//
// and then:
//
//   appLatencyMs = t_req  - t_wheel   the app's own delay before it asks the server
//   rpcMs        = t_resp - t_req     the real round trip
//   commitMs     = t_dom  - t_resp    React's commit, after the page arrived
//   settleMs     = t_end   - t_dom     the harness's own wait for the count to stabilise
//
// The settle leg is REPORTED but kept OUT of the two criterion legs: it is the instrument's
// padding, not the application's cost.
//
// THE WIRE FORMAT (effect's RPC over a WebSocket, `RpcSerialization.layerJson`):
//
//   request:  { "_tag": "Request", id, tag, payload }
//   response: { "_tag": "Exit", requestId, exit: { "_tag": "Success", value } }
//
// so the response is matched to the request by `requestId` ↔ `id`. The tag of the history RPC is
// "conversations.history" (`packages/contracts/src/rpc.ts`).
//
// THE RESPONSE IS AN `Exit`, NOT A `Chunk`: `conversations.history` is a plain request/response
// RPC, not a stream. In effect's RPC the streamed responses are `Chunk` frames and the final one
// is an `Exit` (`node_modules/effect/dist/rpc/RpcMessage.js`: `Exit` carries `exit`, and
// `RpcClient`'s `write` resumes the effect with `message.exit` on `Exit._tag === "Success"`).
// The first version of this probe only looked for `Chunk` and therefore recorded ZERO samples —
// which is why it is written down here.

import type { Page } from "playwright-core"

/** The timeline of one scroll-to-the-top page load. */
export interface ScrollTimeline {
  /** The user's wheel event. */
  readonly wheelAt: number
  /** The `conversations.history` request frame going out. */
  readonly requestAt: number
  /** The matching response frame coming back. */
  readonly responseAt: number
  /** The entry count growing in the DOM. */
  readonly domAt: number
  /** The end of the measurement (after the settle wait). */
  readonly endAt: number
  /** How many entries the page added. */
  readonly added: number
  /** The app's own delay between the scroll and the request going out. */
  readonly appLatencyMs: number
  /** The real RPC round trip. */
  readonly rpcMs: number
  /** React's commit, after the page arrived. */
  readonly commitMs: number
  /** The harness's settle wait — the instrument's padding, not the app's cost. */
  readonly settleMs: number
  /** `t_dom - t_wheel`: what the user actually waits for, with no padding in it. */
  readonly userPerceivedMs: number
}

/**
 * The page-side script. It wraps `WebSocket` before the app loads, so it sees the frames as they
 * go over the wire.
 *
 * It records the request and the response of the history RPC, and watches the DOM for the growth.
 */
export const SCROLL_TIMING_SCRIPT = `
(() => {
  const pending = new Map();
  const marks = {
    wheelAt: null,
    requestAt: null,
    responseAt: null,
    domAt: null,
    endAt: null,
    added: 0,
  };
  const before = new WeakSet();
  let armed = false;
  const Original = globalThis.WebSocket;
  class Wrapped extends Original {
    constructor(url, protocols) {
      super(url, protocols);
      const self = this;
      self.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        // The history RPC is a plain request/response, so its reply is an "Exit" frame.
        // ("Chunk" is for the STREAMING rpcs.)
        if (frame._tag !== "Exit" && frame._tag !== "Chunk") return;
        const id = frame.requestId;
        const started = pending.get(id);
        if (started === undefined) return;
        pending.delete(id);
        if (armed && marks.responseAt === null) {
          marks.responseAt = performance.now();
          marks.requestAt = started;
        }
      });
      // The OUTGOING frame: the browser does not expose it, so the send is wrapped.
      const originalSend = self.send.bind(self);
      self.send = (data) => {
        if (typeof data === "string" && armed && marks.requestAt === null) {
          try {
            const frame = JSON.parse(data);
            if (frame._tag === "Request" && frame.tag === "conversations.history") {
              pending.set(frame.id, performance.now());
            }
          } catch { /* not a frame we care about */ }
        }
        return originalSend(data);
      };
    }
  }
  globalThis.WebSocket = Wrapped;
  window.__obScrollTiming = {
    arm() {
      armed = true;
      marks.wheelAt = performance.now();
      marks.requestAt = null;
      marks.responseAt = null;
      marks.domAt = null;
      marks.endAt = null;
      marks.added = 0;
    },
    noteDomGrowth() {
      if (armed && marks.domAt === null) marks.domAt = performance.now();
    },
    read() {
      return JSON.parse(JSON.stringify(marks));
    },
  };
})();
`

/**
 * Times one "scroll to the top" page load, with the parts measured directly.
 *
 * The DOM growth is caught by polling the entry count inside the page (the same way the app's own
 * list grows — the count is what the user sees), and the settle wait is kept out of the criterion
 * legs.
 */
export const timeScrollPageSplit = async (page: Page): Promise<ScrollTimeline | undefined> => {
  await page.locator('[data-testid="transcript"]').hover()
  // The wheel event IS the start mark; it is dispatched by the browser, so the page-side script
  // cannot see it — the test arms the mark right before.
  await page.evaluate(() => (window as any).__obScrollTiming.arm())
  await page.mouse.wheel(0, -100_000)
  const result = await page.evaluate(async () => {
    const handle = (window as any).__obScrollTiming
    const before = document.querySelectorAll("[data-entry]").length
    const deadline = performance.now() + 15_000
    let last = before
    let stableSince = 0
    while (performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      const now = document.querySelectorAll("[data-entry]").length
      if (now > before && handle.read().domAt === null) {
        handle.noteDomGrowth()
        last = now
        stableSince = 0
        continue
      }
      if (now === last) {
        if (stableSince === 0) stableSince = performance.now()
        else if (performance.now() - stableSince > 400) break
      } else {
        last = now
        stableSince = 0
      }
    }
    const after = document.querySelectorAll("[data-entry]").length
    return { added: after - before, endAt: performance.now() }
  })
  const marks = await page.evaluate(() => (window as any).__obScrollTiming.read())
  if (marks.requestAt === null || marks.responseAt === null || marks.domAt === null) return undefined
  const appLatencyMs = Math.round(marks.requestAt - marks.wheelAt)
  const rpcMs = Math.round(marks.responseAt - marks.requestAt)
  const commitMs = Math.round(marks.domAt - marks.responseAt)
  const settleMs = Math.round(result.endAt - marks.domAt)
  return {
    wheelAt: marks.wheelAt,
    requestAt: marks.requestAt,
    responseAt: marks.responseAt,
    domAt: marks.domAt,
    endAt: result.endAt,
    added: result.added,
    appLatencyMs,
    rpcMs,
    commitMs,
    settleMs,
    userPerceivedMs: Math.round(marks.domAt - marks.wheelAt),
  }
}

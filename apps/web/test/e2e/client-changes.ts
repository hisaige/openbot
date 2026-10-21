// The client-side change counter (PRD C-1, architecture §2.6): how many `entry.upserted` changes
// the CLIENT actually applied during a turn.
//
// WHY THE CLIENT SIDE: the criterion says "the number of changes the client applied". The server's
// published count is a different number — `LiveHubFake` and `LiveHubLive` behave differently, and
// the server publishes before the client applies. So the count is taken from the browser's own
// WebSocket frames, which is exactly what the client's reducer consumed.
//
// THE WIRE FORMAT: the RPC socket carries JSON frames (Effect RPC's `RpcSerialization.layerJson`):
//
//   { "_tag": "Chunk", "requestId": N, "values": [ <stream item>, … ] }
//
// A conversation stream item is `{ kind: "change", cursor, change }` and a change is
// `{ type: "entry.upserted", entry }` (among others). So the count is the number of
// `entry.upserted` items inside the `values` arrays of the frames of the conversation
// subscription.
//
// WHAT IS COUNTED (C-1): only `entry.upserted`. The other four change types
// (`entry.removed` / `turn.upserted` / `request.upserted` / `conversation.updated`) are NOT
// counted — and the denominator (the unmerged control) uses the same rule, so both sides of the
// ratio are the same measure.
//
// WHAT IS NOT COUNTED: the snapshot. A snapshot is not a change the client applied during the
// turn; it is the starting state. The turn's window starts after the snapshot.
//
// This module is a TEST-SIDE measurement helper: it is installed into the page before the app
// loads, and it only reads frames. It never changes what the app does.

export interface ClientChangeCounts {
  /** `entry.upserted` items the client received during the measured window. */
  readonly entryUpserted: number
  /** Of those, the ones whose entry had `streaming: true` (the intermediate states). */
  readonly streamingUpserted: number
  /** Of those, the ones whose entry had `streaming: false` (the terminal states). */
  readonly terminalUpserted: number
  /** The entry ids seen, in order (so a test can tell the bot's message from the owner's). */
  readonly entryIds: ReadonlyArray<string>
  /** The text of the last upsert per entry id — the terminal text, for the byte-for-byte check. */
  readonly lastTextByEntry: Readonly<Record<string, string>>
  /**
   * The page clock at the moment the counter was armed — the reference point for "how long until
   * the client saw the first intermediate state" (E-7).
   *
   * It is `performance.now()` in the PAGE, on the same clock as every item's `at`, so the two can
   * be subtracted. `Date.now()` (the harness's clock) cannot: it is a different time base.
   *
   * `null` before the first `arm()`.
   */
  readonly armedAt: number | null
}

export const emptyCounts = (): ClientChangeCounts => ({
  entryUpserted: 0,
  streamingUpserted: 0,
  terminalUpserted: 0,
  entryIds: [],
  lastTextByEntry: {},
  armedAt: null,
})

/**
 * The page-side script. It wraps `WebSocket` before the app boots, so it sees every frame the
 * client receives.
 *
 * It keeps a rolling log of the conversation stream's items, and the test reads it through
 * `window.__obClientChanges`.
 */
export const CLIENT_CHANGE_SCRIPT = `
(() => {
  const counts = {
    entryUpserted: 0,
    streamingUpserted: 0,
    terminalUpserted: 0,
    entryIds: [],
    lastTextByEntry: {},
    items: [],
    // The page clock at the moment the counter was armed (E-7's reference point).
    armedAt: null,
  };
  // The window the test measures: only items after this point count.
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
        if (frame._tag !== "Chunk" || !Array.isArray(frame.values)) return;
        for (const item of frame.values) {
          if (!item || item.kind !== "change") continue;
          const change = item.change;
          if (!change || change.type !== "entry.upserted") continue;
          const entry = change.entry;
          if (!entry) continue;
          const item_ = {
            entryId: entry.id,
            streaming: entry.streaming === true,
            text: typeof entry.text === "string" ? entry.text : "",
            conversationId: entry.conversationId,
            role: entry.role,
            kind: entry.kind,
            at: performance.now(),
          };
          counts.items.push(item_);
          if (!armed) continue;
          counts.entryUpserted++;
          if (item_.streaming) counts.streamingUpserted++;
          else counts.terminalUpserted++;
          counts.entryIds.push(entry.id);
          counts.lastTextByEntry[entry.id] = item_.text;
        }
      });
    }
  }
  globalThis.WebSocket = Wrapped;
  window.__obClientChanges = {
    // The arm mark is on the PAGE's clock (performance.now), the same clock every item's "at"
    // uses — so "how long until the client saw the first intermediate state" is a subtraction of
    // two numbers on the same clock. The harness's Date.now() is a different time base and cannot
    // be subtracted from an item's "at".
    arm() { armed = true; counts.armedAt = performance.now(); },
    disarm() { armed = false; },
    read() { return JSON.parse(JSON.stringify(counts)); },
    reset() {
      counts.entryUpserted = 0;
      counts.streamingUpserted = 0;
      counts.terminalUpserted = 0;
      counts.entryIds = [];
      counts.lastTextByEntry = {};
      counts.items = [];
      // The arm mark is reset too: a reset means "start measuring from here", so the reference
      // point has to move with it. Otherwise the next measurement would be relative to a stale
      // arm and would read as a huge delay.
      counts.armedAt = null;
    },
  };
})();
`

/** The shape the page exposes (mirrors {@link CLIENT_CHANGE_SCRIPT}). */
export interface ClientChangeHandle {
  readonly arm: () => void
  readonly disarm: () => void
  readonly read: () => ClientChangeCounts & { readonly items: ReadonlyArray<{ entryId: string; streaming: boolean; text: string; conversationId: string; role?: string; kind?: string; at: number }> }
  readonly reset: () => void
}
/**
 * The script that turns the parse counter ON before the app loads.
 *
 * It has to run BEFORE the app's first render: the counter attributes a re-parse to "the same text
 * as last time", and the per-body memory is filled by the first render. Enabling it later would
 * make every body look like a first parse, and the baseline measurement (`unchangedBodies` ≈ K-1)
 * would come out as 0 — a false pass.
 *
 * It is a `sessionStorage` key rather than a URL parameter because the app rewrites the hash on
 * every route change (`uiState.ts`'s `select` replaces it with `#/c/<id>`), dropping a query
 * parameter that was put after the hash.
 */
export const PARSE_STATS_INIT_SCRIPT = `sessionStorage.setItem("obParseStats", "1")`


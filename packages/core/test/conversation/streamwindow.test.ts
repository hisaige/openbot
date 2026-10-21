/**
 * The LiveHub publish window (architecture §2.3, product spec v2 §2.8 C-1~C-6).
 *
 * These tests drive the real `LiveHubLive` layer over the in-memory ports — the window is a
 * publishing strategy of `LiveHubLive`, so `LiveHubFake` (which deliberately does NOT implement
 * it, architecture §2.2.4) cannot be used here.
 *
 * Two things this file takes care to get right:
 *
 * - **The stall path needs the clock moved.** `runTest` installs a `TestClock`, so `Effect.sleep`
 *   never reaches its deadline on its own; a stall test that does not call `TestClock.adjust`
 *   **hangs** instead of failing. Every stall test moves the clock.
 * - **The "must fail" input.** A suite where every assertion passes no matter which branch runs
 *   proves nothing (review methodology 2). The terminal-upsert tests assert both branches of the
 *   C-2 predicate ("was this entry flushed before?"), so swapping the branch turns them red.
 */
import { describe, expect, test } from "bun:test"
import type {
  ConversationId,
  EntryId,
  KnownConversationChange,
  KnownConversationStreamItem,
  KnownTranscriptEntry,
  StreamCursor,
} from "@openbot/contracts"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { ConversationRepo, LiveHub } from "../../src/ports/index.ts"
import { makeLiveHubLayer } from "../../src/services/conversation/index.ts"
import {
  botId,
  conversationId,
  entryId,
  makeDirectConversation,
  makeMessageEntry,
  makeRequest,
  makeTurn,
  runTest,
  TestPorts,
} from "../../src/testing/index.ts"
import { collect, eventually } from "./helpers.ts"

const CONV = conversationId("cnv_win")
const OTHER = conversationId("cnv_win_other")

/** The window's parameters are the defaults unless a test says otherwise. */
const layer = (publishWindow?: Parameters<typeof makeLiveHubLayer>[0]) =>
  makeLiveHubLayer(publishWindow).pipe(Layer.provideMerge(TestPorts()))

const seedConversation = (id: ConversationId) =>
  Effect.flatMap(ConversationRepo, (repo) =>
    Effect.orDie(
      repo.upsert(makeDirectConversation({ id, botId: botId("bot_win"), epoch: "epc_win" })),
    ))

/** A still-growing bot message (the thing the window buffers). */
const streaming = (id: EntryId, text: string, revision = 0): KnownTranscriptEntry =>
  makeMessageEntry({
    id,
    conversationId: CONV,
    revision,
    text,
    streaming: true,
    role: "bot",
    author: { kind: "bot", botId: botId("bot_win") },
  })

/** The same message, finished (the terminal upsert — never buffered). */
const terminal = (id: EntryId, text: string, revision = 1): KnownTranscriptEntry =>
  makeMessageEntry({
    id,
    conversationId: CONV,
    revision,
    text,
    streaming: false,
    role: "bot",
    author: { kind: "bot", botId: botId("bot_win") },
  })

const upsert = (entry: KnownTranscriptEntry): KnownConversationChange => ({ type: "entry.upserted", entry })

/** The `entry.upserted` changes a subscriber saw, oldest first. */
const upserts = (items: ReadonlyArray<KnownConversationStreamItem>) =>
  items.flatMap((item) =>
    item.kind === "change" && item.change.type === "entry.upserted" ? [item.change.entry] : [])

/** The `entry.upserted` changes a subscriber saw, with the text of each. */
const upsertTexts = (items: ReadonlyArray<KnownConversationStreamItem>) =>
  upserts(items).map((entry) => entry.kind === "message" ? entry.text : "")

/**
 * Subscribes to a conversation and waits until the subscriber has seen `n` changes, so the
 * assertions below read the client's view rather than the server's intent.
 */
const waitForChanges = (items: Effect.Effect<ReadonlyArray<KnownConversationStreamItem>>, n: number) =>
  eventually(Effect.map(items, (all) => all.filter((i) => i.kind === "change").length >= n), `${n} changes`)

describe("the publish window: which changes reach the client", () => {
  test("a still-growing upsert is buffered; the terminal one is published at once", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        yield* seedConversation(CONV)
        const hub = yield* LiveHub
        const live = yield* collect(hub.subscribeConversation({ conversationId: CONV }))
        const entry = entryId("ent_a")
        // 3 intermediate states: below K=4, so they stay buffered.
        const cursors: Array<StreamCursor | undefined> = []
        for (let i = 0; i < 3; i++) {
          cursors.push(yield* hub.publishConversation(CONV, upsert(streaming(entry, `t${i}`, i))))
        }
        const terminalCursor = yield* hub.publishConversation(CONV, upsert(terminal(entry, "done")))
        yield* waitForChanges(live.items, 2)
        return { cursors, terminalCursor, items: yield* live.items }
      }),
      layer(),
    )
    // Buffered changes return no cursor: they were not published.
    expect(out.cursors).toEqual([undefined, undefined, undefined])
    // The terminal change is published immediately and has a cursor of its own. It is the second
    // change of the replica: the first is the last buffered intermediate state, published just
    // before it (C-2) — the client has never seen an intermediate state of this entry.
    expect(out.terminalCursor).toEqual({ epoch: "epc_win", sequence: 2 })
    // The client saw the last buffered intermediate state first, then the terminal one (C-2).
    expect(upsertTexts(out.items)).toEqual(["t2", "done"])
  })

  test("the count trigger publishes the entry once K changes are buffered", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        yield* seedConversation(CONV)
        const hub = yield* LiveHub
        const live = yield* collect(hub.subscribeConversation({ conversationId: CONV }))
        const entry = entryId("ent_a")
        const cursors: Array<StreamCursor | undefined> = []
        for (let i = 0; i < 4; i++) {
          cursors.push(yield* hub.publishConversation(CONV, upsert(streaming(entry, `t${i}`, i))))
        }
        yield* waitForChanges(live.items, 1)
        return { cursors, items: yield* live.items }
      }),
      layer(),
    )
    // The 4th change reached the count trigger, so it was published — and got a cursor.
    expect(out.cursors).toEqual([undefined, undefined, undefined, { epoch: "epc_win", sequence: 1 }])
    // Only the newest of the four was published; the three before it are still buffered.
    expect(upsertTexts(out.items)).toEqual(["t3"])
  })

  test("with the window off, every change is published on its own with a consecutive sequence", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        yield* seedConversation(CONV)
        const hub = yield* LiveHub
        const entry = entryId("ent_a")
        const cursors: Array<StreamCursor | undefined> = []
        for (let i = 0; i < 5; i++) {
          cursors.push(yield* hub.publishConversation(CONV, upsert(streaming(entry, `t${i}`, i))))
        }
        return { cursors }
      }),
      layer({ publishWindow: { enabled: false } }),
    )
    expect(out.cursors).toEqual([
      { epoch: "epc_win", sequence: 1 },
      { epoch: "epc_win", sequence: 2 },
      { epoch: "epc_win", sequence: 3 },
      { epoch: "epc_win", sequence: 4 },
      { epoch: "epc_win", sequence: 5 },
    ])
  })
})

describe("the publish window: the invariants", () => {
  test("I-2: a change that is not a message is never buffered — it is published in arrival order", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        yield* seedConversation(CONV)
        const hub = yield* LiveHub
        const live = yield* collect(hub.subscribeConversation({ conversationId: CONV }))
        const entry = entryId("ent_a")
        // Mixed batch: a streaming upsert (buffered), a turn, a request, a removal, a terminal.
        yield* hub.publishConversation(CONV, upsert(streaming(entry, "t0")))
        yield* hub.publishConversation(CONV, { type: "turn.upserted", turn: makeTurn({ id: "trn_1" as never, conversationId: CONV }) })
        yield* hub.publishConversation(CONV, { type: "request.upserted", request: makeRequest({ conversationId: CONV }) })
        yield* hub.publishConversation(CONV, { type: "entry.removed", entryId: entryId("ent_gone"), reason: "retracted" })
        yield* hub.publishConversation(CONV, upsert(terminal(entry, "done")))
        yield* waitForChanges(live.items, 4)
        return { items: yield* live.items }
      }),
      layer(),
    )
    // Every non-message change is there, in the order it arrived; only the intermediate upsert
    // was held back (and released in front of the terminal one).
    const types = out.items.flatMap((item) => (item.kind === "change" ? [item.change.type] : []))
    expect(types).toEqual(["turn.upserted", "request.upserted", "entry.removed", "entry.upserted", "entry.upserted"])
  })

  test("I-3: two entries streaming at once never overwrite each other", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        yield* seedConversation(CONV)
        const hub = yield* LiveHub
        const live = yield* collect(hub.subscribeConversation({ conversationId: CONV }))
        const a = entryId("ent_a")
        const b = entryId("ent_b")
        // Interleaved: each entry reaches the count trigger on its own.
        for (let i = 0; i < 4; i++) {
          yield* hub.publishConversation(CONV, upsert(streaming(a, `a${i}`, i)))
          yield* hub.publishConversation(CONV, upsert(streaming(b, `b${i}`, i)))
        }
        yield* waitForChanges(live.items, 2)
        return { items: yield* live.items }
      }),
      layer(),
    )
    // Both entries were published, each with its own complete text.
    expect(upsertTexts(out.items).sort()).toEqual(["a3", "b3"])
  })

  test("A-5 / C-2: a terminal upsert drops the pending states when the entry was already flushed", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        yield* seedConversation(CONV)
        const hub = yield* LiveHub
        const live = yield* collect(hub.subscribeConversation({ conversationId: CONV }))
        const entry = entryId("ent_a")
        // 5 intermediate states: the 4th reached the count trigger, so the entry WAS flushed.
        for (let i = 0; i < 5; i++) {
          yield* hub.publishConversation(CONV, upsert(streaming(entry, `t${i}`, i)))
        }
        yield* waitForChanges(live.items, 1)
        const flushed = yield* live.items
        yield* hub.publishConversation(CONV, upsert(terminal(entry, "done")))
        yield* waitForChanges(live.items, 2)
        return { flushed, items: yield* live.items }
      }),
      layer(),
    )
    // The client saw exactly one intermediate state (the flushed one) and then the terminal one:
    // the states still pending when the terminal arrived were dropped, not published.
    expect(upsertTexts(out.items)).toEqual(["t3", "done"])
  })

  test("A-6: an entry.removed drops that entry's pending states (the entry is not resurrected)", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        yield* seedConversation(CONV)
        const hub = yield* LiveHub
        const live = yield* collect(hub.subscribeConversation({ conversationId: CONV }))
        const entry = entryId("ent_a")
        yield* hub.publishConversation(CONV, upsert(streaming(entry, "t0")))
        yield* hub.publishConversation(CONV, upsert(streaming(entry, "t1")))
        yield* hub.publishConversation(CONV, { type: "entry.removed", entryId: entry, reason: "retracted" })
        yield* waitForChanges(live.items, 1)
        return { items: yield* live.items }
      }),
      layer(),
    )
    // Only the removal was published: the two buffered upserts of the removed entry are gone.
    const types = out.items.flatMap((item) => (item.kind === "change" ? [item.change.type] : []))
    expect(types).toEqual(["entry.removed"])
  })

  test("A-7: the window does not cross replicas", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        yield* seedConversation(CONV)
        yield* seedConversation(OTHER)
        const hub = yield* LiveHub
        const live = yield* collect(hub.subscribeConversation({ conversationId: CONV }))
        const a = entryId("ent_a")
        const b = entryId("ent_b")
        // 3 states in CONV (buffered), 4 in OTHER (the 4th crosses the count trigger).
        for (let i = 0; i < 3; i++) {
          yield* hub.publishConversation(CONV, upsert(streaming(a, `a${i}`, i)))
        }
        for (let i = 0; i < 4; i++) {
          yield* hub.publishConversation(OTHER, upsert(streaming(b, `b${i}`, i)))
        }
        yield* waitForChanges(live.items, 0)
        return { items: yield* live.items }
      }),
      layer(),
    )
    // Nothing reached CONV: the other replica's flush must not touch it.
    expect(out.items.flatMap((item) => (item.kind === "change" ? [item.change.type] : []))).toEqual([])
  })

  test("the stall fallback publishes a buffered change when the stream stops", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        yield* seedConversation(CONV)
        const hub = yield* LiveHub
        const live = yield* collect(hub.subscribeConversation({ conversationId: CONV }))
        const entry = entryId("ent_a")
        // One buffered state, below the count trigger. The stream then stops: the stall
        // fallback must publish it (the clock has to move, or the test hangs).
        yield* hub.publishConversation(CONV, upsert(streaming(entry, "t0")))
        yield* waitForChanges(live.items, 0)
        const before = yield* live.items
        yield* TestClock.adjust("3 seconds")
        yield* waitForChanges(live.items, 1)
        return { before, items: yield* live.items }
      }),
      layer(),
    )
    // Before the clock moved, nothing had been published.
    expect(out.before.flatMap((item) => (item.kind === "change" ? [item.change.type] : []))).toEqual([])
    // After it, the buffered change went out.
    expect(upsertTexts(out.items)).toEqual(["t0"])
  })

  test("the stall fallback does not fire while the stream keeps advancing", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        yield* seedConversation(CONV)
        const hub = yield* LiveHub
        const live = yield* collect(hub.subscribeConversation({ conversationId: CONV }))
        const entry = entryId("ent_a")
        // Keep the stream moving: every state refreshes the buffer's timestamp.
        for (let i = 0; i < 3; i++) {
          yield* hub.publishConversation(CONV, upsert(streaming(entry, `t${i}`, i)))
          yield* TestClock.adjust("1 second")
        }
        yield* waitForChanges(live.items, 0)
        return { items: yield* live.items }
      }),
      layer(),
    )
    // 3 seconds passed, but the buffer was refreshed throughout: no stall flush.
    expect(out.items.flatMap((item) => (item.kind === "change" ? [item.change.type] : []))).toEqual([])
  })
})

describe("the publish window: a new epoch invalidates the old buffers", () => {
  /**
   * A new epoch (a reset, or the rebuild that follows a failed `ReplicaLog.append`) makes every
   * buffered change of the old epoch meaningless. The old epoch's buffer must not be published
   * into the new one: a change that never got a sequence in the old epoch must not suddenly get
   * one in the new epoch (architecture §3.2.1 C-6), and the client must not receive a change
   * that belongs to a conversation state it has already re-snapshotted.
   *
   * The control arm matters: without it, "nothing was published" could just mean "the timer
   * never fired" and the test would pass for the wrong reason.
   */
  const runWithReset = (withReset: boolean) =>
    runTest(
      Effect.gen(function*() {
        yield* seedConversation(CONV)
        const hub = yield* LiveHub
        const live = yield* collect(hub.subscribeConversation({ conversationId: CONV }))
        const entry = entryId("ent_a")
        // One buffered state, below the count trigger: it waits for the stall deadline.
        yield* hub.publishConversation(CONV, upsert(streaming(entry, "old-text")))
        yield* waitForChanges(live.items, 0)
        if (withReset) yield* hub.resetConversation(CONV, "new-session")
        // Let the stall deadline pass: the timer for the old buffer fires.
        yield* TestClock.adjust("3 seconds")
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        return { items: yield* live.items }
      }),
      layer(),
    )

  test("the old epoch's buffered change is not published into the new epoch", async () => {
    const out = await runWithReset(true)
    // The client saw the reset, but no change carrying the old epoch's text.
    const texts = upsertTexts(out.items)
    expect(texts).not.toContain("old-text")
  })

  test("without a reset the same buffer IS published (the control arm)", async () => {
    const out = await runWithReset(false)
    // So the assertion above is about the epoch change, not about the timer being dead.
    expect(upsertTexts(out.items)).toEqual(["old-text"])
  })

  test("a new epoch clears the 'was flushed' memory (C-2's predicate is per epoch)", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        yield* seedConversation(CONV)
        const hub = yield* LiveHub
        const live = yield* collect(hub.subscribeConversation({ conversationId: CONV }))
        const entry = entryId("ent_a")
        // 4 intermediate states: the count trigger fires, so the entry WAS flushed — the client
        // has seen an intermediate state of it.
        for (let i = 0; i < 4; i++) {
          yield* hub.publishConversation(CONV, upsert(streaming(entry, `t${i}`, i)))
        }
        yield* waitForChanges(live.items, 1)
        const afterFlush = yield* live.items
        // A new epoch: the client's state is replaced by a fresh snapshot.
        yield* hub.resetConversation(CONV, "new-session")
        // The reset itself adds no change (it replaces the snapshot + synchronized).
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        // In the new epoch the same entry id streams again and ends with a terminal upsert.
        // The new epoch's "was flushed" memory must be empty, so the terminal must re-send the
        // last intermediate state — the client sees the stream grow again.
        yield* hub.publishConversation(CONV, upsert(streaming(entry, "new-0", 0)))
        yield* hub.publishConversation(CONV, upsert(terminal(entry, "new-done", 1)))
        yield* waitForChanges(live.items, 3)
        return { afterFlush, items: yield* live.items }
      }),
      layer(),
    )
    // The client saw the flushed intermediate state in the old epoch...
    expect(upsertTexts(out.afterFlush)).toEqual(["t3"])
    // ...and in the new epoch the terminal re-sent the last intermediate state (C-2's "never
    // flushed" branch). If the old epoch's memory had survived, that state would have been
    // dropped instead and the client would only see the terminal one.
    expect(upsertTexts(out.items)).toEqual(["t3", "new-0", "new-done"])
  })
})

describe("the publish window: the change-count budget (A-4, C-1/C-3)", () => {
  /**
   * The number of `entry.upserted` changes the **client** applied for one entry's streaming
   * lifecycle: the published intermediate states plus the terminal one. C-1 fixes the counting
   * point at the client; C-3 fixes the budget as the relation `A <= floor((N+1)/3)`.
   */
  const clientUpserts = (items: ReadonlyArray<KnownConversationStreamItem>) => upserts(items).length

  /**
   * Streams N intermediate states of one entry, then the terminal one, and reports how many
   * `entry.upserted` changes the client saw.
   */
  const runTurn = (n: number) =>
    runTest(
      Effect.gen(function*() {
        yield* seedConversation(CONV)
        const hub = yield* LiveHub
        const live = yield* collect(hub.subscribeConversation({ conversationId: CONV }))
        const entry = entryId("ent_a")
        for (let i = 0; i < n; i++) {
          yield* hub.publishConversation(CONV, upsert(streaming(entry, `t${i}`, i)))
        }
        yield* hub.publishConversation(CONV, upsert(terminal(entry, "done")))
        // The terminal one is always published, so the client has seen at least 1 change.
        yield* waitForChanges(live.items, 1)
        const items = yield* live.items
        return { a: clientUpserts(items), items }
      }),
      layer(),
    )

  test("A <= floor((N+1)/3) for N = 20, 21 and 25 (the relation, not one hard-coded number)", async () => {
    for (const n of [20, 21, 25]) {
      const out = await runTurn(n)
      const budget = Math.floor((n + 1) / 3)
      expect(out.a).toBeLessThanOrEqual(budget)
      // The budget is only meaningful if the window actually merged something: the unmerged path
      // would publish N+1 changes.
      expect(out.a).toBeLessThan(n + 1)
    }
  })

  test("the client still sees at least 3 intermediate states for N >= 20 (US-7 clause 1)", async () => {
    for (const n of [20, 21, 25]) {
      const out = await runTurn(n)
      const intermediate = out.items.flatMap((item) =>
        item.kind === "change" && item.change.type === "entry.upserted" && item.change.entry.kind === "message" &&
          item.change.entry.streaming
          ? [item.change.entry]
          : [])
      expect(intermediate.length).toBeGreaterThanOrEqual(3)
    }
  })

  test("the final text is the terminal text (nothing is lost by merging)", async () => {
    const out = await runTurn(20)
    const texts = upsertTexts(out.items)
    expect(texts.at(-1)).toBe("done")
  })
})

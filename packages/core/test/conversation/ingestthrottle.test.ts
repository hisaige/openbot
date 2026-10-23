/**
 * G2 consumer-side trailing throttle (architecture §2.2, §8 AC-01..AC-10).
 *
 * Counting is at the layer level: `ConversationService` holds its own `EntryRepo`, so wrapping
 * `deps.entries` sees nothing (review N1). Clock rule (R-6): every window move is an explicit
 * `advance` after `yieldNow`, never a real sleep.
 */
import { describe, expect, test } from "bun:test"
import type { HarnessItem } from "@openbot/contracts"
import { Effect, Exit, Layer, Option, Scope } from "effect"
import { BotRepo, ConversationRepo, ConversationService, EntryRepo, LiveHub, UsageService } from "../../src/ports/index.ts"
import { ConversationServiceLive, LiveHubLive } from "../../src/services/conversation/index.ts"
import { ConversationStore, ConversationStoreLive } from "../../src/services/conversation/internal/ConversationStore.ts"
import { finalizeTurnEntries, makeSessionIngest, type SessionIngest } from "../../src/services/conversation/TurnIngest.ts"
import { advance, botId, conversationId, makeBot, makeDirectConversation, makeMemoryEntryRepo, runTest, TestPorts, turnId, UsageServiceFake } from "../../src/testing/index.ts"

const BOT = botId("bot_g2")
const CONV = conversationId("cnv_g2")
const TURN = turnId("trn_g2")
const W = 500

type Stats = { readonly upserts: Map<string, number>; bytes: number }
const total = (stats: Stats) => [...stats.upserts.values()].reduce((a, b) => a + b, 0)

/** Counts every `EntryRepo.upsert` by native key; the build row is included (the metric subtracts it). */
const counting = (stats: Stats) =>
  Layer.effect(EntryRepo, Effect.gen(function*() {
    const inner = yield* makeMemoryEntryRepo()
    return EntryRepo.of({
      ...inner,
      upsert: (entry) =>
        Effect.tap(inner.upsert(entry), () =>
          Effect.sync(() => {
            const key = entry.harnessRef?.nativeId ?? entry.id
            stats.upserts.set(key, (stats.upserts.get(key) ?? 0) + 1)
            stats.bytes += JSON.stringify(entry).length
          })),
    })
  }))

const graph = (stats: Stats) =>
  Layer.mergeAll(ConversationServiceLive, ConversationStoreLive, UsageServiceFake.layer).pipe(
    Layer.provideMerge(LiveHubLive),
    Layer.provideMerge(Layer.merge(TestPorts(), counting(stats))),
  )

const msg = (text: string, streaming = true): HarnessItem => ({ _tag: "Message", role: "bot", text, streaming })
const up = (key: string, item: HarnessItem) => ({ _tag: "ItemUpserted" as const, turnId: TURN, key, item })

/** Opens the real ingest on the counting graph, with the bot and its DM seeded. */
const open = (throttle?: { windowMs?: number; maxIntermediateWrites?: number }) =>
  Effect.gen(function*() {
    yield* (yield* BotRepo).upsert(makeBot({ id: BOT }))
    yield* (yield* ConversationRepo).upsert(makeDirectConversation({ id: CONV, botId: BOT }))
    const ingest = yield* makeSessionIngest({
      botId: BOT, homeConversationId: CONV, harness: "fake", model: () => "m", instructionsHash: "h",
      conversationService: yield* ConversationService, store: yield* ConversationStore,
      hub: yield* LiveHub, usage: yield* UsageService, entries: yield* EntryRepo, bots: yield* BotRepo,
      activeTurnId: () => TURN, onSessionBound: () => Effect.void, onSessionClosed: () => Effect.void,
      onHarnessTurn: () => Effect.succeed(undefined), upsertThrottle: throttle,
    })
    yield* ingest.beginTurn(TURN, CONV)
    return ingest
  })

/** One delta every 10 ms of test time; `yieldNow` lets the flusher register before the clock moves (R-6). */
const send = (ingest: SessionIngest, key: string, texts: ReadonlyArray<string>) =>
  Effect.forEach(texts, (text, i) =>
    ingest.handle(up(key, msg(text))).pipe(
      Effect.andThen(i === texts.length - 1 ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(advance("10 millis")))),
    ), { discard: true })

const read = (key: string) =>
  Effect.gen(function*() {
    const found = yield* (yield* EntryRepo).findByNativeId(CONV, key)
    return Option.getOrUndefined(found)
  })

describe("G2 trailing throttle", () => {
  test("AC-01/03/04: K=100 stays within ⌈KΔ/W⌉+1 and the first delta needs no clock move", async () => {
    for (const [windowMs, bound] of [[500, 3], [100, 11], [1000, 2]] as const) {
      const stats: Stats = { upserts: new Map(), bytes: 0 }
      const first = await runTest(
        Effect.gen(function*() {
          const ingest = yield* open({ windowMs })
          yield* ingest.handle(up("k", msg("0")))
          const early = yield* read("k") // AC-04: visible before any advance
          yield* send(ingest, "k", Array.from({ length: 99 }, (_, i) => `x${i}`))
          return early
        }),
        graph(stats),
      )
      expect(first).toMatchObject({ kind: "message", text: "0" })
      expect(stats.upserts.get("k") ?? 0).toBeLessThanOrEqual(bound)
    }
  })

  test("AC-05/06/07: the last snapshot lands verbatim and a terminal item bypasses the window", async () => {
    const stats: Stats = { upserts: new Map(), bytes: 0 }
    const out = await runTest(
      Effect.gen(function*() {
        const ingest = yield* open()
        yield* send(ingest, "m", ["a", "ab", "abc"])
        yield* Effect.yieldNow
        yield* advance(`${W + 100} millis`)
        const idle = yield* read("m")
        yield* ingest.handle(up("m", msg("abcd", false)))
        const terminal = yield* read("m")
        yield* advance("2000 millis")
        const later = yield* read("m")
        yield* ingest.handle(up("r", { _tag: "Reasoning", text: "deep", streaming: true }))
        yield* ingest.handle(up("r", { _tag: "Reasoning", text: "deeper", streaming: false }))
        const reasoning = yield* read("r")
        const tool = { _tag: "ToolCall" as const, toolName: "Bash", title: "ls", kind: "shell" as const, inputSummary: "ls" }
        yield* ingest.handle(up("t", { ...tool, status: "running" }))
        yield* ingest.handle(up("t", { ...tool, status: "completed", outputPreview: "ok" }))
        return { idle, terminal, later, reasoning, tool: yield* read("t") }
      }),
      graph(stats),
    )
    expect(out.idle).toMatchObject({ kind: "message", text: "abc", streaming: true })
    expect(out.terminal).toMatchObject({ kind: "message", text: "abcd", streaming: false })
    expect(out.later).toMatchObject({ kind: "message", text: "abcd", streaming: false })
    expect(out.reasoning).toMatchObject({ kind: "reasoning", text: "deeper", streaming: false })
    expect(out.tool).toMatchObject({ kind: "tool-call", status: "completed", output: { text: "ok" } })
  })

  test("AC-08: the turn terminal flushes before finalizeTurnEntries", async () => {
    const stats: Stats = { upserts: new Map(), bytes: 0 }
    const out = await runTest(
      Effect.gen(function*() {
        const ingest = yield* open()
        yield* send(ingest, "m", ["one", "one two", "one two three"])
        yield* ingest.handle({ _tag: "TurnCompleted", turnId: TURN, stopReason: "end_turn" })
        const finalized = yield* finalizeTurnEntries({ conversationService: yield* ConversationService, entries: yield* EntryRepo }, TURN, "completed")
        return { finalized, entry: yield* read("m") }
      }),
      graph(stats),
    )
    expect(out.finalized.lastBotMessage).toBe("one two three")
    expect(out.entry).toMatchObject({ kind: "message", text: "one two three", streaming: false })
  })

  test("AC-09: NO_REPLY is held back and never reaches the store", async () => {
    const stats: Stats = { upserts: new Map(), bytes: 0 }
    const out = await runTest(
      Effect.gen(function*() {
        const ingest = yield* open()
        yield* ingest.handle(up("s", msg("NO_")))
        const held = yield* read("s")
        yield* ingest.handle(up("s", msg("NO_REPLY", false)))
        const silent = yield* read("s")
        yield* ingest.handle(up("h", msg("NO")))
        yield* ingest.handle(up("h", msg("Not a sentinel")))
        return { held, silent, visible: yield* read("h") }
      }),
      graph(stats),
    )
    expect(out.held).toBeUndefined()
    expect(out.silent).toBeUndefined()
    expect(out.visible).toMatchObject({ kind: "message", text: "Not a sentinel" })
  })

  test("AC-10: SessionClosed and the scope close stop every later write", async () => {
    const stats: Stats = { upserts: new Map(), bytes: 0 }
    const out = await runTest(
      Effect.gen(function*() {
        const scope = yield* Scope.make()
        const ingest = yield* open().pipe(Scope.provide(scope))
        yield* ingest.handle(up("a", msg("a")))
        yield* advance("10 millis")
        yield* ingest.handle(up("a", msg("ab")))
        yield* ingest.handle(up("b", msg("b")))
        yield* ingest.handle(up("b", msg("bc")))
        const opened = total(stats)
        yield* ingest.handle({ _tag: "SessionClosed", reason: "bye" })
        yield* advance("2000 millis")
        const closedSession = total(stats)
        yield* Scope.close(scope, Exit.void)
        yield* ingest.handle(up("a", msg("abcd")))
        yield* advance("2000 millis")
        return { opened, closedSession, closedScope: total(stats) }
      }),
      graph(stats),
    )
    expect(out.closedSession).toBe(out.opened)
    expect(out.closedScope).toBe(out.opened)
  })
})

/**
 * TurnIngest (architecture §4.3, §3.1): normalized `HarnessEvent`s → transcript entry upserts,
 * native session bookkeeping, activity, usage and the context ring.
 *
 * One ingest per bot session (one mind per bot, D5.0). Every turn is registered with ITS
 * conversation (`beginTurn(turnId, conversationId)`): the turn's messages, reasoning, tool calls and
 * activity land there. The context ring (one session per bot) is kept on the bot's DM.
 *
 * - Entry ids are allocated by OpenBot; the adapter's stable native key is kept in
 *   `harnessRef.nativeId` (in-memory key map per session, `EntryRepo.findByNativeId` as fallback).
 * - Every upsert is a whole entry with `revision + 1` (via `ConversationService.updateEntry`).
 * - Turn terminal events complete the runner's per-turn `Deferred`; the runner finalizes.
 * - A harness-initiated turn (`TurnStarted` with `initiator: "harness"`, D2.1) is routed through the
 *   runner (`onHarnessTurn`): its adapter-generated id maps to the running turn (joined: its output
 *   lands there and its end ends nothing) or to a turn of its own that the runner registered.
 * - `finalizeTurnEntries` closes every streaming entry of a turn (`aborted` on interrupt/failure,
 *   unfinished tool calls `interrupted`).
 *
 * Internal module (not exported from the package).
 */
import type {
  BotId,
  ConversationId,
  ConversationSession,
  EntryId,
  HarnessEvent,
  HarnessItem,
  KnownTranscriptEntry,
  TranscriptEntryOf,
  TurnId,
  Usage,
} from "@openbot/contracts"
import { Clock, Deferred, Duration, Effect, Option, Scope, Semaphore } from "effect"
import { BotRepo, EntryRepo } from "../../ports/repos.ts"
import type { ConversationService, EntryDraft, LiveHub, UsageService } from "../../ports/services.ts"
import type { ConversationStore } from "./internal/ConversationStore.ts"
import { compact, orDie } from "./internal/util.ts"

/** How a turn ended, as seen by the runner. */
export type TurnTerminal =
  | { readonly _tag: "completed"; readonly stopReason?: string | undefined }
  | { readonly _tag: "failed"; readonly code: string; readonly message: string; readonly retryable: boolean }
  | { readonly _tag: "interrupted"; readonly reason?: string | undefined }

/** A bot's reply that is exactly this (trimmed, case-insensitive) is not posted (D5.1 "nothing to add"). */
export const NO_REPLY = "NO_REPLY"

const stripDecoration = (text: string) => text.trim().replace(/^[\s`*_"'“”.!]+|[\s`*_"'“”.!]+$/g, "")

/**
 * True for a silent reply: the message is `NO_REPLY` (any case, optionally wrapped in quotes,
 * backticks or emphasis), or its last line is.
 */
export const isNoReply = (text: string): boolean => {
  const sentinel = NO_REPLY.toLowerCase()
  if (stripDecoration(text).toLowerCase() === sentinel) return true
  const lines = text.trim().split(/\r?\n/)
  return lines.length > 1 && stripDecoration(lines[lines.length - 1]!).toLowerCase() === sentinel
}

/** A streaming message that may still turn out to be `NO_REPLY` (held back until it diverges). */
const mayBecomeNoReply = (text: string): boolean => {
  const t = text.trim().replace(/^[`*_"'“”]+/, "").toLowerCase()
  return t === "" || NO_REPLY.toLowerCase().startsWith(t) || isNoReply(text)
}

/** Minimum time between two context-ring publishes for one session (the last value is flushed at turn end). */
export const CONTEXT_USAGE_THROTTLE_MS = 2_000

/** G2 trailing throttle: minimum gap between two intermediate writes of one entry. */
export const ENTRY_UPSERT_THROTTLE_MS = 500
/** G2 cap on intermediate writes per entry per stream (same value and semantics as G1). */
export const MAX_ENTRY_UPSERTS_PER_STREAM = 16
export const addUsage = (a: Usage | undefined, b: Usage): Usage => {
  if (a === undefined) return b
  const sum = (x: number | undefined, y: number | undefined) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0))
  return compact({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: sum(a.cachedInputTokens, b.cachedInputTokens),
    reasoningTokens: sum(a.reasoningTokens, b.reasoningTokens),
    costUsd: sum(a.costUsd, b.costUsd),
  })
}

const TERMINAL_TOOL = new Set(["completed", "failed", "declined"])

/** The entry fields an item produces (everything except id/revision/timestamps/base refs). */
export const itemFields = (
  item: HarnessItem,
  key: string,
  now: number,
  previous: KnownTranscriptEntry | undefined,
): Record<string, unknown> => {
  switch (item._tag) {
    case "Message":
      return {
        kind: "message",
        role: "bot",
        text: item.text,
        attachments: previous?.kind === "message" ? previous.attachments : [],
        streaming: item.streaming,
        phase: item.phase,
        aborted: item.aborted,
      }
    case "Reasoning":
      return { kind: "reasoning", text: item.text, streaming: item.streaming, source: item.source ?? "thinking" }
    case "ToolCall": {
      const startedAt = previous?.kind === "tool-call" ? previous.startedAt : now
      const terminal = TERMINAL_TOOL.has(item.status)
      const completedAt = terminal ? (previous?.kind === "tool-call" && previous.completedAt !== undefined ? previous.completedAt : now) : undefined
      return {
        kind: "tool-call",
        toolCallId: key,
        name: item.toolName,
        title: item.title,
        toolKind: item.kind,
        status: item.status,
        input: item.input ?? (previous?.kind === "tool-call" ? previous.input : null),
        inputSummary: item.inputSummary,
        output: item.output ?? (item.outputPreview === undefined ? undefined : { text: item.outputPreview }),
        error: item.error,
        command: item.command,
        fileChanges: item.fileChanges,
        mcp: item.mcp,
        nodeId: item.nodeId,
        parentToolCallId: item.parentKey,
        requestId: previous?.kind === "tool-call" ? previous.requestId : undefined,
        startedAt,
        completedAt,
      }
    }
    case "Notice":
      return { kind: "notice", level: item.level, code: item.code ?? "harness", text: item.text }
  }
}

/** Turn → conversation entries kept for late events after a turn ended. */
const TURN_CONVERSATIONS_KEPT = 64

/** Where a harness-initiated turn's events go (BotRunner decides). */
export interface HarnessTurnRoute {
  /** The OpenBot turn its events belong to. */
  readonly turnId: TurnId
  readonly conversationId: ConversationId
  /** Folded into a running turn: its terminal event ends nothing. */
  readonly joined: boolean
}

export interface SessionIngestDeps {
  readonly botId: BotId
  /** The bot's DM: the context ring lives here, and stray events without a known turn land here. */
  readonly homeConversationId: ConversationId
  readonly harness: string
  readonly model: () => string | undefined
  readonly instructionsHash: string
  readonly conversationService: ConversationService["Service"]
  readonly store: ConversationStore["Service"]
  readonly hub: LiveHub["Service"]
  readonly usage: UsageService["Service"]
  readonly entries: EntryRepo["Service"]
  readonly bots: BotRepo["Service"]
  /** The runner's active turn id (activity events are ignored outside a turn). */
  readonly activeTurnId: () => TurnId | undefined
  /** Called once per `SessionBound` (after it is persisted). */
  readonly onSessionBound: (nativeSessionId: string) => Effect.Effect<void>
  /** Called on `SessionClosed`. */
  readonly onSessionClosed: (reason: string) => Effect.Effect<void>
  /**
   * A harness-initiated turn started (its adapter id). Returns where its events go (registering a
   * turn of its own through `ingest.beginTurn` when needed), or `undefined` to leave them unrouted.
   * Runs on the event fiber: later events of the session wait for it.
   */
  readonly onHarnessTurn: (nativeTurnId: TurnId, ingest: SessionIngest) => Effect.Effect<HarnessTurnRoute | undefined>
  /** G2 throttle override (defaults 500 ms / 16); `BotRunner` never sets it — tests do. */
  readonly upsertThrottle?: {
    readonly windowMs?: number | undefined; readonly maxIntermediateWrites?: number | undefined
  } | undefined
}

export interface SessionIngest {
  /** Registers a turn (and its conversation) before `startTurn`, so early events find it. */
  readonly beginTurn: (turnId: TurnId, conversationId: ConversationId) => Effect.Effect<Deferred.Deferred<TurnTerminal>>
  /** True once the turn's terminal event (completed / failed / interrupted) was handled. */
  readonly hasEnded: (turnId: TurnId) => boolean
  readonly handle: (event: HarnessEvent) => Effect.Effect<void>
  /** Usage summed over the turn's `Usage` events. */
  readonly usageOf: (turnId: TurnId) => Usage | undefined
  /** Publishes a throttled context-usage value that is still pending. */
  readonly flushContextUsage: Effect.Effect<void>
  /** Forgets a finished turn's bookkeeping. */
  readonly endTurn: (turnId: TurnId) => void
}

/**
 * Persists the bot's native session id. The per-conversation `seen` cursors and the last
 * conversation are kept while the driver stays the same (a re-bound id of the same harness).
 */
export const persistBotSession = (
  bots: BotRepo["Service"],
  input: {
    readonly botId: BotId
    readonly driver: string
    readonly nativeSessionId: string
    readonly instructionsHash?: string | undefined
  },
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const existing = yield* orDie(bots.getSession(input.botId))
    const now = yield* Clock.currentTimeMillis
    const same = Option.isSome(existing) && existing.value.driver === input.driver ? existing.value : undefined
    if (same !== undefined && same.nativeSessionId === input.nativeSessionId && same.instructionsHash === input.instructionsHash) return
    yield* orDie(bots.setSession(compact({
      botId: input.botId,
      driver: input.driver,
      nativeSessionId: input.nativeSessionId,
      instructionsHash: input.instructionsHash,
      seen: same?.seen,
      lastConversationId: same?.lastConversationId,
      updatedAt: now,
    })))
  })

/** Upserts the bot's `Conversation.sessions` row (context ring, D6.5). */
export const updateSessionRow = (
  store: ConversationStore["Service"],
  conversationId: ConversationId,
  botId: BotId,
  f: (row: ConversationSession | undefined, now: number) => ConversationSession | undefined,
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    yield* Effect.ignore(store.update(conversationId, (c) => {
      const rows = c.sessions ?? []
      const current = rows.find((r) => r.botId === botId)
      const next = f(current, now)
      if (next === undefined) return c
      const others = rows.filter((r) => r.botId !== botId)
      return { ...c, sessions: [...others, compact(next)] }
    }))
  })

/** Per-key trailing throttle (G2 §2.2): one small record per entry, same order as `keys`. */
type KeyThrottle = {
  lastWriteAt: number // last write (`-Infinity` = a new key writes at once)
  writes: number // intermediate writes of the current stream (only these are capped)
  seq: number // generation of `pending`: a timer only flushes its own generation
  pending: { readonly turnId: TurnId; readonly item: HarnessItem } | undefined // newest unwritten snapshot
}
export const makeSessionIngest = (deps: SessionIngestDeps): Effect.Effect<SessionIngest, never, Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    /** One writer at a time, so an older snapshot never lands after a terminal item (INV-5). */
    const writeLock = yield* Semaphore.make(1)
    const windowMs = deps.upsertThrottle?.windowMs ?? ENTRY_UPSERT_THROTTLE_MS
    const maxWrites = deps.upsertThrottle?.maxIntermediateWrites ?? MAX_ENTRY_UPSERTS_PER_STREAM
    const keys = new Map<string, EntryId>()
    const terminals = new Map<TurnId, Deferred.Deferred<TurnTerminal>>()
    const turnConversations = new Map<TurnId, ConversationId>()
    let lastConversationId: ConversationId | undefined
    /** The conversation of a turn (late events: the session's latest turn, else the bot's DM). */
    const conversationOf = (turnId: TurnId | undefined): ConversationId =>
      (turnId === undefined ? undefined : turnConversations.get(turnId)) ?? lastConversationId ?? deps.homeConversationId
    const usage = new Map<TurnId, Usage>()
    let lastContextPublish = Number.NEGATIVE_INFINITY
    let pendingContext: { readonly usedTokens: number; readonly windowTokens: number } | undefined
    /** Turns whose terminal event was handled (bounded). */
    const ended = new Set<TurnId>()
    /** Harness-initiated turn (adapter id) → where its events go. */
    const routes = new Map<TurnId, HarnessTurnRoute>()
    const routeOf = (turnId: TurnId): TurnId => routes.get(turnId)?.turnId ?? turnId
    const throttle = new Map<string, KeyThrottle>()
    /** Set by the session scope's finalizer: from then on nothing reaches the store (INV-9). */
    let closed = false
    /** Drops the oldest keys beyond `TURN_CONVERSATIONS_KEPT`. */
    const keep = <K>(collection: { readonly size: number; keys(): Iterator<K>; delete(key: K): boolean }) => {
      while (collection.size > TURN_CONVERSATIONS_KEPT) collection.delete(collection.keys().next().value as K)
    }
    const publishContext = (value: { readonly usedTokens: number; readonly windowTokens: number }) =>
      updateSessionRow(deps.store, deps.homeConversationId, deps.botId, (row, now) => {
        if (
          row?.contextUsage?.usedTokens === value.usedTokens && row.contextUsage.windowTokens === value.windowTokens &&
          row.active
        ) return undefined
        return { botId: deps.botId, active: true, contextUsage: { ...value }, updatedAt: now }
      })

    const throttleOf = (key: string): KeyThrottle => {
      let st = throttle.get(key)
      if (st === undefined) throttle.set(key, (st = { lastWriteAt: Number.NEGATIVE_INFINITY, writes: 0, seq: 0, pending: undefined }))
      return st
    }
    /** Drops a key's pending snapshot and invalidates the timer armed for it. */
    const invalidate = (st: KeyThrottle): void => {
      st.pending = undefined
      st.seq += 1
    }
    /** Drops every pending snapshot (session close / scope close): their timers become no-ops. */
    const dropAll = (): void => {
      for (const st of throttle.values()) invalidate(st)
    }
    /** The one write path (A1): key cache, native-id adoption, `updateEntry` → `appendEntry` fallback. */
    const writeItemBody = (turnId: TurnId, key: string, item: HarnessItem): Effect.Effect<void> =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const conversationId = conversationOf(turnId)
        let id = keys.get(key)
        if (id === undefined) {
          const found = yield* orDie(deps.entries.findByNativeId(conversationId, key))
          // Native keys are only unique per harness session: never adopt another bot's entry.
          if (
            Option.isSome(found) && found.value.author.kind === "bot" && found.value.author.botId === deps.botId &&
            found.value.harnessRef?.harness === deps.harness
          ) {
            id = found.value.id
            keys.set(key, id)
          }
        }
        if (id !== undefined) {
          const result = yield* Effect.result(deps.conversationService.updateEntry(id, (current) =>
            compact({
              id: current.id,
              conversationId: current.conversationId,
              revision: current.revision,
              createdAt: current.createdAt,
              updatedAt: current.updatedAt,
              author: current.author,
              turnId: current.turnId ?? turnId,
              replyToId: current.replyToId,
              threadRootId: current.threadRootId,
              parentToolCallId: current.parentToolCallId,
              harnessRef: current.harnessRef ?? { harness: deps.harness, nativeId: key },
              ...itemFields(item, key, now, current),
            }) as KnownTranscriptEntry
          ))
          if (result._tag === "Success") return
          keys.delete(key) // vanished: append a fresh entry below
        }
        const draft = compact({
          conversationId,
          author: { kind: "bot" as const, botId: deps.botId },
          turnId,
          harnessRef: { harness: deps.harness, nativeId: key },
          ...itemFields(item, key, now, undefined),
        }) as unknown as EntryDraft
        const entry = yield* Effect.result(deps.conversationService.appendEntry(draft))
        if (entry._tag === "Success") keys.set(key, entry.success.id)
      })
    /** Serialized write; `current` is checked under the lock, so a superseded snapshot never lands (INV-5). */
    const writeItem = (turnId: TurnId, key: string, item: HarnessItem, current?: () => boolean): Effect.Effect<void> =>
      writeLock.withPermits(1)(
        Effect.suspend(() => (closed || current?.() === false ? Effect.void : writeItemBody(turnId, key, item))),
      )
    /** Writes the pending snapshot of `key` when it still belongs to generation `seq`. */
    const flushPending = (key: string, seq: number, counted: boolean): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        const st = throttle.get(key)
        if (st?.pending === undefined || st.seq !== seq) return Effect.succeed(false)
        const { turnId, item } = st.pending
        st.pending = undefined
        return writeItem(turnId, key, item, () => st.seq === seq).pipe(
          Effect.andThen(Clock.currentTimeMillis),
          Effect.map((now) => {
            st.lastWriteAt = now
            if (counted) st.writes += 1
            return true
          }),
        )
      })
    /** Arms the trailing flush; a newer generation makes this timer a no-op (spin ≤ one window). */
    const armFlush = (key: string, st: KeyThrottle, delayMs: number): Effect.Effect<void> => {
      st.seq += 1
      const flush = Effect.sleep(Duration.millis(Math.max(0, delayMs))).pipe(
        Effect.andThen(flushPending(key, st.seq, true)),
        Effect.catchCause((cause) => Effect.logError(`TurnIngest: flush ${key} failed`, cause)),
      )
      return Effect.asVoid(Effect.forkIn(flush, scope, { startImmediately: true }))
    }
    /** Writes every pending snapshot of a turn before its `Deferred` completes (§3.1, INV-6). */
    const flushTurn = (turnId: TurnId): Effect.Effect<void> =>
      Effect.forEach([...throttle.entries()], ([key, st]) =>
        st.pending?.turnId === turnId ? flushPending(key, st.seq, false) : Effect.succeed(false), { discard: true })
    const complete = (nativeTurnId: TurnId, terminal: TurnTerminal): Effect.Effect<void> =>
      Effect.gen(function*() {
        const route = routes.get(nativeTurnId)
        // A harness-initiated turn folded into a running turn never ends it.
        if (route?.joined === true) return
        const turnId = route?.turnId ?? nativeTurnId
        // §3.1: the snapshots land before the runner's Deferred, so finalize reads the terminal text.
        // A flush failure must still complete the Deferred (N4), or the runner waits for session close.
        yield* flushTurn(turnId).pipe(Effect.catchCause((cause) => Effect.logError("TurnIngest: flush turn failed", cause)))
        ended.add(turnId)
        keep(ended)
        const deferred = terminals.get(turnId)
        if (deferred !== undefined) yield* Deferred.succeed(deferred, terminal)
      })
    /** G2 §2.2: NO_REPLY and terminal items bypass the window; the rest lands on the trailing timer. */
    const upsertItem = (turnId: TurnId, key: string, item: HarnessItem): Effect.Effect<void> =>
      Effect.gen(function*() {
        // A streaming NO_REPLY prefix is held back; a terminal one drops the snapshot and the entry.
        if (item._tag === "Message" && item.streaming && mayBecomeNoReply(item.text)) return
        if (item._tag === "Message" && !item.streaming && isNoReply(item.text)) {
          invalidate(throttleOf(key))
          const silent = keys.get(key)
          if (silent === undefined) return
          keys.delete(key)
          yield* Effect.ignore(deps.conversationService.removeEntry(silent))
          return
        }
        const now = yield* Clock.currentTimeMillis
        const st = throttleOf(key)
        const terminal = item._tag === "ToolCall"
          ? TERMINAL_TOOL.has(item.status)
          : (item._tag === "Message" || item._tag === "Reasoning") && !item.streaming
        // Rule 3: a terminal item is written at once; the older snapshot must never follow it.
        if (terminal) {
          invalidate(st)
          st.writes = 0
          st.lastWriteAt = now
          yield* writeItem(turnId, key, item)
          return
        }
        // Rule 4: only the newest snapshot is kept; past the cap the timer becomes an idle flush.
        if (st.pending !== undefined) {
          st.pending = { turnId, item }
          if (st.writes >= maxWrites) yield* armFlush(key, st, windowMs)
          return
        }
        const capped = st.writes >= maxWrites
        // Rule 5: leading edge — a new key, or a window already open.
        if (!capped && now - st.lastWriteAt >= windowMs) {
          st.lastWriteAt = now
          st.writes += 1
          yield* writeItem(turnId, key, item)
          return
        }
        // Rules 6/7: trailing edge (after idle once capped).
        st.pending = { turnId, item }
        yield* armFlush(key, st, capped ? windowMs : st.lastWriteAt + windowMs - now)
      })
    const handle = (event: HarnessEvent): Effect.Effect<void> => {
      switch (event._tag) {
        case "SessionBound":
          return Effect.gen(function*() {
            yield* persistBotSession(deps.bots, {
              botId: deps.botId,
              driver: deps.harness,
              nativeSessionId: event.nativeSessionId,
              instructionsHash: deps.instructionsHash,
            })
            yield* deps.onSessionBound(event.nativeSessionId)
          })
        case "TurnStarted":
          if (event.initiator !== "harness") return Effect.void
          return Effect.gen(function*() {
            const route = yield* deps.onHarnessTurn(event.turnId, self)
            if (route === undefined) return
            routes.set(event.turnId, route)
            keep(routes)
            if (!turnConversations.has(route.turnId)) turnConversations.set(route.turnId, route.conversationId)
          })
        case "ItemUpserted":
          return upsertItem(routeOf(event.turnId), event.key, event.item)
        case "Activity":
          return Effect.gen(function*() {
            const turnId = deps.activeTurnId()
            if (turnId === undefined) return
            yield* deps.hub.setActivity(compact({
              botId: deps.botId,
              conversationId: conversationOf(turnId),
              state: event.toolKind === undefined ? ("thinking" as const) : ("working" as const),
              label: event.label,
              toolKind: event.toolKind,
              since: yield* Clock.currentTimeMillis,
            }))
          })
        case "Usage":
          return Effect.gen(function*() {
            const turnId = event.turnId !== undefined ? routeOf(event.turnId) : deps.activeTurnId()
            if (turnId !== undefined) usage.set(turnId, addUsage(usage.get(turnId), event.usage))
            yield* deps.usage.record(compact({
              botId: deps.botId,
              conversationId: conversationOf(turnId),
              turnId,
              harness: deps.harness,
              model: deps.model(),
              usage: event.usage,
            }))
          })
        case "ContextUsage":
          return Effect.gen(function*() {
            const now = yield* Clock.currentTimeMillis
            const value = { usedTokens: event.usedTokens, windowTokens: event.windowTokens }
            if (now - lastContextPublish < CONTEXT_USAGE_THROTTLE_MS) {
              pendingContext = value
              return
            }
            pendingContext = undefined
            lastContextPublish = now
            yield* publishContext(value)
          })
        case "TurnCompleted":
          return complete(event.turnId, { _tag: "completed", stopReason: event.stopReason })
        case "TurnFailed":
          return complete(event.turnId, {
            _tag: "failed",
            code: event.error.code,
            message: event.error.message,
            retryable: event.error.retryable,
          })
        case "TurnInterrupted":
          return complete(event.turnId, { _tag: "interrupted" })
        case "SessionClosed":
          // Rule 9: no pending snapshot survives the closed session; its timers become no-ops.
          return Effect.andThen(Effect.sync(dropAll), deps.onSessionClosed(event.reason))
      }
    }

    const self: SessionIngest = {
      beginTurn: (turnId, conversationId) =>
        Effect.gen(function*() {
          const deferred = yield* Deferred.make<TurnTerminal>()
          terminals.set(turnId, deferred)
          turnConversations.set(turnId, conversationId)
          lastConversationId = conversationId
          keep(turnConversations)
          return deferred
        }),
      hasEnded: (turnId) => ended.has(turnId),
      handle: (event) =>
        handle(event).pipe(Effect.catchCause((cause) => Effect.logError(`TurnIngest: ${event._tag} failed`, cause))),
      usageOf: (turnId) => usage.get(turnId),
      flushContextUsage: Effect.suspend(() => {
        const value = pendingContext
        if (value === undefined) return Effect.void
        pendingContext = undefined
        return Effect.flatMap(Clock.currentTimeMillis, (now) => {
          lastContextPublish = now
          return publishContext(value)
        })
      }),
      endTurn: (turnId) => {
        terminals.delete(turnId)
        usage.delete(turnId)
        // A finished turn takes its unwritten snapshots with it (the sync `endTurn` cannot await a write).
        for (const st of throttle.values()) if (st.pending?.turnId === turnId) invalidate(st)
      },
    }
    // Rule 10: the session scope owns the timers; once it closes nothing may write (INV-9).
    yield* Effect.addFinalizer(() => Effect.sync(() => { closed = true; dropAll() }))
    return self
  })

export interface FinalizedTurn {
  /** Final bot messages of the turn, oldest first. */
  readonly botMessages: ReadonlyArray<TranscriptEntryOf<"message">>
  /** Text of the last non-empty bot message. */
  readonly lastBotMessage: string | undefined
}

/**
 * Closes every streaming entry of a turn: messages/reasoning stop streaming (bot messages become
 * `aborted` unless the turn completed), unfinished tool calls become `completed` (turn completed)
 * or `interrupted`.
 */
export const finalizeTurnEntries = (
  deps: Pick<SessionIngestDeps, "conversationService" | "entries">,
  turnId: TurnId,
  status: "completed" | "failed" | "interrupted",
): Effect.Effect<FinalizedTurn> =>
  Effect.gen(function*() {
    const all = yield* orDie(deps.entries.listByTurn(turnId))
    const now = yield* Clock.currentTimeMillis
    const botMessages: Array<TranscriptEntryOf<"message">> = []
    for (const entry of all) {
      if (entry.kind === "unknown") continue
      let next: KnownTranscriptEntry | undefined
      if (entry.kind === "message" && entry.streaming) {
        next = entry.role === "bot" && status !== "completed"
          ? { ...entry, streaming: false, aborted: true }
          : { ...entry, streaming: false }
      } else if (entry.kind === "reasoning" && entry.streaming) {
        next = { ...entry, streaming: false }
      } else if (
        entry.kind === "tool-call" &&
        (entry.status === "pending" || entry.status === "running" || entry.status === "awaiting-approval")
      ) {
        next = { ...entry, status: status === "completed" ? "completed" : "interrupted", completedAt: now }
      }
      let final: KnownTranscriptEntry = entry
      if (next !== undefined) {
        const target = next
        const updated = yield* Effect.result(deps.conversationService.updateEntry(entry.id, () => target))
        if (updated._tag === "Success" && updated.success.kind !== "unknown") final = updated.success
      }
      if (final.kind === "message" && final.role === "bot" && final.author.kind === "bot") botMessages.push(final)
    }
    const last = [...botMessages].reverse().find((m) => m.text.trim().length > 0)
    return { botMessages, lastBotMessage: last?.text }
  })

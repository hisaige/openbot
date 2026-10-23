/**
 * LiveHub (architecture §4.3.6, D4.3): ordered replicas for every conversation and for the roster.
 *
 * - Every change is committed to its repository by the caller first, then appended here:
 *   `sequence++` → `ReplicaLog.append` (durable window of 256) → `PubSub` (live subscribers).
 * - `subscribe*({after})`: subscribe to the PubSub FIRST, then read the head. A matching epoch with a
 *   gap ≤ 256 that the log still covers is replayed from `ReplicaLog`; anything else gets a snapshot
 *   (conversation: tail window + pending/referenced requests + recent turns). Then `synchronized`,
 *   then the live tail filtered to `sequence > last sent`.
 * - `resetConversation` starts a new epoch; live subscribers get `reset`, a fresh snapshot and
 *   `synchronized`.
 * - Activities are in memory only (roster snapshot + `activity.updated`).
 * - `NodeDirectory.changes` is forwarded to the roster for the lifetime of the layer.
 */
import type {
  BotActivity,
  BotId,
  Card,
  ConversationId,
  EntryId,
  KnownConversationChange,
  KnownConversationStreamItem,
  KnownRosterChange,
  KnownRosterStreamItem,
  NotFound,
  RequestId,
  StreamCursor,
} from "@openbot/contracts"
import { isStreamingUpsert, MAX_REPLAY_GAP, SNAPSHOT_TAIL_ENTRIES } from "@openbot/contracts"
import { Clock, Duration, Effect, Layer, Option, PubSub, Semaphore, Stream } from "effect"
import { IdGen } from "../../ports/IdGen.ts"
import { NodeDirectory } from "../../ports/NodeDirectory.ts"
import {
  BotRepo,
  ConversationRepo,
  conversationReplicaKey,
  EntryRepo,
  readSettings,
  type ReplicaChange,
  type ReplicaKey,
  ReplicaLog,
  type ReplicaRecord,
  RequestRepo,
  rosterReplicaKey,
  SectionRepo,
  SettingsRepo,
  TaskRepo,
  TurnRepo,
} from "../../ports/repos.ts"
import { LiveHub } from "../../ports/services.ts"
import { rosterTasks } from "./BackgroundTasks.ts"
import { summarize, visiblePage } from "./internal/summary.ts"
import { orDie, required } from "./internal/util.ts"

type ResetReason = "new-session" | "rollback" | "rebuild"

/** What travels on the hub's PubSub (one bus for every replica; subscribers filter by key). */
type HubItem =
  | { readonly key: ReplicaKey; readonly kind: "change"; readonly cursor: StreamCursor; readonly change: ReplicaChange }
  | { readonly key: ReplicaKey; readonly kind: "reset"; readonly epoch: string; readonly reason: ResetReason }

/** Most recent turns included in a conversation snapshot. */
const SNAPSHOT_TURNS = 20
/** Upper bound for a client-requested `tailLimit`. */
const MAX_TAIL_LIMIT = 500

// --------------------------------------------------------------------------- the publish window

/**
 * The publish window (architecture §2.2.2 / §2.3): still-growing `entry.upserted` changes are
 * buffered per entry instead of being published one by one, so a streaming turn reaches the client
 * in batches. Two things end a buffer:
 *
 * - the **count trigger**: the entry reached `maxPending` buffered changes → publish the latest one;
 * - the **stall fallback**: the entry's buffer has not been updated for `stallMs` → publish it
 *   (keep-alive for a stream that stopped without a terminal upsert).
 *
 * There is deliberately **no time-based tick**: a fixed "flush everything every W ms" degenerates
 * into "one change per token" on any harness whose token interval exceeds W, which breaks the
 * change-count budget outright (architecture §2.3.4).
 */
export interface LiveHubPublishWindow {
  /** Turning it off restores the pre-window behaviour (one change → one sequence → one publish). Default true. */
  readonly enabled: boolean
  /**
   * Stall fallback: an entry whose buffered change has not been updated for this long is published
   * (keep-alive). It is **not** a ticker — while the stream keeps advancing it never fires.
   * Default 2000.
   */
  readonly stallMs: number
  /** Count trigger: `maxPending` buffered changes for one entry publish it. Default 4. */
  readonly maxPending: number
}

export interface LiveHubOptions {
  readonly publishWindow?: Partial<LiveHubPublishWindow> | undefined
}

const DEFAULT_PUBLISH_WINDOW: LiveHubPublishWindow = { enabled: true, stallMs: 2000, maxPending: 4 }

/** What the window holds for one entry. */
interface PendingEntry {
  /** The newest buffered change — the one that gets published when the entry is flushed. */
  readonly latest: KnownConversationChange
  /** How many changes are buffered for this entry (reset when it is flushed). */
  readonly count: number
  /** When the buffer was last updated (ms). */
  readonly lastUpdatedAt: number
}

/** The window's state for one conversation replica. */
interface PublishWindowState {
  /** Buffered changes, per entry. */
  readonly pending: Map<EntryId, PendingEntry>
  /**
   * Entries whose buffer was already flushed at least once in this turn. C-2: the terminal-upsert
   * branch is decided by "has this entry been flushed before", **not** by the current buffer size
   * (the buffer is always below `maxPending` after a flush, so a size test cannot express it).
   * Kept even after the buffer empties, so the fact stays evaluable.
   */
  readonly flushed: Set<EntryId>
  /** A trailing timer is running (one per replica). */
  timerScheduled: boolean
}

const cardRequestId = (card: Card): RequestId | undefined =>
  card.type === "approval" || card.type === "form" || card.type === "secret-request" || card.type === "handoff" ||
    card.type === "question"
    ? card.requestId
    : undefined

const sameActivity = (a: BotActivity | undefined, b: BotActivity): boolean =>
  a !== undefined && a.state === b.state && a.label === b.label && a.toolKind === b.toolKind &&
  a.conversationId === b.conversationId

/** The LiveHub layer with custom options (the publish window); `LiveHubLive` uses the defaults. */
export const makeLiveHubLayer = (
  options?: LiveHubOptions,
): Layer.Layer<
  LiveHub,
  never,
  | ReplicaLog
  | ConversationRepo
  | EntryRepo
  | RequestRepo
  | TurnRepo
  | BotRepo
  | SectionRepo
  | SettingsRepo
  | TaskRepo
  | NodeDirectory
  | IdGen
> =>
  Layer.effect(
    LiveHub,
    Effect.gen(function*() {
    const windowOptions = { ...DEFAULT_PUBLISH_WINDOW, ...options?.publishWindow }
    const log = yield* ReplicaLog
    const conversations = yield* ConversationRepo
    const requests = yield* RequestRepo
    const turns = yield* TurnRepo
    const bots = yield* BotRepo
    const sections = yield* SectionRepo
    const taskRepo = yield* TaskRepo
    const directory = yield* NodeDirectory
    const ids = yield* IdGen
    const repos = yield* Effect.context<EntryRepo | RequestRepo | SettingsRepo | TurnRepo>()

    const lock = yield* Semaphore.make(1)
    const heads = new Map<ReplicaKey, StreamCursor>()
    const activities = new Map<BotId, BotActivity>()
    const pubsub = yield* PubSub.unbounded<HubItem>()
    yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))
    // The window's timers live in the layer's scope: they die with the layer (architecture §4.3-4).
    const scope = yield* Effect.scope
    /** One window state per conversation replica; the roster replica never uses the window. */
    const windowStates = new Map<ReplicaKey, PublishWindowState>()
    const windowState = (key: ReplicaKey): PublishWindowState => {
      const existing = windowStates.get(key)
      if (existing !== undefined) return existing
      const created: PublishWindowState = { pending: new Map(), flushed: new Set(), timerScheduled: false }
      windowStates.set(key, created)
      return created
    }

    // ------------------------------------------------------------------ heads (call under `lock`)

    const initialEpoch = (key: ReplicaKey): Effect.Effect<string> =>
      key === rosterReplicaKey
        ? ids.next("epc")
        : Effect.gen(function*() {
          const id = key.slice("conversation:".length) as ConversationId
          const conversation = yield* orDie(conversations.get(id))
          return Option.isSome(conversation) ? conversation.value.epoch : yield* ids.next("epc")
        })

    const headUnlocked = (key: ReplicaKey): Effect.Effect<StreamCursor> =>
      Effect.gen(function*() {
        const cached = heads.get(key)
        if (cached !== undefined) return cached
        const stored = yield* orDie(log.head(key))
        const head: StreamCursor = Option.isSome(stored) ? stored.value : { epoch: yield* initialEpoch(key), sequence: 0 }
        heads.set(key, head)
        return head
      })

    const head = (key: ReplicaKey) => lock.withPermits(1)(headUnlocked(key))

    const resetUnlocked = (key: ReplicaKey, reason: ResetReason): Effect.Effect<string> =>
      Effect.gen(function*() {
        const epoch = yield* ids.next("epc")
        yield* log.reset(key, epoch).pipe(
          Effect.catchCause((cause) => Effect.logError("LiveHub: ReplicaLog.reset failed", cause)),
        )
        // A new epoch invalidates the window's buffers: the old epoch's changes are gone, and so
        // is the "was this entry flushed" memory (C-2's predicate must not read the old epoch's
        // answer). The state object is **replaced**, not merely emptied, so that a timer or a
        // publish still holding the old one can tell that it is stale.
        //
        // This happens **before** the new head is published, so there is no window in which a
        // stale buffer could be appended into the new epoch.
        windowStates.delete(key)
        heads.set(key, { epoch, sequence: 0 })
        yield* PubSub.publish(pubsub, { key, kind: "reset", epoch, reason })
        return epoch
      })

    /** sequence++ → ReplicaLog → PubSub. The caller holds the lock. */
    const appendUnlocked = (key: ReplicaKey, change: ReplicaChange): Effect.Effect<StreamCursor> =>
      Effect.gen(function*() {
        const current = yield* headUnlocked(key)
        const cursor: StreamCursor = { epoch: current.epoch, sequence: current.sequence + 1 }
        const record: ReplicaRecord = { replicaKey: key, epoch: cursor.epoch, sequence: cursor.sequence, change }
        const appended = yield* log.append(record).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logError(`LiveHub: ReplicaLog.append failed for ${key}; rebuilding the replica`, cause).pipe(
              Effect.as(false),
            )
          ),
        )
        if (!appended) {
          // The change is committed in its repository; a new epoch makes every client re-snapshot.
          const epoch = yield* resetUnlocked(key, "rebuild")
          return { epoch, sequence: 0 }
        }
        heads.set(key, cursor)
        yield* PubSub.publish(pubsub, { key, kind: "change", cursor, change })
        return cursor
      })

    /** sequence++ → ReplicaLog → PubSub, serialized so the bus order is the sequence order. */
    const append = (key: ReplicaKey, change: ReplicaChange): Effect.Effect<StreamCursor> =>
      lock.withPermits(1)(appendUnlocked(key, change))

    const publishRoster = (change: KnownRosterChange) => append(rosterReplicaKey, { replica: "roster", change })

    // ------------------------------------------------------------------ snapshots

    const conversationSnapshot = (
      conversationId: ConversationId,
      cursor: StreamCursor,
      tailLimit: number | undefined,
    ) =>
      Effect.gen(function*() {
        const conversation = yield* required(conversations.get(conversationId), "conversation", conversationId)
        const limit = Math.min(Math.max(1, Math.floor(tailLimit ?? SNAPSHOT_TAIL_ENTRIES)), MAX_TAIL_LIMIT)
        const page = yield* orDie(Effect.provide(visiblePage({ conversationId, limit }), repos))
        const window = page.entries.filter((e) => e.kind !== "unknown")
        const referenced = new Set<RequestId>()
        for (const entry of window) {
          if (entry.kind !== "card") continue
          const id = cardRequestId(entry.card)
          if (id !== undefined) referenced.add(id)
        }
        const allRequests = yield* orDie(requests.list({ conversationId }))
        const recentTurns = yield* orDie(turns.listByConversation(conversationId, SNAPSHOT_TURNS))
        const item: KnownConversationStreamItem = {
          kind: "snapshot",
          cursor,
          conversation: { ...conversation, epoch: cursor.epoch },
          entries: window,
          requests: allRequests.filter((r) => r.status === "pending" || referenced.has(r.id)),
          turns: recentTurns,
          hasMoreBefore: page.hasMoreBefore,
          beforeCursor: page.beforeCursor,
        }
        return item
      })

    const rosterSnapshot = (cursor: StreamCursor) =>
      Effect.gen(function*() {
        const allBots = yield* orDie(bots.list)
        const botIds = new Set(allBots.map((b) => b.id))
        const allConversations = yield* orDie(conversations.list())
        const summaries = yield* Effect.forEach(allConversations, (c) => Effect.provide(summarize(c), repos))
        const nodes = yield* directory.list
        const allSections = yield* orDie(sections.list)
        const settings = yield* Effect.provide(orDie(readSettings), repos)
        const tasks = (yield* orDie(rosterTasks(taskRepo))).filter((t) => botIds.has(t.botId))
        const item: KnownRosterStreamItem = {
          kind: "snapshot",
          cursor,
          bots: allBots,
          conversations: summaries,
          activities: [...activities.values()].filter((a) => botIds.has(a.botId)),
          nodes,
          sections: allSections,
          settings,
          tasks,
        }
        return item
      })

    // ------------------------------------------------------------------ resume

    /** Replayable records after `after`, or none (→ snapshot). */
    const replayFor = (key: ReplicaKey, after: StreamCursor | undefined, current: StreamCursor) =>
      Effect.gen(function*() {
        if (after === undefined || after.epoch !== current.epoch) return Option.none<ReadonlyArray<ReplicaRecord>>()
        if (after.sequence > current.sequence || current.sequence - after.sequence > MAX_REPLAY_GAP) {
          return Option.none<ReadonlyArray<ReplicaRecord>>()
        }
        return yield* orDie(log.readAfter(key, after))
      })

    /**
     * The common subscribe skeleton: catch-up items (replay or snapshot) + `synchronized`, then the
     * live tail. `onLive` maps one bus item to the items to emit, given the last sent cursor.
     */
    const subscribe = <Item, E>(options: {
      readonly key: ReplicaKey
      readonly after: StreamCursor | undefined
      readonly preflight: Effect.Effect<void, E>
      readonly snapshot: (cursor: StreamCursor) => Effect.Effect<Item, E>
      readonly toChange: (record: { readonly cursor: StreamCursor; readonly change: ReplicaChange }) => Item | undefined
      readonly synchronized: (cursor: StreamCursor) => Item
      readonly onReset: (epoch: string, reason: ResetReason) => ReadonlyArray<Item>
    }): Stream.Stream<Item, E> =>
      Stream.unwrap(
        Effect.gen(function*() {
          // Subscribe BEFORE reading the head: nothing published after the head read can be missed.
          const subscription = yield* PubSub.subscribe(pubsub)
          yield* options.preflight
          const current = yield* head(options.key)
          let last = current
          const initial: Array<Item> = []
          const replay = yield* replayFor(options.key, options.after, current)
          if (Option.isSome(replay)) {
            for (const record of replay.value) {
              const cursor = { epoch: record.epoch, sequence: record.sequence }
              const item = options.toChange({ cursor, change: record.change })
              if (item !== undefined) initial.push(item)
              if (record.sequence > last.sequence) last = cursor
            }
          } else {
            initial.push(yield* options.snapshot(current))
          }
          initial.push(options.synchronized(last))

          const onItem = (item: HubItem): Effect.Effect<ReadonlyArray<Item>, E> => {
            if (item.key !== options.key) return Effect.succeed([])
            if (item.kind === "change") {
              if (item.cursor.epoch !== last.epoch || item.cursor.sequence <= last.sequence) return Effect.succeed([])
              last = item.cursor
              const mapped = options.toChange(item)
              return Effect.succeed(mapped === undefined ? [] : [mapped])
            }
            return Effect.gen(function*() {
              const fresh = yield* head(options.key)
              last = fresh
              const snapshot = yield* options.snapshot(fresh)
              return [...options.onReset(item.epoch, item.reason), snapshot, options.synchronized(fresh)]
            })
          }
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.flatMap((item) => Stream.fromIterableEffect(onItem(item))),
          )
          return Stream.concat(Stream.fromIterable(initial), live)
        }),
      )

    // ------------------------------------------------------------------ the publish window

    /**
     * Is this window state still the live one for its replica? A new epoch replaces the state
     * object, so a state that is no longer registered belongs to a dead epoch: its buffers must
     * not be published, and its "was flushed" memory must not be read.
     */
    const isCurrentWindow = (key: ReplicaKey, state: PublishWindowState): boolean => windowStates.get(key) === state

    /**
     * Publishes one buffered change and clears the entry's buffer.
     *
     * The staleness check and the publish happen under the same lock, so a reset cannot slip
     * between them: the old epoch's buffer can never be appended into the new epoch.
     */
    const flushEntry = (key: ReplicaKey, state: PublishWindowState, entryId: EntryId): Effect.Effect<StreamCursor | undefined> =>
      lock.withPermits(1)(
        Effect.gen(function*() {
          if (!isCurrentWindow(key, state)) return undefined
          const buffered = state.pending.get(entryId)
          if (buffered === undefined) return undefined
          // Remove it first: a half-removed entry must never be published twice.
          state.pending.delete(entryId)
          state.flushed.add(entryId)
          return yield* appendUnlocked(key, { replica: "conversation", change: buffered.latest })
        }),
      )

    /**
     * The trailing timer: waits until the oldest buffered change is `stallMs` old, then publishes
     * every entry whose buffer really has not moved since (a stalled stream) and re-arms itself
     * for the ones that are still advancing.
     *
     * `timerScheduled` stays true for the timer's whole life (it is the "a timer is running" flag),
     * so a re-arm never forks a second timer.
     *
     * The timer holds the state object it was armed for. A new epoch **replaces** that object
     * (see `resetUnlocked`), so a timer whose state is no longer the current one belongs to a
     * dead epoch: it must publish nothing and must not re-arm. Without this check the old
     * epoch's buffered change was published into the new epoch.
     */
    const runStallTimer = (key: ReplicaKey, state: PublishWindowState): Effect.Effect<void> =>
      Effect.gen(function*() {
        const oldest = [...state.pending.values()].reduce<number | undefined>(
          (min, entry) => (min === undefined || entry.lastUpdatedAt < min ? entry.lastUpdatedAt : min),
          undefined,
        )
        if (oldest === undefined) {
          state.timerScheduled = false
          return
        }
        const now = yield* Clock.currentTimeMillis
        const wait = Math.max(0, oldest + windowOptions.stallMs - now)
        yield* Effect.sleep(Duration.millis(wait))
        const at = yield* Clock.currentTimeMillis
        // Publish the entries that really stalled; keep the ones that are still advancing.
        // The staleness check and the publish happen under one lock, so a reset cannot slip
        // between them: the old epoch's buffer never reaches the new epoch.
        yield* lock.withPermits(1)(
          Effect.gen(function*() {
            if (!isCurrentWindow(key, state)) return
            const stalled = [...state.pending.entries()].filter(
              ([, entry]) => at - entry.lastUpdatedAt >= windowOptions.stallMs,
            )
            for (const [entryId] of stalled) {
              const buffered = state.pending.get(entryId)
              if (buffered === undefined) continue
              state.pending.delete(entryId)
              state.flushed.add(entryId)
              yield* appendUnlocked(key, { replica: "conversation", change: buffered.latest })
            }
          }),
        )
        if (!isCurrentWindow(key, state)) return
        if (state.pending.size === 0) {
          state.timerScheduled = false
          return
        }
        // Still something buffered: re-arm for the next stall deadline (the flag stays true).
        yield* Effect.forkIn(runStallTimer(key, state), scope, { startImmediately: true })
      })

    /** Arms the trailing timer if it is not already running. */
    const armStallTimer = (key: ReplicaKey, state: PublishWindowState): Effect.Effect<void> =>
      Effect.gen(function*() {
        if (state.timerScheduled) return
        state.timerScheduled = true
        yield* Effect.forkIn(runStallTimer(key, state), scope, { startImmediately: true })
      })

    /** Drops an entry's buffer (terminal upsert, `entry.removed`): nothing buffered survives it. */
    const dropEntry = (state: PublishWindowState, entryId: EntryId) => {
      state.pending.delete(entryId)
    }

    /**
     * Publishes a change, routing it through the window when it is a still-growing upsert.
     *
     * Returns the change's own cursor when it was published, or `undefined` when the window
     * buffered it.
     */
    const publishConversation = (
      conversationId: ConversationId,
      change: KnownConversationChange,
    ): Effect.Effect<StreamCursor | undefined> => {
      const key = conversationReplicaKey(conversationId)
      if (!windowOptions.enabled) return append(key, { replica: "conversation", change })

      // A streaming upsert is the only kind of change the window buffers.
      const streaming = change.type === "entry.upserted" && isStreamingUpsert(change.entry)

      if (!streaming) {
        if (change.type === "entry.upserted") {
          // A terminal upsert: resolve the entry's buffered intermediate states first (C-2).
          // The whole resolution happens under one lock, so a reset cannot slip between reading
          // the buffer and publishing it (the old epoch's buffer must not reach the new epoch).
          return lock.withPermits(1)(
            Effect.gen(function*() {
              const state = windowState(key)
              const entryId = change.entry.id
              const alreadyFlushed = state.flushed.has(entryId)
              const buffered = state.pending.get(entryId)
              dropEntry(state, entryId)
              // The entry's streaming lifecycle is over: its "was flushed" fact is no longer needed.
              state.flushed.delete(entryId)
              if (alreadyFlushed) {
                // The client has already seen intermediate states of this entry: drop the rest and
                // publish the terminal one alone.
                return yield* appendUnlocked(key, { replica: "conversation", change })
              }
              if (buffered !== undefined) {
                // The client has not seen any intermediate state yet: publish the last one first,
                // so the stream still grows, then the terminal one. Both go out under one lock, so
                // no other change can slip between them.
                yield* appendUnlocked(key, { replica: "conversation", change: buffered.latest })
                return yield* appendUnlocked(key, { replica: "conversation", change })
              }
              return yield* appendUnlocked(key, { replica: "conversation", change })
            }),
          )
        }
        if (change.type === "entry.removed") {
          // A removal drops the entry's buffered states: publishing them afterwards would
          // resurrect the entry that was just deleted.
          const state = windowState(key)
          dropEntry(state, change.entryId)
          state.flushed.delete(change.entryId)
        }
        return append(key, { replica: "conversation", change })
      }

      // A streaming upsert: buffer it.
      const entryId = change.entry.id
      return Effect.gen(function*() {
        const state = windowState(key)
        const now = yield* Clock.currentTimeMillis
        const previous = state.pending.get(entryId)
        const buffered: PendingEntry = {
          latest: change,
          count: (previous?.count ?? 0) + 1,
          lastUpdatedAt: now,
        }
        state.pending.set(entryId, buffered)
        if (buffered.count >= windowOptions.maxPending) {
          // Count trigger: publish this entry now, leaving the other entries alone. The change
          // was published, so the caller gets its cursor.
          return yield* flushEntry(key, state, entryId)
        }
        yield* armStallTimer(key, state)
        return undefined
      })
    }

    return LiveHub.of({
      publishConversation,

      publishRoster,

      subscribeConversation: ({ after, conversationId, tailLimit }) =>
        subscribe<KnownConversationStreamItem, NotFound>({
          key: conversationReplicaKey(conversationId),
          after,
          preflight: Effect.asVoid(required(conversations.get(conversationId), "conversation", conversationId)),
          snapshot: (cursor) => conversationSnapshot(conversationId, cursor, tailLimit),
          toChange: ({ change, cursor }) => (change.replica === "conversation" ? { kind: "change", cursor, change: change.change } : undefined),
          synchronized: (cursor) => ({ kind: "synchronized", cursor }),
          onReset: (epoch, reason) => [{ kind: "reset", epoch, reason }],
        }),

      subscribeRoster: ({ after }) =>
        subscribe<KnownRosterStreamItem, never>({
          key: rosterReplicaKey,
          after,
          preflight: Effect.void,
          snapshot: rosterSnapshot,
          toChange: ({ change, cursor }) => (change.replica === "roster" ? { kind: "change", cursor, change: change.change } : undefined),
          synchronized: (cursor) => ({ kind: "synchronized", cursor }),
          // The roster stream has no `reset` item: a fresh snapshot replaces the client state.
          onReset: () => [],
        }),

      resetConversation: (conversationId, reason) =>
        lock.withPermits(1)(resetUnlocked(conversationReplicaKey(conversationId), reason)),

      activities: Effect.sync(() => [...activities.values()]),

      setActivity: (activity) =>
        Effect.gen(function*() {
          if (sameActivity(activities.get(activity.botId), activity)) return
          activities.set(activity.botId, activity)
          yield* publishRoster({ type: "activity.updated", activity })
        }),
    })
    }).pipe(
      // Forward node list changes into the roster for the lifetime of the layer (D: §8.6).
      Effect.tap((hub) =>
        Effect.gen(function*() {
          const directory = yield* NodeDirectory
          yield* Effect.forkScoped(
            Stream.runForEach(directory.changes, (change) => Effect.asVoid(hub.publishRoster(change))),
            { startImmediately: true },
          )
        })
      ),
    ),
  )

/** The default LiveHub layer: the publish window on, with its default parameters (K=4, 2000 ms). */
export const LiveHubLive = makeLiveHubLayer()

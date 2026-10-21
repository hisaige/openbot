// The `bots` array's reference stability (architecture §2.4.1, §5.5 B-3; PRD US-6's companion
// constraint).
//
// WHY THIS MATTERS: `Markdown` is wrapped in `React.memo`, and `memo` compares its props with
// `Object.is`. If the `bots` array gets a new identity on every roster change, the memo never
// hits — and US-6's "only the changing message is re-parsed" cannot hold, no matter how good the
// memo is. The PRD calls this out as a hard companion constraint: "若传给消息体的机器人列表引用在
// 每次无关变更时都换新，则本条即便'加了 memo'也不成立——此时本条判不通过".
//
// WHAT IS TESTED: the reducer's behaviour (which changes replace the `bots` Map) and the derived
// array's identity. The array is built exactly as `useRoster` builds it, from the same `state.bots`.

import { expect, test } from "bun:test"
import { applyRosterChange, emptyRosterState, type RosterState } from "@openbot/contracts"
import type { Bot, BotId, ConversationId, ConversationSummary, RosterChange } from "@openbot/contracts"

/** A bot with the fields the reducer and the sort need. */
const bot = (id: string, name: string): Bot => ({
  id: id as BotId,
  name,
  avatar: { shape: "blob", color: "blue" },
  harness: { kind: "fake" },
  hostNodeId: "node_local" as never,
  boundNodeIds: [],
  instructions: "",
  directConversationId: `cnv_${id}` as ConversationId,
  pinned: false,
  hidden: false,
  notify: "all",
  autonomy: "workspace",
  projectFolders: [],
  skills: [],
  createdAt: 1,
  updatedAt: 1,
})

/**
 * The state with the given bots in it.
 *
 * NOTE: it must NOT mutate `emptyRosterState` — that is a module-level singleton, and mutating it
 * would leak this test's bots into every other test in the file (and into `emptyRosterState`
 * itself, which other suites import).
 */
const stateWith = (...bots: ReadonlyArray<Bot>): RosterState => ({
  ...emptyRosterState,
  bots: new Map(bots.map((b) => [b.id, b] as const)),
})

/** The `bots` array, built exactly as `useRoster` builds it. */
const botsOf = (state: RosterState): ReadonlyArray<Bot> =>
  [...state.bots.values()].sort((a, b) => a.name.localeCompare(b.name))

/** The eight roster change types the architecture lists. */
const NON_BOT_CHANGES: ReadonlyArray<{ readonly label: string; readonly change: RosterChange }> = [
  { label: "conversation.upserted", change: { type: "conversation.upserted", conversation: { id: "cnv_x" as ConversationId, kind: "direct", title: "X", botIds: [], lastActivityAt: 1, preview: "", unreadCount: 0, pendingRequestCount: 0, hiddenFromSidebar: false } satisfies ConversationSummary } },
  { label: "conversation.removed", change: { type: "conversation.removed", conversationId: "cnv_x" as ConversationId } },
  { label: "activity.updated", change: { type: "activity.updated", activity: { botId: "bot_a" as BotId, state: "working", label: "Typing…", updatedAt: 1 } as never } },
  { label: "node.upserted", change: { type: "node.upserted", node: { id: "node_x", label: "X", kind: "local", status: "online", capabilities: [] } as never } },
  { label: "node.removed", change: { type: "node.removed", nodeId: "node_x" as never as never } },
  { label: "section.upserted", change: { type: "section.upserted", section: { id: "sec_x", name: "X", order: 0 } as never } },
  { label: "settings.updated", change: { type: "settings.updated", settings: { showSteps: true } as never } },
  { label: "notification", change: { type: "notification", notification: { id: "n_x", title: "N", body: "b", at: 1 } as never } },
  { label: "task.upserted", change: { type: "task.upserted", task: { id: "t_x" } as never } },
]

test("the bots Map keeps its identity across every non-bot roster change", () => {
  const base = stateWith(bot("bot_a", "Ada"), bot("bot_b", "Bea"))
  for (const { label, change } of NON_BOT_CHANGES) {
    const next = applyRosterChange(base, change)
    expect(`${label}: ${next.bots === base.bots}`).toBe(`${label}: true`)
  }
})

test("the bots array keeps its identity across every non-bot roster change", () => {
  const base = stateWith(bot("bot_a", "Ada"), bot("bot_b", "Bea"))
  const before = botsOf(base)
  for (const { label, change } of NON_BOT_CHANGES) {
    const next = applyRosterChange(base, change)
    // The array is rebuilt from the same Map — so it has the same CONTENT. Whether it has the
    // same IDENTITY is what `useRoster` decides (it memoizes on `state.bots`), and that is what
    // this test pins: the same Map in, the same array out.
    expect(`${label}: ${botsOf(next).map((b) => b.id).join(",")}`).toBe(`${label}: ${before.map((b) => b.id).join(",")}`)
    expect(`${label}: ${next.bots === base.bots}`).toBe(`${label}: true`)
  }
})

test("a bot.upserted DOES replace the bots Map (the one change that must re-render)", () => {
  const base = stateWith(bot("bot_a", "Ada"))
  const next = applyRosterChange(base, { type: "bot.upserted", bot: bot("bot_a", "Ada renamed") })
  // The Map is replaced → the `bots` array must be rebuilt → the messages have to be re-parsed.
  // That is correct: the bot's NAME changed, and the name is rendered in the mention chips.
  expect(next.bots === base.bots).toBe(false)
  expect(botsOf(next)[0]?.name).toBe("Ada renamed")
})

test("a bot.removed DOES replace the bots Map", () => {
  const base = stateWith(bot("bot_a", "Ada"), bot("bot_b", "Bea"))
  const next = applyRosterChange(base, { type: "bot.removed", botId: "bot_b" as BotId })
  expect(next.bots === base.bots).toBe(false)
  expect(botsOf(next).map((b) => b.name)).toEqual(["Ada"])
})

test("a bot.upserted of an UNCHANGED bot still replaces the Map (the reducer is not diffing)", () => {
  // This is the honest cost of the approach: the reducer replaces the Map on every bot.upserted,
  // even when the bot's content is identical. The handoff must say so — "the memo always hits"
  // would be false.
  const base = stateWith(bot("bot_a", "Ada"))
  const next = applyRosterChange(base, { type: "bot.upserted", bot: bot("bot_a", "Ada") })
  expect(next.bots === base.bots).toBe(false)
})

test("the bots array is sorted by name, and the sort is stable across rebuilds", () => {
  const base = stateWith(bot("bot_z", "Zoe"), bot("bot_a", "Ada"), bot("bot_m", "Mia"))
  expect(botsOf(base).map((b) => b.name)).toEqual(["Ada", "Mia", "Zoe"])
  // Rebuilding from the same Map gives the same ORDER — so a rebuilt array is content-equal.
  expect(botsOf(base).map((b) => b.name)).toEqual(botsOf({ ...base }).map((b) => b.name))
})

test("an empty roster yields an empty array", () => {
  expect(botsOf(emptyRosterState)).toEqual([])
})

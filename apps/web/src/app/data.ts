// Small read hooks over the client atoms. Server state comes from @openbot/client replicas; these
// helpers only unwrap `AsyncResult`s and build lookups the screens share.
import { useMemo } from "react"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { Atom } from "effect/reactivity"
import { emptyRosterState, type Bot, type BotId, type RosterState } from "@openbot/contracts"
import { rosterAtom, sessionInfoAtom } from "@openbot/client"

/** The success value of an AsyncResult, or `fallback` while initial/failed. */
export const valueOr = <A, E>(result: AsyncResult.AsyncResult<A, E>, fallback: A): A => (AsyncResult.isSuccess(result) ? result.value : fallback)

export const useResultValue = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>, fallback: A): A => valueOr(useAtomValue(atom), fallback)

export interface RosterView {
  readonly state: RosterState
  /** True once the first snapshot arrived. */
  readonly loaded: boolean
  readonly bots: ReadonlyArray<Bot>
  readonly botById: (id: BotId | string | undefined) => Bot | undefined
}

/** The whole roster replica (bots, conversations, activities, sections, settings). */
export const useRoster = (): RosterView => {
  const result = useAtomValue(rosterAtom)
  const state = valueOr(result, emptyRosterState)
  const loaded = AsyncResult.isSuccess(result) && state.cursor !== undefined
  // The `bots` array gets its OWN memo, keyed on `state.bots` — not on `state`.
  //
  // `state` gets a new reference on EVERY roster change (`applyRosterChange` returns
  // `{...state, ...}` in every case), so a `bots` array derived from it would change identity on
  // every change too — and that identity is what `Markdown`'s `React.memo` compares. If `bots`
  // changed on every unrelated change (activity updates, notifications, conversation summaries —
  // all of which arrive while a bot is streaming), the memo would never hit and US-6's
  // "only the changing message is re-parsed" would not hold.
  //
  // `state.bots` is the Map the reducer only replaces in the `bot.upserted` / `bot.removed` cases,
  // so it — and therefore `bots` — keeps its identity across every other change. When the bot
  // list really does change, a new `bots` array is correct: the messages have to be re-rendered.
  //
  // This deliberately does NOT stabilise the whole `useRoster` result: `state` still changes
  // identity, and its ~29 consumers in `apps/web/src/` depend on that.
  const bots = useMemo(() => [...state.bots.values()].sort((a, b) => a.name.localeCompare(b.name)), [state.bots])
  return useMemo(
    () => ({
      state,
      loaded,
      bots,
      botById: (id) => (id === undefined ? undefined : state.bots.get(id as BotId)),
    }),
    [state, loaded, bots],
  )
}

export const useSessionInfo = () => useAtomValue(sessionInfoAtom)

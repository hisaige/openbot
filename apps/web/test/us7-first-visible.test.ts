// The E-7 measurement formula, and WHY it is not the one it replaced.
//
// E-7 (architecture §6.3) asks for "首个可见中间态的延迟" — the delay until the client sees the
// FIRST INTERMEDIATE state of the streaming entry. R-6 is the risk it guards: the publish window
// could hold the first state back and make the stream feel like it stuttered.
//
// THE FIRST VERSION OF THIS MEASUREMENT WAS WORN OUT. It read:
//
//   firstVisibleMs = firstIntermediate.at - botEntries[0].at
//
// and the bot's FIRST upsert already carries `streaming: true` — the fake harness's
// `streamMessage` upserts `{ streaming: true }` for every chunk, the first one included
// (`packages/harness-fake/src/Session.ts`), and `TurnIngest`'s `itemFields` copies `streaming`
// straight off the harness item. So `firstIntermediate` and `botEntries[0]` are THE SAME OBJECT
// and the formula is `x - x = 0`: it reports 0 ms for a 0 ms delay AND for a 10 s one.
//
// These tests pin the replacement: the reference point is the ARM MARK (the page's
// `performance.now()` at the moment the turn was started), which is a different object from the
// first item and therefore a real elapsed time.

import { expect, test } from "bun:test"
import { firstVisibleDelayMs } from "../test/e2e/us7-measure.ts"

// The old formula, verbatim, so the contrast is checkable rather than remembered.
const oldFirstVisibleMs = (items: ReadonlyArray<{ at: number; streaming: boolean }>): number => {
  const firstIntermediate = items.find((i) => i.streaming)
  if (firstIntermediate === undefined) return -1
  return Math.round(firstIntermediate.at - (items[0]?.at ?? firstIntermediate.at))
}

test("E-7: the delay is measured from the arm mark, not from the first item", () => {
  expect(firstVisibleDelayMs(1000, 1045)).toBe(45)
  expect(firstVisibleDelayMs(1000, 1500)).toBe(500)
})

test("E-7: the old formula could not tell a 0 ms delay from a 10 s one — the new one can", () => {
  // Reality A: the first intermediate state arrives immediately.
  const immediate = [{ at: 1000, streaming: true }]
  // Reality B: the first intermediate state arrives 4 s late (the window held it back).
  const held = [{ at: 5000, streaming: true }]
  // Reality C: 10 s late.
  const veryLate = [{ at: 11_000, streaming: true }]

  // The OLD formula: all three read 0 — the defect.
  expect(oldFirstVisibleMs(immediate)).toBe(0)
  expect(oldFirstVisibleMs(held)).toBe(0)
  expect(oldFirstVisibleMs(veryLate)).toBe(0)

  // The NEW formula: the arm mark is 1000 in all three, so the delay is real.
  expect(firstVisibleDelayMs(1000, immediate[0]!.at)).toBe(0)
  expect(firstVisibleDelayMs(1000, held[0]!.at)).toBe(4000)
  expect(firstVisibleDelayMs(1000, veryLate[0]!.at)).toBe(10_000)
})

test("E-7: the delay is never armed → there is nothing to measure (-1, not 0)", () => {
  // -1 and 0 are different facts: "-1 = not measured" vs "0 = measured, no delay". Reporting 0
  // for an unmeasured state is the same class of defect as the formula this replaced.
  expect(firstVisibleDelayMs(null, 1000)).toBe(-1)
  expect(firstVisibleDelayMs(1000, undefined)).toBe(-1)
  expect(firstVisibleDelayMs(null, undefined)).toBe(-1)
})

test("E-7: a negative delay is reported as-is (the arm mark is on the page's clock, so it cannot be)", () => {
  // A guard, not a hope: if the clocks ever do not line up, the number must show it rather than
  // be silently turned into a plausible-looking positive delay.
  expect(firstVisibleDelayMs(2000, 1000)).toBe(-1000)
})

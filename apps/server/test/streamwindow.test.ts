/**
 * The LiveHub publish window, end to end (architecture A-9, product spec §2.8 C-1).
 *
 * This test drives a **real brain** over the real RPC/WebSocket and counts the changes the
 * **client** applied — the counting point C-1 fixes. It runs the same fixture twice, with the
 * window on (`streamWindowMaxPending: 4`) and off (`: 1`, the unmerged control), and compares the
 * two numbers.
 *
 * The point is not the exact ratio (that is Dev-B's E-5 job, with a proper measurement setup) but
 * that **the switch works and the client sees fewer changes with the window on**.
 *
 * Only the **echoed** reply is counted: a bot greets its owner first, and that greeting is a
 * separate entry — counting it would mix two entries' lifecycles into one number.
 */
import { describe, expect, test } from "bun:test"
import type { ConversationId } from "@openbot/contracts"
import { Effect, Ref } from "effect"
import { eventually, login, rpcClient, startServer, watchConversation } from "./helpers.ts"

/** A reply long enough to stream in many chunks (the fake harness splits on words). */
const LONG_REPLY = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ")

/**
 * The number of `entry.upserted` changes the client applied **for the echoed message** — the
 * message whose text is the echo. The count is taken from the client's own stream, not from the
 * server (C-1: the counting point is the client application side).
 */
const echoUpserts = async (
  server: Awaited<ReturnType<typeof startServer>>,
  cookie: string,
  conversationId: ConversationId,
  clientNonce: string,
): Promise<number> => {
  let count = 0
  await server.run(
    Effect.gen(function*() {
      const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
      const convo = yield* watchConversation(client, conversationId)
      yield* client["messages.send"]({ conversationId, text: `echo: ${LONG_REPLY}`, clientNonce })
      const items = yield* eventually(
        Ref.get(convo.items),
        (all) =>
          all.some((item) =>
            item.kind === "change" && item.change.type === "entry.upserted" &&
            item.change.entry.kind === "message" && item.change.entry.role === "bot" &&
            item.change.entry.streaming === false &&
            item.change.entry.text.includes("word29")),
        { label: "the echoed message", timeout: 20_000 },
      )
      count = items.filter((item) =>
        item.kind === "change" && item.change.type === "entry.upserted" &&
        item.change.entry.kind === "message" && item.change.entry.role === "bot" &&
        item.change.entry.text.includes("word")).length
    }),
  )
  return count
}

/** Starts a brain with the given window setting, creates a bot, and returns the DM's id. */
const withBot = async (
  server: Awaited<ReturnType<typeof startServer>>,
  cookie: string,
  nonce: string,
): Promise<ConversationId> =>
  server.run(
    Effect.gen(function*() {
      const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
      const bot = yield* client["bots.create"]({
        name: "Window",
        harness: { kind: "fake" },
        autonomy: "ask",
        clientNonce: nonce,
      })
      return bot.directConversationId
    }),
  )

describe("the publish window, end to end", () => {
  test("the window on merges the stream; the unmerged control publishes every change", async () => {
    // The window off: every change is published on its own (K=1 degenerates to "publish now").
    const control = await startServer({ config: { streamWindowMaxPending: 1 } })
    let controlCount = 0
    try {
      const cookie = await login(control.base, control.ownerToken)
      const conversationId = await withBot(control, cookie, "win-control")
      controlCount = await echoUpserts(control, cookie, conversationId, "win-control-1")
    } finally {
      await control.close()
    }

    // The window on: intermediate states are buffered and published in batches.
    const merged = await startServer({ config: { streamWindowMaxPending: 4 } })
    let mergedCount = 0
    try {
      const cookie = await login(merged.base, merged.ownerToken)
      const conversationId = await withBot(merged, cookie, "win-merged")
      mergedCount = await echoUpserts(merged, cookie, conversationId, "win-merged-1")
    } finally {
      await merged.close()
    }

    // The control published strictly more changes than the window did.
    expect(controlCount).toBeGreaterThan(mergedCount)
    // The window really merged: it is not "one change either way", and it still published some.
    expect(mergedCount).toBeGreaterThan(0)
    // The unmerged control published at least one change per streamed word, plus the terminal one.
    expect(controlCount).toBeGreaterThanOrEqual(LONG_REPLY.split(" ").length)
  })
})

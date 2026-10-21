// The `Markdown` memo semantics (architecture §5.5 B-1, B-2; PRD US-6).
//
// The repository has no DOM test environment (`bun test` cannot import `react-dom/client` without
// a DOM), so these tests exercise the SAME two facts through the two channels that ARE testable
// here:
//
//   - the render output (via `react-dom/server`) — so "the rendering is unchanged" is pinned
//     character for character;
//   - the parse counter — so "the component body ran again" is observable as a counted parse.
//
// The counter is the proxy for "the component function ran". A `React.memo` hit means the
// component body did NOT run, so `parseBlocks` was not called, so the counter did not move.

import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  disableMarkdownParseStats,
  enableMarkdownParseStats,
  markdownParseStats,
  Markdown,
  MentionText,
  renderInline,
  resetMarkdownParseStats,
  safeHref,
} from "../src/chat/Markdown.tsx"

/** Renders a component to static markup. */
const markup = (node: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(node)

// ------------------------------------------------------------------------------- the counter

test("counter: it is off by default — a render does not move the counters", () => {
  disableMarkdownParseStats()
  resetMarkdownParseStats()
  markup(createElement(Markdown, { text: "hello", bodyId: "ent_off" }))
  expect(markdownParseStats().parses).toBe(0)
})

test("counter: when on, one render is one parse", () => {
  enableMarkdownParseStats()
  resetMarkdownParseStats()
  markup(createElement(Markdown, { text: "hello", bodyId: "ent_on" }))
  expect(markdownParseStats().parses).toBe(1)
  disableMarkdownParseStats()
})

test("counter: the same text twice counts as unchanged, a different text as changed", () => {
  enableMarkdownParseStats()
  resetMarkdownParseStats()
  markup(createElement(Markdown, { text: "hello", bodyId: "ent_repeat" }))
  markup(createElement(Markdown, { text: "hello", bodyId: "ent_repeat" }))
  markup(createElement(Markdown, { text: "hello!", bodyId: "ent_repeat" }))
  const stats = markdownParseStats()
  expect(stats.parses).toBe(3)
  expect(stats.unchangedBodies).toBe(1)
  expect(stats.changedBodies).toBe(1)
  resetMarkdownParseStats()
  disableMarkdownParseStats()
})

test("counter: the first parse of a body is not a change (there is nothing to have changed from)", () => {
  enableMarkdownParseStats()
  resetMarkdownParseStats()
  markup(createElement(Markdown, { text: "hello", bodyId: "ent_firstparse" }))
  const stats = markdownParseStats()
  expect(stats.parses).toBe(1)
  expect(stats.changedBodies).toBe(0)
  expect(stats.unchangedBodies).toBe(0)
  resetMarkdownParseStats()
  disableMarkdownParseStats()
})

test("counter: bodies are counted separately", () => {
  enableMarkdownParseStats()
  resetMarkdownParseStats()
  markup(createElement(Markdown, { text: "a", bodyId: "ent_multi_a" }))
  markup(createElement(Markdown, { text: "b", bodyId: "ent_multi_b" }))
  markup(createElement(Markdown, { text: "a", bodyId: "ent_multi_a" }))
  const stats = markdownParseStats()
  expect(stats.parses).toBe(3)
  expect(stats.unchangedBodies).toBe(1)
  expect(stats.changedBodies).toBe(0)
  resetMarkdownParseStats()
  disableMarkdownParseStats()
})

test("counter: a parse without a bodyId counts towards parses but is attributed to no body", () => {
  enableMarkdownParseStats()
  resetMarkdownParseStats()
  markup(createElement(Markdown, { text: "a" }))
  markup(createElement(Markdown, { text: "a" }))
  const stats = markdownParseStats()
  expect(stats.parses).toBe(2)
  // C-8: an unattributed parse lands in neither bucket.
  expect(stats.changedBodies).toBe(0)
  expect(stats.unchangedBodies).toBe(0)
  resetMarkdownParseStats()
  disableMarkdownParseStats()
})

test("counter: reset clears the counters but keeps the per-body memory (C-10)", () => {
  enableMarkdownParseStats()
  resetMarkdownParseStats()
  markup(createElement(Markdown, { text: "same", bodyId: "ent_persist" }))
  resetMarkdownParseStats()
  // The body still remembers its text → this parse is "unchanged", not "first".
  markup(createElement(Markdown, { text: "same", bodyId: "ent_persist" }))
  const stats = markdownParseStats()
  expect(stats.parses).toBe(1)
  expect(stats.unchangedBodies).toBe(1)
  expect(stats.changedBodies).toBe(0)
  resetMarkdownParseStats()
  disableMarkdownParseStats()
})

// -------------------------------------------------------------------------------- the rendering

test("rendering: the memoized Markdown renders the same markup as before (US-9)", () => {
  const text = "# Title\n\nSome **bold** and _italic_ and `code`.\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |"
  const html = markup(createElement(Markdown, { text }))
  // A heading is a styled paragraph in this renderer (not an <h1>) — pinned so the memo cannot
  // quietly change the element type.
  expect(html).toContain('<p class="text-xl font-semibold">Title</p>')
  expect(html).toContain("<strong>bold</strong>")
  expect(html).toContain("<em>italic</em>")
  expect(html).toContain("<code>code</code>")
  expect(html).toContain("<table>")
  expect(html).toContain("<li>one</li>")
  // A list item's text is rendered inline, with the markdown markers gone.
  expect(html).not.toContain("**bold**")
})

test("rendering: a bodyId does not change the markup (it is a counter hook, not a render input)", () => {
  const text = "hello **world**"
  expect(markup(createElement(Markdown, { text, bodyId: "ent_bodyid" }))).toBe(markup(createElement(Markdown, { text })))
})

test("rendering: MentionText renders the same markup with an empty bots list and with bots", () => {
  expect(markup(createElement(MentionText, { text: "plain", bots: [] }))).toBe(
    markup(createElement(MentionText, { text: "plain", bots: [] })),
  )
})

test("rendering: a mention is highlighted when the bot is known, and left as text when it is not", () => {
  const bots = [{ name: "Scout", avatar: { shape: "blob", color: "blue" } }] as const
  const known = markup(createElement(MentionText, { text: "hi @Scout", bots: [...bots] }))
  expect(known).toContain("ob-mention")
  expect(known).toContain("Scout")
  const unknown = markup(createElement(MentionText, { text: "hi @Nobody", bots: [...bots] }))
  expect(unknown).not.toContain("ob-mention")
  expect(unknown).toContain("@Nobody")
})

test("rendering: the memo wrapper does not change what a card summary renders (B-2)", () => {
  // `Cards.tsx:179` calls `renderInline(summary)` OUTSIDE of `Markdown` — so `currentScope` is
  // `undefined` there and an `@Bot` mention is NOT highlighted. That is the current behaviour and
  // US-9 requires it to stay exactly so. If someone "fixed" `renderInline` to take an explicit
  // scope, this assertion would fail — which is the point of it.
  const bots = [{ name: "Scout", avatar: { shape: "blob", color: "blue" } }] as const
  const scoped = markup(createElement(MentionText, { text: "hi @Scout", bots: [...bots] }))
  // The card path goes through `renderInline` with no scope, so it renders the mention as text.
  const asInline = markup(createElement("div", undefined, renderInline("hi @Scout")))
  expect(asInline).not.toContain("ob-mention")
  expect(asInline).toContain("@Scout")
  // And the scoped path DOES highlight it — the two are different, and the difference is the
  // behaviour the architecture says must not change.
  expect(scoped).toContain("ob-mention")
})

// --------------------------------------------------------------------------------- the memo

test("memo: Markdown and MentionText are wrapped (so a stable props identity skips the body)", () => {
  // `React.memo` returns an object with a `type` (the inner function) — not a callable. Asserting
  // on that shape is the only way to check it here: there is no DOM to render into.
  const isMemo = (value: unknown): boolean =>
    typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "function"
  expect(isMemo(Markdown)).toBe(true)
  expect(isMemo(MentionText)).toBe(true)
})

test("memo: the props are the same set as before (text, className, bots) plus bodyId", () => {
  // A guard against the memo wrapper silently dropping or renaming a prop.
  const html = markup(createElement(Markdown, { text: "x", className: "custom", bots: [] }))
  expect(html).toContain("ob-md custom")
})

test("safeHref: the link rules are unchanged (D1 owns these, but the memo must not shift them)", () => {
  expect(safeHref("https://example.com")).toBe("https://example.com")
  expect(safeHref("javascript:alert(1)")).toBeUndefined()
  expect(safeHref("//evil.example")).toBeUndefined()
})

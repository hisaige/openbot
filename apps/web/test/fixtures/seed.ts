// Fixed seed and text distribution for the long-conversation fixture (architecture §3.3).
//
// The fixture must be reproducible: two runs of the generator must produce the same entries, the
// same sizes and the same content distribution. So nothing here may call `Math.random()` or read
// the clock — the "random" choices come from a small LCG seeded by `FIXTURE_SEED`.
//
// The distribution is fixed by the architecture (§3.3):
//   - ≥ 2000 entries
//   - average body ≥ 500 characters
//   - ≥ 10% of entries carry rich text (table / code block / list / image)
//
// `RICH_EVERY` is what makes the rich share land on 10%+: every 8th entry is rich, and the other
// kinds are plain prose.

/** The one seed. Changing it changes every generated entry — so it is written down, not random. */
export const FIXTURE_SEED = 20261021

/** Every 8th entry is rich (12.5% ≥ the 10% the architecture asks for). */
export const RICH_EVERY = 8

/** The four rich kinds, picked in rotation (no randomness needed for the kind itself). */
export const RICH_KINDS = ["table", "code", "list", "image"] as const
export type RichKind = (typeof RICH_KINDS)[number]

/** Words the prose is assembled from. Fixed list → the text is reproducible. */
export const WORDS = [
  "checkpoint", "latency", "throughput", "replica", "cursor", "window", "stall", "flush",
  "payload", "snapshot", "resume", "coalesce", "pending", "terminal", "publish", "sequence",
  "epoch", "replay", "bundle", "hydrate", "render", "commit", "index", "shard", "digest",
  "trace", "budget", "margin", "yield", "backpressure", "fence", "lease", "quota", "gossip",
] as const

/**
 * A tiny linear congruential generator (Numerical Recipes constants): `x = 1664525x + 1013904223`
 * mod 2^32. Deterministic across engines — `Math.random()` is not, and the fixture must be.
 */
export const makeRng = (seed: number): (() => number) => {
  let x = seed >>> 0
  return () => {
    x = (Math.imul(1664525, x) + 1013904223) >>> 0
    return x / 0x1_0000_0000
  }
}

/** Picks one of `items` with the given generator. */
export const pick = <T>(rng: () => number, items: ReadonlyArray<T>): T => items[Math.floor(rng() * items.length)]!

/**
 * One paragraph of prose: `wordCount` words, each followed by a space (the fake harness splits the
 * same way, so the streamed text and the final text agree character for character).
 */
export const prose = (rng: () => number, wordCount: number): string => {
  const words: string[] = []
  for (let i = 0; i < wordCount; i++) words.push(pick(rng, WORDS))
  return words.join(" ") + "."
}

/** A markdown table with a header row and `rows` body rows. */
export const table = (rng: () => number, rows: number): string => {
  const head = "| metric | p50 | p99 |"
  const sep = "| --- | --- | --- |"
  const body: string[] = []
  for (let i = 0; i < rows; i++) {
    const a = Math.floor(rng() * 900) + 10
    const b = Math.floor(rng() * 900) + 10
    body.push(`| ${pick(rng, WORDS)} | ${a}ms | ${b}ms |`)
  }
  return [head, sep, ...body].join("\n")
}

/** A fenced code block. */
export const code = (rng: () => number): string => {
  const lines: string[] = []
  for (let i = 0; i < 8; i++) lines.push(`  const ${pick(rng, WORDS)} = ${Math.floor(rng() * 1000)}`)
  return ["```ts", ...lines, "```"].join("\n")
}

/** A bullet list. */
export const list = (rng: () => number, items: number): string => {
  const out: string[] = []
  for (let i = 0; i < items; i++) out.push(`- ${prose(rng, 6)}`)
  return out.join("\n")
}

/**
 * A rich block. The image is an inline markdown image pointing at a relative attachment URL — the
 * web renderer turns it into an `<img>`; it is never fetched in the DOM-count measurement (the
 * image 404s, which is fine: the node exists either way).
 */
export const rich = (rng: () => number, kind: RichKind): string => {
  switch (kind) {
    case "table":
      return `### ${pick(rng, WORDS)}\n\n${table(rng, 4)}`
    case "code":
      return `### ${pick(rng, WORDS)}\n\n${code(rng)}`
    case "list":
      return `### ${pick(rng, WORDS)}\n\n${list(rng, 5)}`
    case "image":
      return `### ${pick(rng, WORDS)}\n\n![${pick(rng, WORDS)}](/api/attachments/att_fixture_missing.png)`
  }
}

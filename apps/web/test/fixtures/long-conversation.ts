// The long-conversation fixture (architecture §3.3, PRD US-1): a deterministic set of transcript
// entries written straight into the brain's `entries` table, so the web client has a real history
// to render, paginate and scroll.
//
// Why write to the database instead of sending 2000 messages: the fake harness would stream every
// one of them (60 ms per word), and the wall clock alone would be hours. The fixture is a
// *starting state*, not a scenario.
//
// The payload shape is the one the server itself writes (verified against a live brain, not
// guessed): a `message` entry is
//
//   { id, conversationId, revision, createdAt, updatedAt, author, kind: "message", role: "bot",
//     text, attachments: [], streaming: false, turnId? }
//
// and the row is `(id, conversation_id, revision, created_at, kind, turn_id, client_nonce,
// native_id, payload_json)`.
//
// Nothing here is on the production path: this file is only imported by tests.

import { Database } from "bun:sqlite"
import type { ConversationId } from "@openbot/contracts"
import { makeRng, prose, rich, RICH_EVERY, RICH_KINDS } from "./seed.ts"

/** The fixture's entry count. The architecture asks for ≥ 2000; 2000 exactly keeps it comparable. */
export const FIXTURE_ENTRY_COUNT = 2000

/** The average body length the architecture asks for (≥ 500 characters). */
export const FIXTURE_MIN_AVG_CHARS = 500

/** Entries are 1000 ms apart, so `created_at` is strictly increasing (the paging index needs it). */
export const FIXTURE_INTERVAL_MS = 1000

/**
 * The default base timestamp: a fixed instant, so two runs produce identical rows.
 *
 * The seeder normally overrides it with the conversation's own `lastActivityAt` — the bot's
 * greeting must be the OLDEST message, not the newest.
 */
export const FIXTURE_BASE_AT = 1_700_000_000_000

/** The id prefix the architecture pins (`ent_fix_<6 位序号>`). */
export const fixtureEntryId = (index: number): string => `ent_fix_${String(index).padStart(6, "0")}`

/**
 * The word count of a plain entry's body. 88 words × ~6 characters ≈ 530 characters, which clears
 * the 500-character average once the rich entries (which are longer) are mixed in.
 */
const PLAIN_WORDS = 88

export interface FixtureEntry {
  readonly id: string
  readonly conversationId: ConversationId
  readonly revision: number
  readonly createdAt: number
  readonly kind: "message"
  readonly payloadJson: string
}

/**
 * The generated entries, oldest first. Deterministic: same `conversationId` + same seed → same
 * list, every time.
 */
export const buildFixtureEntries = (
  conversationId: ConversationId,
  botId: string,
  options?: { readonly count?: number; readonly seed?: number; readonly baseAt?: number },
): ReadonlyArray<FixtureEntry> => {
  const count = options?.count ?? FIXTURE_ENTRY_COUNT
  const rng = makeRng(options?.seed ?? 20261021)
  const out: FixtureEntry[] = []
  // The rich kinds rotate over the RICH entries. Counting only the rich ones matters: the rich
  // entries all sit at indices ≡ 7 (mod 8) and RICH_EVERY (8) is a multiple of RICH_KINDS.length
  // (4), so indexing by `i % 4` would pick the SAME kind for every rich entry.
  let richSeen = 0
  for (let i = 0; i < count; i++) {
    const createdAt = (options?.baseAt ?? FIXTURE_BASE_AT) + i * FIXTURE_INTERVAL_MS
    const id = fixtureEntryId(i)
    // Every 8th entry is rich (12.5% ≥ the 10% the architecture asks for).
    const isRich = i % RICH_EVERY === RICH_EVERY - 1
    const text = isRich
      ? `${prose(rng, 12)}\n\n${rich(rng, RICH_KINDS[richSeen++ % RICH_KINDS.length]!)}`
      : prose(rng, PLAIN_WORDS)
    const payload = {
      id,
      conversationId,
      revision: 0,
      createdAt,
      updatedAt: createdAt,
      author: { kind: "bot", botId },
      kind: "message",
      role: "bot",
      text,
      attachments: [],
      streaming: false,
    }
    out.push({ id, conversationId, revision: 0, createdAt, kind: "message", payloadJson: JSON.stringify(payload) })
  }
  return out
}

/** The summary of a generated fixture: what the handoff has to report. */
export interface FixtureStats {
  readonly count: number
  readonly totalChars: number
  readonly avgChars: number
  readonly minChars: number
  readonly maxChars: number
  readonly richCount: number
  readonly richShare: number
  readonly byKind: Readonly<Record<string, number>>
}

/** Measures a generated fixture (the numbers the handoff's §8.2 "工作集" row has to carry). */
export const measureFixture = (entries: ReadonlyArray<FixtureEntry>): FixtureStats => {
  let total = 0
  let min = Number.POSITIVE_INFINITY
  let max = 0
  let richCount = 0
  const byKind: Record<string, number> = {}
  for (const e of entries) {
    const payload = JSON.parse(e.payloadJson) as { text: string }
    const chars = payload.text.length
    total += chars
    if (chars < min) min = chars
    if (chars > max) max = chars
    const kind = payload.text.includes("```") ? "code" : payload.text.includes("| ---") ? "table" : payload.text.includes("\n- ") ? "list" : payload.text.includes("![") ? "image" : "prose"
    byKind[kind] = (byKind[kind] ?? 0) + 1
    if (kind !== "prose") richCount++
  }
  return {
    count: entries.length,
    totalChars: total,
    avgChars: Math.round(total / Math.max(1, entries.length)),
    minChars: Number.isFinite(min) ? min : 0,
    maxChars: max,
    richCount,
    richShare: richCount / Math.max(1, entries.length),
    byKind,
  }
}

/**
 * Writes the entries into a brain's database.
 *
 * The caller must have stopped the brain first: SQLite serialises writers, and the live brain
 * holds the file open. (This is exactly why `fixture-brain.ts` implements its own stop that does
 * not delete the data dir.)
 */
export const writeFixtureEntries = (databasePath: string, entries: ReadonlyArray<FixtureEntry>): number => {
  const db = new Database(databasePath)
  try {
    const insert = db.prepare(
      "INSERT INTO entries (id, conversation_id, revision, created_at, kind, turn_id, client_nonce, native_id, payload_json) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)",
    )
    const tx = db.transaction((rows: ReadonlyArray<FixtureEntry>) => {
      for (const e of rows) {
        insert.run(e.id, e.conversationId, e.revision, e.createdAt, e.kind, e.payloadJson)
      }
    })
    tx(entries)
    return entries.length
  } finally {
    db.close()
  }
}

/** The conversation's `last_activity_at` has to point at the newest fixture entry, or the sidebar
 * and the "unread" bookkeeping disagree with the transcript.
 */
export const touchConversation = (databasePath: string, conversationId: ConversationId, lastActivityAt: number): void => {
  const db = new Database(databasePath)
  try {
    db.prepare("UPDATE conversations SET last_activity_at = ? WHERE id = ?").run(lastActivityAt, conversationId)
  } finally {
    db.close()
  }
}

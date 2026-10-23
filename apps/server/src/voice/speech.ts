/**
 * Voice calls (experiment): the Bot's written words as speech. Its messages are cut into sentences
 * as they stream in (each goes to Kokoro on its own), without markdown, links or list marks.
 */

/** The Bot's written answer as something to say: no markdown, links or list marks. */
export const speakable = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>]+/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-•]|\d+[.)])\s+/, "").trim())
    .filter((line) => line !== "")
    .map((line) => (/[.!?:;,]$/.test(line) ? line : `${line}.`))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()

const SENTENCE_END = /[.!?…]+["'”’)\]]*\s+/g
/** A long first sentence starts at a comma so the first words are heard sooner. */
const FIRST_CLAUSE_MIN_CHARS = 60

/** Cuts spoken text into sentences as it arrives (each goes to Kokoro on its own). */
export class SentenceChunker {
  private pending = ""
  private emitted = 0

  push(text: string): Array<string> {
    this.pending += text
    const out: Array<string> = []
    let start = 0
    for (const match of this.pending.matchAll(SENTENCE_END)) {
      const end = match.index + match[0].length
      const sentence = this.pending.slice(start, end).trim()
      if (sentence !== "") out.push(sentence)
      start = end
    }
    this.pending = this.pending.slice(start)
    if (this.emitted === 0 && out.length === 0 && this.pending.length > FIRST_CLAUSE_MIN_CHARS) {
      const comma = this.pending.indexOf(", ", FIRST_CLAUSE_MIN_CHARS / 2)
      if (comma !== -1) {
        out.push(this.pending.slice(0, comma + 1).trim())
        this.pending = this.pending.slice(comma + 2)
      }
    }
    this.emitted += out.length
    return out
  }

  /** What is pending, if it is a whole sentence ("Let me check." before the Bot goes quiet to work). */
  takeFinished(): string | undefined {
    const rest = this.pending.trim()
    if (!/[.!?…]["'”’)\]]*$/.test(rest)) return undefined
    this.pending = ""
    this.emitted++
    return rest
  }

  /** What is left once the text is complete. */
  flush(): string | undefined {
    const rest = this.pending.trim()
    this.pending = ""
    if (rest === "") return undefined
    this.emitted++
    return rest
  }
}

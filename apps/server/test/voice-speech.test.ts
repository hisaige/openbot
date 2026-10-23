// Voice calls (experiment): the Bot's written words as speech.
import { describe, expect, test } from "bun:test"
import { SentenceChunker, speakable } from "../src/voice/speech.ts"

describe("voice speech", () => {
  test("the Bot's written answer becomes something to say", () => {
    expect(speakable("**Tomorrow** is light:\n- 9:00 reminder\n- 11:30 Devenders ([invite](https://cal.example/x))\n\nNothing after `that`")).toBe(
      "Tomorrow is light: 9:00 reminder. 11:30 Devenders (invite). Nothing after that.",
    )
  })

  test("sentences come out as soon as they end; a long first one starts at a comma", () => {
    const chunker = new SentenceChunker()
    expect(chunker.push("On it. I'll ch")).toEqual(["On it."])
    expect(chunker.push("eck Slack now! And")).toEqual(["I'll check Slack now!"])
    expect(chunker.push(" then")).toEqual([])
    expect(chunker.flush()).toBe("And then")
    expect(chunker.flush()).toBeUndefined()

    const long = new SentenceChunker()
    expect(long.push("Anthony replied in the eng channel this afternoon, saying the plan looks good")).toEqual(["Anthony replied in the eng channel this afternoon,"])
    expect(long.push(" but wants Karl's access kept. ")).toEqual(["saying the plan looks good but wants Karl's access kept."])
  })
})

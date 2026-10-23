// Voice calls (experiment): what the Bot is sent for the owner's words on a call.
import { describe, expect, test } from "bun:test"
import { voiceText } from "../src/voice/service.ts"

describe("voice messages to the Bot", () => {
  test("the first one says how a call works; every one asks for a word before tools", () => {
    const first = voiceText("What's on tomorrow?", true)
    expect(first).toContain("We're on a voice call now.")
    expect(first).toContain("Me: What's on tomorrow?")
    const later = voiceText("And my email?", false)
    expect(later).not.toContain("We're on a voice call now.")
    expect(later).toContain("Me (on the call): And my email?")
    for (const text of [first, later]) expect(text).toContain("first write one short sentence saying what you're about to do")
  })

  test("an interruption says how far the Bot got; a stop says its work was stopped", () => {
    const cut = voiceText("Wait, which one?", false, { heard: "At 11:30 it's Devenders, and Break…" })
    expect(cut).toContain(`All I heard was: "At 11:30 it's Devenders, and Break…" The rest wasn't said.`)
    expect(voiceText("Hold on.", false, { heard: "nothing yet" })).toContain("I cut you off before you said anything.")
    expect(voiceText("Stop.", false, { stopped: true })).toContain("(I stopped what you were working on.)")
  })

  test("asked while still working on the last request: acknowledge it and tell what's already found", () => {
    const busy = voiceText("Is it going to rain tomorrow?", false, { busy: true })
    expect(busy).toContain("You're still on what I asked before. First say in a few words that you'll do this too")
    expect(busy.indexOf("You're still on")).toBeLessThan(busy.indexOf("Me (on the call): Is it going to rain tomorrow?"))
    expect(voiceText("Stop.", false, { busy: true, stopped: true })).not.toContain("You're still on")
  })
})

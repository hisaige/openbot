// Voice calls (experiment): turn taking, the owner's words going to the Bot (an unfinished sentence
// waits for the rest), what the Bot writes being spoken as it streams, and being talked over. Stand-ins for
// Parakeet and Kokoro; the Bot is played by the test.
import { describe, expect, test } from "bun:test"
import type { VoiceServerMessage } from "@openbot/contracts"
import { type AskNote, CALL_INPUT_SAMPLE_RATE, type CallDeps, isBackchannel, isStop, toPcm16, VoiceCall } from "../src/voice/call.ts"

const tone = (seconds: number, amplitude = 0.3) => {
  const samples = new Float32Array(Math.round(CALL_INPUT_SAMPLE_RATE * seconds))
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / CALL_INPUT_SAMPLE_RATE)
  return toPcm16(samples)
}
const quiet = (seconds: number) => tone(seconds, 0.001)

const until = async (check: () => boolean, label: string, timeoutMs = 2_000) => {
  for (let waited = 0; waited < timeoutMs && !check(); waited += 10) await Bun.sleep(10)
  if (!check()) throw new Error(`timed out: ${label}`)
}

/** Feeds audio in 100 ms chunks, the way the app sends it. */
const say = async (call: VoiceCall, pcm: Uint8Array) => {
  const chunk = CALL_INPUT_SAMPLE_RATE * 0.1 * 2
  for (let at = 0; at < pcm.length; at += chunk) {
    call.audio(pcm.subarray(at, at + chunk))
    await Bun.sleep(1)
  }
}

/** `audioSeconds`: how long each spoken sentence plays (the default is nearly instant). */
const makeCall = (heard: ReadonlyArray<string>, speakMs = 1, audioSeconds?: number) => {
  const sent: Array<VoiceServerMessage> = []
  const audio: Array<number> = []
  const asked: Array<{ words: string; first: boolean; note?: AskNote }> = []
  let next = 0
  const deps: CallDeps = {
    transcribe: async () => {
      const text = heard[next++] ?? ""
      return { append: async () => text.split(" ")[0] ?? "", finish: async () => text, discard: () => undefined }
    },
    speak: async (text) => {
      await Bun.sleep(speakMs)
      return new Float32Array(audioSeconds === undefined ? text.length * 10 : Math.round(24_000 * audioSeconds))
    },
    ask: (words, first, note) => void asked.push({ words, first, ...(Object.keys(note).length === 0 ? {} : { note }) }),
    send: (message) => sent.push(message),
    sendAudio: (pcm) => audio.push(pcm.length),
    log: () => undefined,
  }
  const call = new VoiceCall(deps)
  call.start()
  const spoken = () => sent.flatMap((m) => (m.type === "bot" ? [m.text] : []))
  return { call, sent, audio, asked, spoken }
}

/** The Bot writing a message, a few words at a time. */
const stream = async (call: VoiceCall, id: string, text: string) => {
  const words = text.split(/(?<= )/)
  let so = ""
  for (const word of words) {
    so += word
    call.botText(id, so, false)
    await Bun.sleep(2)
  }
  call.botText(id, so, true)
}

describe("a voice call", () => {
  test("the owner's words go to the Bot; what it writes is spoken sentence by sentence as it streams", async () => {
    const { call, sent, audio, asked, spoken } = makeCall(["How's it going?", "And tomorrow?"])
    await say(call, quiet(0.5))
    await say(call, tone(1))
    await say(call, quiet(0.8))
    await until(() => asked.length === 1, "asked")
    expect(asked).toEqual([{ words: "How's it going?", first: true }])
    expect(sent).toContainEqual({ type: "you", text: "How's it going?", final: true })
    await stream(call, "m1", "Pretty **good**. Just finished the roles plan")
    await until(() => spoken().length === 2, "spoken")
    expect(spoken()).toEqual(["Pretty good.", "Just finished the roles plan."])
    expect(audio).toHaveLength(2)
    call.botDone(false)
    call.played()
    await until(() => sent.at(-1)?.type === "phase", "listening")
    expect(sent.filter((m) => m.type === "phase").map((m) => m.type === "phase" && m.phase)).toEqual(["listening", "hearing", "thinking", "speaking", "listening"])
    await say(call, tone(1))
    await say(call, quiet(0.8))
    await until(() => asked.length === 2, "asked again")
    expect(asked[1]).toEqual({ words: "And tomorrow?", first: false })
    expect(call.summary().lines).toEqual([
      { who: "you", text: "How's it going?" },
      { who: "bot", text: "Pretty good. Just finished the roles plan." },
      { who: "you", text: "And tomorrow?" },
    ])
  })

  test("a sentence the Bot wrote before going quiet to work is said without waiting for the rest", async () => {
    const { call, asked, spoken } = makeCall(["What's on tomorrow?"])
    await say(call, tone(1))
    await say(call, quiet(0.8))
    await until(() => asked.length === 1, "asked")
    // "Let me look at your calendar." and then a tool runs: the message isn't final yet
    call.botText("m1", "Let me look at your calendar.", false)
    await until(() => spoken().length === 1, "said while it works", 1_000)
    expect(spoken()).toEqual(["Let me look at your calendar."])
    call.botText("m1", "Let me look at your calendar.", true)
    await Bun.sleep(50)
    expect(spoken()).toHaveLength(1)
  })

  test("what the Bot says while the owner is talking (a result coming in) waits until they finish", async () => {
    const { call, asked, spoken } = makeCall(["Check my whole inbox.", "And the calendar?"])
    await say(call, tone(1))
    await say(call, quiet(0.8))
    await until(() => asked.length === 1, "asked")
    // the owner starts talking again; meanwhile the inbox result comes in
    await say(call, tone(0.5))
    call.botText("m1", "Your inbox is clear.", true)
    await Bun.sleep(200)
    expect(spoken()).toEqual([])
    await say(call, tone(0.3))
    await say(call, quiet(0.8))
    await until(() => spoken().includes("Your inbox is clear."), "said once they finished")
    expect(asked[1]?.words).toBe("And the calendar?")
  })

  test("an unfinished sentence waits for the rest: a pause mid-thought sends it as one", async () => {
    const { call, asked, sent, spoken } = makeCall(["Uh can you", "message engineering?", "Thanks"])
    await say(call, tone(0.8))
    await say(call, quiet(0.8))
    await Bun.sleep(300)
    expect(asked).toEqual([])
    await say(call, tone(0.8))
    await say(call, quiet(0.8))
    await until(() => asked.length === 1, "asked")
    expect(asked).toEqual([{ words: "Uh can you message engineering?", first: true }])
    expect(sent.filter((m) => m.type === "you" && m.final)).toEqual([{ type: "you", text: "Uh can you message engineering?", final: true }])
    // nothing more came: after a moment it goes as it is
    await say(call, tone(0.8))
    await say(call, quiet(0.8))
    await until(() => asked.length === 2, "asked again", 3_000)
    expect(asked[1]).toEqual({ words: "Thanks", first: false })
    // no fillers: the Bot's own words only
    expect(spoken()).toEqual([])
  })

  test("a silent reply says nothing; a failed turn says so", async () => {
    const { call, asked, spoken } = makeCall(["Thanks."])
    await say(call, tone(1))
    await say(call, quiet(0.8))
    await until(() => asked.length === 1, "asked")
    await stream(call, "m1", "NO_REPLY")
    call.botDone(true)
    await until(() => spoken().length === 1, "the apology")
    expect(spoken()).toEqual(["Sorry, I couldn't do that just now."])
  })

  test("talking over the Bot turns it down, stops it at the first real word, and tells it how far it got", async () => {
    const { call, sent, asked, spoken } = makeCall(["Tell me everything.", "Wait, which one overlaps?"], 5, 0.4)
    await say(call, tone(1))
    await say(call, quiet(0.8))
    await until(() => asked.length === 1, "asked")
    void stream(call, "m1", "First thing. Second thing. Third thing. Fourth thing. Fifth thing. Sixth thing.")
    await until(() => spoken().length >= 2, "speaking")
    // the owner listens to the first sentence (0.4 s) and part of the second
    await Bun.sleep(650)
    // its own voice leaking back quietly is not the owner
    await say(call, tone(0.3, 0.004))
    expect(sent.some((m) => m.type === "duck")).toBe(false)
    await say(call, tone(0.6))
    expect(sent).toContainEqual({ type: "duck" })
    // the first partial is real words ("Wait,"): stopped right away
    await until(() => sent.some((m) => m.type === "stop"), "stopped")
    await say(call, quiet(0.8))
    await until(() => asked.length === 2, "asked again")
    expect(asked[1]!.words).toBe("Wait, which one overlaps?")
    const heard = asked[1]!.note?.heard ?? ""
    expect(heard).toMatch(/^First thing\. /)
    // the rest was already queued in the app ("stop" drops it there): the Bot is told it went unheard
    expect(heard).not.toContain("Sixth")
    // the Bot's next message is spoken
    await stream(call, "m2", "The eleven forty-five one.")
    await until(() => spoken().includes("The eleven forty-five one."), "the next message")
  })

  test("\"mm-hm\" or a cough over the Bot: its voice comes back and it carries on", async () => {
    const { call, sent, asked, spoken } = makeCall(["Go on.", "Mm-hm.", ""], 5, 0.3)
    await say(call, tone(1))
    await say(call, quiet(0.8))
    await until(() => asked.length === 1, "asked")
    void stream(call, "m1", "First thing. Second thing. Third thing. Fourth thing. Fifth thing. Sixth thing.")
    await until(() => spoken().length >= 1, "speaking")
    await say(call, tone(0.5))
    await say(call, quiet(0.8))
    await until(() => sent.some((m) => m.type === "unduck"), "back up")
    await say(call, tone(0.4))
    await say(call, quiet(0.8))
    await until(() => sent.filter((m) => m.type === "unduck").length === 2, "back up after the cough")
    await until(() => spoken().includes("Sixth thing."), "carried on", 5_000)
    expect(sent.some((m) => m.type === "stop")).toBe(false)
    expect(asked).toHaveLength(1)
  })

  test("\"stop\" on its own stops the Bot's work too", async () => {
    const { call, asked } = makeCall(["Check my whole inbox.", "Stop, stop."])
    await say(call, tone(1))
    await say(call, quiet(0.8))
    await until(() => asked.length === 1, "asked")
    await say(call, tone(0.6))
    await say(call, quiet(0.8))
    await until(() => asked.length === 2, "asked again")
    expect(asked[1]).toEqual({ words: "Stop, stop.", first: false, note: { stop: true } })
  })

  test("what counts as listening, and as stop", () => {
    for (const text of ["Mm-hm.", "Yeah.", "Okay, cool.", "Got it.", "Uh-huh", "Yeah yeah, right."]) expect(isBackchannel(text)).toBe(true)
    for (const text of ["Yeah, but which one?", "Wait.", "No.", "Okay, send it."]) expect(isBackchannel(text)).toBe(false)
    for (const text of ["Stop.", "Wait, wait.", "Okay stop.", "Hold on a second.", "Never mind.", "Cancel that."]) expect(isStop(text)).toBe(true)
    for (const text of ["Wait, which one overlaps?", "Stop the meeting invite.", "Don't stop."]) expect(isStop(text)).toBe(false)
  })
})

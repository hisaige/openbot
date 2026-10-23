/**
 * One voice call (experiment): the owner's microphone in, the Bot's voice out. The Bot itself does
 * the thinking and the talking; the call only hears (Parakeet) and speaks (Kokoro).
 *
 * - Turn taking by loudness (voice input's segmenter levels, 30 ms frames): an utterance starts after
 *   a short run of speech (longer, and louder, while the Bot's voice is still playing) and ends after
 *   ~0.65 s of quiet. Captions follow as Parakeet hears it.
 * - What the owner said goes to the Bot (`ask`); what the Bot writes comes back as it is written
 *   (`botText`) and is spoken sentence by sentence. A sentence Parakeet heard as unfinished ("Uh can
 *   you") waits a moment for the rest, so a pause mid-thought doesn't send half of it.
 * - The owner talking over the Bot first turns its voice down. "Mm-hm", "yeah" or a cough bring it
 *   back up and it carries on; real words stop it: what it was saying is dropped (the app drops audio
 *   it has not played) and the Bot is told how far it got ("I heard: '…Devenders at 11:30, and'").
 * - "Stop", "wait", "never mind"… on their own also stop the Bot's work (`AskNote.stop`).
 */
import { VOICE_OUTPUT_SAMPLE_RATE, type VoiceCallPhase, type VoiceServerMessage } from "@openbot/contracts"
import { frameLevels, speechThreshold } from "../stt/segmenter.ts"
import { SentenceChunker, speakable } from "./speech.ts"

export const CALL_INPUT_SAMPLE_RATE = 16_000
const FRAME_SAMPLES = Math.round(CALL_INPUT_SAMPLE_RATE * 0.03)
const START_FRAMES = 4 // 120 ms of speech starts an utterance
const START_FRAMES_OVER_BOT = 5 // 150 ms while the Bot's voice plays (it is only turned down at first)
const OVER_BOT_LEVEL_FACTOR = 2
const END_QUIET_FRAMES = 22 // ~0.65 s
const PRE_ROLL_FRAMES = 10 // 300 ms kept from before it started
const PARTIAL_EVERY_SAMPLES = Math.round(CALL_INPUT_SAMPLE_RATE * 0.4)
const MAX_UTTERANCE_SAMPLES = CALL_INPUT_SAMPLE_RATE * 60
const LEVEL_HISTORY_FRAMES = 1_000
/** How long an unfinished sentence waits for the rest. */
const UNFINISHED_HOLD_MS = 1_200
/** Parakeet punctuates: a finished sentence ends with one of these. */
const FINISHED = /[.!?…]["'”’)\]]*$/
/** A Bot reply that says nothing. */
const SILENT = "NO_REPLY"
/** The Bot's text stopped growing this long ago and ends a sentence: say it (it is probably working). */
const SETTLED_TEXT_MS = 350
/** How often waiting speech checks whether the owner stopped talking. */
const QUIET_POLL_MS = 50
/** How long it takes the app to start playing what it is sent. */
const PLAYBACK_LATENCY_MS = 60
/** At most this much of what the owner heard goes back to the Bot. */
const HEARD_CHARS = 300

const wordsOf = (text: string): Array<string> =>
  text.toLowerCase().replace(/[^a-z'\s-]/g, " ").replace(/-/g, " ").split(/\s+/).filter((w) => w !== "")

const BACKCHANNEL_PHRASES = ["got it", "i see", "all right", "sounds good", "makes sense", "uh huh", "mm hm", "mm hmm", "of course", "fair enough", "go on"]
const BACKCHANNEL_WORDS = new Set([
  "mm", "mmm", "mhm", "hm", "hmm", "uh", "huh", "ah", "oh", "yeah", "yep", "yes", "yup", "ok", "okay", "right", "sure", "cool",
  "nice", "great", "alright", "true", "exactly", "gotcha", "wow", "totally", "indeed",
])
/** Only "mm-hm", "yeah", "okay", "got it"…: listening, not taking a turn. */
export const isBackchannel = (text: string): boolean => {
  let rest = ` ${wordsOf(text).join(" ")} `
  for (const phrase of BACKCHANNEL_PHRASES) rest = rest.replaceAll(` ${phrase} `, " ")
  const left = rest.split(" ").filter((w) => w !== "")
  return wordsOf(text).length <= 6 && left.every((w) => BACKCHANNEL_WORDS.has(w))
}

const STOP_FILLER = new Set(["ok", "okay", "no", "please", "hey", "actually", "just", "sorry", "um", "uh"])
const STOP_PHRASES = new Set([
  "stop", "stop it", "stop that", "wait", "wait a sec", "wait a second", "wait a minute", "hold on", "hold on a sec", "hold on a second",
  "hang on", "never mind", "nevermind", "cancel", "cancel that", "cancel it", "forget it", "forget that", "enough", "that's enough",
])
/** "Stop", "wait", "never mind"… and nothing else: stop what the Bot is doing. */
export const isStop = (text: string): boolean => {
  const words = wordsOf(text).filter((w) => !STOP_FILLER.has(w))
  // "stop stop", "wait wait wait"
  const unique = words.filter((w, i) => i === 0 || w !== words[i - 1])
  return unique.length > 0 && STOP_PHRASES.has(unique.join(" "))
}

/** What goes to the Bot with the owner's words, besides them. */
export interface AskNote {
  /** The owner talked over the Bot: what they actually heard of it before it stopped. */
  readonly heard?: string | undefined
  /** The owner said only "stop", "wait"…: stop the Bot's work. */
  readonly stop?: boolean | undefined
}

/** One utterance's transcription (voice input's dictation session). */
export interface Transcription {
  readonly append: (samples: Float32Array) => Promise<string>
  readonly finish: (samples: Float32Array) => Promise<string>
  readonly discard: () => void
}

export interface CallDeps {
  readonly transcribe: () => Promise<Transcription>
  /** Speech for `text` at the call's output rate. */
  readonly speak: (text: string) => Promise<Float32Array>
  /** What the owner said, for the Bot (`first`: the call's first words; `note`: an interruption). */
  readonly ask: (words: string, first: boolean, note: AskNote) => void
  readonly send: (message: VoiceServerMessage) => void
  readonly sendAudio: (pcm16: Uint8Array) => void
  readonly log: (message: string, details?: Record<string, unknown>) => void
}

const concat = (parts: ReadonlyArray<Float32Array>): Float32Array => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

export const toPcm16 = (samples: Float32Array): Uint8Array => {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 0x7fff), true)
  return out
}

export const fromPcm16 = (pcm: Uint8Array): Float32Array => {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const out = new Float32Array(Math.floor(pcm.byteLength / 2))
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000
  return out
}

interface Utterance {
  readonly transcription: Promise<Transcription | undefined>
  /** Heard but not yet given to the transcription. */
  pending: Array<Float32Array>
  pendingSamples: number
  totalSamples: number
  quietFrames: number
  /** One transcription call at a time. */
  busy: Promise<unknown>
  latestText: string
}

/** One message of the Bot's, as it is written. */
interface BotMessage {
  readonly chunker: SentenceChunker
  /** How much of its text was taken. */
  seen: number
  /** Talked over: the rest of it is not spoken. */
  dropped: boolean
  /** All of it has arrived. */
  final: boolean
  /** Says a finished sentence still waiting when the text stops growing. */
  settle?: ReturnType<typeof setTimeout> | undefined
  /** Its line in the call's transcript, once something was said. */
  line?: { who: "bot"; text: string } | undefined
}

export interface CallLine {
  readonly who: "you" | "bot"
  readonly text: string
}

export class VoiceCall {
  private phase: VoiceCallPhase = "connecting"
  private readonly levels: Array<number> = []
  private readonly preRoll: Array<Float32Array> = []
  private frame = new Float32Array(FRAME_SAMPLES)
  private frameFill = 0
  private loudFrames = 0
  private utterance: Utterance | undefined
  /** The app still has the Bot's voice queued. */
  private playing = false
  private muted = false
  private ended = false
  private startedAt = 0
  /** What was said, for the chat's "Voice chat" line. */
  private readonly lines: Array<{ who: "you" | "bot"; text: string }> = []
  private readonly messages = new Map<string, BotMessage>()
  /** Speech in order; bumping `generation` drops what is still queued. */
  private speaking: Promise<void> = Promise.resolve()
  private generation = 0
  /** Sentences synthesized or playing. */
  private inFlight = 0
  /** Waiting for the Bot to start talking after the owner's last words. */
  private waiting = false
  private asked = 0
  /** An unfinished sentence waiting for the rest of it. */
  private held: { readonly text: string; timer: ReturnType<typeof setTimeout> | undefined } | undefined
  /** The Bot's voice is turned down while the owner says something (maybe only "mm-hm"). */
  private ducked = false
  /** When what the app was sent will have finished playing (ms since the epoch). */
  private playhead = 0
  /** The Bot's sentences since the owner last spoke, with when they play. */
  private voiced: Array<{ readonly text: string; readonly start: number; readonly end: number }> = []
  /** What the owner heard before cutting the Bot off, for their next words. */
  private cutOff: string | undefined

  constructor(private readonly deps: CallDeps) {}

  start(): void {
    this.startedAt = Date.now()
    this.setPhase("listening")
  }

  /** How long the call went and what was said (both sides). */
  summary(): { readonly durationMs: number; readonly lines: ReadonlyArray<CallLine> } {
    return { durationMs: this.startedAt === 0 ? 0 : Date.now() - this.startedAt, lines: this.lines.map((l) => ({ ...l })) }
  }

  // ---------------------------------------------------------------- input

  audio(pcm16: Uint8Array): void {
    if (this.ended || this.muted) return
    const samples = fromPcm16(pcm16)
    let at = 0
    while (at < samples.length) {
      const take = Math.min(FRAME_SAMPLES - this.frameFill, samples.length - at)
      this.frame.set(samples.subarray(at, at + take), this.frameFill)
      this.frameFill += take
      at += take
      if (this.frameFill === FRAME_SAMPLES) {
        this.onFrame(this.frame)
        this.frame = new Float32Array(FRAME_SAMPLES)
        this.frameFill = 0
      }
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (muted && this.utterance !== undefined) this.endUtterance()
  }

  /** The app played everything it was sent. */
  played(): void {
    this.playing = false
    this.playhead = 0
    this.settle()
  }

  hangup(): void {
    if (this.ended) return
    this.ended = true
    this.generation++
    clearTimeout(this.held?.timer)
    this.held = undefined
    void this.utterance?.transcription.then((t) => t?.discard())
    this.utterance = undefined
  }

  // ---------------------------------------------------------------- the Bot

  /** A message of the Bot's as it is written (`text` so far; `final` once it is complete). */
  botText(messageId: string, text: string, final: boolean): void {
    if (this.ended) return
    let message = this.messages.get(messageId)
    if (message === undefined) {
      message = { chunker: new SentenceChunker(), seen: 0, dropped: false, final: false }
      this.messages.set(messageId, message)
    }
    if (message.dropped || (text.length <= message.seen && !final)) return
    const fresh = text.slice(message.seen)
    message.seen = Math.max(message.seen, text.length)
    for (const sentence of message.chunker.push(fresh)) this.say(sentence, message)
    clearTimeout(message.settle)
    if (!final) {
      const waiting = message
      waiting.settle = setTimeout(() => {
        if (this.ended || waiting.dropped || waiting.final) return
        const sentence = waiting.chunker.takeFinished()
        if (sentence !== undefined) this.say(sentence, waiting)
      }, SETTLED_TEXT_MS)
    }
    if (final) {
      message.final = true
      const rest = message.chunker.flush()
      if (rest !== undefined && rest !== SILENT) this.say(rest, message)
    }
  }

  /** The Bot's turn for the owner's words ended (`failed`: it couldn't answer). */
  botDone(failed: boolean): void {
    if (this.ended) return
    if (failed && this.waiting) this.say("Sorry, I couldn't do that just now.")
    this.waiting = false
    this.settle()
  }

  private say(sentence: string, message?: BotMessage) {
    const text = speakable(sentence)
    if (text === "") return
    const generation = this.generation
    if (message !== undefined) this.waiting = false
    this.inFlight++
    const audio = this.deps.speak(text).catch((error) => {
      this.deps.log("voice call: Kokoro failed", { error: String(error) })
      return new Float32Array(0)
    })
    this.speaking = this.speaking.then(async () => {
      const samples = await audio
      // not over the owner: while they talk it waits ("mm-hm" lets it go on, real words drop it)
      while (this.utterance !== undefined && generation === this.generation && !this.ended) await Bun.sleep(QUIET_POLL_MS)
      this.inFlight--
      if (generation !== this.generation || this.ended || samples.length === 0 || message?.dropped === true) return this.settle()
      if (message !== undefined) {
        if (message.line === undefined) {
          message.line = { who: "bot", text }
          this.lines.push(message.line)
        } else message.line.text = `${message.line.text} ${text}`
      }
      const start = Math.max(Date.now() + PLAYBACK_LATENCY_MS, this.playhead)
      this.playhead = start + (samples.length / VOICE_OUTPUT_SAMPLE_RATE) * 1000
      this.voiced.push({ text, start, end: this.playhead })
      this.playing = true
      this.deps.sendAudio(toPcm16(samples))
      this.deps.send({ type: "bot", text })
      this.setPhase("speaking")
    })
  }

  /** The phase once nothing is happening on the owner's side. */
  private settle() {
    if (this.ended || this.utterance !== undefined) return
    this.setPhase(this.playing || this.inFlight > 0 ? "speaking" : this.waiting ? "thinking" : "listening")
  }

  // ---------------------------------------------------------------- hearing the owner

  private setPhase(phase: VoiceCallPhase) {
    if (this.phase === phase || this.ended) return
    this.phase = phase
    this.deps.send({ type: "phase", phase })
  }

  private onFrame(frame: Float32Array) {
    const level = frameLevels(frame, CALL_INPUT_SAMPLE_RATE)[0] ?? 0
    this.levels.push(level)
    if (this.levels.length > LEVEL_HISTORY_FRAMES) this.levels.shift()
    const threshold = speechThreshold(this.levels)
    const current = this.utterance
    if (current !== undefined) {
      this.hear(current, frame)
      current.quietFrames = level >= threshold ? 0 : current.quietFrames + 1
      if (current.quietFrames >= END_QUIET_FRAMES || current.totalSamples >= MAX_UTTERANCE_SAMPLES) this.endUtterance()
      return
    }
    const overBot = this.playing || this.inFlight > 0
    const needed = overBot ? START_FRAMES_OVER_BOT : START_FRAMES
    const loud = level >= (overBot ? threshold * OVER_BOT_LEVEL_FACTOR : threshold)
    this.loudFrames = loud ? this.loudFrames + 1 : 0
    this.preRoll.push(frame)
    if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift()
    if (this.loudFrames >= needed) this.startUtterance()
  }

  private startUtterance() {
    this.loudFrames = 0
    // over the Bot: only turned down until it is clear the owner is really talking
    if (this.playing || this.inFlight > 0) this.duck()
    // the rest of an unfinished sentence: it joins it
    if (this.held !== undefined) {
      clearTimeout(this.held.timer)
      this.held.timer = undefined
    }
    const heard = [...this.preRoll]
    this.preRoll.length = 0
    const utterance: Utterance = {
      transcription: this.deps.transcribe().catch((error) => {
        this.deps.log("voice call: transcription did not open", { error: String(error) })
        return undefined
      }),
      pending: heard,
      pendingSamples: heard.reduce((n, f) => n + f.length, 0),
      totalSamples: heard.reduce((n, f) => n + f.length, 0),
      quietFrames: 0,
      busy: Promise.resolve(),
      latestText: "",
    }
    this.utterance = utterance
    this.setPhase("hearing")
  }

  private hear(utterance: Utterance, frame: Float32Array) {
    utterance.pending.push(frame)
    utterance.pendingSamples += frame.length
    utterance.totalSamples += frame.length
    if (utterance.pendingSamples < PARTIAL_EVERY_SAMPLES) return
    const samples = concat(utterance.pending)
    utterance.pending = []
    utterance.pendingSamples = 0
    utterance.busy = utterance.busy.then(async () => {
      const transcription = await utterance.transcription
      if (transcription === undefined || this.utterance !== utterance) return
      const text = await transcription.append(samples).catch(() => utterance.latestText)
      if (text !== utterance.latestText && this.utterance === utterance && text !== "") {
        utterance.latestText = text
        this.deps.send({ type: "you", text: this.held === undefined ? text : `${this.held.text} ${text}`, final: false })
        // real words, not "mm-hm": the Bot stops now, not when the owner is done
        if (this.ducked && !isBackchannel(text)) this.talkedOver()
      }
    })
  }

  private endUtterance() {
    const utterance = this.utterance
    if (utterance === undefined) return
    this.utterance = undefined
    const rest = concat(utterance.pending)
    utterance.pending = []
    void utterance.busy.then(async () => {
      const transcription = await utterance.transcription
      const text = transcription === undefined ? "" : (await transcription.finish(rest).catch(() => utterance.latestText)).trim()
      if (this.ended) return
      // over the Bot it was only "mm-hm", "yeah" or a cough: it carries on
      if (this.ducked && (text === "" || isBackchannel(text))) {
        this.unduck()
        return this.settle()
      }
      if (this.ducked) this.talkedOver()
      const held = this.held
      this.held = undefined
      const words = [held?.text, text].filter((part) => part !== undefined && part !== "").join(" ")
      if (words === "") return this.settle()
      if (text !== "" && !FINISHED.test(words)) {
        // unfinished ("Uh can you"): wait a moment for the rest
        this.held = { text: words, timer: setTimeout(() => this.release(), UNFINISHED_HOLD_MS) }
        this.deps.send({ type: "you", text: words, final: false })
        return this.settle()
      }
      this.commit(words)
    })
  }

  /** An unfinished sentence that got no more: it goes as it is. */
  private release() {
    const held = this.held
    if (held === undefined || this.utterance !== undefined || this.ended) return
    this.held = undefined
    this.commit(held.text)
  }

  /** The owner's words, complete: to the Bot, with how far it got if they cut it off. */
  private commit(words: string) {
    this.deps.send({ type: "you", text: words, final: true })
    this.lines.push({ who: "you", text: words })
    const note: AskNote = { ...(this.cutOff === undefined ? {} : { heard: this.cutOff }), ...(isStop(words) ? { stop: true } : {}) }
    this.cutOff = undefined
    this.voiced = []
    this.deps.ask(words, this.asked++ === 0, note)
    this.waiting = true
    this.settle()
  }

  private duck() {
    if (this.ducked) return
    this.ducked = true
    this.deps.send({ type: "duck" })
  }

  private unduck() {
    if (!this.ducked) return
    this.ducked = false
    this.deps.send({ type: "unduck" })
  }

  /** What the owner heard of the Bot by now: the sentences played, and the words of the one playing. */
  private heardSoFar(now: number): { readonly text: string; readonly cut: boolean } {
    const parts: Array<string> = []
    let cut = this.inFlight > 0
    for (const sentence of this.voiced) {
      if (sentence.end <= now) {
        parts.push(sentence.text)
        continue
      }
      cut = true
      if (sentence.start < now) {
        const words = sentence.text.split(" ")
        const share = (now - sentence.start) / (sentence.end - sentence.start)
        const said = words.slice(0, Math.floor(words.length * share)).join(" ")
        if (said !== "") parts.push(`${said}…`)
      }
      break
    }
    const text = parts.join(" ")
    return { text: text.length > HEARD_CHARS ? `…${text.slice(-HEARD_CHARS)}` : text, cut }
  }

  /** The owner talks over the Bot: its voice stops at once, and what it was saying is dropped. */
  private talkedOver() {
    const heard = this.heardSoFar(Date.now())
    // the Bot was still writing what it was saying
    const unfinished = [...this.messages.values()].some((m) => !m.dropped && !m.final && m.seen > 0)
    if (heard.cut || unfinished) this.cutOff = heard.text === "" ? "nothing yet" : heard.text
    this.generation++
    for (const message of this.messages.values()) message.dropped = true
    this.deps.send({ type: "stop" })
    this.ducked = false
    this.playing = false
    this.playhead = 0
  }
}

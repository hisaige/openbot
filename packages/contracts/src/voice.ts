/**
 * Voice calls (experiment): talk with a Bot. The Bot itself does the thinking and the talking; speech
 * in and out stays on the brain (Parakeet, Kokoro).
 *
 * The call runs over `/ws/voice/:botId`. App → brain: binary frames of 16 kHz mono PCM16 (the
 * microphone) and JSON `VoiceClientMessage`s. Brain → app: binary frames of `VOICE_OUTPUT_SAMPLE_RATE`
 * mono PCM16 (the Bot's voice) and JSON `VoiceServerMessage`s.
 */
import { Schema } from "effect"
import { NonNegativeInt } from "./base.ts"

export const VoiceCallStatus = Schema.Struct({
  state: Schema.Literals(["unsupported", "absent", "installing", "ready", "failed"]),
  /** What it runs ("Kokoro"). */
  model: Schema.String,
  downloadBytes: Schema.optionalKey(NonNegativeInt),
  downloadedBytes: Schema.optionalKey(NonNegativeInt),
  problem: Schema.optionalKey(Schema.String),
})
export type VoiceCallStatus = typeof VoiceCallStatus.Type

/** The Bot's voice, as the brain sends it. */
export const VOICE_OUTPUT_SAMPLE_RATE = 24_000

export interface KokoroVoice {
  readonly id: string
  /** Kokoro's speaker number. */
  readonly sid: number
  readonly label: string
  readonly accent: "American" | "British"
  readonly gender: "female" | "male"
}

const voice = (id: string, sid: number, label: string): KokoroVoice => ({
  id,
  sid,
  label,
  accent: id.startsWith("a") ? "American" : "British",
  gender: id[1] === "f" ? "female" : "male",
})

/** Kokoro v1.0's English voices (its speaker numbers 0–27, the Santa voice aside). */
export const KOKORO_VOICES: ReadonlyArray<KokoroVoice> = [
  voice("af_heart", 3, "Heart"),
  voice("af_bella", 2, "Bella"),
  voice("af_nicole", 6, "Nicole"),
  voice("af_sarah", 9, "Sarah"),
  voice("af_alloy", 0, "Alloy"),
  voice("af_aoede", 1, "Aoede"),
  voice("af_jessica", 4, "Jessica"),
  voice("af_kore", 5, "Kore"),
  voice("af_nova", 7, "Nova"),
  voice("af_river", 8, "River"),
  voice("af_sky", 10, "Sky"),
  voice("am_michael", 16, "Michael"),
  voice("am_fenrir", 14, "Fenrir"),
  voice("am_puck", 18, "Puck"),
  voice("am_eric", 13, "Eric"),
  voice("am_adam", 11, "Adam"),
  voice("am_echo", 12, "Echo"),
  voice("am_liam", 15, "Liam"),
  voice("am_onyx", 17, "Onyx"),
  voice("bf_emma", 21, "Emma"),
  voice("bf_isabella", 22, "Isabella"),
  voice("bf_alice", 20, "Alice"),
  voice("bf_lily", 23, "Lily"),
  voice("bm_george", 26, "George"),
  voice("bm_fable", 25, "Fable"),
  voice("bm_daniel", 24, "Daniel"),
  voice("bm_lewis", 27, "Lewis"),
]

/** Voices a Bot gets when none was chosen (this order keeps every Bot's voice as it was). */
const DEFAULT_VOICE_IDS = ["af_heart", "af_bella", "af_nicole", "af_sarah", "am_michael", "am_fenrir", "am_puck", "am_eric", "bf_emma", "bf_isabella", "bm_george", "bm_fable"]

export const kokoroVoice = (id: string | undefined): KokoroVoice | undefined => KOKORO_VOICES.find((v) => v.id === id)

/** A Bot's voice when none was chosen: the same one every call, spread over a few good ones. */
export const defaultVoiceFor = (botId: string): KokoroVoice => {
  let hash = 0
  for (const char of botId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return kokoroVoice(DEFAULT_VOICE_IDS[hash % DEFAULT_VOICE_IDS.length])!
}

/** The voice a Bot speaks with on calls. */
export const voiceOf = (bot: { readonly id: string; readonly voice?: string | undefined }): KokoroVoice => kokoroVoice(bot.voice) ?? defaultVoiceFor(bot.id)

export const VoicePreview = Schema.Struct({ pcmBase64: Schema.String, sampleRate: NonNegativeInt })
export type VoicePreview = typeof VoicePreview.Type

/** What the call is doing (the call bar shows it). */
export type VoiceCallPhase = "connecting" | "listening" | "hearing" | "thinking" | "speaking"

export type VoiceServerMessage =
  /** The call is up: the Bot's voice comes at `sampleRate`. */
  | { readonly type: "ready"; readonly sampleRate: number; readonly voice: string }
  | { readonly type: "phase"; readonly phase: VoiceCallPhase }
  /** What the owner is saying (partial while they speak, then final). */
  | { readonly type: "you"; readonly text: string; readonly final: boolean }
  /** A sentence the Bot is saying now. */
  | { readonly type: "bot"; readonly text: string }
  /** The owner started talking over the Bot: turn its voice down (it may be "mm-hm"). */
  | { readonly type: "duck" }
  /** It was "mm-hm" (or a cough): its voice back up, it carries on. */
  | { readonly type: "unduck" }
  /** The owner is really talking over the Bot: drop the audio not yet played. */
  | { readonly type: "stop" }
  | { readonly type: "error"; readonly message: string }

export type VoiceClientMessage =
  | { readonly type: "mute"; readonly muted: boolean }
  /** Everything the brain sent has been played. */
  | { readonly type: "played" }
  | { readonly type: "hangup" }

export interface SpeakerLaunch {
  readonly library: string
  readonly model: string
  readonly voices: string
  readonly tokens: string
  readonly dataDir: string
  readonly lexicon: string
  readonly lang: string
  readonly threads: number
}

export interface SpeakerRequest {
  readonly id: number
  readonly text: string
  /** Kokoro's speaker number. */
  readonly sid: number
  readonly speed: number
}

export type SpeakerReply =
  | { readonly type: "ready"; readonly sampleRate: number }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "spoken"; readonly id: number; readonly samples: Float32Array }
  | { readonly type: "speak-failed"; readonly id: number; readonly message: string }

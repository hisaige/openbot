// Kokoro through sherpa-onnx's C API (the library voice input installed), in its own process: text in,
// mono float samples out. Struct offsets are SherpaOnnxOfflineTtsConfig's in sherpa-onnx v1.13.8 (c-api.h).
import { dlopen, FFIType, type Pointer, ptr, toArrayBuffer } from "bun:ffi"
import type { SpeakerLaunch, SpeakerReply, SpeakerRequest } from "./speaker-protocol.ts"

const TTS_CONFIG_BYTES = 448
const OFFSETS = {
  numThreads: 56,
  debug: 60,
  provider: 64,
  kokoroModel: 128,
  kokoroVoices: 136,
  kokoroTokens: 144,
  kokoroDataDir: 152,
  kokoroLengthScale: 160,
  kokoroLexicon: 176,
  kokoroLang: 184,
  maxNumSentences: 424,
  silenceScale: 440,
} as const
// SherpaOnnxGeneratedAudio: const float *samples; int32_t n; (its sample_rate is read from the engine)
const AUDIO_SAMPLES = 0
const AUDIO_COUNT = 8
const AUDIO_HEADER_BYTES = 16

const launch = JSON.parse(process.argv[2]!) as SpeakerLaunch
const reply = (message: SpeakerReply) => process.send?.(message)

const sherpa = dlopen(launch.library, {
  SherpaOnnxCreateOfflineTts: { args: [FFIType.ptr], returns: FFIType.ptr },
  SherpaOnnxOfflineTtsSampleRate: { args: [FFIType.ptr], returns: FFIType.i32 },
  SherpaOnnxOfflineTtsGenerate: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.f32], returns: FFIType.ptr },
  SherpaOnnxDestroyOfflineTtsGeneratedAudio: { args: [FFIType.ptr], returns: FFIType.void },
}).symbols

const stringsKeptAlive: Array<Uint8Array> = []
const cString = (value: string): bigint => {
  const bytes = new TextEncoder().encode(`${value}\0`)
  stringsKeptAlive.push(bytes)
  return BigInt(ptr(bytes))
}

const ttsConfig = (): Uint8Array => {
  const config = new Uint8Array(TTS_CONFIG_BYTES)
  const view = new DataView(config.buffer)
  view.setInt32(OFFSETS.numThreads, launch.threads, true)
  view.setInt32(OFFSETS.debug, 0, true)
  view.setBigUint64(OFFSETS.provider, cString("cpu"), true)
  view.setBigUint64(OFFSETS.kokoroModel, cString(launch.model), true)
  view.setBigUint64(OFFSETS.kokoroVoices, cString(launch.voices), true)
  view.setBigUint64(OFFSETS.kokoroTokens, cString(launch.tokens), true)
  view.setBigUint64(OFFSETS.kokoroDataDir, cString(launch.dataDir), true)
  view.setFloat32(OFFSETS.kokoroLengthScale, 1, true)
  view.setBigUint64(OFFSETS.kokoroLexicon, cString(launch.lexicon), true)
  view.setBigUint64(OFFSETS.kokoroLang, cString(launch.lang), true)
  view.setInt32(OFFSETS.maxNumSentences, 1, true)
  view.setFloat32(OFFSETS.silenceScale, 0.2, true)
  return config
}

const tts = sherpa.SherpaOnnxCreateOfflineTts(ptr(ttsConfig())) as Pointer | null
if (tts === null) {
  reply({ type: "failed", message: "sherpa-onnx could not load the Kokoro voices." })
  process.exit(1)
}

const speak = (request: SpeakerRequest): Float32Array => {
  const audio = sherpa.SherpaOnnxOfflineTtsGenerate(tts, ptr(new TextEncoder().encode(`${request.text}\0`)), request.sid, request.speed) as Pointer | null
  if (audio === null) throw new Error("sherpa-onnx returned no audio.")
  try {
    const header = new DataView(toArrayBuffer(audio, 0, AUDIO_HEADER_BYTES))
    const count = header.getInt32(AUDIO_COUNT, true)
    if (count <= 0) return new Float32Array(0)
    const samples = Number(header.getBigUint64(AUDIO_SAMPLES, true)) as Pointer
    return new Float32Array(toArrayBuffer(samples, 0, count * 4).slice(0))
  } finally {
    sherpa.SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio)
  }
}

process.on("message", (request: SpeakerRequest) => {
  try {
    reply({ type: "spoken", id: request.id, samples: speak(request) })
  } catch (error) {
    reply({ type: "speak-failed", id: request.id, message: error instanceof Error ? error.message : String(error) })
  }
})
process.on("disconnect", () => process.exit(0))
reply({ type: "ready", sampleRate: sherpa.SherpaOnnxOfflineTtsSampleRate(tts) })

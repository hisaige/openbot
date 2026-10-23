// A voice call with a Bot (experiment), over /ws/voice/:botId. One call at a time, kept outside React
// so it goes on while the owner moves between chats; the call bar shows it (useVoiceCall).
//
// Up: the microphone (echo cancelled) as 16 kHz PCM16. Down: the Bot's voice as 24 kHz PCM16, played
// back to back. When the owner starts talking over it, it is turned down ("duck"); "unduck" brings it
// back ("mm-hm"), "stop" drops what is still queued. When everything sent has played, the brain is
// told ("played"), so it knows the Bot is quiet.
import { downsample, encodePcm16 } from "@openbot/app-model"
import type { BotId, VoiceCallPhase, VoiceServerMessage } from "@openbot/contracts"
import { describeMicrophoneError, type Microphone, startMicrophone } from "../chat/dictation.ts"

const INPUT_RATE = 16_000

export interface CallLine {
  readonly id: number
  readonly who: "you" | "bot"
  readonly text: string
  /** Still being heard. */
  readonly pending?: boolean
}

export interface CallState {
  readonly botId: BotId | undefined
  readonly phase: VoiceCallPhase | "ended"
  readonly muted: boolean
  readonly lines: ReadonlyArray<CallLine>
  readonly error?: string | undefined
  readonly voice?: string | undefined
}

const IDLE: CallState = { botId: undefined, phase: "ended", muted: false, lines: [] }

let state: CallState = IDLE
const listeners = new Set<() => void>()
const set = (next: Partial<CallState>) => {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

export const subscribeCall = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
export const callState = (): CallState => state

// ---------------------------------------------------------------- levels (read by the waveform each frame)

let outputAnalyser: AnalyserNode | undefined
/** The Bot's volume: turned down while the owner talks over it. */
let outputGain: GainNode | undefined
const DUCKED_GAIN = 0.15
const GAIN_SECONDS = 0.04

const setGain = (value: number) => {
  if (playback === undefined || outputGain === undefined) return
  outputGain.gain.setTargetAtTime(value, playback.currentTime, GAIN_SECONDS)
}
let micLevel = 0
const levelBuffer = new Float32Array(512)

/** 0..1: the Bot's voice when it speaks, else the microphone. */
export const callLevel = (): number => {
  if (outputAnalyser !== undefined) {
    outputAnalyser.getFloatTimeDomainData(levelBuffer)
    let sum = 0
    for (const sample of levelBuffer) sum += sample * sample
    const output = Math.sqrt(sum / levelBuffer.length)
    if (output > 0.005) return Math.min(1, output * 6)
  }
  return Math.min(1, micLevel * 8)
}

// ---------------------------------------------------------------- the call

let socket: WebSocket | undefined
let microphone: Microphone | undefined
let playback: AudioContext | undefined
let playing: Set<AudioBufferSourceNode> = new Set()
let playAt = 0
let lineIds = 0
let hungUp = false

const wsOrigin = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`

const addLine = (line: Omit<CallLine, "id">) => set({ lines: [...state.lines, { ...line, id: ++lineIds }] })

const onMessage = (message: VoiceServerMessage) => {
  switch (message.type) {
    case "ready":
      set({ voice: message.voice })
      return
    case "phase":
      set({ phase: message.phase })
      return
    case "you": {
      const last = state.lines.at(-1)
      if (last?.who === "you" && last.pending) {
        set({ lines: [...state.lines.slice(0, -1), { ...last, text: message.text, pending: !message.final }] })
      } else addLine({ who: "you", text: message.text, pending: !message.final })
      return
    }
    case "bot": {
      const last = state.lines.at(-1)
      if (last?.who === "bot") set({ lines: [...state.lines.slice(0, -1), { ...last, text: `${last.text} ${message.text}` }] })
      else addLine({ who: "bot", text: message.text })
      return
    }
    case "duck":
      setGain(DUCKED_GAIN)
      return
    case "unduck":
      setGain(1)
      return
    case "stop":
      stopPlayback()
      setGain(1)
      return
    case "error":
      set({ error: message.message })
      return
  }
}

const stopPlayback = () => {
  for (const source of playing) {
    source.onended = null
    source.stop()
  }
  playing = new Set()
  playAt = 0
}

/** Queues a chunk of the Bot's voice right after what is already queued. */
const play = (pcm: ArrayBuffer) => {
  const context = playback
  if (context === undefined) return
  const view = new DataView(pcm)
  const buffer = context.createBuffer(1, pcm.byteLength / 2, 24_000)
  const samples = buffer.getChannelData(0)
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(outputGain ?? context.destination)
  playAt = Math.max(playAt, context.currentTime + 0.02)
  source.start(playAt)
  playAt += buffer.duration
  playing.add(source)
  source.onended = () => {
    playing.delete(source)
    if (playing.size === 0) socket?.send(JSON.stringify({ type: "played" }))
  }
}

const sendAudio = (samples: Float32Array) => {
  const rate = microphone?.sampleRate
  if (rate === undefined) return
  let sum = 0
  for (const sample of samples) sum += sample * sample
  micLevel = Math.sqrt(sum / Math.max(1, samples.length))
  if (state.muted || socket?.readyState !== WebSocket.OPEN) return
  socket.send(encodePcm16(downsample(samples, rate, INPUT_RATE)) as Uint8Array<ArrayBuffer>)
}

const teardown = () => {
  stopPlayback()
  void microphone?.stop()
  microphone = undefined
  void playback?.close()
  playback = undefined
  outputAnalyser = undefined
  outputGain = undefined
  micLevel = 0
  const open = socket
  socket = undefined
  if (open !== undefined && open.readyState <= WebSocket.OPEN) {
    if (open.readyState === WebSocket.OPEN) open.send(JSON.stringify({ type: "hangup" }))
    open.close()
  }
}

export const startCall = async (botId: BotId): Promise<void> => {
  if (state.botId !== undefined) hangUp()
  hungUp = false
  lineIds = 0
  set({ ...IDLE, botId, phase: "connecting" })
  // the playback context is made inside the click, so the browser lets it play
  playback = new AudioContext()
  outputAnalyser = playback.createAnalyser()
  outputAnalyser.fftSize = 512
  outputAnalyser.connect(playback.destination)
  outputGain = playback.createGain()
  outputGain.connect(outputAnalyser)
  const ws = new WebSocket(`${wsOrigin()}/ws/voice/${encodeURIComponent(botId)}`)
  ws.binaryType = "arraybuffer"
  socket = ws
  ws.onmessage = (event) => {
    if (socket !== ws) return
    if (typeof event.data === "string") onMessage(JSON.parse(event.data) as VoiceServerMessage)
    else play(event.data as ArrayBuffer)
  }
  ws.onclose = (event) => {
    if (socket !== ws) return
    teardown()
    set({ phase: "ended", ...(hungUp || event.code === 1000 ? {} : { error: state.error ?? (event.reason || "The call dropped.") }) })
  }
  try {
    const mic = await startMicrophone(sendAudio, () => undefined)
    if (socket !== ws) return void mic.stop()
    microphone = mic
  } catch (error) {
    if (socket !== ws) return
    teardown()
    set({ phase: "ended", error: describeMicrophoneError(error) })
  }
}

export const hangUp = (): void => {
  hungUp = true
  teardown()
  set({ ...IDLE })
}

export const setMuted = (muted: boolean): void => {
  set({ muted })
  socket?.send(JSON.stringify({ type: "mute", muted }))
}

/** Clears a call that ended with a problem (the bar showed why). */
export const dismissCall = (): void => set({ ...IDLE })

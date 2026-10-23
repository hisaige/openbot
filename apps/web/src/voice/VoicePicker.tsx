// A Bot's voice on calls (experiment): Kokoro's English voices, grouped by accent and gender, each with
// a short preview ("Hi, I'm Chief of Staff…"). Choosing one changes the Bot's voice from its next sentence.
import { type Bot, KOKORO_VOICES, type KokoroVoice, voiceOf } from "@openbot/contracts"
import { cn, Icon, IconButton, Spinner } from "@openbot/ui"
import { Check, Play } from "lucide-react"
import { type ReactNode, useState } from "react"
import { useCommand } from "../details/kit.tsx"

const GROUPS: ReadonlyArray<{ readonly title: string; readonly accent: KokoroVoice["accent"]; readonly gender: KokoroVoice["gender"] }> = [
  { title: "American · female", accent: "American", gender: "female" },
  { title: "American · male", accent: "American", gender: "male" },
  { title: "British · female", accent: "British", gender: "female" },
  { title: "British · male", accent: "British", gender: "male" },
]

let previewContext: AudioContext | undefined
let previewSource: AudioBufferSourceNode | undefined

/** Plays 24 kHz PCM16 (base64), stopping a preview still playing. */
const playPcm = (pcmBase64: string, sampleRate: number) => {
  const bytes = Uint8Array.from(atob(pcmBase64), (c) => c.charCodeAt(0))
  if (bytes.length < 2) return
  previewContext ??= new AudioContext()
  const view = new DataView(bytes.buffer)
  const buffer = previewContext.createBuffer(1, bytes.length / 2, sampleRate)
  const samples = buffer.getChannelData(0)
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000
  previewSource?.stop()
  previewSource = previewContext.createBufferSource()
  previewSource.buffer = buffer
  previewSource.connect(previewContext.destination)
  previewSource.start()
}

export function VoicePicker({ bot }: { readonly bot: Bot }): ReactNode {
  const choose = useCommand("bots.update", `voice:${bot.id}`)
  const preview = useCommand("voice.preview", `voice-preview:${bot.id}`)
  const [previewing, setPreviewing] = useState<string | undefined>()
  const current = voiceOf(bot).id

  const listen = async (voice: KokoroVoice) => {
    setPreviewing(voice.id)
    const result = await preview.run({ voice: voice.id, text: `Hi, I'm ${bot.name}. This is how I'd sound on a call.` })
    setPreviewing(undefined)
    if (result.ok) playPcm(result.value.pcmBase64, result.value.sampleRate)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="voice-picker">
      {GROUPS.map((group) => (
        <section key={group.title} className="flex flex-col gap-0.5">
          <h3 className="px-2 pb-1 text-xs text-fg-tertiary">{group.title}</h3>
          {KOKORO_VOICES.filter((v) => v.accent === group.accent && v.gender === group.gender).map((voice) => (
            <div key={voice.id} className={cn("flex items-center gap-1 rounded-xl ps-1 pe-2", voice.id === current && "bg-secondary")}>
              {previewing === voice.id ? (
                <span className="inline-flex size-7 items-center justify-center">
                  <Spinner size={12} label={`Playing ${voice.label}`} />
                </span>
              ) : (
                <IconButton icon={Play} label={`Hear ${voice.label}`} size={28} iconSize="xs" onClick={() => void listen(voice)} />
              )}
              <button
                type="button"
                className="flex h-8 flex-1 items-center justify-between text-start text-sm text-fg"
                onClick={() => void choose.run({ botId: bot.id, patch: { voice: voice.id } })}
                data-voice={voice.id}
              >
                {voice.label}
                {voice.id === current && <Icon icon={Check} size="sm" className="text-accent-fg" />}
              </button>
            </div>
          ))}
        </section>
      ))}
      {(choose.error ?? preview.error) && <p className="px-2 text-sm text-danger-fg">{choose.error ?? preview.error}</p>}
    </div>
  )
}

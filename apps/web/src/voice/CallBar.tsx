// The call bar (experiment; Grok Bot's design): floats at the top of the chat while a voice call with
// a Bot is on (whichever chat is open). The Bot's avatar (working while it speaks), a dotted waveform that follows whoever is talking,
// the transcript (what was said, and the work handed to the Bot), mute and hang up.
import { useRoster } from "../app/data.ts"
import { useIsPhone } from "../app/layout.ts"
import { Avatar, IconButton, botTintStyle, cn } from "@openbot/ui"
import { MessageCircle, Mic, MicOff, Settings, X } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { callLevel, callState, dismissCall, hangUp, setMuted, subscribeCall } from "./voiceCall.ts"
import { VoicePicker } from "./VoicePicker.tsx"

export const useVoiceCall = () => useSyncExternalStore(subscribeCall, callState)

const DOTS = 14

/** Dots that rise with the level of whoever is talking (read every frame, outside React). */
function Waveform({ active, className }: { readonly active: boolean; readonly className?: string }): ReactNode {
  const dots = useRef<Array<HTMLSpanElement | null>>([])
  useEffect(() => {
    let frame = 0
    const levels: Array<number> = Array(DOTS).fill(0)
    const tick = () => {
      const level = active ? callLevel() : 0
      levels.shift()
      levels.push(level)
      dots.current.forEach((dot, i) => {
        if (dot === null) return
        const value = levels[i] ?? 0
        dot.style.transform = `scaleY(${1 + value * 5})`
        dot.style.opacity = String(0.35 + value * 0.65)
      })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [active])
  return (
    <div className={cn("flex items-center justify-between px-1", className)} aria-hidden>
      {Array.from({ length: DOTS }, (_, i) => (
        <span key={i} ref={(el) => void (dots.current[i] = el)} className="h-1 w-1 rounded-full bg-accent transition-transform duration-75" />
      ))}
    </div>
  )
}

const PHASE_LABEL: Record<string, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  hearing: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
}

export function CallBar(): ReactNode {
  const call = useVoiceCall()
  const roster = useRoster()
  // a phone's width: smaller buttons, and the waveform takes what is left, the phase under it
  const phone = useIsPhone()
  /** Under the bar: what was said, or the Bot's voices. */
  const [panel, setPanel] = useState<"transcript" | "voices" | undefined>()
  const transcript = panel === "transcript"
  const toggle = (next: "transcript" | "voices") => setPanel((open) => (open === next ? undefined : next))
  const end = useRef<HTMLDivElement>(null)
  // braces: newer browsers return a promise from scrollIntoView, which React would take for a cleanup
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" })
  }, [call.lines.length, transcript])
  if (call.botId === undefined) return null
  const bot = roster.botById(call.botId)
  const ended = call.phase === "ended"
  const button = phone ? 36 : 44
  const phase = <span className={cn("text-fg-tertiary", phone ? "text-[11px] leading-3" : "w-20 text-xs")} data-testid="call-phase">{ended ? "Call ended" : call.muted ? "Muted" : PHASE_LABEL[call.phase]}</span>
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-14 z-40 flex flex-col items-center gap-2 px-3 pt-[env(safe-area-inset-top)]"
      style={bot === undefined ? undefined : botTintStyle(bot.avatar.color)}
      data-testid="call-bar"
    >
      <div
        className={cn(
          "pointer-events-auto flex items-center rounded-full bg-elevated shadow-xl hairline border-line-tertiary",
          phone ? "w-full max-w-[420px] gap-1 py-1.5 ps-2 pe-1.5" : "gap-2 py-2 ps-3 pe-2",
        )}
        aria-label={`Call with ${bot?.name ?? "Bot"}`}
      >
        {bot !== undefined && <Avatar shape={bot.avatar.shape} color={bot.avatar.color} size={phone ? 32 : 36} working={call.phase === "speaking"} />}
        {phone ? (
          <div className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
            <Waveform active={!ended && !call.muted} className="h-4 w-full max-w-28" />
            {phase}
          </div>
        ) : (
          <>
            <Waveform active={!ended && !call.muted} className="h-8 w-28" />
            {phase}
          </>
        )}
        {bot !== undefined && <IconButton icon={Settings} label="Voice" size={button} variant={panel === "voices" ? "secondary" : "ghost"} onClick={() => toggle("voices")} />}
        <IconButton icon={MessageCircle} label={transcript ? "Hide transcript" : "Show transcript"} size={button} variant={transcript ? "secondary" : "ghost"} onClick={() => toggle("transcript")} />
        {!ended && <IconButton icon={call.muted ? MicOff : Mic} label={call.muted ? "Unmute" : "Mute"} size={button} variant={call.muted ? "secondary" : "ghost"} onClick={() => setMuted(!call.muted)} />}
        <button
          type="button"
          aria-label={ended ? "Close" : "End call"}
          title={ended ? "Close" : "End call"}
          onClick={ended ? dismissCall : hangUp}
          className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-danger text-white transition-opacity hover:opacity-85", phone ? "size-9" : "size-11")}
        >
          <X className="size-5" strokeWidth={2} />
        </button>
      </div>
      {call.error !== undefined && <p className="pointer-events-auto rounded-full bg-elevated px-4 py-2 text-sm text-danger-fg shadow">{call.error}</p>}
      {panel === "voices" && bot !== undefined && (
        <div className="pointer-events-auto max-h-[50vh] w-full max-w-[360px] overflow-y-auto overscroll-contain rounded-3xl bg-elevated/95 p-3 shadow-lg backdrop-blur hairline border-line-tertiary">
          <VoicePicker bot={bot} />
        </div>
      )}
      {transcript && call.lines.length > 0 && (
        <div className="pointer-events-auto max-h-[40vh] w-full max-w-[520px] overflow-y-auto rounded-3xl bg-elevated/95 p-4 text-sm shadow-lg backdrop-blur hairline border-line-tertiary" data-testid="call-transcript">
          {call.lines.map((line) => (
            <p key={line.id} className={cn("py-1", line.who === "you" ? "text-fg" : "text-fg-secondary")}>
              {line.who === "you" ? "You: " : `${bot?.name ?? "Bot"}: `}
              {line.text}
            </p>
          ))}
          <div ref={end} />
        </div>
      )}
    </div>
  )
}

// A voice call in the chat (experiment; Grok Bot's design): one centered line, "Voice chat · 00:31",
// that opens into what was said, the owner's words on the right, the Bot's on the left.
import { AudioLines, X } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { EventLine, Icon, IconButton } from "@openbot/ui"

export interface VoiceChatLineProps {
  readonly durationMs: number
  readonly lines: ReadonlyArray<{ readonly who: "you" | "bot"; readonly text: string }>
}

export const callLength = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

export function VoiceChatLine({ durationMs, lines }: VoiceChatLineProps): ReactNode {
  const [open, setOpen] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  // opened at the bottom of the chat, it would end below the fold
  useEffect(() => {
    if (open) card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [open])
  const title = (
    <span className="inline-flex items-center gap-1.5">
      <Icon icon={AudioLines} size="sm" className="text-icon-secondary" />
      <span>
        Voice chat · <span className="tabular-nums">{callLength(durationMs)}</span>
      </span>
    </span>
  )
  if (!open) {
    return (
      <EventLine>
        <button
          type="button"
          data-testid="voice-chat-line"
          onClick={() => setOpen(true)}
          className="inline-flex h-7 items-center rounded-full px-2 text-fg-secondary transition-colors duration-[120ms] hover:bg-secondary hover:text-fg"
        >
          {title}
        </button>
      </EventLine>
    )
  }
  return (
    <div ref={card} className="mx-auto my-2 w-full max-w-[720px] rounded-3xl bg-elevated hairline border-line-tertiary" data-testid="voice-chat">
      <div className="relative flex h-12 items-center justify-center border-b-[0.5px] border-line-secondary text-sm text-fg-secondary">
        {title}
        <IconButton icon={X} label="Close" size={28} className="absolute end-3" onClick={() => setOpen(false)} />
      </div>
      <div className="flex max-h-[min(60vh,560px)] flex-col gap-2 overflow-y-auto overscroll-contain p-4">
        {lines.map((line, i) => (
          <div key={i} className={line.who === "you" ? "flex justify-end" : "flex justify-start"}>
            <p
              className={
                line.who === "you"
                  ? "max-w-[80%] rounded-bubble bg-accent px-4 py-2 text-base text-white"
                  : "max-w-[80%] rounded-bubble bg-secondary px-4 py-2 text-base text-fg"
              }
            >
              {line.text}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

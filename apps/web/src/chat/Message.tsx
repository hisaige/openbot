// One chat bubble with Grok's hover actions (React / Reply / More), reaction chip, reply quote,
// attachments (Attachments.tsx: inline images/video/audio, file cards) and send states
// (grok-bot-ui.md §4.4, grok-bot-ui-activity.md F.7).
import { Copy, Ellipsis, Hash, MessageSquareQuote, Reply, SmilePlus } from "lucide-react"
import { type ReactNode, useState } from "react"
import { useAtomSet } from "@effect/atom-react"
import type { Bot, ConversationId, EntryId } from "@openbot/contracts"
import { commands } from "@openbot/client"
import { Bubble, Menu, MenuItem, MenuSeparator, Popover, cn, useToast, type BubblePosition } from "@openbot/ui"
import { plainPreview } from "../app/format.ts"
import { Attachments } from "./Attachments.tsx"
import type { MessageEntry, PendingMessage } from "./grouping.ts"
import { Markdown, Mention, MentionText } from "./Markdown.tsx"
import { useRoster } from "../app/data.ts"

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "🙏"] as const

/**
 * "to @Sender" above a bot's replies in its direct chat when they answer another Bot's message
 * (`message_bot`), so the owner sees they are not addressed to them.
 */
export function AddresseeChip({ bot, onOpen }: { readonly bot: Bot | undefined; readonly onOpen?: (() => void) | undefined }): ReactNode {
  return (
    <button
      type="button"
      data-testid="addressee-chip"
      onClick={onOpen}
      title={bot ? `This reply answers ${bot.name}'s message` : "This reply answers another Bot"}
      className="ms-3 inline-flex h-5 w-fit items-center gap-1 rounded-full text-xs text-fg-tertiary transition-colors hover:text-fg-secondary"
    >
      to <Mention bot={bot ?? { name: "a Bot", avatar: { shape: "blob", color: "gray" } }} tone="bot" />
    </button>
  )
}

const isEmojiOnly = (text: string) => {
  const t = text.trim()
  return t.length > 0 && t.length <= 8 && /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(t) && !/^[\d#*\s]+$/.test(t)
}

export interface MessageBubbleProps {
  readonly entry: MessageEntry
  readonly position: BubblePosition
  readonly conversationId: ConversationId
  readonly quoted?: MessageEntry | undefined
  readonly onReply?: ((entry: MessageEntry) => void) | undefined
}

export function MessageBubble({ entry, position, conversationId, quoted, onReply }: MessageBubbleProps): ReactNode {
  const roster = useRoster()
  const side = entry.role === "user" ? "user" : "bot"
  const react = useAtomSet(commands["messages.react"])
  const { toast } = useToast()
  const [menuOpen, setMenuOpen] = useState(false)
  const emoji = !quoted && entry.attachments.length === 0 && isEmojiOnly(entry.text)
  const reactions = entry.reactions ?? []
  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => toast({ title: `${what} copied`, icon: Copy }),
      () => toast({ title: `Couldn't copy ${what.toLowerCase()}`, tone: "danger" }),
    )
  }
  const actions = (
    <div className={cn("ob-msg-actions flex shrink-0 items-center gap-0.5 self-center", menuOpen && "opacity-100")} role="toolbar" aria-label="Message actions">
      <Popover
        side="top"
        align={side === "user" ? "end" : "start"}
        label="React"
        onOpenChange={setMenuOpen}
        className="p-1"
        trigger={(p) => (
          <button {...p} type="button" aria-label="React" title="React" className="inline-flex size-7 items-center justify-center rounded-full text-icon-tertiary transition-colors hover:bg-secondary hover:text-icon">
            <SmilePlus size={16} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      >
        {(close) => (
          <div className="flex gap-0.5">
            {QUICK_REACTIONS.map((e) => (
              <button
                key={e}
                type="button"
                className="inline-flex size-8 items-center justify-center rounded-full text-lg hover:bg-hover"
                onClick={() => {
                  react({ conversationId, entryId: entry.id as EntryId, emoji: e })
                  close()
                }}
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </Popover>
      {onReply && (
        <button type="button" aria-label="Reply" title="Reply" onClick={() => onReply(entry)} className="inline-flex size-7 items-center justify-center rounded-full text-icon-tertiary transition-colors hover:bg-secondary hover:text-icon">
          <Reply size={16} strokeWidth={1.75} aria-hidden />
        </button>
      )}
      <Menu
        label="More actions"
        align={side === "user" ? "end" : "start"}
        side="top"
        onOpenChange={setMenuOpen}
        trigger={(p) => (
          <button {...p} type="button" aria-label="More" title="More" className="inline-flex size-7 items-center justify-center rounded-full text-icon-tertiary transition-colors hover:bg-secondary hover:text-icon">
            <Ellipsis size={16} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      >
        <MenuItem icon={Copy} onSelect={() => copy(entry.text, "Message")}>
          Copy
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={Hash} onSelect={() => copy(entry.id, "Message ID")}>
          Copy message ID
        </MenuItem>
      </Menu>
    </div>
  )

  return (
    <div className={cn("ob-msg flex w-full flex-col gap-1", side === "user" ? "items-end" : "items-start", reactions.length > 0 && "pt-5")} data-entry={entry.id}>
      <Attachments items={entry.attachments} side={side} />
      {(entry.text.length > 0 || quoted) && (
        <div className={cn("relative flex w-full items-end gap-2", side === "user" ? "flex-row-reverse" : "flex-row")}>
          <Bubble side={side} position={position} emojiOnly={emoji} className={cn("relative", side === "bot" && !emoji && "whitespace-normal", entry.aborted && "opacity-80")}>
            {quoted && (
              <span className="mb-0.5 flex items-center gap-1 text-xs opacity-80">
                <MessageSquareQuote size={13} strokeWidth={1.75} aria-hidden />
                <span className="truncate">“{plainPreview(quoted.text, 80)}”</span>
              </span>
            )}
            {side === "bot" && !emoji ? <Markdown text={entry.text} bots={roster.bots} bodyId={entry.id} /> : emoji ? entry.text : <MentionText text={entry.text} bots={roster.bots} />}
            {entry.aborted && <span className="ms-1 text-sm opacity-70">(stopped)</span>}
            {reactions.length > 0 && (
              <span className={cn("absolute -top-4 flex gap-0.5", side === "user" ? "-start-3" : "-end-3")}>
                {Object.entries(reactions.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.emoji]: (acc[r.emoji] ?? 0) + 1 }), {})).map(([e, n]) => {
                  // Who reacted (bots react too, D5.1 `react` tool): shown on hover.
                  const who = reactions
                    .filter((r) => r.emoji === e)
                    .map((r) => (r.by.kind === "bot" ? (roster.botById(r.by.botId)?.name ?? "A Bot") : "You"))
                    .join(", ")
                  return (
                  <button
                    key={e}
                    type="button"
                    onClick={() => react({ conversationId, entryId: entry.id as EntryId, emoji: e })}
                    className="inline-flex h-7 min-w-7 items-center justify-center gap-0.5 rounded-full bg-elevated px-1 text-base shadow-control ring-2 ring-chrome"
                    title={`${e} ${who}`}
                    aria-label={`${e} by ${who}`}
                    data-testid="reaction"
                  >
                    {e}
                    {n > 1 && <span className="text-xs text-fg-secondary">{n}</span>}
                  </button>
                  )
                })}
              </span>
            )}
          </Bubble>
          {!entry.streaming && actions}
        </div>
      )}
    </div>
  )
}

/** Optimistic user bubble from the outbox: pending progress bar, or "Failed to send · Resend · Delete". */
export function PendingBubble({ pending, position, onResend, onDelete }: { readonly pending: PendingMessage; readonly position: BubblePosition; readonly onResend: () => void; readonly onDelete: () => void }): ReactNode {
  return (
    <div className="flex flex-col items-end gap-1" data-pending={pending.clientNonce}>
      <div className="relative">
        <Bubble side="user" position={position}>
          {pending.text}
        </Bubble>
        {pending.status === "sending" && (
          <span className="ob-send-progress absolute -bottom-2 end-2 h-1 w-5 overflow-hidden rounded bg-secondary" aria-label="Sending">
            <span className="absolute inset-y-0 start-1.5 w-2 rounded bg-fg-tertiary" />
          </span>
        )}
      </div>
      {pending.status === "failed" && (
        <div className="mt-1 flex items-center gap-1 text-[11px] leading-[14px]">
          <span className="font-medium text-danger-fg" title={pending.error}>
            Failed to send
          </span>
          <button type="button" onClick={onResend} className="h-[22px] rounded-[11px] px-2 text-fg-secondary hover:bg-hover hover:text-fg">
            Resend
          </button>
          <button type="button" onClick={onDelete} className="h-[22px] rounded-[11px] px-2 text-fg-secondary hover:bg-hover hover:text-fg">
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

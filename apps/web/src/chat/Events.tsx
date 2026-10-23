// Event lines (one per ConversationEvent type), notices and the unknown-entry placeholder
// (grok-bot-ui.md §4.4 "Event lines"). Centered 13/18 secondary text with inline chips.
import { Archive, Ban, BookMarked, Brain, CircleAlert, Clock, Info, ShieldCheck, ShieldX, Sparkles, TriangleAlert, Users } from "lucide-react"
import type { ReactNode } from "react"
import type { Bot, ConversationId } from "@openbot/contracts"
import { Avatar, AvatarStack, EventChip, EventLine, Icon, cn } from "@openbot/ui"
import { VoiceChatLine } from "../voice/VoiceChatLine.tsx"
import type { ExchangeTarget } from "./exchange.ts"
import type { EventEntry, MessageEntry, NoticeEntry, UnknownEntry } from "./grouping.ts"

export interface EventContext {
  readonly botById: (id: string | undefined) => Bot | undefined
  readonly openConversation: (id: ConversationId) => void
  readonly openBot: (botId: string) => void
  readonly openRoutines: () => void
  /** Opens the bot-to-bot exchange between `a` and `b` (ExchangeDialog) at the line's message(s). */
  readonly openExchange: (a: string, b: string, target: ExchangeTarget) => void
}

/**
 * "N messages with ‹avatar› ‹Bot›" (Grok): a run of bot-to-bot messages collapsed into one centered,
 * clickable line that opens the whole exchange at those messages.
 */
export function ExchangeLine({ ctx, peerBotId, ownerBotId, entries }: { readonly ctx: EventContext; readonly peerBotId: string; readonly ownerBotId: string; readonly entries: ReadonlyArray<MessageEntry> }): ReactNode {
  const peer = ctx.botById(peerBotId)
  const count = entries.length
  return (
    <EventLine>
      <button
        type="button"
        data-exchange={peerBotId}
        onClick={() => ctx.openExchange(ownerBotId, peerBotId, { at: entries[0]?.createdAt ?? 0, entryIds: entries.map((e) => e.id) })}
        className="inline-flex h-6 min-w-0 items-center gap-1 rounded-full px-1.5 text-fg-secondary transition-colors duration-[120ms] hover:bg-secondary hover:text-fg"
      >
        {count} {count === 1 ? "message" : "messages"} with
        <Avatar shape={peer?.avatar.shape} color={peer?.avatar.color} size={16} className="ms-0.5" />
        <span className="truncate text-fg-secondary">{peer?.name ?? "a Bot"}</span>
      </button>
    </EventLine>
  )
}

function BotChip({ ctx, botId, name }: { readonly ctx: EventContext; readonly botId: string; readonly name?: string | undefined }): ReactNode {
  const bot = ctx.botById(botId)
  return (
    <EventChip leading={<Avatar shape={bot?.avatar.shape} color={bot?.avatar.color} size={16} />} onClick={() => ctx.openBot(botId)}>
      {bot?.name ?? name ?? "a Bot"}
    </EventChip>
  )
}

const Strong = ({ children }: { readonly children: ReactNode }) => <span className="text-fg">{children}</span>

const routineVerb = { created: "Created routine", updated: "Updated routine", enabled: "Resumed routine", disabled: "Paused routine", deleted: "Deleted routine" } as const
const runVerb = { running: "Started routine", succeeded: "Finished routine", failed: "Routine failed:", interrupted: "Interrupted routine", skipped: "Skipped routine" } as const

export function EventRow({ entry, ctx }: { readonly entry: EventEntry; readonly ctx: EventContext }): ReactNode {
  const ev = entry.event
  switch (ev.type) {
    case "name-changed":
      return (
        <EventLine>
          Renamed to <Strong>{ev.to}</Strong>
        </EventLine>
      )
    case "joined":
      return (
        <EventLine>
          <BotChip ctx={ctx} botId={ev.botId} name={ev.name} /> joined the team
        </EventLine>
      )
    case "member-added":
      return (
        <EventLine>
          <BotChip ctx={ctx} botId={ev.botId} name={ev.name} /> was added to the chat
        </EventLine>
      )
    case "member-removed":
      return (
        <EventLine>
          <BotChip ctx={ctx} botId={ev.botId} name={ev.name} /> was removed from the chat
        </EventLine>
      )
    case "messaged-bot": {
      const from = entry.author.kind === "bot" ? entry.author.botId : undefined
      return (
        <EventLine>
          Messaged
          <EventChip
            leading={<Avatar shape={ctx.botById(ev.toBotId)?.avatar.shape} color={ctx.botById(ev.toBotId)?.avatar.color} size={16} />}
            data-exchange={ev.toBotId}
            onClick={() =>
              from
                ? ctx.openExchange(from, ev.toBotId, { at: entry.createdAt, entryIds: ev.entryId ? [ev.entryId] : [], fromBotId: from, toBotId: ev.toBotId })
                : ctx.openConversation(ev.conversationId)}
          >
            {ctx.botById(ev.toBotId)?.name ?? ev.toName}
          </EventChip>
          {ev.urgency === "urgent" && <span className="text-fg-tertiary">(urgent)</span>}
        </EventLine>
      )
    }
    case "posted-to-group":
      return (
        <EventLine>
          Posted to
          <EventChip leading={<Icon icon={Users} size="sm" />} onClick={() => ctx.openConversation(ev.conversationId)}>
            {ev.title}
          </EventChip>
        </EventLine>
      )
    case "handoff":
      return (
        <EventLine>
          Handed off to
          <EventChip
            leading={<Avatar shape={ctx.botById(ev.toBotId)?.avatar.shape} color={ctx.botById(ev.toBotId)?.avatar.color} size={16} />}
            data-exchange={ev.toBotId}
            onClick={() => ctx.openExchange(ev.fromBotId, ev.toBotId, { at: entry.createdAt, entryIds: [], fromBotId: ev.fromBotId, toBotId: ev.toBotId })}
          >
            {ctx.botById(ev.toBotId)?.name ?? ev.toName}
          </EventChip>
          <span className="max-w-[360px] truncate text-fg-tertiary">· {ev.task}</span>
        </EventLine>
      )
    case "bot-exchange": {
      const peers = ev.peerBotIds.map((id) => ctx.botById(id))
      const n = ev.messageCount
      const label = `${n} ${n === 1 ? "message" : "messages"} with`
      if (peers.length === 1) {
        return (
          <EventLine>
            {label} <BotChip ctx={ctx} botId={ev.peerBotIds[0]!} />
          </EventLine>
        )
      }
      return (
        <EventLine>
          {label}
          <EventChip
            interactive={false}
            leading={<AvatarStack size={18} outlineColor="var(--ob-chrome)" avatars={peers.map((b, i) => ({ key: String(i), shape: b?.avatar.shape, color: b?.avatar.color }))} />}
          >
            {peers.length} Bots
          </EventChip>
        </EventLine>
      )
    }
    case "hop-limit":
      return (
        <EventLine>
          <Icon icon={Ban} size="sm" className="me-1 text-icon-tertiary" />
          Stopped: too many hand-offs
        </EventLine>
      )
    case "routine-changed":
      return (
        <EventLine>
          {routineVerb[ev.action]}
          <EventChip leading={<Icon icon={Clock} size="sm" />} onClick={ctx.openRoutines}>
            {ev.routineName}
          </EventChip>
          {ev.action === "deleted" && <span className="text-fg-tertiary">(deleted)</span>}
        </EventLine>
      )
    case "routine-run":
      return (
        <EventLine className={cn(ev.status === "failed" && "text-danger-fg")}>
          {runVerb[ev.status]}
          <EventChip leading={<Icon icon={Clock} size="sm" />} onClick={ctx.openRoutines}>
            {ev.routineName}
          </EventChip>
        </EventLine>
      )
    case "memory-updated": {
      const bot = ctx.botById(ev.botId)
      return (
        <EventLine>
          <Icon icon={Brain} size="sm" className="me-1 text-icon-tertiary" />
          {ev.action === "remembered" ? "Remembered" : ev.action === "forgot" ? "Forgot" : "Updated memory"}
          {ev.title ? <Strong>&nbsp;“{ev.title}”</Strong> : <>&nbsp;for {bot?.name ?? "this Bot"}</>}
        </EventLine>
      )
    }
    case "skill-saved":
      return (
        <EventLine>
          <Icon icon={BookMarked} size="sm" className="me-1 text-icon-tertiary" />
          Saved skill <Strong>&nbsp;{ev.name}</Strong>
        </EventLine>
      )
    case "auto-decided":
      return (
        <EventLine>
          <Icon icon={ev.decision === "allowed" ? ShieldCheck : ShieldX} size="sm" className={cn("me-1", ev.decision === "allowed" ? "text-success-fg" : "text-danger-fg")} />
          {ev.decision === "denied" ? "Blocked by your rules:" : ev.autonomy === "workspace" ? "Allowed in its workspace:" : ev.autonomy === "full" ? "Allowed (Full auto):" : "Allowed by your rules:"}
          <span className="ms-1 max-w-[420px] truncate text-fg">{ev.summary}</span>
        </EventLine>
      )
    case "request-elsewhere":
      return (
        <EventLine>
          <BotChip ctx={ctx} botId={ev.botId} /> needs your approval
          <button type="button" className="ms-1 text-accent-fg hover:underline" onClick={() => ctx.openConversation(ev.conversationId)}>
            in your direct chat
          </button>
        </EventLine>
      )
    case "session-changed":
      return (
        <EventLine>
          <Icon icon={ev.action === "compacted" ? Archive : Sparkles} size="sm" className="me-1 text-icon-tertiary" />
          {ev.action === "compacted" ? "Compacted context" : "Started a new session"}
          {ctx.botById(ev.botId) && <span className="text-fg-tertiary">&nbsp;· {ctx.botById(ev.botId)!.name}</span>}
        </EventLine>
      )
    case "voice-call":
      return <VoiceChatLine durationMs={ev.durationMs} lines={ev.lines} />
    default:
      return <EventLine className="text-fg-tertiary">Something happened here that this version of OpenBot can't show.</EventLine>
  }
}

export function NoticeRow({ entry }: { readonly entry: NoticeEntry }): ReactNode {
  const icon = entry.level === "error" ? CircleAlert : entry.level === "warning" ? TriangleAlert : Info
  return (
    <EventLine className={cn(entry.level === "error" ? "text-danger-fg" : entry.level === "warning" ? "text-warn-fg" : "text-fg-secondary")}>
      <Icon icon={icon} size="sm" className="me-1" />
      <span className="max-w-[640px] text-center">{entry.text}</span>
    </EventLine>
  )
}

export function UnknownRow({ entry }: { readonly entry: UnknownEntry }): ReactNode {
  return (
    <div className="flex justify-start py-1" data-unknown={entry.originalTag}>
      <div className="max-w-[min(80%,560px)] rounded-bubble border-[0.5px] border-dashed border-line px-3 py-[7px] text-base text-fg-secondary">
        This message can't be shown in this version of OpenBot. Update OpenBot to see it.
      </div>
    </div>
  )
}

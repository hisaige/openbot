# OpenBot interfaces cheat-sheet (wave 1)

The compiled contract between wave-1 work packages. It summarizes `@openbot/contracts`,
`@openbot/node-protocol` and `@openbot/core` (ports, service shapes, testing) as of the end of
wave 0. **The code is the source of truth**; this page tells you where to look and what was decided.
Binding rules live in `AGENTS.md`, `docs/decisions.md` and `docs/architecture.md`.

Contents: [1 Conventions](#1-conventions) · [2 Ownership, exports, composition](#2-ownership-expected-exports-and-composition) ·
[3 contracts](#3-openbotcontracts) · [4 node-protocol](#4-openbotnode-protocol) · [5 core ports](#5-openbotcore-ports) ·
[6 core service shapes](#6-openbotcore-service-shapes-portsservicests) · [7 core/testing](#7-openbotcoretesting) ·
[8 Cross-WP decisions](#8-cross-wp-decisions-made-at-integration) · [9 Known gaps](#9-known-gaps-not-in-the-v1-contracts)

---

## 1. Conventions

- **Imports.** `@openbot/contracts` (browser-safe), `@openbot/node-protocol` (browser-safe) plus its
  `@openbot/node-protocol/testing` subpath, `@openbot/core` (ports + service tags + service layers)
  and `@openbot/core/testing` (doubles). Never import from `src/` paths of another package.
- **Tags.** Every port and service is a `Context.Service` class. Access it with `yield* Tag`. Build an
  implementation with `Tag.of({...})`; provide it with `Layer.effect(Tag, make)` or `Layer.succeed`.
  For a quick partial stub in tests, use `Layer.mock(Tag, { onlyTheMethodsYouNeed })` (effect 4.0.4;
  missing members die with `UnimplementedError`).
- **Layer names.** The implementation of tag `X` is exported as `XLive` (for example `LiveHubLive`
  or `PersistenceLive(dataDir)`). Its requirements may only name tags from LOWER layers (§2.3).
- **Errors.**
  - Use `Schema.TaggedError<Self>()("Tag", fields)`. `Schema.TaggedErrorClass` does not exist in
    4.0.4; AGENTS.md is wrong on this point.
  - Wire and RPC errors come from contracts: `NotFound{entity,id}`, `InvalidInput{message}`,
    `Conflict{reason}`, `Forbidden{reason}`, `Unauthorized{reason}`,
    `HarnessUnavailable{harness,message}`, `RequestNotPending{requestId,status}`,
    `NodeUnavailable{nodeId,message}` and `Internal{message}`.
  - Port errors come from core: `RepoError{op,message,cause?}`,
    `HarnessError{harness,code,message,retryable?,cause?}` and
    `PlacementError{botId,nodeId?,reason,message,cause?}`.
  - Services `Effect.orDie` any `RepoError`. The RPC edge maps defects to `Internal`, and the gateway
    maps them to `ERROR: Internal error`.
  - Refusals of bot-facing tools fail with `InvalidInput` and a message the model can read.
- **Ids.** Ids are branded strings (`BotId`, `ConversationId`, …). New ids come from the `IdGen`
  port, never from `crypto.randomUUID`, so tests stay deterministic. Ids never contain `:`.
- **Time.** Use `Clock.currentTimeMillis`, never `Date.now()`, so `TestClock` works.
- **Optional fields.** contracts uses `Schema.optionalKey` (exact `?:`). node-protocol and the core
  record schemas use `Schema.optional` (`?: T | undefined`).
- **Effect 4.0.4 traps.** See effect4-core.md §23. The common ones:
  - `Stream.filterMap` takes a `Result`-returning function.
  - Tags have no `.asEffect()`, because they already are Effects.
  - `Effect.forkChild` needs `{ startImmediately: true }` when ordering matters.
  - `PubSub.subscribe` must run before you publish.

## 2. Ownership, expected exports and composition

### 2.1 Who implements what

| WP | Implements (tags) | Must export (names the server composes) |
|---|---|---|
| W1.1 persistence | every repository/store tag (`RepositoryPorts`), `ProcessLedger`, `McpTokenRepo`, `BootRecovery` | `PersistenceLive(dataDir: string): Layer<RepositoryPorts \| BootRecovery, <boot error>, IdGen>`. Its `BootRecovery` uses core's `runBootRecovery({killProcessGroup})`. |
| W1.2 core conversation | `LiveHub`, `ConversationService`, `Notifier`, `AttachmentService`, `InstructionRenderer`, `BackgroundTasks`, `Orchestrator`, `Messaging`, `BotService` | `LiveHubLive`, `ConversationServiceLive`, `NotifierLive`, `AttachmentServiceLive`, `InstructionRendererLive`, `BackgroundTasksLive` (`makeBackgroundTasksLayer(options)`), `OrchestratorLive`, `MessagingLive`, `BotServiceLive`, all from `core/src/services/conversation/index.ts` |
| W1.3 core automation | `SettingsService`, `UsageService`, `MemoryService`, `SkillService`, `ApprovalService`, `RoutineScheduler` | `SettingsServiceLive`, `UsageServiceLive`, `MemoryServiceLive`, `SkillServiceLive`, `ApprovalServiceLive`, `RoutineSchedulerLive`, all from `core/src/services/automation/index.ts` |
| W1.4 harness-fake | a `HarnessDriver` (kind `fake`) | `FakeHarnessLive: Layer<never, never, HarnessRegistry>` (via `HarnessRegistry.registerLayer`), plus `makeFakeDriver(options?)` |
| W1.5 harness-claude | `HarnessDriver` (kind `claude`) | `ClaudeHarnessLive(config?)`. Requires `HarnessRegistry`, plus `DataDir` and `ProcessLedger` as needed. `config` injects `query` for tests. |
| W1.6 harness-codex | `HarnessDriver` (kind `codex`) | `CodexHarnessLive(config?)`, same requirements |
| W1.7 harness-opencode | `HarnessDriver` (kind `opencode`) | `OpenCodeHarnessLive(config?)`, same requirements |
| W1.8 gateway | `McpBindingIssuer`, plus its own `McpGateway` tag | `McpBindingIssuerLive: Layer<McpBindingIssuer, never, McpTokenRepo \| InternalAddress>` and `McpGatewayLive` (provides `McpGateway { handle: (req: Request) => Promise<Response> }`, mounted at `/mcp/:botId`) |
| W1.9 node-daemon | `NodeRpcs` handlers; DialOut provides `BrainLink`/`StreamDialer` for remote nodes | `NodeHandlersLive(config)`: handler layer for `NodeRpcs`, requiring `BrainLink \| StreamDialer` (§4.5). Also `DialOut`, `KeyStore`, `PathPolicy`, `NodePolicy`, `AuditLog`, `BrowserManager`. |
| W1.10 brain-nodes | `NodeDirectory`, `NodeAdmin`, `PlacementService`, `ComputerPort`; the local node | `NodeRegistryLive` (`NodeDirectory`+`NodeAdmin`, layer 0), `PlacementServiceLive`, `ComputerServiceLive`, plus top-level `NodeGatewayLive` and `LocalNodeLive` (these need `ApprovalService`). Handlers as functions/Effects for `/node`, `/node/pair`, `/node/stream/:id`, `/relay/:nodeId/:kind`, `/ws/computer/:botId` and a terminal socket (`/ws/terminal/:botId`, xterm.js ↔ `pty.open`). |
| W1.11 ui | none (React) | primitives, `Avatar` (mirrors `defaultBotAvatar`, §8.9), tokens |
| W1.12 client | none (atoms over `OpenBotRpcs`) | `OpenBotClient`, `rosterAtom`, `conversationAtom(id)`, `connectionAtom` and mutation atoms |
| W2.1 server | provides `DataDir`, `IdGen`, `InternalAddress`, `HarnessRegistry`, config; RPC handlers | composition root |

### 2.2 Who provides the ports

- **Repositories and stores** (`RepositoryPorts`): W1.1. Tests use `MemoryPersistence`.
- **`BootRecovery`**: W1.1. Tests use `MemoryBootRecovery()`.
- **`IdGen`**: `IdGen.layer` (ULIDs). Tests use `SequentialIdGen()`.
- **`DataDir`**: `DataDir.layer(root)`.
- **`InternalAddress`**: the server, with `InternalAddress.layer(url)` or a Deferred-backed layer.
- **`HarnessRegistry`**: `HarnessRegistry.layer`. Drivers add themselves with `registerLayer`.
- **`NodeDirectory`, `NodeAdmin`, `PlacementService` and `ComputerPort`**: W1.10. Fakes are in
  core/testing.
- **`McpBindingIssuer`**: W1.8. A fake is in core/testing.
- **`Notifier`**: W1.2. A fake is in core/testing.

### 2.3 Layer order (no cycles; a layer may depend only on layers above it)

```
0  ports: RepositoryPorts, BootRecovery, IdGen, DataDir, InternalAddress, HarnessRegistry (+ drivers),
   NodeDirectory, NodeAdmin, PlacementService, ComputerPort (brain-nodes registry, NOT the gateways),
   McpBindingIssuer (gateway)
1  LiveHub               (repos + NodeDirectory; forwards NodeDirectory.changes into the roster)
2  SettingsService, UsageService, Notifier, ConversationService, AttachmentService
3  MemoryService, SkillService
4  ApprovalService       (never calls Orchestrator; answers to async tool requests → asyncAnswers)
5  InstructionRenderer
5b BackgroundTasks       (D5.7; never calls Orchestrator: emits `results`, task-result deliveries)
6  Orchestrator          (drains ApprovalService.asyncAnswers and BackgroundTasks.results; owns runners, turns, approveToolCall)
7  Messaging, RoutineScheduler
8  BotService
top  McpGatewayLive (gateway), NodeGatewayLive + LocalNodeLive (brain-nodes: need ApprovalService), RPC handlers
```

Boot (server):
1. Migrations.
2. `(yield* BootRecovery).run` produces `report`.
3. `(yield* Orchestrator).recover(report)`.
4. Drivers.
5. Local node, then `(yield* BackgroundTasks).recover(report)` (the tasks boot recovery failed are published and each bot is told; it needs its driver).
6. Gateway.
7. Node gateway.
8. Scheduler: its layer forks the fiber.
9. Public listener.

---

## 3. @openbot/contracts

Files are in `packages/contracts/src/`, and everything is re-exported from `index.ts`.

| File | Key exports |
|---|---|
| `base.ts` | Ids: `BotId UserId ConversationId EntryId RequestId TurnId NodeId RoutineId RoutineRunId SectionId AttachmentId ApprovalRuleId NotificationId TaskId` (`tsk_`). `LOCAL_NODE_ID` (`"node_local"`), `OWNER_USER_ID`, `IdPrefix`. `Millis`, `NonNegativeInt`, `NonEmptyString`, `Slug`. `HarnessKind` (`claude\|codex\|opencode\|fake`), `HarnessKindName` (an open string; unknown kinds are kept), `isKnownHarnessKind`, `KnownHarnessKinds`. `HarnessRef{harness,nativeId}`, `Usage{inputTokens,outputTokens,cachedInputTokens?,reasoningTokens?,costUsd?}`, **`ContextUsage{usedTokens,windowTokens}`**, `Author` (user\|bot\|system), `withUnknownFallback` |
| `domain.ts` | `Bot{id,name,label?,avatar{shape,color},harness{kind,model?,effort?,profileId?},hostNodeId=node_local,boundNodeIds=[],instructions,directConversationId,sectionId?,pinned,hidden,notify:all\|mentions\|none,autonomy:ask\|workspace\|full=workspace,projectFolders=[],createdAt,updatedAt}`. `BotAvatar`, `AvatarShapes`(13), `AvatarColors`(11), **`fnv1a32`, `defaultBotAvatar(id)`**. `BotActivity{botId,conversationId?,state:idle\|thinking\|working\|waiting\|error\|offline,label?,toolKind?,since}`. `Section{id,name,order}`. `Conversation` = `DirectConversation{botId}` \| `GroupConversation{memberBotIds,leadBotId?,namedBy}` \| `RoutineRunConversation{botId,routineId,runId,triggerSummary}`. Common fields: `id,title,createdAt,lastActivityAt,unreadCount,unreadBoundaryAt?,hiddenFromSidebar,epoch,`**`sessions?: ConversationSession[]`**. `ConversationSession{botId,active,contextUsage?,updatedAt}`, `ConversationSummary`, `MIN_GROUP_BOTS=2`/`MAX_GROUP_BOTS=6`. Routine triggers: `Cron{schedule,timezone}` \| `Interval{everyMinutes≥5}` \| `Once{at}` \| `Manual`; `Webhook` is decode-only. `RoutineTriggerInput`, `RoutineOutput: direct\|own-conversation`, `Routine{…,enabled,lastRunAt?,lastRunStatus?,nextRunAt?}`, `RoutineRun{id,routineId,firedBy:schedule\|manual\|catch-up,startedAt,finishedAt?,status:running\|succeeded\|failed\|interrupted\|skipped,conversationId,turnId?,summary?,error?}`, `ROUTINE_RUNS_KEPT=20`. `NodeCapabilities` (names), `NodeStatus`, `NodeSummary{id,label,kind:local\|remote,status,capabilities(effective),declaredCapabilities,platform,hostname,roots,version?,lastSeenAt?,createdAt}`. `PairingCode{code,expiresAt,command}`. `Notification{id,kind,botId?,conversationId?,title,body,at}` |
| `transcript.ts` | `TranscriptEntry`: whole-entry upserts, with base fields `id,conversationId,revision,createdAt,updatedAt,author,turnId?,replyToId?,threadRootId?,parentToolCallId?,harnessRef?`. Kinds: `message{role,text,attachments,streaming,phase?,clientNonce?,delivery?,aborted?,addressedBotIds?,toBotId?,reactions?}`, `reasoning{text,streaming,source}`, `tool-call{toolCallId,name,title?,toolKind,status,input,inputSummary?,output?,error?,mcp?,command?,fileChanges?,nodeId?,requestId?,startedAt,completedAt?}`, `card{card,state}`, `event{event}` and `notice{level,code,text}`. Unknown kinds decode to `{kind:"unknown"}`. Also `KnownTranscriptEntry` (encodable), `TranscriptEntryOf<K>`, `ToolKind`, `ToolCallStatus` and `ConversationEvent`, whose types are name-changed, joined, member-added, member-removed, messaged-bot, posted-to-group, handoff, bot-exchange, hop-limit, routine-changed, routine-run, memory-updated, skill-saved, auto-decided, request-elsewhere and session-changed. `Turn{id,conversationId,botId,status:queued\|running\|waiting\|completed\|interrupted\|failed,trigger,inputEntryId?,harnessRef?,startedAt,endedAt?,usage?,stopReason?,failure?}`, `Attachment`, `MessageDelivery` |
| `card.ts` | `Card` = `approval` \| `question` \| `form` \| `secret-request` \| `handoff` \| `routine` (informational). `ApprovalCard` / `QuestionCard` carry `taskTitle?` (raised by a background task, D5.7: the card's subtitle). `CardState{status:pending\|resolved\|dismissed\|expired\|cancelled\|info,response?,detail?}` |
| `activity.ts` | Owner-visible activity phrases shared by the harness adapters (D6.4): `THINKING_ACTIVITY` ("Thinking…", the generic phrase: thinking, bookkeeping tools, native helpers), `MESSAGING_ACTIVITY` ("Sending a message": `message_bot` / `handoff_task` / `post_to_group`), `CONNECTED_APP_ACTIVITY` (another MCP server), `openBotToolActivity(tool)` (gateway tools other than the computer tools) |
| `task.ts` | Background tasks (D5.7): `Task{id,botId,conversationId (origin),title,brief,status:queued\|running\|succeeded\|failed\|cancelled,createdAt,updatedAt,startedAt?,endedAt?,result?,error?,stoppedBy?:owner\|bot\|system,usage?,progress?,stepCount?,waiting?}`, `TaskDetail{task,steps: TranscriptEntry[]}`, `isTerminalTaskStatus`, `isActiveTask`, limits `TASK_TITLE_MAX_CHARS=120` / `TASK_BRIEF_MAX_CHARS` / `TASK_RESULT_MAX_CHARS=16000`, `DEFAULT_TASKS_PER_BOT=3`, `ROSTER_FINISHED_TASKS=5` |
| `runtime-request.ts` | `RuntimeRequest{id,conversationId,botId,turnId?,taskId?,cardEntryId,kind,status:pending\|resolved\|expired\|cancelled,statusReason?,title,detail?,subject,responseCapability,suggestedRule?,source{origin,method,nativeRequestId},blocking,createdAt,expiresAt?,resolvedAt?,response?,resolvedBy?}`. `RuntimeRequestKind`: tool-, command-, file- and mcp-approval, question, form, secret, handoff. `DecisionId`: allow-once, allow-session, allow-always, deny, cancel. `Question`, `FormField`, `ResponseCapability`, `RuntimeResponse`, `RuntimeResponseInput` (a secret carries its value and is never stored), `DEFAULT_APPROVAL_EXPIRY_MINUTES=10` |
| `harness.ts` | `PlacementMode`: native-local, brain-mcp-hands, codex-environment. `HarnessCapabilities{resume,steer,interrupt,approvals,questions,compact,contextUsage,images,remotePlacements}`, `HarnessStatus{kind,displayName?,installed,version?,auth{state,label?},problems,capabilities?,checkedAt?}`, `ModelInfo{id,label,default?,efforts?}`. `HarnessItem` (`_tag`): `Message`, `Reasoning`, `ToolCall` and `Notice`. `HarnessEvent` (`_tag`): `SessionBound`, `TurnStarted{turnId,initiator?:"harness"}`, `ItemUpserted{turnId,key,item}`, `Activity`, `Usage`, `ContextUsage`, `TurnCompleted`, `TurnFailed{error{code,message,retryable}}`, `TurnInterrupted` and `SessionClosed`. `HarnessRequest` = `HarnessApprovalRequest{kind,toolName,title,detail,`**`surface?`**`,toolKey?,nativeRequestId?,command?,cwd?,paths?,diff?,server?,input?,nodeId?,suggestions?}` \| `HarnessQuestionRequest{kind:"question",title?,toolKey?,nativeRequestId?,questions}`. `HarnessRequestResolution` = `{decision,message?,updatedInput?,native?}` \| `{answers: Record<id, string\|string[]>}`, plus `isAnswersResolution` |
| `policy.ts` | `ApprovalRule{id,botId?,surface,match{toolName?,commandPrefix?,pathPrefix?},action:ask\|allow\|deny,note?,origin?,createdAt}`, `ApprovalRuleInput`, `ApprovalSurface` (shell, file-edit, file-read, mcp, browser, computer, network, other), `SuggestedRule` |
| `settings.ts` | `Settings{theme,accent,showSteps,botMessaging,defaultHarness?,approvalExpiryMinutes,ownerName?}` (every key has a decoding default), `DEFAULT_SETTINGS`, `SettingsPatch` (`null` clears), `applySettingsPatch` |
| `memory.ts` / `skills.ts` | `MemoryFact{id: MemoryFactId(slug),title,description?,body,updatedAt}`, `BotMemory{index,facts}`, `MemoryFactInput`, `memoryFactIdFromTitle`, `MEMORY_INDEX_PROMPT_CAP_BYTES=4096`. `Skill{name: SkillName(slug),description,body,updatedAt,source?{kind:"skills.sh",id,hash?},files?}`, `SkillInput`, `SkillSearchResult{id,name,repo,installs}`, `SkillPreview{id,name,description,body,files[{path,bytes}],replaces}` |
| `stream.ts` | `StreamCursor{epoch,sequence}`. Conversation changes: `entry.upserted`, `entry.removed`, `request.upserted`, `turn.upserted` and `conversation.updated`. Conversation stream items: `snapshot{cursor,conversation,entries,requests,turns,hasMoreBefore,beforeCursor}`, `change`, `synchronized` and `reset{epoch,reason}`. Roster changes: `bot.upserted`/`removed`, `conversation.upserted`/`removed`, `activity.updated`, `node.upserted`/`removed`, `section.upserted`/`removed`, `settings.updated`, `notification` and `task.upserted`/`task.removed` (D5.7). Roster snapshot: `{bots,conversations,activities,nodes,sections,settings,tasks?}` (`tasks`: every active task + each bot's 5 latest finished ones; absent from older brains). `Known*` variants are the encodable server-side unions. `TranscriptPage` |
| `projection.ts` | Pure reducers: `applyConversationStreamItem`, `applyRosterStreamItem` (a gap sets `gap:true`; `RosterState.tasks`, at most `ROSTER_TASKS_KEPT=200`, a removed bot takes its tasks), `prependHistory`, `transcriptOf`, `pendingRequestsOf`, `sectionsOf`, `activeTasksOf(state, botId)`. Server helpers: `resumePlan(after, head, oldestBuffered)`, `coalesce`, `compareEntries`, `MAX_REPLAY_GAP=256`, `SNAPSHOT_TAIL_ENTRIES=100` |
| `rpc.ts` | errors (§1), payload types (`SessionInfo`, `BotCreateInput`, `BotPatch`, `BotContext`, `SendMode`, `SendInput`, `SendResult{entryId,turnIds,disposition}`, `SendLookup`, `RoutineSpec`, `ComputerState`, `ComputerStatus{botId,nodeId,state,surface: browser|desktop|none,controller,viewPath?,message?,width?,height?,missing?}`, `BotUsage`), `OpenBotRpcs`, `OpenBotRpcTag` |

### 3.1 `OpenBotRpcs` (62 RPCs; every error union also contains `Internal`)

Each RPC maps to one method. Service methods are in §6; port methods are `NodeAdmin`, `NodeDirectory`, `ComputerPort` and `HarnessRegistry`.

| RPC | Payload → success | Calls |
|---|---|---|
| `session.info` | → `SessionInfo{ownerName,version,dataDir,firstRun}` | server (SettingsService + BotService) |
| `roster.subscribe` (stream) | `{after?}` → `RosterStreamItem` | `LiveHub.subscribeRoster` |
| `bots.create` | `BotCreateInput` → `Bot` | `BotService.create` |
| `bots.update` | `{botId, patch}` → `Bot` | `BotService.update` |
| `bots.delete` / `bots.get` | `{botId}` | `BotService.delete` / `get` |
| `bots.readContext` | `{botId}` → `BotContext{instructions,memory}` | `BotService.readContext` |
| `bots.newSession` / `bots.compact` | `{botId}` | `BotService.newSession` / `compact` (the bot's single session, D5.0) |
| `sections.list/create/rename/delete/reorder` | … | `BotService.*Section(s)` |
| `conversations.subscribe` (stream) | `{conversationId, after?, tailLimit?}` | `LiveHub.subscribeConversation` |
| `conversations.history` | `{conversationId, beforeCursor, limit}` → `TranscriptPage` | `ConversationService.history` |
| `conversations.exchange` | `{botId, peerBotId, at? \| before? \| after?, limit}` → `ExchangePage{entries, beforeCursor, afterCursor}`: the messages two bots sent each other (both DMs), paged around a time or from a cursor | `ConversationService.exchange` |
| `conversations.createGroup/setMembers/rename/markRead/setHidden` | … | `ConversationService.*` |
| `conversations.delete` | `{conversationId}` (groups only; `InvalidInput` for a DM / routine run) | `Orchestrator.deleteConversation` (stops the members' work there, cancels its requests, then `ConversationService.removeGroup`) |
| `messages.send` | `SendInput` → `SendResult` | `Orchestrator.send` |
| `messages.lookupSend` / `messages.react` | … | `Orchestrator.lookupSend` / `react` |
| `turns.interrupt` | `{conversationId, turnId?}` → `Turn[]` | `Orchestrator.interrupt` |
| `turns.retry` | `{conversationId, turnId}` → `void` (failed turns only; the turn's bot answers its newest source message again, nothing is posted) | `Orchestrator.retry` |
| `attachments.upload` | `{name, mime, bytesBase64}` → `Attachment` | `AttachmentService.upload` |
| `requests.respond` | `{requestId, response: RuntimeResponseInput}` → `RuntimeRequest` | `ApprovalService.respond` |
| `requests.listPending` | `{conversationId?}` | `ApprovalService.listPending` |
| `routines.list/create/update/setEnabled/delete/runNow/runs` | … | `RoutineScheduler.*`, called with `userActor` |
| `memory.get/putFact/deleteFact/setIndex` | … | `MemoryService.*` |
| `skills.list/upsert/delete/assign/search/preview/install` | … | `SkillService.*` |
| `harnesses.status` / `harnesses.models {kind, profileId?}` | → `HarnessStatus[]` (one per (kind, account), with `profileId`, `profileLabel`, `configDir`, `account`) / `ModelInfo[]` | server `HarnessProfiles.status` over `HarnessRegistry` (`probe` / `listModels`) |
| `harnesses.profiles {kind?}` / `addProfile {kind, label, configDir}` / `removeProfile {profileId}` / `discover {kind}` | → `HarnessProfile[]` / `HarnessProfile` / void / `HarnessProfileCandidate[]` | server `HarnessProfiles` (apps/server/src/profiles.ts; D2.7) |
| `nodes.list` | → `NodeSummary[]` | `NodeDirectory.list` |
| `nodes.createPairingCode/rename/revoke/setCapabilities` | … | `NodeAdmin.*` |
| `computer.status/ensure/lease/reset` | `{botId}` / `{botId, take}` → `ComputerStatus` (`reset`: stops the bot's desktop and the owner's control; unchanged without a desktop) | `ComputerPort.*` |
| `settings.get/update` | … | `SettingsService.get` / `update` |
| `rules.list/upsert/delete` | … | `SettingsService.listRules` / `upsertRule` / `deleteRule` |
| `tasks.list` | `{botId, limit?}` → `Task[]` (newest first, default 50; `NotFound` for an unknown bot) | `BackgroundTasks.list` |
| `tasks.get` | `{taskId}` → `TaskDetail` (the task + its steps) | `BackgroundTasks.get` |
| `tasks.cancel` | `{taskId}` → `Task` (the owner's Stop: only that task; the bot is told; a finished task comes back unchanged) | `BackgroundTasks.cancel(taskId, "owner")` |
| `usage.byBot` | `{sinceMs?}` → `BotUsage[]` | `UsageService.byBot` |

`packages/core/test/ports/services.test.ts` checks at compile time that each RPC payload fits its method's input and each method's result fits the RPC's success type.

---

## 4. @openbot/node-protocol

Files are in `packages/node-protocol/src/`. The full wire spec is `docs/node-protocol.md`.

### 4.1 RPC groups (`rpcs.ts`)

- **`NodeRpcs`** is served by the node and called by the brain through `NodeClient`. It contains:
  - `node.hello(NodeHelloRequest) → NodeHello`;
  - the fs calls: `fs.read`, `fs.download` / `fs.upload` (bulk read / write over a `transfer` data stream: `send_file`, the inbox of received files), `fs.write`, `fs.edit`, `fs.stat`, `fs.list`, `fs.glob`, `fs.grep`, `fs.mkdir`, `fs.move` and `fs.remove`;
  - `shell.exec`, which streams `ExecEvent` (Started, Output, Exit);
  - `pty.open`, `tunnel.open`, `service.start`, `service.stop` and `forward.listen`;
  - the browser calls `browser.ensure{botId}`, `browser.action{inv, action}`, `browser.screencast{botId, streamId, streamToken, options?}` and `browser.input{botId, event}`;
  - `lease.set{botId, holder}`;
  - the desktop calls (`desktop@1`, D1.7: a screen per bot): `desktop.ensure{botId} → DesktopInfo{botId, display, width, height}`, `desktop.stop{botId}` (also ends the owner's control), `computer.act{inv, action: ComputerAction} → ComputerResult{text, image?}` (`LeaseHeld` while the owner holds the screen) and `computer.stream{botId, mode: view|control, streamId, streamToken}`, which opens a raw-binary `vnc-view` / `vnc-control` data stream (control needs the owner's lease).

  Every bot-originated, side-effecting payload carries `inv: Invocation{invocationId, botId, runId, toolCallId?}`.
- **`BrainRpcs`** is served by the brain and called by the node. It contains `node.requestApproval(NodeApprovalRequest{invocationId, botId, runId?, toolCallId?, action, target, reason}) → {decision: allow-once|allow-always|deny, by}`, `node.openStream{kind, botId} → StreamTicket`, `node.event{type, data}` and `node.heartbeat`.

### 4.2 Errors (`errors.ts`)

- The wire errors are `PathDenied`, `PolicyRefused`, `EditFailed`, `FsError{op,path,code,reason}`, `TunnelFailed`, `StreamRefused{kind,reason}`, `NotAuthenticated`, `NodeUnavailable{nodeId,reason}`, `BrowserUnavailable`, `LeaseHeld`, `BrowserActionFailed` and `DesktopUnavailable{message, missing?}` (not covered by `describeNodeError`: the brain renders it itself).
- `describeNodeError(e)` turns any of them into text a model can read.
- Node-protocol's `NodeUnavailable` has a `reason` field. The contract error of the same name has `message`. Map one to the other at the edge.

### 4.3 Schemas (`schemas.ts`)

- `Invocation`, `NodeHello`, `NodeRoot`, `PolicyCeiling`.
- The fs results, `ExecEvent` and `TunnelKind`.
- `StreamKind`, `BrainStreamKind` and `StreamTicket`.
- `BrowserAction` (the verbs navigate, snapshot, click, type, key, scroll, screenshot and tabs), `BrowserActionResult` and `BrowserInputEvent`.
- `LeaseHolder`, `LeaseState`, `ComputerActionName` (Anthropic's 17 computer-use actions), `ComputerAction` (flat: `coordinate`, `start_coordinate`, `region` as number arrays), `ComputerResult`, `DesktopInfo`; `NodeHello.desktop?: DesktopSupport{missing[], width, height}`.
- `NodeApprovalRequest`, `NodeApprovalResponse` and `NodeHeartbeat`.
- `NodeEventTypes`, `PairRequest{code, publicKey, hostname, platform, …}` and `PairResponse{nodeId, brainPublicKey, brainOrigin}`.

### 4.4 Helpers

- **`version.ts`**:
  - `PROTOCOL_VERSION`, `negotiateProtocol`;
  - `Capabilities` (`fs@1`, …), `parseCapability`, `hasCapability(caps, "browser")`, `effectiveCapabilities`;
  - `Routes{control: "/node", stream(id), streamPattern, pair}`, `ProtocolHeaders`;
  - `CloseCodes{revoked: 4401, helloFailed: 4403, protocolMismatch: 4426, replaced: 4000}`;
  - the constants `STREAM_TOKEN_TTL_MS`, `UPGRADE_SKEW_MS`, `PAIRING_CODE_TTL_MS`, `BRAIN_CLIENT_PING_TIMEOUT_MS`, and `REDIAL` with `redialDelayMs`.
- **`auth.ts`** (WebCrypto Ed25519; every function returns an Effect):
  - keys: `generateKeyPair`, `publicKeyFromPrivate`, `sign`, `verify`;
  - the signed upgrade: `makeUpgradeAuth`, `parseUpgradeAuth`, `verifyUpgradeAuth(…, ReplayCache)`, `makeReplayCache`;
  - the hello: `signHello`, `verifyHello`;
  - `originOf`, plus `formatStreamAuth` and `parseStreamAuth` for stream bearers.
- **`pairing.ts`**: `generatePairingCode`, `normalizePairingCode`, `hashPairingCode`, `pairingCodeExpiresAt`, `isPairingCodeExpired`.
- **`mux.ts`**: `makePeer({socket, serve, call, stamp?, pingTimeout?}) → {client, mux, closed}` serves one group and calls the other over a single socket using JSON-RPC. Also `mux`, `stampedNodeId(headers)` and `nodeStamp(nodeId)`.
- **`streams.ts`**: `mintStreamTicket`, the pty and claude.cli control frames (`PtyControl`, `CliControl`, `decodeControlFrame`), and `encodeScreencastFrame` / `decodeScreencastFrame`.
- **`encoding.ts`**: base64 and base64url, `sha256Hex`, `randomToken`, `safeEqual`.

### 4.5 Node-side seams (`links.ts`), shared by W1.9 and W1.10

```ts
class BrainLink {           // the node's view of BrainRpcs
  requestApproval(req: NodeApprovalRequest): Effect<NodeApprovalResponse>   // never fails; unreachable → deny, by:"unreachable"
  openStream({kind, botId}): Effect<StreamTicket, StreamRefused>
  event(type, data): Effect<void>
}
class StreamDialer {        // opens the node side of a data stream
  dial({ticket, kind}): Effect<Socket.Socket, StreamRefused, Scope>
}
```

- `NodeHandlersLive` (W1.9) depends on these two tags.
- A remote node: DialOut provides them from the control-socket peer and from `wss://…/node/stream/:id`.
- The local node: brain-nodes provides them in-process, using its BrainRpcs handlers and StreamBroker. `makeMemorySocketPair` from `@openbot/node-protocol/testing` works for the data streams.
- The `node.hello` gate belongs to the connection (DialOut), not to `NodeHandlersLive`.
- The local node's `NodeClient` can come from `RpcTest.makeClient(NodeRpcs)` with the handlers provided. It type-checks as a `NodeClient` (core test).
- **Testing subpath** (`@openbot/node-protocol/testing`): `makeMemorySocketPair()` and `rawJsonPeer(socket)`.

---

## 5. @openbot/core ports

All ports are in `packages/core/src/ports/`. Repository and store methods fail only with `RepoError`, and lookups return `Option`.

### 5.1 Harness (`Harness.ts`)

```ts
sessionKeyOf(botId, conversationId) → "<botId>:<conversationId>";  parseSessionKey(key) → {botId, conversationId} | undefined
taskSessionKeyOf(botId, taskId) → "<botId>:<taskId>"   // OpenSessionInput.sessionKey of a background task's own session (D5.7)
interface RenderedInstructions { text; sections{base,persona,team,memoryIndex,placement}; hash }
interface TurnAttachment { path; mime; name }            // brain path readable by the harness
interface TurnInput { turnId; conversationId?; text; attachments: TurnAttachment[] }   // conversationId: the turn's conversation (D5.0)
// ONE session per bot (D5.0): conversationId = the bot's DM (home), sessionKey = sessionKeyOf(bot.id, bot.directConversationId)
interface OpenSessionInput { bot; conversationId; sessionKey; nativeSessionId?; placement: ResolvedPlacement;
  instructions: RenderedInstructions; mcp: McpBinding[]; model?; effort?;
  onRequest(req: HarnessRequest): Effect<HarnessRequestResolution> }   // blocks the native callback; never fails
interface HarnessSession { events: Stream<HarnessEvent>; nativeSessionId: Effect<string|undefined>;
  startTurn(TurnInput): Effect<void, HarnessError>   // completes when ACCEPTED
  steer(TurnInput): Effect<void, HarnessError>       // HarnessError{code:"unsupported"} unless capabilities.steer
  interrupt: Effect<void>; compact: Effect<void, HarnessError>; contextUsage: Effect<ContextUsage|undefined> }
interface HarnessDriver { kind; displayName; capabilities: HarnessCapabilities; probe: Effect<HarnessStatus>;  // never fails, no model call
  listModels: Effect<ModelInfo[], HarnessError>; openSession(OpenSessionInput): Effect<HarnessSession, HarnessError, Scope> }
class HarnessRegistry { get(kind: string, profileId?: string): Effect<HarnessDriver, HarnessUnavailable>; list: Effect<HarnessDriver[]>;
  register(driver): Effect<void, never, Scope> }   // keyed by (kind, driver.profileId); static layer; static registerLayer(...)
// HarnessDriver.profileId?: the account (D2.7) the driver instance runs with; absent = default.
// driverForBot(registry, bot) = registry.get(bot.harness.kind, bot.harness.profileId); driverKeyOf(kind, profileId)
```

`HarnessErrorCode` is one of unsupported, not-installed, auth, open-failed, closed, turn-rejected, protocol, usage-limit or other.

### 5.2 Placement (`Placement.ts`, implemented by brain-nodes)

```ts
type Toolset = "bot" | "node" | "browser" | "computer"
interface ResolvedPlacement { mode: PlacementMode; hostNodeId; workspacePath /* on host node */; harnessCwd /* brain */;
  env; disableBuiltinTools; codexEnvironment?: {environmentId, execServerUrl, authBearerToken, cwd};
  toolsets: Toolset[]; promptAppend; release: Effect<void> }
type PlacementSummary = Pick<ResolvedPlacement, "mode"|"hostNodeId"|"workspacePath"|"toolsets"|"promptAppend">
class PlacementService { resolve({bot, driver}): Effect<ResolvedPlacement, PlacementError, Scope> }
// pure rules, shared by the live impl, the fake and previews:
planPlacement({bot, driverKind, capabilities, hostNode}): Result<PlacementPlan{mode,disableBuiltinTools,toolsets}, PlacementError>
describePlacement(plan, hostNode, workspacePath): string        // default promptAppend
workspacePathFor({node, botId, dataDir}): string                // local → <data>/bots/<id>/workspace; remote → <roots[0]>/workspaces/<id>
```

### 5.3 MCP (`Mcp.ts`)

```ts
McpClaims = { botId, conversationId, sessionKey, toolsets: Toolset[], hostNodeId, workspacePath, boundNodeIds, taskId? }   // Schema
// taskId: the token of a background task's own session (D5.7): conversationId stays its origin (no
// current-turn lookup), ToolContext.taskId is set, and task tools / ask_user / request_approval are not offered
// minted once per bot session with the bot's HOME conversation (DM); per tool call the gateway substitutes the
// conversation of the bot's running turn (Orchestrator.activeTurn(botId)) into conversationId/sessionKey (§8.1)
interface McpBinding { name: "openbot"; url; headers }          // token in headers, never argv
class McpBindingIssuer { issue(claims): Effect<McpBinding, never, Scope> }   // revoked when scope closes
McpTokenRecord = { hash /* hex sha256 */, claims, createdAt, expiresAt?, revoked }
class McpTokenRepo { put(rec); lookup(hash): Option<McpTokenRecord>; revoke(hash); revokeAll(botId?) }
```

### 5.4 Nodes (`NodeDirectory.ts`, `Computer.ts`, implemented by brain-nodes)

```ts
type NodeClient = RpcClient.FromGroup<typeof NodeRpcs, RpcClientError>
type NodeDirectoryChange = {type:"node.upserted", node: NodeSummary} | {type:"node.removed", nodeId}
class NodeDirectory { list: Effect<NodeSummary[]>; get(nodeId): Effect<NodeSummary, NodeUnavailable>;
  changes: Stream<NodeDirectoryChange>;                         // hot; LiveHub forwards to the roster
  client(nodeId): Effect<NodeClient, NodeUnavailable>;          // message reads "Node ‹label› is offline"
  capabilities(nodeId): Effect<string[], NodeUnavailable> }     // effective = declared ∩ approved
class NodeAdmin { createPairingCode: Effect<PairingCode>; rename(id, label): Effect<NodeSummary, NotFound|InvalidInput>;
  revoke(id): Effect<void, NotFound|Forbidden>; setCapabilities(id, approved): Effect<NodeSummary, NotFound|InvalidInput> }
class ComputerPort { status(botId): Effect<ComputerStatus, NotFound>; ensure(botId): Effect<ComputerStatus, NotFound|NodeUnavailable>;
  lease(botId, take): Effect<ComputerStatus, NotFound|NodeUnavailable|Conflict>;   // take: mirrored to the node first; release never fails on an offline node
  reset(botId): Effect<ComputerStatus, NotFound|NodeUnavailable>;                   // desktop.stop; a browser-only screen is returned unchanged
  leaseChanges: Stream<ComputerLeaseChange{botId, holder: bot|user, cause: lease|reset}> }   // hot; ApprovalService answers hand-offs from it
// NodeFiles.ts (brain-nodes `NodeFilesLive`, part of BrainNodesLive): node → brain file transfer for send_file
class NodeFiles { download({nodeId, inv, path, cwd?, maxBytes}): Effect<NodeDownload{path,name,size,mtimeMs,head,
  chunks: Stream<Uint8Array, TunnelFailed>}, NodeDownloadError, Scope>     // fs.download + `transfer` stream; sha256/size verified
  upload({nodeId, inv, path, size, chunks}): Effect<{path, size, skipped}, NodeDownloadError | E> }   // fs.upload; same-size file kept
```

### 5.5 Other ports

```ts
class Notifier { notify({kind, botId?, conversationId?, title, body}): Effect<Notification | undefined> }  // undefined = suppressed by bot.notify
class IdGen { next(prefix); botId; conversationId; entryId; requestId; turnId; routineId; routineRunId; nodeId;
  sectionId; attachmentId; ruleId; notificationId }   // static layer (ULIDs); CoreIdPrefix adds dlv/epc/inv/pair
class DataDir { root; database; botDir(id); memoryDir(id); workspaceDir(id); skillsLib; codexHome; opencodeConfig;
  attachments; localNode; logs; brainIdentity }   // static layer(root); makeDataDir; joinPath
class InternalAddress { baseUrl: Effect<string> }   // internal listener, e.g. http://127.0.0.1:43123; static layer(url)
class ProcessLedger { record(ProcessRecord{pid,pgid,kind,label?,startedAt}); remove(pid); list; clear }
```

### 5.6 Repositories (`repos.ts`)

```ts
BotRepo        get(id) list upsert(bot) delete(id): boolean /* also its session */
               getSession(botId) setSession(BotSessionRecord) clearSession(botId)        // ONE native session per bot (D5.0)
               BotSessionRecord = {botId, driver, nativeSessionId, instructionsHash?, seen?: Record<convId, EntryId>, lastConversationId?, updatedAt}
SectionRepo    list get upsert delete
ConversationRepo get list(filter?{kind?,botId?,includeHidden?}) upsert delete members(id)
EntryRepo      get upsert(KnownTranscriptEntry): UpsertOutcome  // written iff new or revision strictly greater
               remove page({conversationId, before?, limit}): EntryPage listAfter(convId, afterEntryId?, limit)
               findByClientNonce(convId, nonce) findByNativeId(convId, nativeId) listByTurn(turnId)
               listExchange({botIds, conversationIds, direction, from?, limit}): {entries, more}  // bot-to-bot messages between two bots
RequestRepo    get upsert list(filter?{conversationId?,botId?,turnId?,statuses?}) findByNativeId(botId, nativeRequestId) deleteByConversation(convId)
TurnRepo       get upsert listByConversation(convId, limit) listActive /* queued|running|waiting */ deleteByConversation(convId)
TaskRepo       get upsert list({botId?, conversationId?, statuses?, limit?}) /* newest first */ delete(id) /* + its steps */
               putStep(taskId, KnownTranscriptEntry) steps(taskId) /* (createdAt, id) order */   // D5.7; steps are never conversation entries
RoutineRepo    get list({botId?}) upsert delete upsertRun(run) /* keeps newest 20 */ getRun listRuns(routineId) /* newest first */
NodeRepo       get list findByPublicKey upsert delete putPairingCode consumePairingCode(code, now)   // NodeRecord, PairingCodeRecord
ApprovalRuleRepo get list({botId?}) /* bot's + global */ upsert delete
SettingsRepo   get(key) getAll set(key, json) remove(key)
UsageRepo      record(UsageRecord) totalsByBot(sinceMs?): UsageTotals{botId,usage,records,turnCount,lastAt}[] list(filter?)
ReplicaLog     head(key) append(ReplicaRecord) readAfter(key, cursor): Option<records> reset(key, epoch)
               ReplicaKey = "roster" | `conversation:${id}`; conversationReplicaKey(id); REPLICA_LOG_WINDOW = 256
```

Settings storage uses one `SettingsRepo` key per `Settings` field. Read and write it with `readSettings`, `writeSettings(settings)`, `settingsFromEntries(map)`, `settingsToEntries(settings)` and `SETTINGS_KEYS`. Prefix other brain-internal keys, for example `brain.*`.

### 5.7 Stores (`stores.ts`) and persistence (`Persistence.ts`)

```ts
MemoryStore    readIndex(botId) writeIndex(botId, md) listFacts getFact putFact(botId, fact) deleteFact deleteAll(botId)
SkillStore     list get(name) put(skill) install(skill, files) parse(text) delete(name) root dir(name)
SkillDirectory search(query) ! Unavailable; download(id): {files, hash?} ! NotFound | Unavailable   (skills.sh; server)
AttachmentStore put({name,mime,bytes}): AttachmentRecord{id,name,mime,byteSize,path,createdAt,width?,height?} get read delete
               putStream({name,mime,chunks: Stream<Uint8Array,E>,width?,height?})   // chunk by chunk to a temp file, renamed when complete
               stream(id): Stream<Uint8Array, RepoError>
type RepositoryPorts = the 13 repos of §5.6 + McpTokenRepo + ProcessLedger + the 3 stores (18 tags)
class BootRecovery { run: Effect<BootRecoveryReport, RepoError> }
BootRecoveryReport = { killedProcesses, interruptedTurns, expiredRequests, updatedEntries, interruptedRuns, interruptedTasks }
// interruptedTasks: queued|running tasks now failed with TASK_RESTART_ERROR ("interrupted by a restart")
runBootRecovery({killProcessGroup(record): Effect<boolean>})   // the D2.5 rules over the repos; persistence uses it
```

---

## 6. @openbot/core service shapes (`ports/services.ts`)

### 6.1 Shared types

```ts
interface ToolContext { claims: McpClaims; callId?: string; turnId?; taskId? }   // gateway tool call; callId = idempotency key; taskId = a background task's call
type Actor = {kind:"user"} | {kind:"bot", tool: ToolContext};  userActor; botActor(tool)
type DeliveryKind = "user-message"|"bot-message"|"routine"|"system-resume"|"task-result";  DeliveryUrgency = "urgent"|"background"
// task-result (D5.7): a finished task's `[Result of "<title>"]` text for the bot's main session; never steered, its own turn (trigger "system")
interface CausalChain { rootId; hops };  MAX_BOT_HOPS = 8
interface Delivery { id; conversationId; botId; kind; text; attachmentIds; sourceEntryId?; fromBotId?; causalChain;
  urgency; mode: SendMode; routineRunId?; taskId? };  DeliveryInput = Delivery minus defaults (id/mode/attachmentIds/causalChain optional)
DeliveryReceipt { deliveryId; disposition: started|queued|steered|batched; turnId? }
DeliveryOutcome { deliveryId; status: completed|failed|interrupted|dropped; turn?; lastBotMessage? }
EntryDraft = KnownTranscriptEntry without id/revision/createdAt/updatedAt (+ optional id)
PendingRequestReceipt { status: "pending"; requestId }
```

### 6.2 Service methods

The error channel is shown after `!`. Methods with no `!` never fail.

```ts
LiveHub              publishConversation(convId, KnownConversationChange): StreamCursor|undefined   // call AFTER commit
                     publishRoster(KnownRosterChange): StreamCursor
                     subscribeConversation({conversationId, after?, tailLimit?}): Stream<KnownConversationStreamItem> ! NotFound
                     subscribeRoster({after?}): Stream<KnownRosterStreamItem>
                     resetConversation(convId, "new-session"|"rollback"|"rebuild"): string(epoch)
                     activities: BotActivity[];  setActivity(BotActivity)
BotService           create(BotCreateInput): Bot ! NotFound|InvalidInput|Conflict|HarnessUnavailable
                     update(botId, BotPatch): Bot ! NotFound|InvalidInput|Conflict;  delete(botId) ! NotFound;  get(botId) ! NotFound
                     list: Bot[];  resolve(ref /* id | name | @name */): Bot ! NotFound;  readContext(botId): BotContext ! NotFound
                     newSession(botId) ! NotFound|Conflict;  compact(botId) ! NotFound|Conflict|HarnessUnavailable   // the bot's one session
                     listSections; createSection(name) ! InvalidInput; renameSection(id, name) ! NotFound|InvalidInput
                     deleteSection(id) ! NotFound; reorderSections(ids): Section[] ! NotFound|InvalidInput|Conflict
ConversationService  get(id) ! NotFound; summaries; summary(id) ! NotFound; history({conversationId, beforeCursor, limit}): TranscriptPage
                     createGroup({title, memberBotIds, leadBotId?, clientNonce?}); setMembers({conversationId, memberBotIds, leadBotId?|null})
                     rename(id, title); markRead({conversationId, unread?, at?}); setHidden(id, hidden)
                     appendEntry(EntryDraft): TranscriptEntry ! NotFound;  updateEntry(entryId, fn): TranscriptEntry ! NotFound
                     appendEvent({conversationId, event, author?, turnId?});  appendNotice({conversationId, level, code, text, turnId?})
                     upsertRequest(RuntimeRequest) ! NotFound;  createRoutineRunConversation({botId, routineId, runId, title, triggerSummary})
                     removeEntry(entryId)   /* NO_REPLY */;  removeGroup(convId) ! NotFound|InvalidInput   // storage only; see Orchestrator.deleteConversation
Orchestrator         send(SendInput): SendResult ! NotFound|InvalidInput|HarnessUnavailable;  lookupSend({conversationId, clientNonce})
                     react({conversationId, entryId, emoji});  interrupt({conversationId, turnId?}): Turn[] ! NotFound
                     deliver(DeliveryInput): DeliveryReceipt ! NotFound|HarnessUnavailable;  awaitDelivery(id): DeliveryOutcome ! NotFound
                     newSession({botId}) ! NotFound|Conflict;  compact({botId}) ! …|HarnessUnavailable   // per bot (D5.0)
                     deleteConversation(convId) ! NotFound|InvalidInput   // groups only
                     approveToolCall(ToolContext, HarnessApprovalRequest): HarnessRequestResolution   // gateway tools (§8.3)
                     noteGroupAddress({botId, conversationId, recipientBotId, text, causalChain}): boolean   // message_bot in a group turn
                     stopBot(botId);  currentChain(botId): Option<CausalChain>;  activeTurn(botId): Option<Turn>   // the bot's running turn
                     recover(BootRecoveryReport)
Messaging            messageBot(ctx, {to, text, urgency}): MessageBotResult ! NotFound|InvalidInput
                     postToGroup(ctx, {conversationId?, text}): {conversationId, entryId} ! NotFound|InvalidInput
                     handoffTask(ctx, {to, task, context?}): MessageBotResult ! NotFound|InvalidInput
                     react(ctx, {emoji, messageId?}): {conversationId, entryId, emoji} ! NotFound|InvalidInput
                     sendFiles(ctx, {nodeId, inv, cwd?, paths, caption?, to?, progress?}): SendFilesResult{conversationId, entryId, files,
                       destination: current|group|direct, recipientBotId?, replayed?}   // `to` = a Bot (its DM, or the shared group) or a group id
                       ! NotFound|InvalidInput   // NodeFiles → AttachmentStore → ONE bot message in the current turn's conversation;
                                                 // idempotent per call id (clientNonce `send_file:<bot>:<callId>`); limits: SendFileLimits (200 MB, 10 files)
                     // MessageBotResult = {recipientBotId, conversationId, entryId?, deliveryId, postedInGroup?, noted?}
InstructionRenderer  render({bot, placement: PlacementSummary}): RenderedInstructions   // conversation-independent
ApprovalService      evaluate(ApprovalContext{bot, conversationId, turnId?, harness, workspace?{nodeId, path}, onPending?, task?{id,title}, recordDecision?}, HarnessRequest): HarnessRequestResolution
                       // task: card `taskTitle` + request `taskId`; recordDecision: auto-decided events go there (a task's steps)
                       // rules first; no matching rule → bot.autonomy (core automation/autonomy.ts)
                     evaluateNode(NodeApprovalInput{nodeId, request: NodeApprovalRequest}): NodeApprovalResponse
                     respond({requestId, response}): RuntimeRequest ! NotFound|RequestNotPending|InvalidInput
                     listPending({conversationId?});  askUser(ctx, {title?, questions}): PendingRequestReceipt ! InvalidInput
                     requestApproval(ctx, {title, detail?, command?, paths?}): PendingRequestReceipt ! InvalidInput
                     requestTakeover(ctx, {instruction}): PendingRequestReceipt ! InvalidInput   // kind handoff, D1.7
                     asyncAnswers: Stream<DeliveryInput>   // single consumer: Orchestrator
                     cancelPending({botId?, conversationId?, turnId?, taskId?, reason}): number
BackgroundTasks      start(ctx, {title, brief}): Task ! NotFound|InvalidInput   // returns at once; origin = ctx.claims.conversationId
                       // its first turn = the origin conversation's recent messages (≤ 30 / 12 KB) + "[The brief]" + brief
                     list({botId, limit?}): Task[];  get(taskId): TaskDetail ! NotFound;  find(botId, ref /* id | title */): Task ! NotFound
                     cancel(taskId, by: owner|bot|system): Task ! NotFound   // only that task; the owner's stop is reported to the bot
                     update(ctx, {taskId, message}): {task, delivery: steered|queued|finished} ! NotFound|InvalidInput
                       // update_task: steered into the running turn (capabilities.steer), else the session's next / first turn; never dropped
                     removeBot(botId);  cancelForConversation(convId)   // bot / group deleted (nobody is told)
                     approve(taskId, HarnessApprovalRequest, workspace?): HarnessRequestResolution   // Orchestrator.approveToolCall routes ctx.taskId here
                     results: Stream<DeliveryInput>   // task-result deliveries; single consumer: Orchestrator
                     recover(BootRecoveryReport)       // after the drivers: publish + tell each bot
RoutineScheduler     list({botId?}); get(id) ! NotFound; create(actor, {botId, spec}) ! NotFound|InvalidInput|Conflict
                     update(actor, {routineId, spec}) ! …; setEnabled(id, enabled) ! NotFound; delete(id) ! NotFound
                     runNow(id): RoutineRun ! NotFound|Conflict|HarnessUnavailable; runs(id): RoutineRun[] ! NotFound
MemoryService        get(botId): BotMemory ! NotFound; putFact(actor, botId, MemoryFactInput): MemoryFact ! NotFound|InvalidInput
                     deleteFact(actor, botId, factId) ! NotFound; setIndex(botId, md): BotMemory ! NotFound|InvalidInput
                     recall(botId, query?): MemoryFact[] ! NotFound; promptIndex(botId): string   // ≤ 4 KB
SkillService         list; get(name) ! NotFound; upsert(actor, SkillInput): Skill ! InvalidInput (a Bot gets its skill); delete(name) ! NotFound (from every Bot);
                     assign(name, botIds) ! NotFound | InvalidInput; search(query); preview(id); install(id, botIds) ! NotFound | InvalidInput | Unavailable
SettingsService      get: Settings; update(SettingsPatch): Settings ! InvalidInput; changes: Stream<Settings> (current first)
                     listRules({botId?}); upsertRule(ApprovalRuleInput): ApprovalRule ! NotFound|InvalidInput; deleteRule(id) ! NotFound
UsageService         record({botId, conversationId, turnId?, harness, model?, usage}); byBot({sinceMs?}): BotUsage[]
AttachmentService    upload({name, mime, bytes}): Attachment ! InvalidInput; get(id): Attachment ! NotFound
```

**The LiveHub publish window.** `publishConversation` buffers the still-growing
(`isStreamingUpsert`) `entry.upserted` changes of an entry instead of publishing each one, so a
streaming turn reaches the client in batches. A buffered change is **not** published and gets **no
sequence** — `publishConversation` returns `undefined` for it; every other change is published at
once and returns its cursor.

| What ends a buffer | Rule |
|---|---|
| **Count trigger** | the entry accumulated `maxPending` buffered changes → the newest one is published |
| **Stall fallback** | the entry's buffer has not been updated for `stallMs` → the newest one is published (keep-alive) |
| **Terminal upsert** | never waits: the terminal change is published immediately. If the entry had **not** been flushed yet, the last buffered state is published just before it; if it **had**, the pending states are dropped |
| **`entry.removed`** | the entry's buffered states are dropped — publishing them afterwards would resurrect the removed entry |

There is deliberately **no time-based tick**: a "flush everything every W ms" window degenerates
into one change per token on any harness whose token interval exceeds W, and the change count
stops shrinking. The window is off with `enabled: false`; `apps/server` wires it from
`OPENBOT_STREAM_WINDOW_MAX_PENDING` and `OPENBOT_STREAM_WINDOW_STALL_MS`. `LiveHubFake` does
**not** implement the window, so it records more changes than production does — a test that
counts merged changes must use `LiveHubLive`.

`OPENBOT_STREAM_WINDOW_MAX_PENDING` is the window's K. It takes **two** values, not one range:

| Value | Meaning |
|---|---|
| `1` | the window is **off** — every change is published on its own (the unmerged control path E-5 compares against) |
| `4` … `5` | the window is on, with that K |

**Nothing in between is accepted** (a config error is raised at startup). The reason is a
criterion, not a style rule: the US-7 clause 2 budget is `A ≤ floor((N+1)/3)`, where `A` is the
number of changes the client applied. At K=3 that budget is broken from N=21 on (and K=2 breaks
it earlier), so a K outside 4..5 would let a tuning run silently invalidate the criterion while
every test still passes — the tests only ever exercise K=4. The product spec v2 §2.8 C-3 is the
authority for this range.

A **new epoch** invalidates the window's state: the old epoch's buffered changes are dropped
rather than published into the new epoch, and the "was this entry already flushed" memory (which
decides the terminal-upsert branch) starts empty in the new epoch. Both the reset path and the
rebuild path (`ReplicaLog.append` failed) go through the same invalidation.

Gateway bot tools map onto these methods:

| Tool | Method |
|---|---|
| `message_bot` | `Messaging.messageBot` |
| `post_to_group` | `Messaging.postToGroup` |
| `handoff_task` | `Messaging.handoffTask` |
| `react` | `Messaging.react` |
| `list_bots` | `BotService.list` |
| `ask_user` | `ApprovalService.askUser` |
| `request_approval` | `ApprovalService.requestApproval` |
| `request_takeover` | `ApprovalService.requestTakeover` (offered with a screen: toolset `computer` or `browser`; not in a task's own session) |
| `computer` | node `computer.act` on the host node (toolset `computer`: host has `desktop@1`); `LeaseHeld` → "The owner is using your screen right now. Wait until they hand it back." |
| `notify_user` | `Notifier.notify` |
| `remember` / `forget` | `MemoryService.putFact` / `deleteFact` |
| `recall_memory` | `MemoryService.recall` |
| `create_routine` | `RoutineScheduler.create`, with `botActor` |
| `update_routine` | `RoutineScheduler.get`, then merge the arguments, then `update` |
| `list_routines` | `RoutineScheduler.list` |
| `save_skill` | `SkillService.upsert` (the calling Bot gets the skill) |
| `list_skills` | `SkillService.list`, marking the caller's skills |
| `enable_skill` / `disable_skill` | approval card (surface `skills`; not for dropping one's own skill), then `BotService.update {skills}` |
| `find_skills` / `preview_skill` | `SkillService.search` / `preview` (skills.sh; read-only) |
| `install_skill` | `SkillService.preview`, approval card (surface `skills`), then `SkillService.install` |
| `list_nodes` | `NodeDirectory.list`, filtered to the host node and bound nodes |
| `send_file` | `Messaging.sendFiles` (node chosen like the node tools; relative paths from the bot's workspace there; `to` = another Bot or a group) |
| `start_task` | `BackgroundTasks.start` (D5.7; not offered in a task's own session, nor are the next three and `ask_user` / `request_approval`) |
| `list_tasks` | `BackgroundTasks.list` |
| `check_task` | `BackgroundTasks.find` + `get` |
| `cancel_task` | `BackgroundTasks.find` + `cancel(…, "bot")` |

**Received files (BotRunner, `internal/inbox.ts`).** Before a turn starts, every file it carries — the
deliveries' `attachmentIds` (owner uploads, `send_file` to this bot) and the files in the group
catch-up — is copied into the bot's workspace on its host node at `inbox/<attachmentId>/<name>`
(`NodeFiles.upload`, capped by `SendFileLimits`), and the turn text gets
`[Attachments: inbox/…/name (mime, size), …]`. `TurnInput.attachments` then carries only the images
(png/jpeg/gif/webp, by brain path) when `capabilities.images`, plus any file that could not be copied.
Deliveries with files are not steered into a running turn; they queue.

---

## 7. @openbot/core/testing

- **In-memory persistence.**
  - `MemoryPersistence: Layer<RepositoryPorts, never, IdGen>` provides every repository and store.
  - `MemoryBootRecovery(options?)` runs the shared recovery rules; the default process killer is a no-op.
  - The `makeMemory*` factories build individual repositories.
  - `compareEntries` and `encodeEntryCursor` / `decodeEntryCursor` use the in-memory cursor format `"<createdAt>:<id>"`.
- **Contract suites** (framework-agnostic; each case expects FRESH repositories). Persistence (W1.1) runs both against SQLite:
  - `repoContractCases: {name, run: Effect<void, unknown, RepositoryPorts>}[]`;
  - `bootRecoveryContractCases` (requires `RepositoryPorts | BootRecovery`).
- **Ports bundle.** `TestPorts({nodes?, dataRoot?})` provides `MemoryPersistence`, `MemoryBootRecovery`, `SequentialIdGen`, `DataDir("/openbot-test")`, an empty `HarnessRegistry`, `InternalAddress("http://127.0.0.1:0")`, and every port fake.
- **Port fakes.** Each has a control tag:
  - `NodeDirectoryFake` (`upsert`, `remove`, `setClient`), with nodes built by `localNodeSummary()` and `remoteNodeSummary(id)`;
  - `PlacementServiceFake` (`resolutions`), which follows the real rules;
  - `McpBindingIssuerFake` (`issued`, `verify`), with tokens `test-token-n`;
  - `ComputerPortFake` (`set`, `leases`, `resets`; `leaseChanges` when the holder changes);
  - `NotifierFake` (`sent`).
- **Service fakes** (`serviceFakes.ts`; methods a fake does not implement die). Each has a control tag:
  - `LiveHubFake` (`published`, `conversationChanges`, `rosterChanges`, `resets`; subscriptions stream `synchronized` and then live items);
  - `ConversationServiceFake` (`written`; implements get, append/update entry, events, notices, upsertRequest and createRoutineRunConversation);
  - `OrchestratorFake.layer({autoComplete?, toolApproval?})` (`deliveries`, `complete`, `setChain`, `setActiveTurn`, `calls`);
  - `ApprovalServiceFake.layer({policy?})` (`evaluated`, `setPolicy`, `toolRequests`, `nodeRequests`, `answer`, `cancelled`; the default is `allowAllPolicy`);
  - `SettingsServiceFake.layer({initial?})` (`set`);
  - `UsageServiceFake` (`recorded`);
  - `MemoryServiceFake` (`calls`), over `MemoryStore`.
  - `BackgroundTasksFake.layer({maxRunning?})` (`started`, `put`, `cancelled`; D5.7): records starts, never runs anything.
- **All service fakes at once.** `CoreServiceFakes(options?)` needs repositories, `IdGen` and `MemoryStore`. Typical use: `CoreServiceFakes().pipe(Layer.provideMerge(TestPorts()))`. To test a real service, build its layer on top so it replaces the fake.
- **Builders and helpers.**
  - Ids: `botId`, `conversationId`, `entryId`, `turnId`, `requestId`, `routineId`, `routineRunId`, `nodeId`, `sectionId`.
  - Entities: `makeBot`, `makeDirectConversation`, `makeGroupConversation`, `makeMessageEntry`, `makeEventEntry`, `makeToolCallEntry`, `makeCardEntry`, `makeTurn`, `makeRequest`, `makeRoutine`, `makeRoutineRun`, `makeSection`, `makeRule`, `makeClaims`, `makeTask` (+ `taskId`).
  - `SequentialIdGen()` produces ids like `bot_000001`.
  - Clock: `runTest(effect, layer)` runs a scoped effect under a fresh `TestClock` and returns a Promise; `advance(duration)`, `setTime(ms)` and `testClock()`.
  - `capUtf8(text, bytes)`.

---

## 8. Cross-WP decisions made at integration

1. **Session key.** The key is `sessionKeyOf(botId, conversationId) = "<botId>:<conversationId>"`. One mind per bot (D5.0):
   - `OpenSessionInput.sessionKey` and the minted `McpClaims.sessionKey` name the bot's single session with its HOME conversation (its DM);
   - per gateway tool call, `McpGateway` replaces `claims.conversationId` / `claims.sessionKey` with the conversation of the bot's running turn (`Orchestrator.activeTurn(botId)`), falling back to the home conversation, and passes `ToolContext.turnId`;
   - node-protocol **`Invocation.runId`**: the gateway builds every `inv` as `{invocationId: IdGen.next("inv"), botId, runId: claims.sessionKey, toolCallId?: ctx.callId}` — the per-call key.

   A node echoes `runId` and `toolCallId` in `node.requestApproval`, so the brain can route the card with `parseSessionKey` to the conversation the bot works in.
2. **Claims carry the workspace.** `McpClaims.workspacePath` is the bot's workspace on the host node and the default cwd for node tools. For other bound nodes, use `workspacePathFor`.
3. **Approval of gateway tools** (mcp-conformance.md R10).
   - Adapters pre-approve `mcp__openbot__*` natively:
     - Claude: `allowedTools`, or `setMcpServers` with an `always_allow` policy;
     - Codex: `default_tools_approval_mode: "approve"`;
     - OpenCode: an `openbot_*` allow rule.
   - Before running a side-effecting tool, the gateway calls `Orchestrator.approveToolCall(ctx, request)`:
     - `shell` gets `{kind: "command-approval", surface: "shell", command, cwd, nodeId}`;
     - `write_file` and `edit_file` get `{kind: "file-approval", surface: "file-edit", paths, diff?}`.
   - Read-only tools are not asked about; node policy still applies to them.
   - A deny produces `ERROR: …` text.
   - `HarnessApprovalRequest.surface` lets an adapter classify its tools. Without it, ApprovalService derives the surface from `kind`.
4. **Native approvals.**
   - The runner's `onRequest` calls `ApprovalService.evaluate(ctx, req)`, with `ctx.onPending` marking the turn `waiting` and setting the activity to "Waiting for you: …". The runner marks the turn `running` again when `evaluate` returns.
   - **ApprovalService never writes Turns.**
5. **Node approvals.** When a node's ceiling says `ask`, the node calls `BrainLink.requestApproval`. The brain-nodes BrainRpcs handler then calls `ApprovalService.evaluateNode({nodeId: <mux stamp>, request})`. That handler lives in a top-level layer (`NodeGatewayLive` / `LocalNodeLive`) and never in the `NodeDirectory` layer.
6. **Roster nodes.** `NodeDirectory.changes` emits roster-shaped `node.upserted` / `node.removed` changes, and LiveHub forwards them. brain-nodes never depends on LiveHub.
7. **Boot recovery.**
   - The rules live in core (`runBootRecovery`), and persistence injects `killProcessGroup`.
   - The changes are listed in `BootRecoveryReport`, and `Orchestrator.recover(report)` republishes them so resumed cursors see them.
   - Recovery also interrupts running routine runs and revokes every MCP token.
8. **Context ring.** `Conversation.sessions?: ConversationSession[]` (`{botId, active, contextUsage?, updatedAt}`) is maintained by W1.2 on the bot's DIRECT conversation only (one session per bot, D5.0):
   - TurnIngest updates it on `ContextUsage` events, throttled, whatever conversation the turn is in;
   - `newSession` sets `active: false`.

   It is published with `conversation.updated`. The client reads it for the composer ring and Details › Session.
9. **Avatars.** `defaultBotAvatar(id)` computes `h = fnv1a32(id)` and picks `{shape: AvatarShapes[h % 13], color: AvatarColors[floor(h / 13) % 11]}`. BotService stores the result at creation. `@openbot/ui` cannot import contracts, so it must mirror the same arrays (in the same order) and the same function.
10. **Group catch-up.** `BotSessionRecord.seen[conversationId]` marks what the bot's session has already seen of each group. Group turns render `EntryRepo.listAfter(conv, seen)` (capped at 8 KB, newest kept), skipping the bot's own messages and entries it already read in steered input. New session clears it.
11. **Internal address.** Gateway bindings use `<InternalAddress.baseUrl>/mcp/<botId>`. Codex relays use `ws://…/relay/<nodeId>/codex.exec-server`.
12. **Brain identity.** The brain's Ed25519 key pair is stored at `DataDir.brainIdentity` (0600) and owned by brain-nodes. The brain's public origin for pairing commands and `PairResponse.brainOrigin` is brain-nodes configuration, provided by the server.
13. **Pairing codes.** `PairingCodeRecord.code` may hold `hashPairingCode(code)`; brain-nodes decides. `NodeRepo.consumePairingCode` compares it verbatim.
14. **Error rendering.** Gateway node tools render `NodeUnavailable` as `ERROR: Node ‹label› is offline` and node-protocol errors with `describeNodeError`.
15. **Background tasks (D5.7).** A task runs in its own session of the bot (`taskSessionKeyOf`, a fresh native session) with a token whose claims carry `taskId` and its origin conversation (`sessionKey` = `sessionKeyOf(botId, origin)`, so node approvals route there). Its gateway calls get `ToolContext.taskId` (no `turnId`); `Orchestrator.approveToolCall` hands them to `BackgroundTasks.approve`; `Messaging` neither notes group addresses nor extends the main turn's causal chain for them. Its harness events become `TaskRepo` steps; the roster carries `task.upserted` (status changes at once, progress throttled). The fake harness: `bg: <seconds> <title>` calls `start_task`, `work: <seconds> <title>` is a slow task turn, and a `[Result of "…"]` turn replies "Update on …".
16. **Screens (D1.7).** `ComputerStatus.surface` is `desktop` when the host node has `desktop@1`, else `browser` (`browser@1`), else `none`; `missing` carries `node.hello.desktop.missing` (or `DesktopUnavailable.missing` from a failed `desktop.ensure`). The viewer socket `/ws/computer/:botId?mode=view|control` answers 404 (unknown bot), 409 (no screen), 503 (node offline) or 403 (`control` without the lease) before upgrading. On a desktop it relays raw RFB (binary frames) between noVNC and one node stream per viewer (`computer.stream` → `vnc-view` / `vnc-control`, the desktop ensured first) and closes with 1000 "control released" (control viewers, lease handed back), 1012 "screen reset" (every viewer, `computer.reset`), 4403 "Take control first" (control refused after the upgrade) or 1011 + reason (the screen could not start or the stream ended). Hand-offs: `request_takeover` → `RuntimeRequest{kind: "handoff", blocking: false, responseCapability: acknowledge [done, skip]}` + `HandoffCard{requestId, nodeId, instruction}`; "Take over" is `computer.lease {take: true}` (not an answer); handing the screen back (`computer.lease {take: false}`) answers the bot's pending hand-offs `done`; answering `done` / `skip` (`requests.respond`) gives the screen back before the bot is told. Hand-offs expire after 30 minutes (`HANDOFF_EXPIRY_MINUTES`), re-armed while the owner holds the screen.

## 9. Known gaps (not in the v1 contracts)

- **Retry after a failed turn.** There is no `turns.retry` RPC. The UI's Retry button re-sends the last user text through `messages.send` with a new nonce.
- **Library "workspace files".** No RPC lists a bot's workspace files. Either add one in a later wave (`NodeClient.fs.list` on the host node) or leave the tab out.
- **Routine changes.** The roster has no change type for routines. The UI refetches `routines.list` when it sees a `routine-changed` or `routine-run` event entry or a `routine` card.
- **Secrets.** There is no secret store. A `secret` answer goes only to the native harness that asked (Codex `isSecret`).

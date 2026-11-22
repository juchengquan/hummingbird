"use client"
import "client-only"

/**
 * `useChatSend` — owns the chat send pipeline that used to live as the
 * 600-line `callChatAPI` callback inside `components/panels/chat.tsx`.
 *
 * Returns:
 *  - `send(history, options)`: stable wrapper that invokes the latest
 *    pipeline (internal ref keeps closures fresh without forcing
 *    consumers to manage their own).
 *  - `stop()`: aborts the *active* conversation's stream only; other
 *    conversations mid-stream stay running.
 *  - `isStreaming(convId)`: true iff that conv has an in-flight stream.
 *  - `streamingConvIds`: the live Set (consumers can read it directly
 *    for "any conv streaming?" status).
 *  - `liveToolCalls`: per-message in-flight tool-call pills; cleared on
 *    stream `done`. Durable record gets persisted onto the message in
 *    `setMessageToolCalls`.
 *
 * Preserves the invariants `callChatAPI` had:
 *  - Per-conversation `AbortController` map → switching tabs mid-stream
 *    doesn't move the stream's UI state onto the wrong chat.
 *  - `useStore.getState()` fresh reads for `chatModel`, MCP/URL state,
 *    `localFilesOnly` — so retry-after-model-change uses the new
 *    value without waiting for re-render.
 *  - `callChatAPIRef` latest-version pattern (moved internal to the
 *    hook) → the same instance can call back into itself for the
 *    1s auto-retry-once on transient errors.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { apiClient } from "@/client/api-client"
import { useTaskRunContext } from "@/client/agent/task-run-context"
import { autoArchiveCodeBlocks as autoArchiveCodeBlocksPure } from "@/client/chat/auto-archive-code-blocks"
import { shouldAutoRetry } from "@/client/chat/auto-retry-decision"
import { resolveSendTargetConversationId } from "@/client/chat/resolve-send-target"
import { buildAttachments } from "@/client/chat/build-attachments"
import { buildTransmittedMessages } from "@/client/chat/build-messages"
import { toPersistedToolCalls } from "@/client/chat/tool-call-buffer"
import { createTurnWriter } from "@/client/chat/turn-writer"
import {
  buildSandboxFiles,
  type SandboxFileSource,
} from "@/client/chat/build-sandbox-files"
import { getFileImageDataUrls } from "@/client/files/blob-fields"
import { getBlob } from "@/client/files/local-store"
import { extractAfterTurn } from "@/client/memory/extract-after-turn"
import { translateFrame } from "@/client/chat/sse-frame-translator"
import { useStore } from "@/client/hooks/use-store"
import { getLocalCred } from "@/client/mcp/local-creds"
import type { LiveToolCall } from "@/components/skills/tool-call-strip"
import { composeSystemPrompts } from "@/shared/agents/resolve"
import { withUserSkillInstructions } from "@/shared/skills/user-skill-prompt"
import type { ChatRequestInput, TaskRequestInput } from "@/shared/api-schemas"
import { isAuthRequiredError } from "@/shared/api-errors"
import { modelSupportsReasoningEffort } from "@/shared/models"
import { resolveEnabledSkills } from "@/shared/skills/resolve-enabled-skills"
import type { SkillId } from "@/shared/skills/types"
import type { Message, MessageError, MessageErrorCode } from "@/shared/types"
import { toISO } from "@/shared/utils"
import { abortStreamsOfDeletedConversations } from "@/client/chat/abort-deleted-streams"
import { buildRunInput, runDocumentsFor } from "@/client/runs/build-input"
import { registerChatRunBridge } from "@/client/runs/chat-bridge"
import { createChatRunner, type ChatRunner } from "@/client/runs/chat-runner"
import { RUNS_CHAT_ENABLED } from "@/client/runs/config"

export interface SendOptions {
  modelOverride?: string
  isRetry?: boolean
  /** I2I reference URL to forward to the server for this turn.
   *  Captured by the caller ahead of the store clear so a retry doesn't
   *  quietly re-attach a reference the user already dismissed. */
  referenceImage?: { url: string }
  /** Skill ids forced on for this turn by a `/slash` command, on top of
   *  the workspace/conversation cascade. Passed as an arg (not read from
   *  state) so a retry re-applies the same forced set deterministically. */
  forcedSkillIds?: SkillId[]
  /** Skill ids muted (× chip) for this one send. Passed in so the hook
   *  doesn't need to subscribe to panel-level UI state. */
  mutedSkillIds?: Set<SkillId>
  /** When true, launch the turn as a long-running task (Tasks panel)
   *  instead of an inline chat stream. */
  asTask?: boolean
  /** Task mode for this turn — `'research'` triggers Deep Research
   *  mode in the worker. Only meaningful when `asTask` is true. */
  taskMode?: "default" | "research"
  /** Custom-agent system prompt for this turn — appended after the
   *  workspace's system prompt via `composeSystemPrompts`. See
   *  `PLAN-custom-agents.md`. */
  agentSystemPrompt?: string
  /** Per-turn MCP allow-list — when set, MCP servers are filtered to
   *  this list server-side (Phase 2 of `PLAN-custom-agents`, Q48): task
   *  mode, the chat route (`loadEffectiveMcpServers`) and runs alike.
   *  Absent = no restriction; `[]` = no MCP. */
  allowedMcpServerIds?: string[]
  /** Route this turn's reply onto a specific conversation rather than
   *  the React-subscribed `activeConversationId`. Needed when the caller
   *  has *just* created a conversation (e.g. a non-destructive edit/
   *  regenerate fork) in the same event tick: the store's
   *  `activeConversationId` is already the fork, but the subscribed
   *  closure values inside `send` still see the source. When set, the
   *  conversation (and everything derived from it at send-time) is
   *  resolved from `useStore.getState()` for this id. When absent, the
   *  pipeline keeps reading the subscribed `activeConversationId` /
   *  `conversations` — preserving the tab-switch-mid-stream protection. */
  targetConversationId?: string
}

export interface UseChatSendResult {
  send: (history: Message[], options?: SendOptions) => Promise<void>
  stop: () => void
  isStreaming: (convId: string | null | undefined) => boolean
  streamingConvIds: ReadonlySet<string>
  liveToolCalls: Record<string, LiveToolCall[]>
}

export function useChatSend(): UseChatSendResult {
  // --- store mutators read internally (no panel-side dep array) ---
  const addMessage = useStore((s) => s.addMessage)
  const deleteMessage = useStore((s) => s.deleteMessage)
  const appendToMessage = useStore((s) => s.appendToMessage)
  const appendToMessageReasoning = useStore((s) => s.appendToMessageReasoning)
  const setMessageError = useStore((s) => s.setMessageError)
  const setMessageReasoningDuration = useStore(
    (s) => s.setMessageReasoningDuration
  )
  const setMessageToolCalls = useStore((s) => s.setMessageToolCalls)
  const setMessageSuggestions = useStore((s) => s.setMessageSuggestions)
  const setMessageVerification = useStore((s) => s.setMessageVerification)
  const setMessageRoutedModel = useStore((s) => s.setMessageRoutedModel)
  const appendMessageGeneratedImages = useStore(
    (s) => s.appendMessageGeneratedImages
  )
  const appendMessageGeneratedFiles = useStore(
    (s) => s.appendMessageGeneratedFiles
  )
  const appendMessageCodeResult = useStore((s) => s.appendMessageCodeResult)
  const appendMessageUiPart = useStore((s) => s.appendMessageUiPart)
  const appendMessageMcpApp = useStore((s) => s.appendMessageMcpApp)
  const setConversationTyping = useStore((s) => s.setConversationTyping)
  const setConversationStreaming = useStore((s) => s.setConversationStreaming)
  const createArtifact = useStore((s) => s.createArtifact)

  // Slices the pipeline reads when assembling the request. Subscribing
  // keeps the resolved messages array fresh between turns; `getState()`
  // is reserved for values that *must* be read at-send-time
  // (chatModel for retry-after-model-change, MCP/URL state, localFilesOnly).
  const activeConversationId = useStore((s) => s.activeConversationId)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const conversations = useStore((s) => s.conversations)
  const workspaces = useStore((s) => s.workspaces)
  const files = useStore((s) => s.files)
  const conversationFiles = useStore((s) => s.conversationFiles)
  // Enabled portable user skills fold their bodies into the system
  // prompt (client-side v1 activation). See PLAN-portable-skills.md.
  const userSkills = useStore((s) => s.userSkills)
  // Account-level custom instructions — the always-on base of the
  // system-prompt cascade (account style → voice, account about →
  // context). Subscribed so an edit takes effect on the next turn.
  const customInstructionsStyle = useStore((s) => s.customInstructionsStyle)
  const customInstructionsAbout = useStore((s) => s.customInstructionsAbout)
  // Cross-conversation memory opt-in. Subscribed so toggling it takes
  // effect on the next turn; read at finalization time to decide whether
  // to fire the best-effort extraction. The server self-gates again on
  // `profiles.memory_enabled`, so this is purely a "don't even ask" guard.
  const memoryEnabled = useStore((s) => s.memoryEnabled)

  // --- own state / refs (used to live on the chat panel) ---
  // In-flight streams live in the store (not local state) so `useSync`
  // can hold per-token message diffs until each stream settles.
  const streamingConversationIds = useStore((s) => s.streamingConversationIds)
  const streamingConvIds = useMemo(
    () => new Set(streamingConversationIds),
    [streamingConversationIds]
  )
  const [liveToolCalls, setLiveToolCalls] = useState<
    Record<string, LiveToolCall[]>
  >({})
  // Per-conversation abort controllers. Stop on the active conv aborts
  // *that* controller only; sibling conversations keep streaming.
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map())
  // Chat on agent-py's runs API ("agent-py (runs)") — its sessions,
  // Stop → cancel, pointer, rejoin and the answer-card bridge
  // (`lib/client/runs/chat-runner.ts`). Reads the store fresh; the
  // session module (`@ag-ui/client`) is imported only when a run starts.
  const [runner] = useState<ChatRunner>(() =>
    createChatRunner({
      store: () => useStore.getState(),
      setLiveToolCalls,
      loadSession: () => import("@/client/runs/session"),
      resolveTarget: async () =>
        RUNS_CHAT_ENABLED
          ? (await import("@/client/api/backend-resolver")).resolveRunsTarget()
          : null,
      cancelRun: (runId, opts) => apiClient.runs.cancel(runId, opts),
      buildRunInput,
      autoArchive: (messageId, conversationId) => {
        const st = useStore.getState()
        const message = st.conversations
          .find((c) => c.id === conversationId)
          ?.messages.find((m) => m.id === messageId)
        if (!message) return
        autoArchiveCodeBlocksPure(
          { content: message.content, messageId, conversationId },
          st.createArtifact
        )
      },
      extractMemory: extractAfterTurn,
      memoryEnabled: () => useStore.getState().memoryEnabled,
      // A resume after a reload (the paused run's request is gone):
      // composed like a send's, minus the per-turn persona / forced skills.
      composeResumeInput: (turn) => {
        const st = useStore.getState()
        const conv = st.conversations.find((c) => c.id === turn.conversationId)
        const workspaceId = conv?.workspaceId || st.activeWorkspaceId
        const workspace = st.workspaces.find((w) => w.id === workspaceId)
        const model = turn.model ?? st.chatModel
        return {
          model,
          systemPrompt: withUserSkillInstructions(
            composeSystemPrompts(
              st.customInstructionsStyle,
              st.customInstructionsAbout,
              workspace?.systemPrompt,
              conv?.systemPrompt,
              ""
            ),
            st.userSkills,
            workspaceId
          ),
          skills: resolveEnabledSkills({ workspace, conversation: conv }),
          workspaceId: workspaceId || undefined,
          reasoningEffort: modelSupportsReasoningEffort(model)
            ? st.chatReasoningEffort ?? undefined
            : undefined,
          memoryBypass: conv?.memoryOff || undefined,
          verifyCitations: st.verifyCitations || undefined,
          localFilesOnly: st.localFilesOnly || undefined,
          // TODO(5b-B): the turn's `attachments`. TODO(5b-D):
          // `localMcpServers` + `localMcpCredentials` (`getLocalCred`) —
          // re-read here, since nothing keeps the paused run's request
          // across a reload. The I2I `referenceImage` is per send and is
          // not re-applied after a reload.
        }
      },
    })
  )

  // Long-running task mode. The provider owns the active run so the chat
  // panel + Tasks panel share it. Ref so the pipeline can reach
  // `startTask` without depending on the context's React identity.
  const taskRun = useTaskRunContext()
  const taskRunRef = useRef(taskRun)
  useEffect(() => {
    taskRunRef.current = taskRun
  }, [taskRun])

  // --- shared local helpers ---
  const mockAIResponse = useCallback(
    (userMessage: string, convId: string) => {
      setConversationTyping(convId, true)
      setTimeout(() => {
        const reasoning = [
          `User asked: "${userMessage}".`,
          "",
          "Step 1 — Parse the request: they want a brief explanation.",
          "Step 2 — Consider whether any state is relevant. The mock path doesn't actually call a model, so I'll keep this short.",
          "Step 3 — Draft a reply that makes the mock origin obvious so it isn't confused with real model output.",
        ].join("\n")
        const aiContent = `_Mock response (set \`AI_GATEWAY_API_KEY\` to enable real AI)_\n\nRegarding "${userMessage}": this is placeholder text.`
        addMessage({ role: "assistant", content: aiContent, reasoning }, convId)
        setConversationTyping(convId, false)
      }, 300)
    },
    [setConversationTyping, addMessage]
  )

  // Auto-archive code blocks after a stream completes. Re-read the
  // message from the store (the streaming loop's `Message` reference is
  // stale because `appendToMessage` updates immutably) and hand it to
  // the pure helper.
  const autoArchiveCodeBlocks = useCallback(
    (assistantMessageId: string, conversationId: string) => {
      const conv = useStore
        .getState()
        .conversations.find((c) => c.id === conversationId)
      const message = conv?.messages.find((m) => m.id === assistantMessageId)
      if (!message) return
      autoArchiveCodeBlocksPure(
        {
          content: message.content,
          messageId: assistantMessageId,
          conversationId,
        },
        createArtifact
      )
    },
    [createArtifact]
  )

  // Latest-version ref so the hook can call back into itself (auto-
  // retry-once) without becoming a stale closure across renders.
  // Declared before `callChatAPI` (which reads it) and synced in an
  // effect below, per react-hooks/immutability.
  const callChatAPIRef = useRef<
    ((history: Message[], options?: SendOptions) => Promise<void>) | null
  >(null)

  // --- the pipeline (the body that used to be `callChatAPI`) ---
  const callChatAPI = useCallback(
    async (history: Message[], options?: SendOptions) => {
      // Read the model freshly so retry-after-model-change works.
      const modelForCall =
        options?.modelOverride ?? useStore.getState().chatModel
      const isRetry = options?.isRetry ?? false
      // Capture the conv id at send time so a tab switch mid-stream
      // doesn't move the UI state onto the wrong chat. When the caller
      // explicitly targets a conversation (a just-created fork that the
      // subscribed closure hasn't seen yet), that id wins and the conv
      // is resolved from `getState()` — see `resolveSendTargetConversationId`.
      const targetConvId = resolveSendTargetConversationId(
        options,
        activeConversationId
      )
      if (!targetConvId) return
      // For an explicit target, `conversations` (the subscribed closure)
      // may not yet contain the just-created fork — read it fresh.
      // Without a target, keep using the subscribed array so the
      // tab-switch-mid-stream protection is unchanged.
      const conv = options?.targetConversationId
        ? useStore.getState().conversations.find((c) => c.id === targetConvId)
        : conversations.find((c) => c.id === targetConvId)
      const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
      // Compose the three system-prompt tiers in the cascade: workspace
      // voice → conversation thread context → per-turn persona override.
      // The conversation prompt is **additive** — switching personas does
      // not drop the thread context. See
      // `docs/PLAN-conversation-system-prompt.md`.
      const workspaceSystemPrompt = withUserSkillInstructions(
        composeSystemPrompts(
          customInstructionsStyle,
          customInstructionsAbout,
          activeWorkspace?.systemPrompt,
          conv?.systemPrompt,
          options?.agentSystemPrompt ?? ""
        ),
        userSkills,
        activeWorkspaceId
      )

      // Effective skills = (workspace/conversation cascade ∪ forced) − muted.
      // Mute wins over forced when both name the same skill.
      const enabledSkills = resolveEnabledSkills({
        workspace: activeWorkspace,
        conversation: conv,
        forcedSkillIds: options?.forcedSkillIds,
        mutedSkillIds: options?.mutedSkillIds,
      })

      // Attachments + API-shaped message list via the pure helpers.
      const { attachedFiles, attachedImageFiles } = buildAttachments({
        conversation: conv,
        files,
        conversationFiles,
      })
      // Image data URLs live in IndexedDB since store v32.
      const attachedImageUrls = await getFileImageDataUrls(attachedImageFiles)
      const buildMessages = () =>
        buildTransmittedMessages(history, attachedImageUrls)

      // Task mode: hand off to the shared task runner (Tasks panel).
      if (options?.asTask) {
        taskRunRef.current.startTask(
          {
            messages: buildMessages() as TaskRequestInput["messages"],
            conversationId: targetConvId,
            model: modelForCall,
            workspaceSystemPrompt,
            workspaceId: activeWorkspaceId || undefined,
            skills: enabledSkills,
            ...(options.taskMode && options.taskMode !== "default"
              ? { mode: options.taskMode }
              : {}),
            ...(options.allowedMcpServerIds
              ? { allowedMcpServerIds: options.allowedMcpServerIds }
              : {}),
          },
          { title: conv?.title }
        )
        return
      }

      // Chat on agent-py's runs API ("agent-py (runs)", Q33):
      // `resolveRunsTarget()` is `null` unless that option is selected and
      // agent-py configured — then the path below runs exactly as before.
      // Signed-out users get a target too (anonymous runs, Q34), so no
      // `authToken` / mock fallback here. Attachments go as the newest
      // user message's parts — the attached images' data URLs (as
      // `buildMessages` sends them) and the inline-mode files' extracted
      // text (`runDocumentsFor`, as the file attachments below) — and the
      // reasoning tier as `/v1/chat` sends it. The contract-0.4.0 options
      // go too where they are at hand (the memory opt-out, citation
      // checks, `localFilesOnly`, the I2I reference, the persona's MCP
      // allow-list); agent-py accepts them and acts on them in wave 5b.
      // Not yet sent (Q32, see the plan's Phase 3 checklist): MCP servers /
      // resources, URL bookmarks, cloud files by id, sandbox files.
      const runsTarget = RUNS_CHAT_ENABLED
        ? await (
            await import("@/client/api/backend-resolver")
          ).resolveRunsTarget()
        : null
      if (runsTarget) {
        // Q35: a new message while a turn is paused cancels the paused run.
        await runner.supersedeInterrupted(targetConvId, runsTarget)
        await runner.send({
          conversationId: targetConvId,
          history,
          target: runsTarget,
          model: modelForCall,
          isRetry,
          body: buildRunInput({
            conversationId: targetConvId,
            history,
            model: modelForCall,
            systemPrompt: workspaceSystemPrompt,
            skills: enabledSkills,
            workspaceId: activeWorkspaceId || undefined,
            images: attachedImageUrls,
            documents: runDocumentsFor(
              attachedFiles,
              conv?.fileRetrievalModes
            ),
            reasoningEffort: modelSupportsReasoningEffort(modelForCall)
              ? useStore.getState().chatReasoningEffort ?? undefined
              : undefined,
            memoryBypass: conv?.memoryOff || undefined,
            verifyCitations: useStore.getState().verifyCitations || undefined,
            localFilesOnly: useStore.getState().localFilesOnly || undefined,
            referenceImage: options?.referenceImage,
            allowedMcpServerIds: options?.allowedMcpServerIds,
            // TODO(5b-B): `attachments` — files (cloud ones by id, Q44),
            // URL bookmarks, MCP resources, as the `/v1/chat` body's
            // `attachmentsForRequest` below. TODO(5b-D): `localMcpServers`
            // (no credentials) + `localMcpCredentials` (`getLocalCred`),
            // as `mcpServersForRequest` below.
          }),
        })
        return
      }
      // Off runs now: a turn paused on runs earlier can't be answered any
      // more — forget it (local state only; nothing else changes here).
      void runner.supersedeInterrupted(targetConvId, null)

      const controller = new AbortController()
      // If this conversation already has an in-flight controller
      // (very rare — user double-clicks Send before the previous turn
      // lands a placeholder), abort the old one first so we don't leak
      // its event listener.
      abortControllersRef.current.get(targetConvId)?.abort()
      abortControllersRef.current.set(targetConvId, controller)
      setConversationTyping(targetConvId, true)
      setConversationStreaming(targetConvId, true)
      // The stream's per-frame handling + local state (placeholder created
      // on the first output frame, tool-call buffer, reasoning timers,
      // `error` / `memory_tainted`) — `turn-writer.ts`, shared with chat
      // on runs.
      const writer = createTurnWriter(
        {
          addMessage,
          setConversationTyping,
          appendToMessage,
          appendToMessageReasoning,
          appendMessageGeneratedImages,
          appendMessageGeneratedFiles,
          appendMessageCodeResult,
          appendMessageUiPart,
          appendMessageMcpApp,
          setMessageSuggestions,
          setMessageVerification,
          setMessageRoutedModel,
          setMessageToolCalls,
          createArtifact,
          setLiveToolCalls,
        },
        { conversationId: targetConvId }
      )

      const surfaceError = (error: MessageError) => {
        setConversationTyping(targetConvId, false)
        const placeholder = writer.placeholder
        if (placeholder) {
          setMessageError(placeholder.id, error)
        } else {
          const created = addMessage(
            { role: "assistant", content: "" },
            targetConvId
          )
          setMessageError(created.id, error)
        }
      }

      // MCP servers for this turn. Local-mode creds come straight from
      // localStorage; cloud-mode rows stay out of the body (server looks
      // them up via Supabase + pgcrypto).
      const mcpStore = useStore.getState()
      const mcpServersForRequest = mcpStore.mcpServers
        .filter(
          (s) =>
            s.workspaceId === activeWorkspaceId &&
            !s.deletedAt &&
            s.enabled &&
            s.credentialMode === "local" &&
            (s.capabilities?.tools?.length ?? 0) > 0
        )
        .map((s) => ({
          id: s.id,
          name: s.name,
          url: s.url,
          transport: s.transport,
          enabled: s.enabled,
          capabilities: s.capabilities,
          credentials: getLocalCred(s.id) ?? undefined,
        }))

      // Unified attachments — files + MCP resources + URL bookmarks in
      // one discriminated array. Workspace-ticked + conversation-pinned,
      // de-duped per kind, tombstones filtered.
      const attachmentsForRequest: ChatRequestInput["attachments"] = []

      const retrievalModes = conv?.fileRetrievalModes ?? {}
      for (const file of attachedFiles) {
        const mode = retrievalModes[file.id] ?? "inline"
        attachmentsForRequest.push({
          kind: "file",
          summary: {
            name: file.name,
            size: file.size,
            type: file.type,
            // Suppress the inline body for RAG-mode attachments — the
            // server renders a short "available via searchFiles" note
            // instead of the full text. We still send `truncated` and
            // `kind` so the meta block (filename / type / size) stays
            // accurate. Setting `text` to undefined keeps the wire
            // shape clean.
            text: mode === "rag" ? undefined : file.extractedText,
            truncated:
              mode === "rag" ? undefined : file.extractionTruncated,
            kind: file.extractedKind,
            // Only emit the field when non-default to keep cache-hit
            // friendliness — an unchanged prefix matters for the
            // Vercel Gateway's auto-cache story.
            ...(mode === "rag" ? { retrievalMode: "rag" as const } : {}),
          },
        })
      }

      const mcpResourcesById = new Map(
        mcpStore.mcpResources.map((r) => [r.id, r])
      )
      const workspaceMcpIds = conv?.selectedMcpResourceIds ?? []
      const privateMcpIds = conv
        ? mcpStore.conversationMcpResources
            .filter((cmr) => cmr.conversationId === conv.id)
            .map((cmr) => cmr.resourceId)
        : []
      const attachedMcpResourceIds = [
        ...new Set([...workspaceMcpIds, ...privateMcpIds]),
      ]
      for (const id of attachedMcpResourceIds) {
        const resource = mcpResourcesById.get(id)
        if (!resource || resource.deletedAt) continue
        attachmentsForRequest.push({
          kind: "mcp_resource",
          ref: {
            id: resource.id,
            serverId: resource.serverId,
            uri: resource.uri,
            name: resource.name,
            mimeType: resource.mimeType,
          },
        })
      }

      const urlBookmarksById = new Map(
        mcpStore.urlBookmarks.map((b) => [b.id, b])
      )
      const workspaceUrlIds = conv?.selectedUrlBookmarkIds ?? []
      const privateUrlIds = conv
        ? mcpStore.conversationUrlBookmarks
            .filter((cub) => cub.conversationId === conv.id)
            .map((cub) => cub.bookmarkId)
        : []
      const attachedUrlBookmarkIds = [
        ...new Set([...workspaceUrlIds, ...privateUrlIds]),
      ]
      for (const id of attachedUrlBookmarkIds) {
        const bookmark = urlBookmarksById.get(id)
        if (!bookmark || bookmark.deletedAt) continue
        attachmentsForRequest.push({
          kind: "url_bookmark",
          bookmark: {
            id: bookmark.id,
            url: bookmark.url,
            title: bookmark.title,
            content: bookmark.content,
            contentTruncated: bookmark.contentTruncated,
            fetchedAt: toISO(bookmark.fetchedAt),
          },
        })
      }

      // Snapshot the user's local-files-only preference at send-time;
      // the server routes generated images to Storage vs. data URLs
      // based on this.
      const localFilesOnly = useStore.getState().localFilesOnly
      // Opt-in citation verification (account-menu toggle). Snapshotted
      // at send-time; the server only acts on it for retrieval turns that
      // produced cited claims. See PLAN-citation-verifiability.md.
      const verifyCitations = useStore.getState().verifyCitations
      // Phase 4-2 backend selector + Phase 5 of PLAN-agent-ts. The
      // resolver reads `chatBackend` from the store + grabs the
      // Supabase JWT lazily; null means "in-Next route, no token
      // needed." Shared with the four non-chat endpoints in
      // `apiClient.{summarize,mcp,url,images}.*` so divergence is
      // impossible. `'python-runs'` ("agent-py (runs)") took the runs
      // path above whenever it resolved a target; when it didn't
      // (agent-py unconfigured) it is sent as `'python'` here.
      const { resolveRemoteBackend } = await import(
        "@/client/api/backend-resolver"
      )
      const remoteCtx = await resolveRemoteBackend()
      const chatBackend = remoteCtx?.backend ?? "ts"
      const authToken = remoteCtx?.authToken ?? null

      // Code-interpreter mount manifest (PR-2). Only when the
      // codeInterpreter skill is enabled for THIS send: map the same
      // attached files used above into sources. Cloud files (with a
      // `storagePath`) ride as bytes-less entries — the server
      // downloads them by fileId under the user's RLS. Local-only files
      // read their bytes from the IndexedDB blob cache (`getBlob`, the
      // same store attachments use). Skipped entirely otherwise so the
      // field stays absent on the wire.
      let sandboxFiles: ChatRequestInput["sandboxFiles"]
      if (enabledSkills.some((s) => s.id === "codeInterpreter")) {
        const sources: SandboxFileSource[] = attachedFiles.map((file) => ({
          fileId: file.id,
          name: file.name,
          storagePath: file.storagePath ?? null,
          readBytes: async () => {
            const blob = await getBlob(file.id)
            if (!blob) return new Uint8Array(0)
            return new Uint8Array(await blob.arrayBuffer())
          },
        }))
        const built = await buildSandboxFiles(sources)
        if (built.length > 0) sandboxFiles = built
      }

      try {
        const result = await apiClient.chat.stream(
          {
            model: modelForCall,
            messages: buildMessages() as ChatRequestInput["messages"],
            workspaceSystemPrompt,
            ...(conv?.memoryOff ? { memoryBypass: true } : {}),
            workspaceId: activeWorkspaceId || undefined,
            skills: enabledSkills,
            mcpServers:
              mcpServersForRequest.length > 0
                ? mcpServersForRequest
                : undefined,
            // Q48: the persona's MCP allow-list, filtered server-side.
            allowedMcpServerIds: options?.allowedMcpServerIds,
            attachments:
              attachmentsForRequest.length > 0
                ? attachmentsForRequest
                : undefined,
            sandboxFiles,
            referenceImage: options?.referenceImage,
            localFilesOnly: localFilesOnly || undefined,
            verifyCitations: verifyCitations || undefined,
            // Only send the reasoning tier when the active model exposes
            // the knob; harmless otherwise (the route maps it to {} for
            // unsupported providers), but keeps the wire clean.
            reasoningEffort: modelSupportsReasoningEffort(modelForCall)
              ? useStore.getState().chatReasoningEffort ?? undefined
              : undefined,
          },
          {
            signal: controller.signal,
            backend: chatBackend,
            authToken,
          }
        )

        if (!result.ok) {
          // REQUIRE_AUTH_FOR_AI: the caller must sign in. Typed bubble
          // with a Sign in action — never the no-key mock fallback below.
          if (isAuthRequiredError(result.error)) {
            surfaceError({
              code: "auth_required",
              status: result.status,
              model: modelForCall,
            })
            return
          }
          if (result.status === 401) {
            setConversationTyping(targetConvId, false)
            setConversationStreaming(targetConvId, false)
            const lastUser = [...history]
              .reverse()
              .find((m) => m.role === "user")
            if (lastUser) mockAIResponse(lastUser.content, targetConvId)
            return
          }
          surfaceError({
            code: (result.error?.code as MessageErrorCode) || "unknown",
            status: result.status,
            model: modelForCall,
            detail: result.error?.message,
          })
          return
        }

        if (!result.body) {
          surfaceError({
            code: "provider",
            status: result.status,
            model: modelForCall,
            detail: "No response body.",
          })
          return
        }

        const reader = result.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        // SSE frames: `data: <json>\n\n`, each applied by the writer.
        outer: while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          let nlIndex: number
          while ((nlIndex = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, nlIndex)
            buffer = buffer.slice(nlIndex + 2)
            if (!frame.startsWith("data:")) continue
            const payload = frame.slice(5).trim()
            if (!payload) continue
            // AI SDK v5 UI message stream terminator. PLAN-useChat-
            // adoption.md Phase B.2 — the consumer accepts both the
            // custom format and the AI SDK shape side-by-side.
            if (payload === "[DONE]") break outer
            const translated = translateFrame(payload)
            if (!translated) continue
            if (writer.handleFrame(translated) === "stop") break outer
          }
        }

        const { streamError, memoryTainted, toolCalls, reasoningStart, reasoningLast } =
          writer
        const placeholder = writer.placeholder
        if (streamError) {
          surfaceError({
            code: (streamError.code as MessageErrorCode) || "unknown",
            model: modelForCall,
            detail: streamError.message,
          })
        } else if (writer.firstChunk) {
          surfaceError({
            code: "provider",
            model: modelForCall,
            detail: "The model returned an empty response.",
          })
        } else if (placeholder) {
          const ph = placeholder as Message
          // Pass the id, not the captured Message — the local reference
          // is stale; auto-archive re-reads streamed content from the
          // store. Conversation id is captured from targetConvId so a
          // stream that finished while the user was on a different tab
          // still archives into the originating conversation.
          autoArchiveCodeBlocks(ph.id, targetConvId)
          if (reasoningStart !== null && reasoningLast !== null) {
            setMessageReasoningDuration(
              ph.id,
              Math.max(0, reasoningLast - reasoningStart)
            )
          }
          // Flush live tool-call buffer onto the message so the pill
          // survives reload. Drop the in-flight (running) entries:
          // a tool that never returned doesn't belong in the durable
          // record.
          const persisted = toPersistedToolCalls(toolCalls)
          if (persisted.length > 0) {
            setMessageToolCalls(ph.id, persisted)
          }

          // Cross-conversation memory: best-effort, fire-and-forget
          // extraction over THIS turn (latest user message + the
          // just-finalized assistant reply). Gated on the opt-in flag so
          // opted-out / anonymous users make zero calls; the route +
          // `extractFacts` self-gate again on sign-in + memory_enabled.
          // Read the assistant content fresh from the store — the
          // `placeholder` reference is stale (appendToMessage is immutable).
          const finalConv = useStore
            .getState()
            .conversations.find((c) => c.id === targetConvId)
          if (memoryEnabled && !finalConv?.memoryOff) {
            const assistantText =
              finalConv?.messages.find((m) => m.id === ph.id)?.content ?? ""
            const lastUserText =
              [...history].reverse().find((m) => m.role === "user")?.content ??
              ""
            const turnText = [
              lastUserText && `User: ${lastUserText}`,
              assistantText && `Assistant: ${assistantText}`,
            ]
              .filter(Boolean)
              .join("\n\n")
            if (turnText.trim()) {
              extractAfterTurn(turnText, targetConvId, { tainted: memoryTainted })
            }
          }
        }
      } catch (err) {
        const aborted =
          (err instanceof DOMException && err.name === "AbortError") ||
          controller.signal.aborted
        const ph = writer.placeholder
        if (aborted) {
          if (ph && ph.content === "") {
            deleteMessage(ph.id)
          }
        } else {
          // Distinguish offline from generic network failure.
          const offline =
            typeof navigator !== "undefined" && navigator.onLine === false
          // Auto-retry-once decision is the pure policy in
          // `auto-retry-decision.ts` so the rules can be unit-tested
          // without a React + Zustand harness. The caller handles the
          // 1 s timer + the `isRetry: true` flag + the surface-error
          // fallback.
          if (shouldAutoRetry({ isRetry, offline, placeholderEmpty: !ph || ph.content === "" })) {
            if (ph) deleteMessage(ph.id)
            setConversationTyping(targetConvId, false)
            setConversationStreaming(targetConvId, false)
            setTimeout(() => {
              void callChatAPIRef.current?.(history, {
                modelOverride: options?.modelOverride,
                isRetry: true,
              })
            }, 1000)
            return
          }
          const detail = offline
            ? "You appear to be offline. Reconnect and click Retry."
            : err instanceof Error
              ? err.message
              : "Network error"
          surfaceError({
            code: "network",
            model: modelForCall,
            detail,
          })
        }
      } finally {
        setConversationTyping(targetConvId, false)
        // Drop live tool-call pills now that the stream is finished.
        // The durable record lives on the message via setMessageToolCalls.
        const ph = writer.placeholder
        if (ph) {
          setLiveToolCalls((prev) => {
            if (!(ph.id in prev)) return prev
            const next = { ...prev }
            delete next[ph.id]
            return next
          })
        }
        // Clear this conv's controller entry only if it's still the
        // one we set — guards against a follow-up send for the same
        // conv overwriting the slot. Same guard for the streaming flag:
        // a superseded stream must not end the hold `useSync` keeps on
        // the newer stream's message diffs. Clearing it is what releases
        // that hold, so the final message state (incl. the tool calls /
        // reasoning duration stamped above) syncs exactly once here.
        if (abortControllersRef.current.get(targetConvId) === controller) {
          abortControllersRef.current.delete(targetConvId)
          setConversationStreaming(targetConvId, false)
        }
      }
    },
    // Reads via getState() (chatModel, MCP state, localFilesOnly) and
    // refs (taskRunRef, callChatAPIRef) intentionally don't appear in
    // the deps — fresh-at-send-time / latest-version are the invariants.
    [
      activeConversationId,
      activeWorkspaceId,
      addMessage,
      appendMessageGeneratedImages,
      appendMessageGeneratedFiles,
      appendMessageCodeResult,
      appendMessageUiPart,
      appendToMessage,
      appendMessageMcpApp,
      appendToMessageReasoning,
      autoArchiveCodeBlocks,
      conversationFiles,
      conversations,
      createArtifact,
      customInstructionsAbout,
      customInstructionsStyle,
      deleteMessage,
      files,
      memoryEnabled,
      mockAIResponse,
      runner,
      setConversationStreaming,
      setConversationTyping,
      setMessageError,
      setMessageReasoningDuration,
      setMessageRoutedModel,
      setMessageSuggestions,
      setMessageVerification,
      setMessageToolCalls,
      userSkills,
      workspaces,
    ]
  )

  useEffect(() => {
    callChatAPIRef.current = callChatAPI
  }, [callChatAPI])

  // A conversation deleted mid-stream — here, or in another tab (the
  // cross-tab merge lets that delete win) — has its stream aborted, so
  // it stops writing into a conversation that no longer exists.
  useEffect(
    () =>
      useStore.subscribe((state, prev) => {
        if (state.conversations === prev.conversations) return
        abortStreamsOfDeletedConversations(
          abortControllersRef.current,
          state.conversations
        )
        // Runs: detach (the run goes on server-side, but nothing writes
        // into a conversation that's gone), drop pointers + paused turns.
        runner.forgetDeleted(state.conversations, prev.conversations)
      }),
    [runner]
  )

  // Runs: the answer cards resume paused turns through this hook
  // (`ChatRunBridge`); after a reload, running answers are rejoined into
  // their messages. Unmount stops reading every run (they go on
  // server-side and are rejoined on the next mount).
  useEffect(() => {
    const unregister = registerChatRunBridge({
      answerInterrupts: (turn, answers, opts) =>
        runner.answerInterrupts(turn, answers, opts),
    })
    const rejoin = () => void runner.rejoinActive()
    let offHydrate: (() => void) | undefined
    if (useStore.persist.hasHydrated()) rejoin()
    else offHydrate = useStore.persist.onFinishHydration(rejoin)
    return () => {
      offHydrate?.()
      unregister()
      runner.detachAll()
    }
  }, [runner])

  // Stable wrapper — consumers don't manage their own ref.
  const send = useCallback(
    (history: Message[], options?: SendOptions): Promise<void> =>
      callChatAPIRef.current?.(history, options) ?? Promise.resolve(),
    []
  )

  const stop = useCallback(() => {
    // Stop only the *active* conv's stream. Other conversations
    // mid-stream stay running — each has its own controller.
    if (!activeConversationId) return
    // Runs: Stop cancels the run on the server (Q36).
    if (runner.stop(activeConversationId)) return
    abortControllersRef.current.get(activeConversationId)?.abort()
  }, [activeConversationId, runner])

  const isStreaming = useCallback(
    (convId: string | null | undefined): boolean =>
      !!convId && streamingConvIds.has(convId),
    [streamingConvIds]
  )

  return { send, stop, isStreaming, streamingConvIds, liveToolCalls }
}

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

import { useCallback, useEffect, useRef, useState } from "react"

import { apiClient } from "@/client/api-client"
import { useTaskRunContext } from "@/client/agent/task-run-context"
import { autoArchiveCodeBlocks as autoArchiveCodeBlocksPure } from "@/client/chat/auto-archive-code-blocks"
import { buildAttachments } from "@/client/chat/build-attachments"
import { buildTransmittedMessages } from "@/client/chat/build-messages"
import { useStore } from "@/client/hooks/use-store"
import { getLocalCred } from "@/client/mcp/local-creds"
import type { LiveToolCall } from "@/components/skills/tool-call-strip"
import { composeSystemPrompts } from "@/shared/agents/resolve"
import type { ChatRequestInput, TaskRequestInput } from "@/shared/api-schemas"
import { resolveEnabledSkills } from "@/shared/skills/resolve-enabled-skills"
import type { SkillId } from "@/shared/skills/types"
import type { Message, MessageError, MessageErrorCode } from "@/shared/types"
import { toISO } from "@/shared/utils"

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
  /** Per-turn MCP allow-list — when set, cloud-mode MCP servers are
   *  filtered to this list server-side (Phase 2 of `PLAN-custom-agents`).
   *  Passed through to task mode; the inline chat stream relies on the
   *  server-side filter in `loadEffectiveMcpServers`. */
  allowedMcpServerIds?: string[]
}

export interface UseChatSendResult {
  send: (history: Message[], options?: SendOptions) => Promise<void>
  stop: () => void
  isStreaming: (convId: string | null | undefined) => boolean
  streamingConvIds: ReadonlySet<string>
  liveToolCalls: Record<string, LiveToolCall[]>
}

/** Shape the stream handler reads. The translator below normalises
 *  both the legacy custom format (`{type:"text",value}`, `tool_call`,
 *  `tool_result`, `tool_image`, `suggestions`, `error`, `done`) and
 *  the AI SDK v5 UI message stream (`text-delta`, `reasoning-delta`,
 *  `tool-input-available`, `tool-output-available`, `data-tool-image`,
 *  `data-suggestions`, `error`, lifecycle frames) into this single
 *  shape so the handler block stays small. */
interface NormalisedFrame {
  type?: string
  value?: string
  values?: string[]
  code?: string
  message?: string
  id?: string
  name?: string
  args?: unknown
  summary?: string
  results?: Array<{ title?: string; url?: string; snippet?: string }>
  mode?: string
  images?: unknown[]
}

/** Decode one SSE payload (the JSON between `data: ` and `\n\n`) and
 *  translate it into our internal shape. Returns null when the frame
 *  is one of the AI SDK lifecycle no-ops (start, start-step,
 *  text-start/end, reasoning-start/end, finish-step, finish) or
 *  when the payload doesn't parse — the handler ignores it.
 *
 *  PLAN-useChat-adoption.md Phase B.2. */
export function translateFrame(payload: string): NormalisedFrame | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(payload)
  } catch {
    return null
  }
  const t = raw.type
  if (typeof t !== "string") return null

  // AI SDK errors use `errorText` instead of `message`. Reshape
  // before the custom-format passthrough so the downstream handler
  // gets a consistent `message`.
  if (t === "error" && typeof raw.errorText === "string") {
    return { type: "error", message: raw.errorText }
  }

  // Legacy custom format — pass through unchanged.
  if (
    t === "text" ||
    t === "reasoning" ||
    t === "tool_call" ||
    t === "tool_result" ||
    t === "tool_image" ||
    t === "suggestions" ||
    t === "error" ||
    t === "done"
  ) {
    return raw as NormalisedFrame
  }

  // AI SDK v5 frame types. Re-shape into the same logical envelope
  // the handler block expects (`{type:"text", value}` etc.) so the
  // downstream dispatch doesn't need to know which wire format the
  // backend chose.
  if (t === "text-delta" && typeof raw.delta === "string") {
    return { type: "text", value: raw.delta }
  }
  if (t === "reasoning-delta" && typeof raw.delta === "string") {
    return { type: "reasoning", value: raw.delta }
  }
  if (t === "tool-input-available") {
    const toolCallId = raw.toolCallId
    const toolName = raw.toolName
    if (typeof toolCallId === "string" && typeof toolName === "string") {
      return {
        type: "tool_call",
        id: toolCallId,
        name: toolName,
        args: raw.input,
      }
    }
    return null
  }
  if (t === "tool-output-available") {
    const toolCallId = raw.toolCallId
    if (typeof toolCallId !== "string") return null
    // `output` is a JSON-stringified `{summary, results?}` object per
    // `lib/server/chat/sse-emitter.ts`. Parse it back so we can pull
    // the summary + sources strip results.
    let summary: string | undefined
    let results:
      | Array<{ title?: string; url?: string; snippet?: string }>
      | undefined
    if (typeof raw.output === "string") {
      try {
        const out = JSON.parse(raw.output) as {
          summary?: unknown
          results?: unknown
        }
        if (typeof out.summary === "string") summary = out.summary
        if (Array.isArray(out.results)) {
          results = out.results.filter(
            (r): r is { title?: string; url?: string; snippet?: string } =>
              typeof r === "object" && r !== null,
          )
        }
      } catch {
        // ignore — summary stays undefined and the pill shows "done"
      }
    }
    // The emitter also sends `errorText` on the AI SDK side when
    // `isError` was true on the source frame. Surface as summary so
    // the pill shows it.
    if (typeof raw.errorText === "string" && !summary) summary = raw.errorText
    return {
      type: "tool_result",
      id: toolCallId,
      summary,
      results,
    }
  }
  if (t === "data-tool-image") {
    const data = raw.data as
      | { id?: unknown; mode?: unknown; images?: unknown }
      | undefined
    if (!data || typeof data !== "object") return null
    return {
      type: "tool_image",
      id: typeof data.id === "string" ? data.id : undefined,
      mode: typeof data.mode === "string" ? data.mode : undefined,
      images: Array.isArray(data.images) ? data.images : undefined,
    }
  }
  if (t === "data-suggestions") {
    const data = raw.data as { values?: unknown } | undefined
    if (!data || !Array.isArray(data.values)) return null
    return {
      type: "suggestions",
      values: data.values.filter((v): v is string => typeof v === "string"),
    }
  }
  // Lifecycle frames the handler doesn't need to act on.
  if (
    t === "start" ||
    t === "start-step" ||
    t === "text-start" ||
    t === "text-end" ||
    t === "reasoning-start" ||
    t === "reasoning-end" ||
    t === "finish-step" ||
    t === "finish"
  ) {
    return null
  }

  // Unknown frame type — ignore.
  return null
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
  const appendMessageGeneratedImages = useStore(
    (s) => s.appendMessageGeneratedImages
  )
  const setConversationTyping = useStore((s) => s.setConversationTyping)
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

  // --- own state / refs (used to live on the chat panel) ---
  const [streamingConvIds, setStreamingConvIds] = useState<Set<string>>(
    () => new Set()
  )
  const [liveToolCalls, setLiveToolCalls] = useState<
    Record<string, LiveToolCall[]>
  >({})
  // Per-conversation abort controllers. Stop on the active conv aborts
  // *that* controller only; sibling conversations keep streaming.
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map())

  // Long-running task mode. The provider owns the active run so the chat
  // panel + Tasks panel share it. Ref so the pipeline can reach
  // `startTask` without depending on the context's React identity.
  const taskRun = useTaskRunContext()
  const taskRunRef = useRef(taskRun)
  useEffect(() => {
    taskRunRef.current = taskRun
  }, [taskRun])

  // --- shared local helpers ---
  const markStreaming = useCallback((convId: string, on: boolean) => {
    setStreamingConvIds((prev) => {
      const has = prev.has(convId)
      if (on === has) return prev
      const next = new Set(prev)
      if (on) next.add(convId)
      else next.delete(convId)
      return next
    })
  }, [])

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

  // --- the pipeline (the body that used to be `callChatAPI`) ---
  const callChatAPI = useCallback(
    async (history: Message[], options?: SendOptions) => {
      // Read the model freshly so retry-after-model-change works.
      const modelForCall =
        options?.modelOverride ?? useStore.getState().chatModel
      const isRetry = options?.isRetry ?? false
      // Capture the conv id at send time so a tab switch mid-stream
      // doesn't move the UI state onto the wrong chat.
      const targetConvId = activeConversationId
      if (!targetConvId) return
      const conv = conversations.find((c) => c.id === targetConvId)
      const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
      // Compose workspace + per-turn persona system prompts. When neither
      // is set, `composeSystemPrompts` returns undefined and the route
      // falls back to its built-in default. See `PLAN-custom-agents.md`.
      const workspaceSystemPrompt = composeSystemPrompts(
        activeWorkspace?.systemPrompt,
        options?.agentSystemPrompt ?? ""
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
      const { attachedFiles, attachedImageUrls } = buildAttachments({
        conversation: conv,
        files,
        conversationFiles,
      })
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

      const controller = new AbortController()
      // If this conversation already has an in-flight controller
      // (very rare — user double-clicks Send before the previous turn
      // lands a placeholder), abort the old one first so we don't leak
      // its event listener.
      abortControllersRef.current.get(targetConvId)?.abort()
      abortControllersRef.current.set(targetConvId, controller)
      setConversationTyping(targetConvId, true)
      markStreaming(targetConvId, true)
      let placeholder: Message | null = null
      let firstChunk = true
      // Reasoning duration capture: first/last chunk timestamps so we
      // can persist the elapsed ms on the message at stream end.
      let reasoningStart: number | null = null
      let reasoningLast: number | null = null

      const surfaceError = (error: MessageError) => {
        setConversationTyping(targetConvId, false)
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

      for (const file of attachedFiles) {
        attachmentsForRequest.push({
          kind: "file",
          summary: {
            name: file.name,
            size: file.size,
            type: file.type,
            text: file.extractedText,
            truncated: file.extractionTruncated,
            kind: file.extractedKind,
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
      // Phase 4-2 backend selector + Phase 5 of PLAN-agent-ts.
      // Resolve the JWT lazily — only call into Supabase when the
      // user actually picked a remote backend, otherwise the
      // in-Next TS route doesn't need a token (cookie auth).
      const chatBackend = useStore.getState().chatBackend
      let authToken: string | null = null
      if (chatBackend === "python" || chatBackend === "ts-service") {
        try {
          const { getSupabaseBrowserClient } = await import(
            "@/client/supabase/client"
          )
          const supa = getSupabaseBrowserClient()
          if (supa) {
            const { data } = await supa.auth.getSession()
            authToken = data.session?.access_token ?? null
          }
        } catch {
          // Supabase unconfigured or session lookup failed — fall
          // through with a null token; the apiClient will route to
          // the in-Next TS backend as a defensive default.
          authToken = null
        }
      }

      try {
        const result = await apiClient.chat.stream(
          {
            model: modelForCall,
            messages: buildMessages() as ChatRequestInput["messages"],
            workspaceSystemPrompt,
            workspaceId: activeWorkspaceId || undefined,
            skills: enabledSkills,
            mcpServers:
              mcpServersForRequest.length > 0
                ? mcpServersForRequest
                : undefined,
            attachments:
              attachmentsForRequest.length > 0
                ? attachmentsForRequest
                : undefined,
            referenceImage: options?.referenceImage,
            localFilesOnly: localFilesOnly || undefined,
          },
          {
            signal: controller.signal,
            backend: chatBackend,
            authToken,
          }
        )

        if (!result.ok) {
          if (result.status === 401) {
            setConversationTyping(targetConvId, false)
            markStreaming(targetConvId, false)
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
        let streamError: { code?: string; message?: string } | null = null

        // SSE frames: `data: <json>\n\n`. Placeholder created on the
        // first event of any kind so reasoning-first models still show
        // typing UI disappearing as soon as any output arrives.
        const ensurePlaceholder = () => {
          if (placeholder) return placeholder
          setConversationTyping(targetConvId, false)
          placeholder = addMessage(
            { role: "assistant", content: "" },
            targetConvId
          )
          firstChunk = false
          return placeholder
        }

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
            const parsed = translated
            if (parsed.type === "text" && typeof parsed.value === "string") {
              const p = ensurePlaceholder()
              appendToMessage(p.id, parsed.value)
            } else if (
              parsed.type === "reasoning" &&
              typeof parsed.value === "string"
            ) {
              const p = ensurePlaceholder()
              const now = Date.now()
              if (reasoningStart === null) reasoningStart = now
              reasoningLast = now
              appendToMessageReasoning(p.id, parsed.value)
            } else if (
              parsed.type === "tool_call" &&
              parsed.id &&
              parsed.name
            ) {
              const p = ensurePlaceholder()
              const id = parsed.id
              const name = parsed.name
              const argsLabel =
                typeof (parsed.args as { query?: string })?.query === "string"
                  ? (parsed.args as { query: string }).query
                  : undefined
              setLiveToolCalls((prev) => ({
                ...prev,
                [p.id]: [
                  ...(prev[p.id] ?? []),
                  { id, name, argsLabel, status: "running" },
                ],
              }))
            } else if (parsed.type === "tool_result" && parsed.id) {
              const ph = placeholder as Message | null
              if (ph) {
                const id = parsed.id
                const summary = parsed.summary
                const results = Array.isArray(parsed.results)
                  ? parsed.results.filter(
                      (r): r is {
                        title: string
                        url: string
                        snippet: string
                      } =>
                        typeof r?.title === "string" &&
                        typeof r?.url === "string" &&
                        typeof r?.snippet === "string"
                    )
                  : undefined
                setLiveToolCalls((prev) => ({
                  ...prev,
                  [ph.id]: (prev[ph.id] ?? []).map((t) =>
                    t.id === id
                      ? { ...t, status: "done", summary, results }
                      : t
                  ),
                }))
              }
            } else if (
              parsed.type === "tool_image" &&
              Array.isArray(parsed.images)
            ) {
              // generateImage produced images; the server pre-persisted
              // each URL to a durable form so the message survives reload.
              const ph = placeholder as Message | null
              if (ph) {
                const mode: "t2i" | "i2i" =
                  parsed.mode === "i2i" ? "i2i" : "t2i"
                const images = (
                  parsed.images as Array<Record<string, unknown>>
                )
                  .filter(
                    (img): img is {
                      id: string
                      url: string
                      storagePath?: string
                      width: number
                      height: number
                      format: string
                      prompt: string
                      mode: "t2i" | "i2i"
                    } =>
                      typeof img?.id === "string" &&
                      typeof img?.url === "string" &&
                      typeof img?.width === "number" &&
                      typeof img?.height === "number" &&
                      typeof img?.format === "string" &&
                      typeof img?.prompt === "string" &&
                      (img.storagePath === undefined ||
                        typeof img.storagePath === "string")
                  )
                  .map((img) => ({ ...img, mode }))
                if (images.length > 0) {
                  appendMessageGeneratedImages(ph.id, images)
                  images.forEach((img) => {
                    const title = img.prompt
                      ? img.prompt.slice(0, 80).trim()
                      : `Generated image`
                    createArtifact({
                      conversationId: targetConvId,
                      messageId: ph.id,
                      kind: "image",
                      title,
                      content: img.url,
                      storagePath: img.storagePath ?? null,
                    })
                  })
                }
              }
            } else if (
              parsed.type === "suggestions" &&
              Array.isArray(parsed.values)
            ) {
              const ph = placeholder as Message | null
              if (ph) {
                setMessageSuggestions(ph.id, parsed.values)
              }
            } else if (parsed.type === "error") {
              streamError = { code: parsed.code, message: parsed.message }
              break outer
            } else if (parsed.type === "done") {
              break outer
            }
          }
        }

        if (streamError) {
          surfaceError({
            code: (streamError.code as MessageErrorCode) || "unknown",
            model: modelForCall,
            detail: streamError.message,
          })
        } else if (firstChunk) {
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
          const liveSnapshot = liveToolCalls[ph.id] ?? []
          const persisted = liveSnapshot
            .filter((t) => t.status === "done")
            .map(({ id, name, argsLabel, summary, results }) => ({
              id,
              name,
              argsLabel,
              summary,
              ...(results && results.length > 0 ? { results } : {}),
            }))
          if (persisted.length > 0) {
            setMessageToolCalls(ph.id, persisted)
          }
        }
      } catch (err) {
        const aborted =
          (err instanceof DOMException && err.name === "AbortError") ||
          controller.signal.aborted
        const ph = placeholder as Message | null
        if (aborted) {
          if (ph && ph.content === "") {
            deleteMessage(ph.id)
          }
        } else {
          // Distinguish offline from generic network failure.
          const offline =
            typeof navigator !== "undefined" && navigator.onLine === false
          // Auto-retry-once: a transient blip on a brand-new request
          // (no placeholder content yet, online, not already a retry)
          // tries one silent recovery after 1s before surfacing the
          // error. Anything past the first chunk has visible state
          // we shouldn't duplicate or rewind, so we skip retry there.
          const phEmpty = !ph || ph.content === ""
          if (!isRetry && !offline && phEmpty) {
            if (ph) deleteMessage(ph.id)
            setConversationTyping(targetConvId, false)
            markStreaming(targetConvId, false)
            setTimeout(() => {
              callChatAPIRef.current(history, {
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
        markStreaming(targetConvId, false)
        // Drop live tool-call pills now that the stream is finished.
        // The durable record lives on the message via setMessageToolCalls.
        const ph = placeholder as Message | null
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
        // conv overwriting the slot.
        if (abortControllersRef.current.get(targetConvId) === controller) {
          abortControllersRef.current.delete(targetConvId)
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
      appendToMessage,
      appendToMessageReasoning,
      autoArchiveCodeBlocks,
      conversationFiles,
      conversations,
      createArtifact,
      deleteMessage,
      files,
      liveToolCalls,
      markStreaming,
      mockAIResponse,
      setConversationTyping,
      setMessageError,
      setMessageReasoningDuration,
      setMessageSuggestions,
      setMessageToolCalls,
      workspaces,
    ]
  )

  // Latest-version ref so the hook can call back into itself (auto-
  // retry-once) without becoming a stale closure across renders.
  const callChatAPIRef = useRef(callChatAPI)
  useEffect(() => {
    callChatAPIRef.current = callChatAPI
  }, [callChatAPI])

  // Stable wrapper — consumers don't manage their own ref.
  const send = useCallback(
    (history: Message[], options?: SendOptions): Promise<void> =>
      callChatAPIRef.current(history, options),
    []
  )

  const stop = useCallback(() => {
    // Stop only the *active* conv's stream. Other conversations
    // mid-stream stay running — each has its own controller.
    if (!activeConversationId) return
    abortControllersRef.current.get(activeConversationId)?.abort()
  }, [activeConversationId])

  const isStreaming = useCallback(
    (convId: string | null | undefined): boolean =>
      !!convId && streamingConvIds.has(convId),
    [streamingConvIds]
  )

  return { send, stop, isStreaming, streamingConvIds, liveToolCalls }
}

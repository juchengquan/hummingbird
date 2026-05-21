"use client"

import { useState, useRef, useEffect, useMemo, useCallback } from "react"
import { useChatScroll } from "@/components/panels/use-chat-scroll"
import { toast } from "sonner"
import { useStore, useHydrated } from "@/client/hooks/use-store"
import { apiClient } from "@/client/api-client"
import type { ChatRequestInput } from "@/shared/api-schemas"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupTextarea, InputGroupButton } from "@/components/ui/input-group"
import { cn } from "@/shared/utils"
import { ResourcesSidebar } from "@/components/sidebars/resources"
import { ActiveSkillsChips } from "@/components/skills/active-chips"
import { SKILLS } from "@/shared/skills/registry"
import { resolveSkill, type SkillId } from "@/shared/skills/types"
import { SmartPasteChip } from "@/components/chat/smart-paste-chip"
import { detectPasteKind, type PasteDetection } from "@/shared/smart-paste/detect"
import { ChatHeader } from "@/components/panels/chat-header"
import { ChatMessage } from "@/components/panels/chat-message"
import { EmptyChatWelcome } from "@/components/panels/empty-chat-welcome"
import { SelectionTrigger } from "@/components/selection/selection-trigger"
import { Plus, ChevronDown, Square, ArrowUp } from "lucide-react"
import { processSelectedFiles } from "@/client/file-utils"
import { runExtraction } from "@/client/extract"
import { persistFile } from "@/client/files/persist"
import { getLocalCred } from "@/client/mcp/local-creds"
import { extractCodeBlocks } from "@/shared/code-blocks"

const AUTO_ARCHIVE_MIN_LINES = 15
const AUTO_ARCHIVE_MAX_PER_MESSAGE = 3
import { FILE_SIZE_LIMIT, IMAGE_SIZE_LIMIT, ALLOWED_EXTENSIONS } from "@/shared/upload-config"
import type { Message, MessageError, MessageErrorCode } from "@/shared/types"
import type { LiveToolCall } from "@/components/skills/tool-call-strip"

export function ChatPanel() {
  const addMessage = useStore((state) => state.addMessage)
  const deleteMessage = useStore((state) => state.deleteMessage)
  const updateMessage = useStore((state) => state.updateMessage)
  const appendToMessage = useStore((state) => state.appendToMessage)
  const appendToMessageReasoning = useStore((state) => state.appendToMessageReasoning)
  const truncateMessagesAfter = useStore((state) => state.truncateMessagesAfter)
  const setMessageError = useStore((state) => state.setMessageError)
  const setMessageSuggestions = useStore((state) => state.setMessageSuggestions)
  const setMessageReasoningDuration = useStore((state) => state.setMessageReasoningDuration)
  const setMessageToolCalls = useStore((state) => state.setMessageToolCalls)
  const isTyping = useStore((state) => state.isTyping)
  const setIsTyping = useStore((state) => state.setIsTyping)
  const chatModel = useStore((state) => state.chatModel)
  const setChatModel = useStore((state) => state.setChatModel)
  const files = useStore((state) => state.files)
  const activeConversationId = useStore((state) => state.activeConversationId)
  const conversations = useStore((state) => state.conversations)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  const workspaces = useStore((state) => state.workspaces)
  const addFile = useStore((state) => state.addFile)
  const addConversationFile = useStore((state) => state.addConversationFile)
  const conversationFiles = useStore((state) => state.conversationFiles)
  const setFileExtraction = useStore((state) => state.setFileExtraction)
  const setFileStorage = useStore((state) => state.setFileStorage)
  const createArtifact = useStore((state) => state.createArtifact)
  const pinExplanation = useStore((state) => state.pinExplanation)
  const setResourcesSidebarTab = useStore((state) => state.setResourcesSidebarTab)
  const setResourcesSidebarOpen = useStore((state) => state.setResourcesSidebarOpen)
  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) || null,
    [conversations, activeConversationId]
  )
  const hydrated = useHydrated()
  const [inputValue, setInputValue] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  /**
   * Per-message live tool-call state — keyed by message id. Populated as
   * tool_call / tool_result frames arrive during a stream and cleared on
   * `done`. The durable record lives in the message text (markdown footer
   * appended by the server).
   */
  /**
   * Per-message skill mute. Skills the user clicked × on for the next
   * send only. Cleared on send (handleSendMessage) so the next turn
   * resets to the conversation/workspace effective set.
   */
  const [mutedSkillsForNext, setMutedSkillsForNext] = useState<Set<SkillId>>(
    () => new Set()
  )
  const toggleMutedSkillForNext = useCallback((id: SkillId) => {
    setMutedSkillsForNext((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /**
   * Smart-paste chip detection. Lives in component state because it's
   * a per-input ephemeral hint — never persists, clears on send or when
   * the input edits away from the detected snippet.
   */
  const [pasteDetection, setPasteDetection] = useState<PasteDetection | null>(null)

  const [liveToolCalls, setLiveToolCalls] = useState<
    Record<string, LiveToolCall[]>
  >({})
  const abortControllerRef = useRef<AbortController | null>(null)
  const inputFileRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const messages = useMemo(() => activeConversation?.messages || [], [activeConversation])

  // SelectionTrigger needs the conversation slice up to (and including)
  // the message the selection lives in. We resolve the scope attribute
  // (`message-<id>`) back into a slice of `messages` so the model
  // answers "explain this" with the right conversational context.
  const resolveSelectionContext = useCallback(
    (scope: string): typeof messages | null => {
      const prefix = "message-"
      if (!scope.startsWith(prefix)) return null
      const id = scope.slice(prefix.length)
      const idx = messages.findIndex((m) => m.id === id)
      if (idx === -1) return null
      return messages.slice(0, idx + 1)
    },
    [messages]
  )

  // Skills payload for selection-driven explanations. Uses the same
  // workspace+conversation cascade as the chat input — minus the
  // per-send mute (which is an input-bar concern, not relevant to
  // ad-hoc explain queries).
  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId),
    [workspaces, activeWorkspaceId]
  )
  const selectionSkillsPayload = useMemo(() => {
    return SKILLS.filter((s) =>
      resolveSkill(s, activeWorkspace?.skillPrefs, activeConversation?.skillPrefs)
    ).map((s) => ({ id: s.id }))
  }, [activeWorkspace, activeConversation])

  // "Quote in reply": stuff the selection into the input as a
  // markdown blockquote and focus the textarea so the user can type
  // their follow-up. Each line of the selection gets its own `>` so
  // multi-paragraph selections render cleanly.
  const handleQuoteSelection = useCallback((text: string) => {
    const quoted = text
      .trim()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")
    setInputValue((prev) => {
      const sep = prev.length === 0 || prev.endsWith("\n\n") ? "" : prev.endsWith("\n") ? "\n" : "\n\n"
      return `${prev}${sep}${quoted}\n\n`
    })
    // Focus the textarea + resize + move caret to end on the next
    // tick so the new value has been applied.
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.style.height = "auto"
      ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`
      ta.selectionStart = ta.selectionEnd = ta.value.length
    })
  }, [])

  // The most recent non-error assistant message id — only that message
  // renders follow-up suggestion chips; older ones would just be clutter.
  // Walk from the end (cheaper than reversing the whole array).
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === "assistant" && !m.error) return m.id
    }
    return null
  }, [messages])

  // Map each assistant message to the PDF that its `[p.N]` citations
  // should open. Resolved by walking forward through history and
  // remembering the most recent PDF the user attached. Memoized so the
  // map's identity is stable across unrelated renders (the chat panel
  // re-renders on isTyping / input changes; without memo, every
  // assistant message would receive a freshly-computed string from a
  // freshly-built map and React.memo on ChatMessage couldn't skip).
  const pdfByMessage = useMemo(() => {
    const out = new Map<string, string>()
    let currentPdfId: string | undefined
    for (const m of messages) {
      if (m.role === "user" && m.attachedFileIds) {
        const firstPdf = m.attachedFileIds
          .map((id) => files.find((f) => f.id === id))
          .find(
            (f) =>
              !!f &&
              !f.deletedAt &&
              (f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"))
          )
        if (firstPdf) currentPdfId = firstPdf.id
      } else if (m.role === "assistant" && currentPdfId) {
        out.set(m.id, currentPdfId)
      }
    }
    return out
  }, [messages, files])

  const { messagesEndRef, showScrollButton, scrollToBottom } = useChatScroll({
    messageCount: messages.length,
    isTyping,
  })

  // Mock fallback used when the AI Gateway key isn't configured.
  // Includes a fake reasoning block so the Thinking… UI is exercisable
  // without a live reasoning-capable model.
  const mockAIResponse = useCallback(
    (userMessage: string) => {
      setIsTyping(true)
      setTimeout(() => {
        const reasoning = [
          `User asked: "${userMessage}".`,
          "",
          "Step 1 — Parse the request: they want a brief explanation.",
          "Step 2 — Consider whether any state is relevant. The mock path doesn't actually call a model, so I'll keep this short.",
          "Step 3 — Draft a reply that makes the mock origin obvious so it isn't confused with real model output.",
        ].join("\n")
        const aiContent = `_Mock response (set \`AI_GATEWAY_API_KEY\` to enable real AI)_\n\nRegarding "${userMessage}": this is placeholder text.`
        addMessage({ role: "assistant", content: aiContent, reasoning })
        setIsTyping(false)
      }, 300)
    },
    [setIsTyping, addMessage]
  )

  // After a stream completes, auto-archive substantial code blocks so they
  // become first-class artifacts without the user having to remember the
  // Save-as-artifact button. Conservative threshold (>= AUTO_ARCHIVE_MIN_LINES)
  // and capped count keep the artifacts panel from flooding.
  const autoArchiveCodeBlocks = useCallback(
    (assistantMessage: Message) => {
      if (!activeConversationId) return
      const blocks = extractCodeBlocks(assistantMessage.content)
      const eligible = blocks.filter((b) => b.lines >= AUTO_ARCHIVE_MIN_LINES)
      if (eligible.length === 0) return
      const capped = eligible.slice(0, AUTO_ARCHIVE_MAX_PER_MESSAGE)
      capped.forEach((b, i) => {
        const lang = (b.language ?? "").toLowerCase()
        const kind = lang === "json" ? "json" : "code"
        createArtifact({
          conversationId: activeConversationId,
          messageId: assistantMessage.id,
          kind,
          language: b.language,
          title:
            capped.length === 1
              ? `Code${b.language ? ` (${b.language})` : ""}`
              : `Code ${i + 1}${b.language ? ` (${b.language})` : ""}`,
          content: b.code,
        })
      })
    },
    [activeConversationId, createArtifact]
  )

  // Build the message list and file context the API expects, sent up to and
  // including the most recent user message.
  const callChatAPI = useCallback(
    async (
      history: Message[],
      options?: { modelOverride?: string; isRetry?: boolean }
    ) => {
      // Read the model freshly from the store rather than via the closure.
      // Lets retry-after-model-change use the new value without waiting for
      // this callback's useEffect-driven ref refresh to catch up.
      const modelForCall = options?.modelOverride ?? useStore.getState().chatModel
      const isRetry = options?.isRetry ?? false
      const conv = conversations.find((c) => c.id === activeConversationId)
      const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
      const workspaceSystemPrompt = activeWorkspace?.systemPrompt?.trim() || undefined
      // Resolve which skills are effectively on for this turn so the route
      // knows which tools to register.
      // Effective set = workspace/conversation cascade minus any skills
      // the user muted for this one send via the chip × button.
      const enabledSkills = SKILLS.filter(
        (s) =>
          resolveSkill(s, activeWorkspace?.skillPrefs, conv?.skillPrefs) &&
          !mutedSkillsForNext.has(s.id)
      ).map((s) => ({ id: s.id }))
      // Merge the two lanes: workspace files ticked via `selectedFileIds`
      // plus conversation-private files joined via `conversationFiles`.
      // De-dup by `fileId` so a file in both lanes is sent once.
      const workspaceFileIds = conv?.selectedFileIds ?? []
      const privateFileIds = conv
        ? conversationFiles
            .filter((cf) => cf.conversationId === conv.id)
            .map((cf) => cf.fileId)
        : []
      const attachedFileIds = [...new Set([...workspaceFileIds, ...privateFileIds])]
      // Drop tombstoned files — they're metadata stubs only, no content to
      // ship. They still render as "removed" placeholders in the message
      // attachment chips via `MessageAttachments`, just not sent upstream.
      const attachedFiles = attachedFileIds
        .map((id) => files.find((f) => f.id === id))
        .filter((f): f is NonNullable<typeof f> => !!f && !f.deletedAt)
      const fileSummaries = attachedFiles.map((f) => ({
        name: f.name,
        size: f.size,
        type: f.type,
        text: f.extractedText,
        truncated: f.extractionTruncated,
        kind: f.extractedKind,
      }))
      // Attach images only to the most recent user message — re-sending them
      // on every turn would explode the token bill and isn't how vision
      // chats are typically structured.
      const attachedImageUrls = attachedFiles
        .filter((f) => f.extractedKind === "image" && f.imageDataUrl)
        .map((f) => f.imageDataUrl as string)
      const buildMessages = () =>
        history.map((m, i) => {
          const isLastUser =
            i === history.length - 1 && m.role === "user" && attachedImageUrls.length > 0
          if (!isLastUser) {
            return { role: m.role, content: m.content }
          }
          return {
            role: m.role,
            content: [
              { type: "text" as const, text: m.content },
              ...attachedImageUrls.map((url) => ({
                type: "image" as const,
                image: url,
              })),
            ],
          }
        })

      const controller = new AbortController()
      abortControllerRef.current = controller
      setIsTyping(true)
      setIsStreaming(true)
      let placeholder: Message | null = null
      let firstChunk = true
      // Reasoning duration capture: first/last chunk timestamps so we can
      // persist the elapsed ms on the message. Set on the first reasoning
      // chunk; refreshed on each subsequent chunk so the difference at
      // stream end equals total reasoning time.
      let reasoningStart: number | null = null
      let reasoningLast: number | null = null

      const surfaceError = (error: MessageError) => {
        setIsTyping(false)
        if (placeholder) {
          setMessageError(placeholder.id, error)
        } else {
          const created = addMessage({ role: "assistant", content: "" })
          setMessageError(created.id, error)
        }
      }

      // Bundle the enabled MCP servers for this workspace into the
      // chat payload. For each local-mode server we attach the
      // credential straight from `localStorage` — it never lives in
      // any store partition that syncs. Cloud-mode servers stay out
      // of the body for now (Stage 3 will let the server look them
      // up via Supabase + pgcrypto).
      const mcpStore = useStore.getState()
      const mcpServersForRequest = mcpStore.mcpServers
        .filter(
          (s) =>
            s.workspaceId === activeWorkspaceId &&
            !s.deletedAt &&
            s.enabled &&
            s.credentialMode === "local" &&
            // Only ship servers with at least one discovered tool —
            // empty capability lists are noise.
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

      // Resolve which MCP resources are attached to this turn. Union of:
      //   - Workspace-ticked (`selectedMcpResourceIds` on the conv)
      //   - Conversation-pinned (`conversationMcpResources`)
      // De-duped by resource id. Server fetches content via the
      // appropriate MCP server.
      const workspaceMcpIds = conv?.selectedMcpResourceIds ?? []
      const privateMcpIds = conv
        ? mcpStore.conversationMcpResources
            .filter((cmr) => cmr.conversationId === conv.id)
            .map((cmr) => cmr.resourceId)
        : []
      const attachedMcpResourceIds = [
        ...new Set([...workspaceMcpIds, ...privateMcpIds]),
      ]
      const mcpResourcesForRequest = attachedMcpResourceIds
        .map((id) => mcpStore.mcpResources.find((r) => r.id === id))
        .filter(
          (r): r is NonNullable<typeof r> => !!r && !r.deletedAt
        )
        .map((r) => ({
          id: r.id,
          serverId: r.serverId,
          uri: r.uri,
          name: r.name,
          mimeType: r.mimeType,
        }))

      try {
        const result = await apiClient.chat.stream(
          {
            model: modelForCall,
            messages: buildMessages() as ChatRequestInput["messages"],
            files: fileSummaries,
            workspaceSystemPrompt,
            workspaceId: activeWorkspaceId || undefined,
            skills: enabledSkills,
            mcpServers: mcpServersForRequest.length > 0 ? mcpServersForRequest : undefined,
            mcpResources:
              mcpResourcesForRequest.length > 0 ? mcpResourcesForRequest : undefined,
          },
          { signal: controller.signal }
        )

        if (!result.ok) {
          if (result.status === 401) {
            setIsTyping(false)
            setIsStreaming(false)
            const lastUser = [...history].reverse().find((m) => m.role === "user")
            if (lastUser) mockAIResponse(lastUser.content)
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

        // Server emits SSE frames: `data: <json>\n\n`. The payload is one of:
        //   { type: 'text',      value: string }
        //   { type: 'reasoning', value: string }
        //   { type: 'error',     code: string, message: string }
        //   { type: 'done' }
        // We parse line-by-line and dispatch text vs reasoning into the
        // placeholder. The placeholder is created on the first event of
        // either kind, so reasoning-first models still show typing UI
        // disappearing as soon as any output arrives.
        const ensurePlaceholder = () => {
          if (placeholder) return placeholder
          setIsTyping(false)
          placeholder = addMessage({ role: "assistant", content: "" })
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
            let parsed: {
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
            }
            try {
              parsed = JSON.parse(payload)
            } catch {
              continue
            }
            if (parsed.type === "text" && typeof parsed.value === "string") {
              const p = ensurePlaceholder()
              appendToMessage(p.id, parsed.value)
            } else if (parsed.type === "reasoning" && typeof parsed.value === "string") {
              const p = ensurePlaceholder()
              const now = Date.now()
              if (reasoningStart === null) reasoningStart = now
              reasoningLast = now
              appendToMessageReasoning(p.id, parsed.value)
            } else if (parsed.type === "tool_call" && parsed.id && parsed.name) {
              const p = ensurePlaceholder()
              const id = parsed.id
              const name = parsed.name
              const argsLabel = typeof (parsed.args as { query?: string })?.query === "string"
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
                // Validate at the boundary — server should always produce
                // complete entries but JSON-over-the-wire is `unknown` to TS.
                const results = Array.isArray(parsed.results)
                  ? parsed.results
                      .filter(
                        (r): r is { title: string; url: string; snippet: string } =>
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
            } else if (parsed.type === "suggestions" && Array.isArray(parsed.values)) {
              // Same TS-can't-narrow-through-closure issue as the catch
              // below; restore what we know with a cast.
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
        } else if (placeholder && activeConversationId) {
          const ph = placeholder as Message
          autoArchiveCodeBlocks(ph)
          // Persist reasoning duration so the "Thought for X.Xs" badge
          // survives reload. Captured during the stream; written here so
          // we only commit on successful completion.
          if (reasoningStart !== null && reasoningLast !== null) {
            setMessageReasoningDuration(
              ph.id,
              Math.max(0, reasoningLast - reasoningStart)
            )
          }
          // Flush the live tool-call buffer onto the message so the pill
          // survives reload. We drop the in-flight (running) entries: a
          // tool that never returned doesn't belong in the durable record.
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
        // TS can't narrow `placeholder` through the SSE loop's nested
        // ensurePlaceholder closure; the type assertion just restores
        // what we already know.
        const ph = placeholder as Message | null
        if (aborted) {
          if (ph && ph.content === "") {
            deleteMessage(ph.id)
          }
        } else {
          // Distinguish offline from generic network failure — gives the
          // user a concrete next action (reconnect) instead of "Network error".
          const offline = typeof navigator !== "undefined" && navigator.onLine === false
          // Auto-retry-once: a transient blip on a brand-new request (no
          // placeholder content yet, online, not already a retry) tries one
          // silent recovery after 1s before surfacing the error to the user.
          // Anything past the first chunk has visible state we shouldn't
          // duplicate or rewind, so we skip the retry there.
          const phEmpty = !ph || ph.content === ""
          if (!isRetry && !offline && phEmpty) {
            if (ph) deleteMessage(ph.id)
            setIsTyping(false)
            setIsStreaming(false)
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
        setIsTyping(false)
        setIsStreaming(false)
        // Drop live tool-call pills now that the stream is finished. The
        // markdown footer the server appended carries the durable record.
        const ph = placeholder as Message | null
        if (ph) {
          setLiveToolCalls((prev) => {
            if (!(ph.id in prev)) return prev
            const next = { ...prev }
            delete next[ph.id]
            return next
          })
        }
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null
        }
      }
    },
    [
      activeConversationId,
      activeWorkspaceId,
      addMessage,
      appendToMessage,
      appendToMessageReasoning,
      autoArchiveCodeBlocks,
      conversationFiles,
      conversations,
      deleteMessage,
      files,
      liveToolCalls,
      mockAIResponse,
      mutedSkillsForNext,
      setIsTyping,
      setMessageError,
      setMessageReasoningDuration,
      setMessageToolCalls,
      setMessageSuggestions,
      workspaces,
    ]
  )

  const callChatAPIRef = useRef(callChatAPI)
  useEffect(() => {
    callChatAPIRef.current = callChatAPI
  }, [callChatAPI])

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort()
  }, [])

  const handleAttachClick = useCallback(() => {
    inputFileRef.current?.click()
  }, [])

  const handleFileSelected = useCallback(
    (list: FileList | null) => {
      // The chat input's `+` button attaches files to the
      // conversation-private lane — they live and die with this chat
      // and don't pollute the workspace library. Users who want a file
      // available across every conversation in the workspace upload via
      // the "Workspace files" section in the resources panel instead.
      if (!activeConversationId) return
      const processed = processSelectedFiles(list, {
        maxSize: FILE_SIZE_LIMIT,
        maxImageSize: IMAGE_SIZE_LIMIT,
        onValidationError: (err) => toast.error(err),
      })
      processed.forEach(({ meta, source }) => {
        addFile(meta)
        addConversationFile(activeConversationId, meta.id)
        void runExtraction(meta.id, source, setFileExtraction)
        // Persist the raw blob in parallel with extraction. Result lands
        // on the store via `setFileStorage` so cross-device sync can
        // include the `storage_path`.
        void persistFile(source, meta.id, meta.name).then((result) => {
          if (result.storagePath) {
            setFileStorage(meta.id, { storagePath: result.storagePath })
          }
        })
      })
      if (processed.length > 0) {
        toast.success(
          `Attached ${processed.length} file${processed.length === 1 ? "" : "s"}`
        )
      }
      if (inputFileRef.current) inputFileRef.current.value = ""
    },
    [
      activeConversationId,
      addFile,
      addConversationFile,
      setFileExtraction,
      setFileStorage,
    ]
  )

  const handleSendMessage = () => {
    if (!inputValue.trim() || isStreaming) return

    const messageContent = inputValue.trim()
    // Snapshot every attached file onto the message — both lanes — so
    // the chat scroll shows a visible record of what was attached.
    // Without this the attachments are invisible after the send (the
    // model still sees the image/text, but the user has no way to
    // remember what they sent).
    const conv = conversations.find((c) => c.id === activeConversationId)
    const workspaceIds = conv?.selectedFileIds ?? []
    const privateIds = conv
      ? conversationFiles
          .filter((cf) => cf.conversationId === conv.id)
          .map((cf) => cf.fileId)
      : []
    const snapshotIdsRaw = [...new Set([...workspaceIds, ...privateIds])]
    const snapshotIds = snapshotIdsRaw.length > 0 ? snapshotIdsRaw : undefined
    const userMessage = addMessage({
      role: "user",
      content: messageContent,
      attachedFileIds: snapshotIds,
    })

    setInputValue("")
    // Per-message skill mutes were for this one send — reset.
    if (mutedSkillsForNext.size > 0) setMutedSkillsForNext(new Set())
    if (pasteDetection) setPasteDetection(null)

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }

    const history = [...messages, userMessage]
    callChatAPIRef.current(history)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  const handleEditUserMessage = useCallback(
    (messageId: string, newContent: string) => {
      const conv = conversations.find((c) => c.id === activeConversationId)
      if (!conv) return
      const idx = conv.messages.findIndex((m) => m.id === messageId)
      if (idx === -1) return

      updateMessage(messageId, newContent)
      truncateMessagesAfter(messageId)

      const newHistory = [
        ...conv.messages.slice(0, idx),
        { ...conv.messages[idx], content: newContent },
      ]
      callChatAPIRef.current(newHistory)
    },
    [conversations, activeConversationId, updateMessage, truncateMessagesAfter]
  )

  const handleRegenerateAssistantMessage = useCallback(
    (messageId: string) => {
      const conv = conversations.find((c) => c.id === activeConversationId)
      if (!conv) return
      const idx = conv.messages.findIndex((m) => m.id === messageId)
      if (idx <= 0) return
      truncateMessagesAfter(messageId, true)
      const newHistory = conv.messages.slice(0, idx)
      callChatAPIRef.current(newHistory)
    },
    [conversations, activeConversationId, truncateMessagesAfter]
  )

  const forkConversation = useStore((s) => s.forkConversation)
  const handleForkFromMessage = useCallback(
    (messageId: string) => {
      if (!activeConversationId) return
      const fork = forkConversation(activeConversationId, messageId)
      if (fork) {
        toast.success("Branched into a new chat")
      }
    },
    [activeConversationId, forkConversation]
  )

  const handleRetryErrorMessage = useCallback(
    (messageId: string, modelOverride?: string) => {
      const conv = conversations.find((c) => c.id === activeConversationId)
      if (!conv) return
      const idx = conv.messages.findIndex((m) => m.id === messageId)
      if (idx === -1) return
      const newHistory = conv.messages.slice(0, idx)
      deleteMessage(messageId)
      callChatAPIRef.current(newHistory, modelOverride ? { modelOverride } : undefined)
    },
    [conversations, activeConversationId, deleteMessage]
  )

  // Picker may be opened from the bottom select OR from an error bubble's
  // "Change model" button. When opened from a bubble, the user expects the
  // retry to fire automatically after they pick. This ref records which
  // message to retry; cleared on selection or on plain dismissal.
  const pendingRetryRef = useRef<string | null>(null)

  const handleChangeModel = useCallback((messageId?: string) => {
    pendingRetryRef.current = messageId ?? null
    setModelPickerOpen(true)
  }, [])

  const handleModelPick = useCallback(
    (modelId: string) => {
      setChatModel(modelId)
      const retryId = pendingRetryRef.current
      pendingRetryRef.current = null
      if (retryId) {
        handleRetryErrorMessage(retryId, modelId)
      }
    },
    [setChatModel, handleRetryErrorMessage]
  )

  const handleTryFallback = useCallback(
    (messageId: string, fallbackModelId: string) => {
      setChatModel(fallbackModelId)
      handleRetryErrorMessage(messageId, fallbackModelId)
    },
    [setChatModel, handleRetryErrorMessage]
  )

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value
    setInputValue(next)
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`
    }
    // Auto-dismiss the smart-paste chip if the user has edited the input
    // enough that the originally-pasted snippet is no longer present.
    if (pasteDetection && !next.includes(pasteDetection.snippet.slice(0, 80))) {
      setPasteDetection(null)
    }
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData("text")
    if (!pasted) return
    // Only show the chip when the paste *is* the input (or close to it).
    // If the user is pasting into an existing draft, the chip's "replace
    // input" semantics would be surprising — bail in that case.
    const ta = e.currentTarget
    const existing = ta.value.trim()
    if (existing.length > 0 && !pasted.includes(existing) && !existing.includes(pasted.slice(0, 40))) {
      return
    }
    const detection = detectPasteKind(pasted)
    if (detection) {
      setPasteDetection(detection)
    }
  }

  const applyPasteAction = (prompt: string) => {
    setInputValue(prompt)
    setPasteDetection(null)
    if (textareaRef.current) {
      // Refocus and resize after the state has flushed.
      requestAnimationFrame(() => {
        const ta = textareaRef.current
        if (!ta) return
        ta.focus()
        ta.style.height = "auto"
        ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`
        ta.selectionStart = ta.selectionEnd = ta.value.length
      })
    }
  }

  const pickSuggestion = useCallback((text: string) => {
    setInputValue(text)
    // Focus + place caret at end so the user can immediately keep typing.
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(ta.value.length, ta.value.length)
      ta.style.height = "auto"
      ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`
    })
  }, [])

  if (!activeConversation) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="text-center text-[var(--muted-foreground)]">
          <p className="text-lg mb-2">No conversation selected</p>
          <p className="text-sm">Select a conversation or start a new session</p>
        </div>
      </div>
    )
  }

  // Don't render messages until hydrated to avoid hydration mismatch
  if (!hydrated) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="text-center text-[var(--muted-foreground)]">
          <p className="text-sm">Loading...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* Messages column */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0 relative">
        <ChatHeader
          chatModel={chatModel}
          onModelPick={handleModelPick}
          modelPickerOpen={modelPickerOpen}
          onModelPickerOpenChange={(open) => {
            setModelPickerOpen(open)
            // Drop pending-retry intent if the user dismisses the picker
            // without selecting (closing without picking shouldn't trigger
            // a retry on the next plain model change).
            if (!open) pendingRetryRef.current = null
          }}
        />
        <div className="flex-1 min-h-0 overflow-hidden">
          <ScrollArea
            className="max-w-5xl mx-auto max-h-[calc(100vh-2.75rem)] h-[calc(100vh-2.75rem)] px-4"
          >
            <div className="max-w-5xl mx-auto px-4 py-4 pb-44 space-y-4">
              {messages.length === 0 ? (
                <EmptyChatWelcome onPickSuggestion={pickSuggestion} />
              ) : (
                messages.map((message, index) => (
                    <ChatMessage
                      key={message.id}
                      message={message}
                      index={index}
                      isLastAssistant={message.id === lastAssistantId}
                      liveToolCalls={liveToolCalls[message.id]}
                      pdfCitationFileId={pdfByMessage.get(message.id)}
                      onDelete={deleteMessage}
                      onEditUserMessage={handleEditUserMessage}
                      onRegenerateAssistantMessage={handleRegenerateAssistantMessage}
                      onForkFromMessage={handleForkFromMessage}
                      onRetryError={handleRetryErrorMessage}
                      onChangeModel={handleChangeModel}
                      onTryFallback={handleTryFallback}
                      onPickSuggestion={pickSuggestion}
                    />
                  ))
              )}

              {/* Typing indicator */}
              {isTyping && (
                <div className="flex">
                  <div className="bg-[var(--secondary)] rounded-lg px-4 py-3">
                    <div className="flex gap-1">
                      <span className="w-2 h-2 bg-[var(--muted-foreground)] rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-2 h-2 bg-[var(--muted-foreground)] rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-2 h-2 bg-[var(--muted-foreground)] rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>
        </div>

        {/* Scroll to bottom button — only shown when the user has scrolled
            meaningfully off the bottom (>300px). Positioned above the input
            bar so it doesn't overlap the textarea. */}
        {showScrollButton && (
          <Button
            variant="secondary"
            size="icon"
            className="absolute bottom-32 left-1/2 -translate-x-1/2 rounded-full shadow-md animate-scroll-button-in z-10"
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
          >
            <ChevronDown size={18} />
          </Button>
        )}

        {/* Gradient fade above the input — masks messages as they approach
            the bottom so the pill + tagline don't need opaque backdrops.
            The bottom 40% stays fully solid (covers the tagline area and
            the lower portion of the pill); above that it fades to
            transparent so messages still feel like they're scrolling
            into the input area rather than being abruptly cut. Same
            pattern as ChatGPT / Claude.ai. */}
        <div className="absolute bottom-0 inset-x-0 h-40 bg-gradient-to-t from-[var(--background)] from-40% to-transparent pointer-events-none" />

        {/* Input Bar — wrapper handles positioning only and stays
            transparent on the sides so the messages-column scrollbar isn't
            covered. The pill is the integral floating element; the tagline
            sits below the pill as plain text — the gradient above masks
            messages so neither needs its own opaque strip. */}
        <div className="absolute bottom-3 inset-x-0 px-4 animate-input-bar-in pointer-events-none">
          <input
            ref={inputFileRef}
            type="file"
            multiple
            accept={ALLOWED_EXTENSIONS.join(",")}
            className="hidden"
            onChange={(e) => handleFileSelected(e.target.files)}
          />
          <div className="max-w-3xl mx-auto pointer-events-auto bg-[var(--background)] rounded-3xl border border-[var(--border)] p-2 shadow-sm">
            <ActiveSkillsChips
              className="px-1 pb-1"
              mutedForNext={mutedSkillsForNext}
              onToggleMuted={toggleMutedSkillForNext}
            />
            {pasteDetection && (
              <div className="px-1 pb-1">
                <SmartPasteChip
                  detection={pasteDetection}
                  onApply={applyPasteAction}
                  onDismiss={() => setPasteDetection(null)}
                />
              </div>
            )}
            <InputGroup className="bg-transparent border-none shadow-none rounded-none">
            <InputGroupButton
              size="icon-sm"
              onClick={handleAttachClick}
              className="ml-2 rounded-full transition-transform hover:scale-110 active:scale-95"
              aria-label="Attach files to this conversation"
              title="Attach files"
            >
              <Plus size={20} />
            </InputGroupButton>
            <InputGroupTextarea
              ref={textareaRef}
              value={inputValue}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Ask me anything!"
              rows={1}
              className="min-h-[44px] max-h-[160px] m-2 transition-all focus:outline-none focus:ring-2 focus:ring-primary/30"
              style={{
                scrollbarColor: "var(--muted-foreground) transparent",
              }}
            />
            {/* Right-side button slot — fixed width / position so the
                buttons fade IN PLACE (no width animation that would make
                them appear to grow). Both buttons always rendered and
                overlapped; only opacity transitions. */}
            {(() => {
              const showStop = isStreaming
              const showSend = !isStreaming && inputValue.trim().length > 0
              return (
                <div className="relative h-8 w-8 mr-2 shrink-0">
                  <InputGroupButton
                    size="icon-sm"
                    onClick={handleStop}
                    aria-label="Stop generating"
                    aria-hidden={!showStop}
                    tabIndex={showStop ? 0 : -1}
                    title="Stop"
                    className={cn(
                      "absolute inset-0 rounded-full bg-[var(--destructive)]/10 text-[var(--destructive)] hover:bg-[var(--destructive)]/20 transition-opacity duration-200",
                      showStop
                        ? "opacity-100 pointer-events-auto"
                        : "opacity-0 pointer-events-none"
                    )}
                  >
                    <Square size={14} fill="currentColor" />
                  </InputGroupButton>
                  <InputGroupButton
                    size="icon-sm"
                    onClick={handleSendMessage}
                    aria-label="Send message"
                    aria-hidden={!showSend}
                    tabIndex={showSend ? 0 : -1}
                    title="Send (Enter)"
                    className={cn(
                      "absolute inset-0 rounded-full bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground transition-opacity duration-200",
                      showSend
                        ? "opacity-100 pointer-events-auto"
                        : "opacity-0 pointer-events-none"
                    )}
                  >
                    <ArrowUp size={16} />
                  </InputGroupButton>
                </div>
              )
            })()}
          </InputGroup>
          </div>
          {/* Tagline — plain text, centered below the pill. No backdrop
              needed because the gradient above already masks messages. */}
          <p className="max-w-3xl mx-auto mt-2 text-center text-[11px] text-[var(--muted-foreground)] italic">
            AI is not a silver bullet!
          </p>
        </div>
      </div>

      {/* Selection-driven actions (Phase 1: desktop only) — floating
          toolbar + Explain popover. Mounted once per chat view; manages
          its own visibility based on the current text selection. */}
      <SelectionTrigger
        resolveContext={resolveSelectionContext}
        chatModel={chatModel}
        workspaceSystemPrompt={activeWorkspace?.systemPrompt}
        skills={selectionSkillsPayload}
        onQuote={handleQuoteSelection}
        onPin={(input) => {
          if (!activeConversationId) return
          pinExplanation({
            conversationId: activeConversationId,
            selection: input.selection,
            content: input.content,
            model: input.model,
            results: input.results.length > 0 ? input.results : undefined,
          })
          // Auto-switch the right rail to the Pins tab + open it so
          // the user sees the pinned card without hunting for it.
          setResourcesSidebarTab("pins")
          setResourcesSidebarOpen(true)
        }}
      />

      {/* Resources side panel */}
      <ResourcesSidebar />
    </div>
  )
}

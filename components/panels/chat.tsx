"use client"

import { useState, useRef, useEffect, useMemo, useCallback, useDeferredValue } from "react"
import { useChatScroll } from "@/components/panels/use-chat-scroll"
import { toast } from "sonner"
import { useStore, useHydrated, useIsConversationTyping } from "@/client/hooks/use-store"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupTextarea, InputGroupButton } from "@/components/ui/input-group"
import { cn } from "@/shared/utils"
import { ResourcesSidebar } from "@/components/sidebars/resources"
import { TasksSidebar } from "@/components/sidebars/tasks"
import { useTaskRunContext } from "@/client/agent/task-run-context"
import { ContextPicker } from "@/components/chat/context-picker"
import { SlashAutocomplete } from "@/components/panels/slash-autocomplete"
import { SlashHelpDialog } from "@/components/panels/slash-help-dialog"
import { AgentsDialog } from "@/components/panels/agents-dialog"
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog"
import { SKILLS } from "@/shared/skills/registry"
import { resolveSkill, type SkillId } from "@/shared/skills/types"
import { resolveSlash } from "@/shared/slash-resolver"
import { useSlashCommands } from "@/client/hooks/use-slash-commands"
import { TASK_MODES, type TaskModeId } from "@/shared/task-modes/registry"
import { resolveAgent } from "@/shared/agents/resolve"
import { PromptVariableFill } from "@/components/panels/prompt-variable-fill"
import { SmartPasteChip } from "@/components/chat/smart-paste-chip"
import { ChatHeader } from "@/components/panels/chat-header"
import { ChatMessage } from "@/components/panels/chat-message"
import { EmptyChatWelcome } from "@/components/panels/empty-chat-welcome"
import { SelectionTrigger } from "@/components/selection/selection-trigger"
import { ChevronDown, Square, ArrowUp, Repeat2, X, Loader2, ChevronRight } from "lucide-react"
import { processSelectedFiles } from "@/client/file-utils"
import { runExtraction } from "@/client/extract"
import { persistFile } from "@/client/files/persist"

import { useChatSend } from "@/client/hooks/use-chat-send"
import { useChatDropzone } from "@/client/hooks/use-chat-dropzone"
import { useSmartPaste } from "@/client/hooks/use-smart-paste"
import { useSlashAutocomplete } from "@/client/hooks/use-slash-autocomplete"
import { usePromptMentionAutocomplete } from "@/client/hooks/use-prompt-mention-autocomplete"
import { FILE_SIZE_LIMIT, IMAGE_SIZE_LIMIT, ALLOWED_EXTENSIONS } from "@/shared/upload-config"
import type { Agent } from "@/shared/types"

export function ChatPanel() {
  const addMessage = useStore((state) => state.addMessage)
  const deleteMessage = useStore((state) => state.deleteMessage)
  const updateMessage = useStore((state) => state.updateMessage)
  const truncateMessagesAfter = useStore((state) => state.truncateMessagesAfter)
  // Per-conversation typing flag is sourced from `useChatSend` /
  // `useIsConversationTyping` below.
  const pendingReferenceImage = useStore(
    (state) => state.pendingReferenceImage
  )
  const setPendingReferenceImage = useStore(
    (state) => state.setPendingReferenceImage
  )
  const chatModel = useStore((state) => state.chatModel)
  const setChatModel = useStore((state) => state.setChatModel)
  const files = useStore((state) => state.files)
  const activeConversationId = useStore((state) => state.activeConversationId)
  const conversations = useStore((state) => state.conversations)
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId)
  const activeAgentId = useStore((state) => state.activeAgentId)
  const workspaces = useStore((state) => state.workspaces)
  const addFile = useStore((state) => state.addFile)
  const addConversationFile = useStore((state) => state.addConversationFile)
  const conversationFiles = useStore((state) => state.conversationFiles)
  const setFileExtraction = useStore((state) => state.setFileExtraction)
  const setFileStorage = useStore((state) => state.setFileStorage)
  const pinExplanation = useStore((state) => state.pinExplanation)
  const setResourcesSidebarTab = useStore((state) => state.setResourcesSidebarTab)
  const setResourcesSidebarOpen = useStore((state) => state.setResourcesSidebarOpen)
  const setTasksPanelOpen = useStore((state) => state.setTasksPanelOpen)
  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) || null,
    [conversations, activeConversationId]
  )
  const hydrated = useHydrated()
  const [inputValue, setInputValue] = useState("")
  // Send pipeline lives in its own hook (see lib/client/hooks/use-chat-send).
  // The hook owns the abort-controller map, the streaming-conv-ids Set,
  // the live tool-call buffer, and `mockAIResponse` — what used to be
  // the ~620-line callChatAPI callback on this component. Destructure
  // the stable members so callbacks can depend on `send`/`stop`
  // directly without re-creating on every render.
  const {
    send: chatSendMessage,
    stop: chatStop,
    isStreaming: isConversationStreaming,
    liveToolCalls: chatLiveToolCalls,
  } = useChatSend()
  const isStreaming = isConversationStreaming(activeConversationId)
  const isTyping = useIsConversationTyping(activeConversationId)
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
  // ContextPicker open state is lifted here so the inline preview's
  // overflow chip can trigger the popover via the same handle.
  const [contextPickerOpen, setContextPickerOpen] = useState(false)
  // File drop overlay for the chat input card — state + drag handlers
  // owned by `useChatDropzone`. The ingestion callback is
  // `handleFileSelected` (the same one the `+`-button picker uses).
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
   * Smart-paste chip — paste-detection state + the paste event handler
   * + the auto-dismiss-on-input rule live in `useSmartPaste`; this
   * panel keeps the apply action (it touches the textarea ref and
   * `setInputValue`, which are panel concerns).
   */
  const smartPaste = useSmartPaste()

  // Personas live alongside skills + commands + modes in the slash
  // surface (`PLAN-custom-agents.md`). Pass the active workspace's
  // non-deleted personas in so the resolver + autocomplete can pick
  // up `/<slug>` triggers. Used by both the slash autocomplete and the
  // send-time `resolveSlash`.
  const allAgents = useStore((s) => s.agents)
  const workspaceAgents = useMemo(
    () =>
      allAgents.filter(
        (a) => a.workspaceId === activeWorkspaceId && !a.deletedAt
      ),
    [allAgents, activeWorkspaceId]
  )

  // The `/` action-command runtime (`/new`, `/clear`, `/model`, …). Owns
  // its own confirm + help + personas dialogs, rendered below. Stays in
  // the panel because the send path and those dialogs use it too.
  const slashCommands = useSlashCommands({
    openModelPicker: () => setModelPickerOpen(true),
    isStreaming,
  })

  const prompts = useStore((state) => state.prompts)

  const inputFileRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /**
   * The `/` slash-command and `@` prompt-mention autocomplete menus.
   * Each hook owns its highlighted-row index, Escape-dismiss flag,
   * derived match set, and keyboard navigation (shared
   * `navigateAutocomplete` reducer). They're mutually exclusive — each
   * needs its own leading char. The pick side-effects that touch the
   * textarea / input stay here as injected callbacks.
   */
  const slash = useSlashAutocomplete({
    inputValue,
    agents: workspaceAgents,
    runCommand: (id) => slashCommands.run(id, ""),
    setInputValue,
    focusInput: () => textareaRef.current?.focus(),
  })
  const mention = usePromptMentionAutocomplete({
    inputValue,
    prompts,
    setInputValue,
    // Programmatic value changes bypass the Textarea's onChange-driven
    // auto-grow, so run the same rAF resize the other programmatic input
    // writes use, and move the caret to the end.
    resizeInput: () => {
      requestAnimationFrame(() => {
        const ta = textareaRef.current
        if (!ta) return
        ta.focus()
        ta.style.height = "auto"
        ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`
        ta.selectionStart = ta.selectionEnd = ta.value.length
      })
    },
  })

  const messages = useMemo(() => activeConversation?.messages || [], [activeConversation])
  // `useDeferredValue` lets React render the message list at lower
  // priority when the main thread is busy (typing in the input,
  // scrolling, an unrelated panel updating). Streaming SSE frames
  // append to `messages` many times per second; deferring keeps the
  // composer input responsive while assistant text catches up at
  // its own pace. Identity-stable when nothing changes — no extra
  // renders triggered.
  const deferredMessages = useDeferredValue(messages)

  // Long-running task mode. The provider owns the active run; this
  // panel reads `runAsTask` / `isRunning` for the header toggle. The
  // send hook holds its own ref for `startTask` (see useChatSend).
  const taskRun = useTaskRunContext()

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

  // Pending-input subscription — sidebar prompt clicks (and any future
  // surface that wants to seed the input) push a string through
  // `useStore.pendingChatInput`. When it's non-null, copy to local
  // input state, focus the textarea, then clear the store so the same
  // string can be inserted again later without dedup confusion.
  const pendingChatInput = useStore((s) => s.pendingChatInput)
  const setPendingChatInput = useStore((s) => s.setPendingChatInput)
  useEffect(() => {
    if (pendingChatInput === null) return
    setInputValue(pendingChatInput)
    setPendingChatInput(null)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.style.height = "auto"
      ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`
      ta.selectionStart = ta.selectionEnd = ta.value.length
    })
  }, [pendingChatInput, setPendingChatInput])

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
    // Build the id→file index once instead of doing a linear scan
    // per attached file id (was O(messages × files × ids)).
    const filesById = new Map<string, (typeof files)[number]>()
    for (const f of files) filesById.set(f.id, f)
    const out = new Map<string, string>()
    let currentPdfId: string | undefined
    for (const m of messages) {
      if (m.role === "user" && m.attachedFileIds) {
        for (const id of m.attachedFileIds) {
          const f = filesById.get(id)
          if (
            f &&
            !f.deletedAt &&
            (f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"))
          ) {
            currentPdfId = f.id
            break
          }
        }
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

  // File-drop overlay — bound to the same ingestion callback as the
  // `+`-button picker, so drop and pick share one path.
  const dropzone = useChatDropzone({ onFiles: handleFileSelected })

  const handleSendMessage = () => {
    if (!inputValue.trim() || isStreaming) return
    // v1 runs a single task at a time — block a second launch while one
    // is in flight (the panel shows the active run + a Cancel button).
    if (taskRun.runAsTask && taskRun.isRunning) {
      toast.error("A task is already running. Cancel it first.")
      return
    }

    const trimmed = inputValue.trim()
    // Resolve a leading `/` directive. A **command** runs now and does
    // NOT send a message; a **skill** forces a capability on and is
    // stripped from the visible message; a **task_mode** forces a
    // task-mode launch (`/research <goal>` → research-mode task);
    // an **agent** applies the persona's recipe and pins the persona
    // for the turn (`PLAN-custom-agents.md`).
    const slash = resolveSlash(trimmed, { agents: workspaceAgents })
    if (slash?.kind === "command") {
      slashCommands.run(slash.commandId, slash.arg)
      setInputValue("")
      if (textareaRef.current) textareaRef.current.style.height = "auto"
      return // ← no message added, no API call
    }
    let taskModeForCall: TaskModeId | undefined
    let forcedSkillIds: SkillId[] | undefined
    let messageContent: string
    let activeAgentForCall: Agent | null = null
    if (slash?.kind === "task_mode") {
      taskModeForCall = slash.modeId
      const descriptor = TASK_MODES.find((m) => m.id === slash.modeId)
      forcedSkillIds = descriptor?.forcedSkillIds
      messageContent = slash.goal
    } else if (slash?.kind === "skill") {
      forcedSkillIds = [slash.skillId]
      messageContent = slash.remainder
    } else if (slash?.kind === "agent") {
      activeAgentForCall = workspaceAgents.find((a) => a.id === slash.agentId) ?? null
      messageContent = slash.remainder
    } else {
      messageContent = trimmed
    }
    // If no /<persona> for this turn but a persona is pinned via the
    // chat-header (`activeAgentId`), apply the pinned recipe.
    if (!activeAgentForCall && activeAgentId) {
      activeAgentForCall =
        workspaceAgents.find((a) => a.id === activeAgentId) ?? null
    }
    if (activeAgentForCall) {
      const resolved = resolveAgent(activeAgentForCall)
      forcedSkillIds = [
        ...(forcedSkillIds ?? []),
        ...resolved.forcedSkillIds.filter(
          (s) => !forcedSkillIds?.includes(s as SkillId)
        ),
      ] as SkillId[]
    }
    // `/search ` with no query is a no-op (don't send an empty turn);
    // the user is mid-compose. The send button stays available.
    if (!messageContent) return
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
    // Per-message skill mutes were for this one send — snapshot before
    // the clear so the pipeline below still sees the user's choices for
    // *this* turn, then reset so the next turn falls back to the
    // workspace/conversation cascade.
    const mutedForThisTurn = new Set(mutedSkillsForNext)
    if (mutedSkillsForNext.size > 0) setMutedSkillsForNext(new Set())
    if (smartPaste.detection) smartPaste.dismiss()
    // Snapshot the remix reference and clear it — one-shot semantics.
    // The chip disappears immediately; the in-flight request still gets
    // the URL via the hook's `options.referenceImage` arg.
    const pendingRef = useStore.getState().pendingReferenceImage
    if (pendingRef) useStore.getState().setPendingReferenceImage(null)

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }

    const history = [...messages, userMessage]
    const agentResolved = activeAgentForCall ? resolveAgent(activeAgentForCall) : null
    chatSendMessage(history, {
      referenceImage: pendingRef ? { url: pendingRef.url } : undefined,
      forcedSkillIds,
      mutedSkillIds: mutedForThisTurn,
      // `/research <goal>` forces task mode on for this turn even if
      // the chat-input toggle is off — the mode is the meaningful
      // signal, not the toggle.
      asTask: taskRun.runAsTask || !!taskModeForCall,
      taskMode: taskModeForCall,
      // Persona overrides for this turn (`PLAN-custom-agents.md`).
      // Persona modelId beats the chat-input's session-picked model;
      // persona system prompt is appended after the workspace's;
      // persona MCP allow-list narrows the cloud-mode server set
      // (Phase 2 — server-side enforcement in `loadEffectiveMcpServers`).
      modelOverride: agentResolved?.modelId,
      agentSystemPrompt: agentResolved?.systemPrompt,
      allowedMcpServerIds:
        agentResolved?.allowedMcpServerIds ?? undefined,
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // The autocomplete menus get first crack at the nav keys; each
    // returns true once it consumes the key so it drives its highlight /
    // pick / dismiss instead of the textarea or send. They're mutually
    // exclusive (each needs its own leading char), so at most one fires.
    if (slash.onKeyDown(e)) return
    if (mention.onKeyDown(e)) return
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
      chatSendMessage(newHistory)
    },
    [
      conversations,
      activeConversationId,
      updateMessage,
      truncateMessagesAfter,
      chatSendMessage,
    ]
  )

  const handleRegenerateAssistantMessage = useCallback(
    (messageId: string) => {
      const conv = conversations.find((c) => c.id === activeConversationId)
      if (!conv) return
      const idx = conv.messages.findIndex((m) => m.id === messageId)
      if (idx <= 0) return
      truncateMessagesAfter(messageId, true)
      const newHistory = conv.messages.slice(0, idx)
      chatSendMessage(newHistory)
    },
    [
      conversations,
      activeConversationId,
      truncateMessagesAfter,
      chatSendMessage,
    ]
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
      chatSendMessage(newHistory, modelOverride ? { modelOverride } : undefined)
    },
    [conversations, activeConversationId, deleteMessage, chatSendMessage]
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
    // The slash / mention menus re-arm their own Escape-dismiss flags
    // off `inputValue` (see each hook's effect), so there's nothing to
    // do here for them.
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`
    }
    // Auto-dismiss the smart-paste chip if the user has edited the
    // input enough that the originally-pasted snippet is no longer
    // present. (Owned by `useSmartPaste`.)
    smartPaste.syncFromInput(next)
  }

  const applyPasteAction = (prompt: string) => {
    setInputValue(prompt)
    smartPaste.dismiss()
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
          runAsTask={taskRun.runAsTask}
          onRunAsTaskChange={taskRun.setRunAsTask}
        />
        <div className="flex-1 min-h-0 overflow-hidden">
          {/* ScrollArea fills the full messages column so its right-edge
              scrollbar sits at the column edge (not floating in mid-air
              the way a centered ScrollArea on a wide viewport does).
              The inner div does the actual reading-width centering with
              its own `max-w-5xl mx-auto`. */}
          <ScrollArea className="w-full max-h-[calc(100vh-2.75rem)] h-[calc(100vh-2.75rem)]">
            <div className="max-w-5xl mx-auto px-4 py-4 pb-44 space-y-4">
              {deferredMessages.length === 0 ? (
                <EmptyChatWelcome onPickSuggestion={pickSuggestion} />
              ) : (
                deferredMessages.map((message, index) => (
                    <ChatMessage
                      key={message.id}
                      message={message}
                      index={index}
                      isLastAssistant={message.id === lastAssistantId}
                      liveToolCalls={chatLiveToolCalls[message.id]}
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
          {/* Scroll-to-bottom button — visible only when the user has
              scrolled meaningfully off the bottom. Lives INSIDE the
              input-bar wrapper so it tracks the pill's actual top edge
              (`bottom-full`) regardless of how tall the pill grows —
              attached files, skill chips, smart-paste hint, etc. The
              `mb-3` is the fixed gap between button bottom and pill top. */}
          {showScrollButton && (
            <Button
              variant="secondary"
              size="icon"
              className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 rounded-full shadow-md animate-scroll-button-in z-10 pointer-events-auto"
              onClick={scrollToBottom}
              aria-label="Scroll to bottom"
            >
              <ChevronDown size={18} />
            </Button>
          )}
          <input
            ref={inputFileRef}
            type="file"
            multiple
            accept={ALLOWED_EXTENSIONS.join(",")}
            className="hidden"
            onChange={(e) => handleFileSelected(e.target.files)}
          />
          {/* Inline task pointer — while a task launched from this
              conversation is running, show a one-line status that opens
              the Tasks panel. The full live surface lives in the panel.
              "Queued" appears in the brief window after POST 202 while
              the worker is being picked up; "Running · step N/M" once
              the loop is actually advancing. */}
          {taskRun.isRunning &&
            taskRun.runConversationId === activeConversationId && (
              <button
                type="button"
                onClick={() => setTasksPanelOpen(true)}
                className="max-w-3xl mx-auto mb-2 w-full pointer-events-auto flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] hover:bg-[var(--secondary)] transition-colors"
              >
                <Loader2 size={12} className="animate-spin text-[var(--primary)]" />
                <span>
                  {taskRun.view.status === "queued"
                    ? "Task queued · waiting for worker"
                    : `Task running · step ${taskRun.view.step}${
                        taskRun.view.maxSteps ? ` / ${taskRun.view.maxSteps}` : ""
                      }`}
                </span>
                <span className="ml-auto flex items-center gap-0.5 text-[var(--foreground)]">
                  View <ChevronRight size={12} />
                </span>
              </button>
            )}
          <div
            className={cn(
              "relative max-w-3xl mx-auto pointer-events-auto bg-[var(--background)] rounded-3xl border border-[var(--border)] p-2 shadow-sm transition-colors",
              // Drop-zone highlight while a file is being dragged over.
              // The `+` button used to be the file-attach affordance;
              // drag-and-drop replaces that role.
              dropzone.active && "border-[var(--primary)] bg-[var(--primary)]/5"
            )}
            {...dropzone.bindings}
          >
            {slash.open && (
              <SlashAutocomplete
                triggerChar="/"
                entries={slash.matches.map((m) => ({
                  id: `${m.kind}:${m.id}`,
                  label: m.trigger,
                  hint: m.hint,
                  icon: m.icon,
                  groupLabel: m.group,
                }))}
                activeIndex={slash.activeIndex}
                onHoverIndex={slash.setActiveIndex}
                onPick={(entry) => {
                  const match = slash.matches.find(
                    (m) => `${m.kind}:${m.id}` === entry.id
                  )
                  if (match) slash.pick(match)
                }}
              />
            )}
            {mention.open && (
              <SlashAutocomplete
                triggerChar="@"
                entries={mention.matches.map((m) => ({
                  id: m.id,
                  label: m.slug,
                  hint: m.name,
                }))}
                activeIndex={mention.activeIndex}
                onHoverIndex={mention.setActiveIndex}
                onPick={(entry) => {
                  const prompt = mention.matches.find((m) => m.id === entry.id)
                  if (prompt) mention.pick(prompt)
                }}
              />
            )}
            {pendingReferenceImage && (
              <div className="px-1 pb-1">
                <ReferenceImageChip
                  url={pendingReferenceImage.url}
                  sourcePrompt={pendingReferenceImage.sourcePrompt}
                  onClear={() => setPendingReferenceImage(null)}
                />
              </div>
            )}
            {smartPaste.detection && (
              <div className="px-1 pb-1">
                <SmartPasteChip
                  detection={smartPaste.detection}
                  onApply={applyPasteAction}
                  onDismiss={smartPaste.dismiss}
                />
              </div>
            )}
            <InputGroup className="bg-transparent border-none shadow-none rounded-none">
            <ContextPicker
              open={contextPickerOpen}
              onOpenChange={setContextPickerOpen}
              mutedSkillIds={mutedSkillsForNext}
              onToggleMute={toggleMutedSkillForNext}
              onPickFile={handleAttachClick}
            />
            <InputGroupTextarea
              ref={textareaRef}
              value={inputValue}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={smartPaste.onPaste}
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
                    onClick={chatStop}
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

      {/* Tasks side panel — the live control room for long-running
          runs. Sits left of the resources rail; zero-width when closed. */}
      <TasksSidebar />

      {/* Resources side panel */}
      <ResourcesSidebar />

      {/* Variable-fill modal for `@`-mention prompts that carry
          `{variable}` markers. On insert it drops the expanded
          template into the chat input. */}
      <PromptVariableFill
        open={mention.fillPrompt !== null}
        onOpenChange={(open) => {
          if (!open) mention.setFillPrompt(null)
        }}
        prompt={mention.fillPrompt}
        onInsert={mention.completeFill}
      />

      {/* `/clear` destructive confirm + `/help` cheat-sheet — owned by
          the useSlashCommands hook, rendered here alongside the other
          chat dialogs. */}
      <DeleteConfirmDialog
        open={slashCommands.clearConfirmOpen}
        onOpenChange={slashCommands.setClearConfirmOpen}
        title="Clear this conversation?"
        description="Every message in this chat will be removed. This can't be undone."
        confirmLabel="Clear"
        onConfirm={slashCommands.confirmClear}
      />
      <SlashHelpDialog
        open={slashCommands.helpOpen}
        onOpenChange={slashCommands.setHelpOpen}
      />
      <AgentsDialog
        open={slashCommands.personasOpen}
        onOpenChange={slashCommands.setPersonasOpen}
      />
    </div>
  )
}

/**
 * Small inline chip rendered above the chat input when the user has
 * pinned a reference image via the gallery's "Remix" action. Shows a
 * thumbnail + a caption hinting at the source prompt, plus an × to
 * dismiss without sending. The reference clears automatically on send
 * — this chip just exposes the manual dismiss path.
 */
function ReferenceImageChip({
  url,
  sourcePrompt,
  onClear,
}: {
  url: string
  sourcePrompt: string | undefined
  onClear: () => void
}) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--muted)]/40 pl-1 pr-2 py-1 max-w-fit">
      <div className="relative h-7 w-7 rounded-full overflow-hidden shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element -- same
            reasoning as in generated-images-gallery.tsx. */}
        <img
          src={url}
          alt="Reference image"
          className="h-full w-full object-cover"
        />
      </div>
      <Repeat2 size={12} className="text-[var(--muted-foreground)] shrink-0" />
      <span className="text-[11px] text-[var(--foreground)] leading-none">
        Remix
        {sourcePrompt ? (
          <span className="text-[var(--muted-foreground)]">
            {" "}
            — {sourcePrompt.length > 60 ? sourcePrompt.slice(0, 59) + "…" : sourcePrompt}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={onClear}
        aria-label="Remove reference image"
        className="ml-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)] shrink-0"
      >
        <X size={12} />
      </button>
    </div>
  )
}

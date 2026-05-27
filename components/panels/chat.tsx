"use client"

import { useState, useRef, useEffect, useMemo, useCallback } from "react"
import { useChatScroll } from "@/components/panels/use-chat-scroll"
import { toast } from "sonner"
import { useStore, useHydrated, useIsConversationTyping } from "@/client/hooks/use-store"
import { apiClient } from "@/client/api-client"
import type { ChatRequestInput } from "@/shared/api-schemas"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupTextarea, InputGroupButton } from "@/components/ui/input-group"
import { cn, toISO } from "@/shared/utils"
import { ResourcesSidebar } from "@/components/sidebars/resources"
import { ContextPicker } from "@/components/chat/context-picker"
import { SlashAutocomplete } from "@/components/panels/slash-autocomplete"
import { SlashHelpDialog } from "@/components/panels/slash-help-dialog"
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog"
import { SKILLS } from "@/shared/skills/registry"
import { resolveSkill, type SkillId } from "@/shared/skills/types"
import { isTypingSlashCommand } from "@/shared/skills/slash-parser"
import {
  matchSlashMenu,
  resolveSlash,
  type SlashMenuEntry,
} from "@/shared/slash-resolver"
import { useSlashCommands } from "@/client/hooks/use-slash-commands"
import type { CommandId } from "@/shared/commands/registry"
import {
  isTypingPromptMention,
  matchPromptMentions,
} from "@/shared/prompts/mention-parser"
import { expandTemplate } from "@/shared/prompts/expand"
import { PromptVariableFill } from "@/components/panels/prompt-variable-fill"
import {
  resolveWebSearchConfig,
  type WebSearchConfig,
} from "@/shared/skills/web-search-config"
import {
  resolveWebFetchConfig,
  type WebFetchConfig,
} from "@/shared/skills/web-fetch-config"
import {
  resolveImageGenConfig,
  type ImageGenConfig,
} from "@/shared/skills/image-gen-config"
import { SmartPasteChip } from "@/components/chat/smart-paste-chip"
import { detectPasteKind, type PasteDetection } from "@/shared/smart-paste/detect"
import { ChatHeader } from "@/components/panels/chat-header"
import { ChatMessage } from "@/components/panels/chat-message"
import { EmptyChatWelcome } from "@/components/panels/empty-chat-welcome"
import { SelectionTrigger } from "@/components/selection/selection-trigger"
import { ChevronDown, Square, ArrowUp, Repeat2, X } from "lucide-react"
import { processSelectedFiles } from "@/client/file-utils"
import { runExtraction } from "@/client/extract"
import { persistFile } from "@/client/files/persist"
import { getLocalCred } from "@/client/mcp/local-creds"
import { extractCodeBlocks } from "@/shared/code-blocks"
import { detectArtifactShell } from "@/client/live-artifact/detect"

const AUTO_ARCHIVE_MIN_LINES = 15
const AUTO_ARCHIVE_MAX_PER_MESSAGE = 3
import { FILE_SIZE_LIMIT, IMAGE_SIZE_LIMIT, ALLOWED_EXTENSIONS } from "@/shared/upload-config"
import type { Message, MessageError, MessageErrorCode, Prompt } from "@/shared/types"
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
  const appendMessageGeneratedImages = useStore(
    (state) => state.appendMessageGeneratedImages
  )
  // Per-conversation typing flag. Reads via a memoised selector so
  // switching to a non-streaming conversation while another is mid-
  // stream doesn't show "typing…" here.
  const setConversationTyping = useStore((state) => state.setConversationTyping)
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
  // Per-conversation streaming flags. Keeping a Set lets the chat panel
  // know which conversations are mid-stream so switching to another
  // conv while one is streaming doesn't blanket-disable the send
  // button. `isStreaming` below is the *active conversation*'s flag.
  const [streamingConvIds, setStreamingConvIds] = useState<Set<string>>(
    () => new Set()
  )
  const isStreaming =
    activeConversationId !== null && streamingConvIds.has(activeConversationId)
  const isTyping = useIsConversationTyping(activeConversationId)
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
  // Whether a file is currently being dragged over the input card.
  // Drives the drop-zone highlight; cleared on drop or dragleave.
  const [inputDragActive, setInputDragActive] = useState(false)
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

  /**
   * `/` slash-command autocomplete. `slashActiveIndex` is the
   * highlighted row; `slashDismissed` lets Escape close the menu for
   * the duration of the current slash token (reset once the input no
   * longer starts with `/`). Skill triggers only — prompt templates
   * use `@` (a separate surface, prompt-library Phase 3).
   */
  const [slashActiveIndex, setSlashActiveIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  // The `/` menu now lists both action commands and skills, grouped.
  const slashMatches = useMemo<SlashMenuEntry[]>(
    () =>
      isTypingSlashCommand(inputValue)
        ? matchSlashMenu(inputValue.slice(1))
        : [],
    [inputValue]
  )
  const slashOpen = !slashDismissed && slashMatches.length > 0
  // Keep the highlighted row in range as the match set shrinks while
  // typing.
  useEffect(() => {
    setSlashActiveIndex((i) => (i >= slashMatches.length ? 0 : i))
  }, [slashMatches.length])

  const slashCommands = useSlashCommands({
    openModelPicker: () => setModelPickerOpen(true),
    isStreaming,
  })

  const pickSlashEntry = useCallback(
    (entry: SlashMenuEntry) => {
      // Skill picks and arg-taking commands complete to `/trigger ` so
      // the user types the body. Instant commands (argKind 'none') run
      // immediately and clear the input.
      const instant = entry.kind === "command" && entry.argKind === "none"
      if (instant) {
        slashCommands.run(entry.id as CommandId, "")
        setInputValue("")
      } else {
        setInputValue(`/${entry.trigger} `)
      }
      setSlashActiveIndex(0)
      textareaRef.current?.focus()
    },
    [slashCommands]
  )

  /**
   * `@` prompt-mention autocomplete. Sibling of the `/` skill surface
   * — mutually exclusive because each requires its own leading char.
   * Picking a prompt expands its template into the input (replacing
   * the `@slug`); prompts with `{variable}` markers route through
   * the fill modal first. See prompt-library Phase 3 in
   * `docs/_done/PLAN-prompt-library.md`.
   */
  const prompts = useStore((state) => state.prompts)
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const [mentionFillPrompt, setMentionFillPrompt] = useState<Prompt | null>(null)
  const mentionMatches = useMemo(
    () =>
      isTypingPromptMention(inputValue)
        ? matchPromptMentions(inputValue.slice(1), prompts)
        : [],
    [inputValue, prompts]
  )
  const mentionOpen = !mentionDismissed && mentionMatches.length > 0
  useEffect(() => {
    setMentionActiveIndex((i) => (i >= mentionMatches.length ? 0 : i))
  }, [mentionMatches.length])

  const pickPromptMention = useCallback((prompt: Prompt) => {
    if (prompt.variables.length > 0) {
      // Defer expansion to the fill modal; it calls back with the
      // expanded text which we drop into the input.
      setMentionFillPrompt(prompt)
      return
    }
    // No variables — expand (a no-op substitution) straight into the
    // input. Clearing the `@slug` token entirely.
    setInputValue(expandTemplate(prompt.template, {}))
    setMentionActiveIndex(0)
    // Programmatic value changes don't trigger the Textarea's own
    // onChange-driven auto-resize, so we run the same rAF resize that
    // handleQuoteSelection / pendingChatInput effect use. Move the
    // caret to the end too so the user picks up where the template
    // ends.
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.style.height = "auto"
      ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`
      ta.selectionStart = ta.selectionEnd = ta.value.length
    })
  }, [])


  const [liveToolCalls, setLiveToolCalls] = useState<
    Record<string, LiveToolCall[]>
  >({})
  // Per-conversation abort controllers. Map<convId, controller>. The
  // Stop button on the active conversation aborts that conversation's
  // controller only — other conversations keep streaming. Cleaned up
  // when the stream ends (success, error, or abort).
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map())
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
        // Pin to the originating conv id so the mock answer still lands
        // in the right tab if the user switched away while waiting.
        addMessage({ role: "assistant", content: aiContent, reasoning }, convId)
        setConversationTyping(convId, false)
      }, 300)
    },
    [setConversationTyping, addMessage]
  )

  // After a stream completes, auto-archive substantial code blocks so they
  // become first-class artifacts without the user having to remember the
  // Save-as-artifact button. Conservative threshold (>= AUTO_ARCHIVE_MIN_LINES)
  // and capped count keep the artifacts panel from flooding. Renderable
  // blocks (tsx/jsx/html/svg/mermaid, or content that sniffs as one)
  // bypass the line threshold — the point of those is to be *previewed*,
  // not archived for length. A 6-line `<Button>` JSX block is just as
  // worth showing inline as a 60-line one.
  const autoArchiveCodeBlocks = useCallback(
    (assistantMessageId: string, conversationId: string) => {
      // Caller supplies the conversation id explicitly so this works
      // for streams that completed while the user was looking at a
      // different conversation tab. Re-read the message from the store
      // using the id (the streaming loop holds a stale `Message`
      // reference because `appendToMessage` updates the store
      // immutably).
      const conv = useStore
        .getState()
        .conversations.find((c) => c.id === conversationId)
      const message = conv?.messages.find((m) => m.id === assistantMessageId)
      if (!message) return
      const blocks = extractCodeBlocks(message.content)
      const eligible = blocks.filter(
        (b) =>
          b.lines >= AUTO_ARCHIVE_MIN_LINES ||
          detectArtifactShell({ language: b.language ?? null, content: b.code })
            .renderable
      )
      if (eligible.length === 0) return
      const capped = eligible.slice(0, AUTO_ARCHIVE_MAX_PER_MESSAGE)
      capped.forEach((b, i) => {
        const lang = (b.language ?? "").toLowerCase()
        const kind = lang === "json" ? "json" : "code"
        createArtifact({
          conversationId,
          messageId: assistantMessageId,
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
    [createArtifact]
  )

  // Build the message list and file context the API expects, sent up to and
  // including the most recent user message.
  const callChatAPI = useCallback(
    async (
      history: Message[],
      options?: {
        modelOverride?: string
        isRetry?: boolean
        /** I2I reference URL to forward to the server for this turn.
         *  Captured by the caller (`handleSendMessage`) ahead of the
         *  store clear so a retry doesn't quietly re-attach a reference
         *  the user already dismissed. */
        referenceImage?: { url: string }
        /** Skill ids forced on for this turn by a `/slash` command,
         *  on top of the workspace/conversation cascade. Passed as an
         *  arg (not read from state) so a retry re-applies the same
         *  forced set deterministically. */
        forcedSkillIds?: SkillId[]
      }
    ) => {
      // Read the model freshly from the store rather than via the closure.
      // Lets retry-after-model-change use the new value without waiting for
      // this callback's useEffect-driven ref refresh to catch up.
      const modelForCall = options?.modelOverride ?? useStore.getState().chatModel
      const isRetry = options?.isRetry ?? false
      // Capture the conversation id at send time. Every "is this conv
      // streaming?" / "this conv's controller" decision below uses
      // `targetConvId` instead of reading `activeConversationId`
      // mid-flight, so switching conversations during a stream
      // doesn't move the stream's UI state onto the wrong chat.
      const targetConvId = activeConversationId
      if (!targetConvId) return
      const conv = conversations.find((c) => c.id === targetConvId)
      const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
      const workspaceSystemPrompt = activeWorkspace?.systemPrompt?.trim() || undefined
      // Resolve which skills are effectively on for this turn so the route
      // knows which tools to register.
      // Effective set = (workspace/conversation cascade ∪ slash-forced)
      // minus any skills the user muted for this one send via the chip ×
      // button. Mute wins over slash-force in the rare case both name the
      // same skill (explicit "off" beats explicit "on").
      const forcedSkillIds = new Set(options?.forcedSkillIds ?? [])
      const enabledSkills = SKILLS.filter(
        (s) =>
          (resolveSkill(s, activeWorkspace?.skillPrefs, conv?.skillPrefs) ||
            forcedSkillIds.has(s.id)) &&
          !mutedSkillsForNext.has(s.id)
      ).map((s) => {
        const entry: {
          id: string
          webSearchConfig?: WebSearchConfig
          webFetchConfig?: WebFetchConfig
          imageGenConfig?: ImageGenConfig
        } = {
          id: s.id,
        }
        if (s.id === 'webSearch') {
          // Cascade conversation override → workspace default → built-in.
          // Resolver clamps + fills in provider defaults.
          const resolved = resolveWebSearchConfig(
            activeWorkspace?.webSearchConfig,
            conv?.webSearchConfig
          )
          entry.webSearchConfig = {
            maxCalls: resolved.maxCalls,
            tavily: {
              enabled: resolved.tavily.enabled,
              searchDepth: resolved.tavily.searchDepth,
            },
            brave: {
              enabled: resolved.brave.enabled,
              freshness: resolved.brave.freshness,
            },
            exa: {
              enabled: resolved.exa.enabled,
              type: resolved.exa.type,
            },
          }
        }
        if (s.id === 'webFetch') {
          const resolved = resolveWebFetchConfig(
            activeWorkspace?.webFetchConfig,
            conv?.webFetchConfig
          )
          entry.webFetchConfig = { maxCalls: resolved.maxCalls }
        }
        if (s.id === 'imageGen') {
          const resolved = resolveImageGenConfig(
            activeWorkspace?.imageGenConfig,
            conv?.imageGenConfig
          )
          entry.imageGenConfig = {
            maxCalls: resolved.maxCalls,
            aspectRatio: resolved.aspectRatio,
          }
        }
        return entry
      })
      // Index workspace entities up front so the three attachment-collection
      // loops below are O(attached) instead of O(attached × workspace-total).
      const filesById = new Map(files.map((f) => [f.id, f]))
      // Merge the two lanes: workspace-ticked via `selectedFileIds` plus
      // conversation-private joins via `conversationFiles`. De-dup by id
      // so a file in both lanes is sent once. Tombstoned files drop out —
      // they still render as "removed" placeholders in the message chips
      // via `MessageAttachments`, just not sent upstream.
      const workspaceFileIds = conv?.selectedFileIds ?? []
      const privateFileIds = conv
        ? conversationFiles
            .filter((cf) => cf.conversationId === conv.id)
            .map((cf) => cf.fileId)
        : []
      const attachedFileIds = [...new Set([...workspaceFileIds, ...privateFileIds])]
      const attachedFiles = attachedFileIds
        .map((id) => filesById.get(id))
        .filter((f): f is NonNullable<typeof f> => !!f && !f.deletedAt)
      // Attach images only to the most recent user message — re-sending them
      // on every turn would explode the token bill and isn't how vision
      // chats are typically structured.
      const attachedImageUrls = attachedFiles
        .filter((f) => f.extractedKind === "image" && f.imageDataUrl)
        .map((f) => f.imageDataUrl as string)
      // Drop messages the user compressed out of context — the recap
      // message that replaced them stays in the array and travels to
      // the model as a regular assistant turn, which is the whole
      // point of the compression action.
      const transmittedHistory = history.filter((m) => !m.compressed)
      const buildMessages = () =>
        transmittedHistory.map((m, i) => {
          const isLastUser =
            i === transmittedHistory.length - 1 &&
            m.role === "user" &&
            attachedImageUrls.length > 0
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
      // If this conversation already has an in-flight controller
      // (very rare — user double-clicks Send before the previous
      // turn lands a placeholder), abort the old one first so we
      // don't leak its event listener.
      abortControllersRef.current.get(targetConvId)?.abort()
      abortControllersRef.current.set(targetConvId, controller)
      setConversationTyping(targetConvId, true)
      markStreaming(targetConvId, true)
      let placeholder: Message | null = null
      let firstChunk = true
      // Reasoning duration capture: first/last chunk timestamps so we can
      // persist the elapsed ms on the message. Set on the first reasoning
      // chunk; refreshed on each subsequent chunk so the difference at
      // stream end equals total reasoning time.
      let reasoningStart: number | null = null
      let reasoningLast: number | null = null

      const surfaceError = (error: MessageError) => {
        setConversationTyping(targetConvId, false)
        if (placeholder) {
          setMessageError(placeholder.id, error)
        } else {
          const created = addMessage({ role: "assistant", content: "" }, targetConvId)
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

      // Build the unified attachments payload — files + MCP resources
      // + URL bookmarks in one discriminated array. Workspace-ticked
      // + conversation-pinned, de-duped per kind, tombstones filtered.
      // See `lib/shared/attachments.ts` for the union shape.
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

      // Read at send-time rather than subscribing — the flag is a boolean
      // that doesn't need to re-trigger anything mid-flight; just snapshot
      // the user's current preference so the server knows whether to
      // route generated images to Supabase Storage or fall back to data
      // URLs (same semantic the client uses for file uploads in
      // `persist.ts`).
      const localFilesOnly = useStore.getState().localFilesOnly

      try {
        const result = await apiClient.chat.stream(
          {
            model: modelForCall,
            messages: buildMessages() as ChatRequestInput["messages"],
            workspaceSystemPrompt,
            workspaceId: activeWorkspaceId || undefined,
            skills: enabledSkills,
            mcpServers: mcpServersForRequest.length > 0 ? mcpServersForRequest : undefined,
            attachments:
              attachmentsForRequest.length > 0 ? attachmentsForRequest : undefined,
            referenceImage: options?.referenceImage,
            localFilesOnly: localFilesOnly || undefined,
          },
          { signal: controller.signal }
        )

        if (!result.ok) {
          if (result.status === 401) {
            setConversationTyping(targetConvId, false)
            markStreaming(targetConvId, false)
            const lastUser = [...history].reverse().find((m) => m.role === "user")
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
          setConversationTyping(targetConvId, false)
          placeholder = addMessage({ role: "assistant", content: "" }, targetConvId)
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
              mode?: string
              images?: unknown[]
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
            } else if (parsed.type === "tool_image" && Array.isArray(parsed.images)) {
              // generateImage produced images; the server pre-persisted
              // each Minimax URL to a durable form (data URL today,
              // Supabase signed URL in a future PR) so the message
              // survives reload. Validate at the boundary; drop
              // malformed entries silently.
              const ph = placeholder as Message | null
              if (ph) {
                const mode: "t2i" | "i2i" = parsed.mode === "i2i" ? "i2i" : "t2i"
                const images = (parsed.images as Array<Record<string, unknown>>)
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
                }
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
        } else if (placeholder) {
          const ph = placeholder as Message
          // Pass the id, not the captured Message — the local reference is
          // stale (it still has the empty initial content); `autoArchive`
          // re-reads the actual streamed content from the store. The
          // conversation id is captured from `targetConvId` so a stream
          // that finished while the user was on a different tab still
          // archives into the originating conversation.
          autoArchiveCodeBlocks(ph.id, targetConvId)
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
        // Clear this conversation's controller entry only if it's
        // still the one we set — guards against a follow-up send
        // for the same conversation overwriting the slot.
        if (abortControllersRef.current.get(targetConvId) === controller) {
          abortControllersRef.current.delete(targetConvId)
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
      setConversationTyping,
      markStreaming,
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
    // Stop only the *active* conversation's stream. Other conversations
    // mid-stream stay running — they each have their own controller
    // in the map.
    if (!activeConversationId) return
    abortControllersRef.current.get(activeConversationId)?.abort()
  }, [activeConversationId])

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

    const trimmed = inputValue.trim()
    // Resolve a leading `/` directive. A **command** runs now and does
    // NOT send a message; a **skill** forces a capability on and is
    // stripped from the visible message.
    const slash = resolveSlash(trimmed)
    if (slash?.kind === "command") {
      slashCommands.run(slash.commandId, slash.arg)
      setInputValue("")
      if (textareaRef.current) textareaRef.current.style.height = "auto"
      return // ← no message added, no API call
    }
    const forcedSkillIds =
      slash?.kind === "skill" ? [slash.skillId] : undefined
    const messageContent =
      slash?.kind === "skill" ? slash.remainder : trimmed
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
    // Per-message skill mutes were for this one send — reset.
    if (mutedSkillsForNext.size > 0) setMutedSkillsForNext(new Set())
    if (pasteDetection) setPasteDetection(null)
    // Snapshot the remix reference and clear it — one-shot semantics.
    // The chip disappears immediately; the in-flight request still gets
    // the URL via callChatAPI's `options.referenceImage` arg.
    const pendingRef = useStore.getState().pendingReferenceImage
    if (pendingRef) useStore.getState().setPendingReferenceImage(null)

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }

    const history = [...messages, userMessage]
    callChatAPIRef.current(history, {
      referenceImage: pendingRef ? { url: pendingRef.url } : undefined,
      forcedSkillIds,
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // While the slash menu is open, the nav keys drive it instead of
    // the textarea / send.
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSlashActiveIndex((i) => (i + 1) % slashMatches.length)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setSlashActiveIndex(
          (i) => (i - 1 + slashMatches.length) % slashMatches.length
        )
        return
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const entry = slashMatches[slashActiveIndex]
        if (entry) pickSlashEntry(entry)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
    }
    // Same nav-key capture for the `@` mention menu. Mutually exclusive
    // with the slash menu (each needs its own leading char), so the
    // two blocks never both fire.
    if (mentionOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setMentionActiveIndex((i) => (i + 1) % mentionMatches.length)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setMentionActiveIndex(
          (i) => (i - 1 + mentionMatches.length) % mentionMatches.length
        )
        return
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const prompt = mentionMatches[mentionActiveIndex]
        if (prompt) pickPromptMention(prompt)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setMentionDismissed(true)
        return
      }
    }
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
    // Re-arm the slash menu once the input no longer starts with `/`
    // (so a prior Escape doesn't keep it closed forever).
    if (!next.startsWith("/") && slashDismissed) setSlashDismissed(false)
    // Same re-arm for the `@` mention menu.
    if (!next.startsWith("@") && mentionDismissed) setMentionDismissed(false)
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
          {/* ScrollArea fills the full messages column so its right-edge
              scrollbar sits at the column edge (not floating in mid-air
              the way a centered ScrollArea on a wide viewport does).
              The inner div does the actual reading-width centering with
              its own `max-w-5xl mx-auto`. */}
          <ScrollArea className="w-full max-h-[calc(100vh-2.75rem)] h-[calc(100vh-2.75rem)]">
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
          <div
            className={cn(
              "relative max-w-3xl mx-auto pointer-events-auto bg-[var(--background)] rounded-3xl border border-[var(--border)] p-2 shadow-sm transition-colors",
              // Drop-zone highlight while a file is being dragged over.
              // The `+` button used to be the file-attach affordance;
              // drag-and-drop replaces that role.
              inputDragActive && "border-[var(--primary)] bg-[var(--primary)]/5"
            )}
            onDragOver={(e) => {
              if (!e.dataTransfer?.types.includes("Files")) return
              e.preventDefault()
              e.dataTransfer.dropEffect = "copy"
              if (!inputDragActive) setInputDragActive(true)
            }}
            onDragLeave={(e) => {
              // `dragleave` fires for every child crossing; only clear
              // when we leave the wrapper itself.
              if (e.currentTarget.contains(e.relatedTarget as Node | null))
                return
              setInputDragActive(false)
            }}
            onDrop={(e) => {
              if (!e.dataTransfer?.files?.length) return
              e.preventDefault()
              setInputDragActive(false)
              handleFileSelected(e.dataTransfer.files)
            }}
          >
            {slashOpen && (
              <SlashAutocomplete
                triggerChar="/"
                entries={slashMatches.map((m) => ({
                  id: `${m.kind}:${m.id}`,
                  label: m.trigger,
                  hint: m.hint,
                  icon: m.icon,
                  groupLabel: m.group,
                }))}
                activeIndex={slashActiveIndex}
                onHoverIndex={setSlashActiveIndex}
                onPick={(entry) => {
                  const match = slashMatches.find(
                    (m) => `${m.kind}:${m.id}` === entry.id
                  )
                  if (match) pickSlashEntry(match)
                }}
              />
            )}
            {mentionOpen && (
              <SlashAutocomplete
                triggerChar="@"
                entries={mentionMatches.map((m) => ({
                  id: m.id,
                  label: m.slug,
                  hint: m.name,
                }))}
                activeIndex={mentionActiveIndex}
                onHoverIndex={setMentionActiveIndex}
                onPick={(entry) => {
                  const prompt = mentionMatches.find((m) => m.id === entry.id)
                  if (prompt) pickPromptMention(prompt)
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

      {/* Variable-fill modal for `@`-mention prompts that carry
          `{variable}` markers. On insert it drops the expanded
          template into the chat input. */}
      <PromptVariableFill
        open={mentionFillPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setMentionFillPrompt(null)
        }}
        prompt={mentionFillPrompt}
        onInsert={(expanded) => {
          setInputValue(expanded)
          setMentionFillPrompt(null)
          setMentionActiveIndex(0)
          // Same rAF resize as `pickPromptMention` — programmatic
          // value changes bypass the textarea's onChange-driven
          // auto-grow.
          requestAnimationFrame(() => {
            const ta = textareaRef.current
            if (!ta) return
            ta.focus()
            ta.style.height = "auto"
            ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`
            ta.selectionStart = ta.selectionEnd = ta.value.length
          })
        }}
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

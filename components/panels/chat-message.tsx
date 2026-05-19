"use client"

import { useState, useRef, useEffect } from "react"
import type { Message, MessageError } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Copy, Pencil, Trash2, RotateCcw, Check, X, Bookmark, AlertTriangle, ChevronDown, Archive, Send, GitBranch } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { copyText } from "@/lib/export"
import { CHAT_MODELS, DEFAULT_CHAT_MODEL } from "@/lib/models"
import { extractCodeBlocks } from "@/lib/code-blocks"
import { MarkdownPreview } from "@/components/markdown-preview"
import { ToolCallStrip, type LiveToolCall } from "@/components/skills/tool-call-strip"
import { MessageAttachments } from "@/components/panels/message-attachments"
import { useStore, useMessageBookmark } from "@/lib/hooks/use-store"
import type { ArtifactKind } from "@/lib/types"
import {
  SaveArtifactDialog,
  type DetectedBlock,
  type SaveArtifactSelection,
} from "@/components/panels/save-artifact-dialog"

function formatTime(timestamp: Date | string): string {
  const date = new Date(timestamp)
  const hours = date.getUTCHours()
  const minutes = date.getUTCMinutes()
  const ampm = hours >= 12 ? "PM" : "AM"
  const hour12 = hours % 12 || 12
  const minuteStr = minutes.toString().padStart(2, "0")
  return `${hour12}:${minuteStr} ${ampm}`
}

function MessageTime({ timestamp }: { timestamp: Date | string }) {
  const [time, setTime] = useState<string>("")
  useEffect(() => {
    setTime(formatTime(timestamp))
  }, [timestamp])
  if (!time) return null
  return <>{time}</>
}

function ReasoningBlock({
  reasoning,
  /** The assistant message's `content`. When non-empty, the model has
   *  moved on from reasoning to the answer — we use this transition to
   *  swap the header label from "Thinking…" to "Reasoning". */
  content,
  streaming,
  durationMs,
}: {
  reasoning: string
  content: string
  /** When true (the message has reasoning but no content yet), open by default
   *  so the user sees the model is actively thinking. */
  streaming: boolean
  /** Total reasoning time in ms, persisted on the message. Shown as "Thought for X.Xs"
   *  in the collapsed header once streaming finishes. */
  durationMs?: number
}) {
  const [open, setOpen] = useState(streaming)

  // Re-open automatically when a new streaming session begins.
  useEffect(() => {
    if (streaming) setOpen(true)
  }, [streaming])

  const isLive = streaming && !content

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    void copyText(reasoning)
    toast.success("Reasoning copied")
  }

  return (
    <div className="group/reasoning mb-2 text-[var(--muted-foreground)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2 py-1 text-xs hover:bg-[var(--accent)]/50 rounded-md transition-colors min-w-0"
        aria-expanded={open}
      >
        <span className="shrink-0">{isLive ? "Thinking…" : "Reasoning"}</span>
        {isLive && (
          <span
            aria-hidden
            className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--muted-foreground)] animate-pulse shrink-0"
          />
        )}
        {!isLive && durationMs !== undefined && durationMs > 0 && (
          <span className="shrink-0 text-[10px] opacity-70" title="Total reasoning time">
            · {(durationMs / 1000).toFixed(1)}s
          </span>
        )}
        <ChevronDown
          size={12}
          className={cn("transition-transform shrink-0", !open && "-rotate-90")}
        />
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div className="relative px-2 pb-2 pt-1 max-h-[40vh] overflow-y-auto">
            <div className="sticky top-1 z-10 flex justify-end -mb-7 pr-2 pointer-events-none">
              <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy reasoning"
                title="Copy reasoning"
                className="pointer-events-auto p-1 rounded bg-[var(--background)]/80 backdrop-blur-sm opacity-0 group-hover/reasoning:opacity-100 focus-visible:opacity-100 hover:bg-[var(--accent)]/50 transition-opacity"
              >
                <Copy size={12} />
              </button>
            </div>
            <MarkdownPreview
              content={reasoning}
              className="text-xs opacity-90 pr-7 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

interface ChatMessageProps {
  message: Message
  index: number
  /** True for the most recent non-error assistant message; controls whether
   *  follow-up suggestion chips render. */
  isLastAssistant?: boolean
  onDelete: (messageId: string) => void
  onEditUserMessage: (messageId: string, newContent: string) => void
  onRegenerateAssistantMessage: (messageId: string) => void
  /** Branch the conversation at this message — creates a sibling chat starting from this point. */
  onForkFromMessage?: (messageId: string) => void
  onRetryError?: (messageId: string) => void
  onChangeModel?: (messageId?: string) => void
  /** Retry with a different model in one click. Wired by chat.tsx for invalid_model / provider errors. */
  onTryFallback?: (messageId: string, modelId: string) => void
  onPickSuggestion?: (text: string) => void
  /** Live tool-call pills rendered above the assistant text during a stream. Cleared on `done`. */
  liveToolCalls?: LiveToolCall[]
  /** Resolved by the parent: the PDF this assistant message is citing via `[p.N]` markers. */
  pdfCitationFileId?: string
}

/**
 * Pick a fallback model id for one-click retry. Prefers DEFAULT_CHAT_MODEL
 * when it differs from the failed one, otherwise the first different model
 * in CHAT_MODELS. Returns null when no different model exists (unreachable
 * given the current list, but kept for safety).
 */
function pickFallbackModel(failedModelId: string | undefined): { id: string; label: string } | null {
  if (DEFAULT_CHAT_MODEL !== failedModelId) {
    const def = CHAT_MODELS.find((m) => m.id === DEFAULT_CHAT_MODEL)
    if (def) return { id: def.id, label: def.label }
  }
  const other = CHAT_MODELS.find((m) => m.id !== failedModelId)
  return other ? { id: other.id, label: other.label } : null
}

const ERROR_TITLES: Record<string, string> = {
  auth: "Authentication failed",
  rate_limit: "Rate limited",
  invalid_model: "Model unavailable",
  provider: "Provider error",
  network: "Network error",
  unknown: "Something went wrong",
}

function ErrorBubble({
  error,
  partialContent,
  onRetry,
  onChangeModel,
  onTryFallback,
  onDelete,
}: {
  error: MessageError
  partialContent: string
  onRetry: () => void
  onChangeModel?: () => void
  onTryFallback?: (modelId: string) => void
  onDelete: () => void
}) {
  const [showDetails, setShowDetails] = useState(false)
  // Rate-limit cooldown: when the model says "too many requests", retrying
  // immediately just hits the same wall. Soft-disable Retry for 30 s with
  // a countdown so the user knows when it's safe to try again.
  const RATE_LIMIT_COOLDOWN_S = 30
  const [cooldown, setCooldown] = useState<number>(
    error.code === "rate_limit" ? RATE_LIMIT_COOLDOWN_S : 0
  )
  useEffect(() => {
    if (cooldown <= 0) return
    const id = setInterval(() => {
      setCooldown((s) => (s <= 1 ? 0 : s - 1))
    }, 1000)
    return () => clearInterval(id)
  }, [cooldown])
  const title = ERROR_TITLES[error.code] ?? ERROR_TITLES.unknown
  // `auth` means the API key is missing/invalid — retrying with the same
  // setup will hit the same wall. Hide Retry and let the user dismiss or
  // pick a different model (which the bubble will surface separately).
  const canRetrySameModel = error.code !== "auth" && error.code !== "invalid_model"
  // Quick-fallback only makes sense when the model itself failed (invalid)
  // or the provider behind it returned an error. For rate_limit / network
  // / unknown the same-model retry is the right primary action.
  const fallback =
    (error.code === "invalid_model" || error.code === "provider") && onTryFallback
      ? pickFallbackModel(error.model)
      : null
  return (
    <div className="rounded-lg border border-[var(--destructive)]/40 bg-[var(--destructive)]/5 px-4 py-3 max-w-[90%] space-y-2">
      {partialContent && (
        <p className="text-sm whitespace-pre-wrap text-[var(--foreground)]">
          {partialContent}
        </p>
      )}
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="text-[var(--destructive)] mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-[var(--destructive)]">{title}</p>
          {error.detail && (
            <p className="text-xs text-[var(--muted-foreground)] mt-0.5 break-words">
              {error.detail}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {canRetrySameModel && (
          <Button
            size="sm"
            variant="secondary"
            onClick={onRetry}
            disabled={cooldown > 0}
            className="h-7 gap-1.5 text-xs"
            title={cooldown > 0 ? `Wait ${cooldown}s before retrying — provider asked us to slow down.` : undefined}
          >
            <RotateCcw size={12} />
            {cooldown > 0 ? `Retry in ${cooldown}s` : "Retry"}
          </Button>
        )}
        {fallback && (
          <Button
            size="sm"
            variant={canRetrySameModel ? "ghost" : "secondary"}
            onClick={() => onTryFallback?.(fallback.id)}
            className="h-7 gap-1.5 text-xs"
            title={`Switch model and retry with ${fallback.label}`}
          >
            <RotateCcw size={12} />
            Try {fallback.label}
          </Button>
        )}
        {onChangeModel && error.code !== "network" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onChangeModel}
            className="h-7 gap-1.5 text-xs"
          >
            Change model
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={onDelete}
          className="h-7 gap-1.5 text-xs text-[var(--muted-foreground)]"
        >
          Dismiss
        </Button>
        {(error.status !== undefined || error.model) && (
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            Details
            <ChevronDown
              size={10}
              className={cn("transition-transform", showDetails && "rotate-180")}
            />
          </button>
        )}
      </div>
      {showDetails && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[10px] text-[var(--muted-foreground)] pt-1 border-t border-[var(--destructive)]/20">
          <dt>Code</dt>
          <dd className="font-mono">{error.code}</dd>
          {error.status !== undefined && (
            <>
              <dt>HTTP</dt>
              <dd className="font-mono">{error.status}</dd>
            </>
          )}
          {error.model && (
            <>
              <dt>Model</dt>
              <dd className="font-mono break-all">{error.model}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  )
}

export function ChatMessage({
  message,
  index,
  isLastAssistant = false,
  onDelete,
  onEditUserMessage,
  onRegenerateAssistantMessage,
  onForkFromMessage,
  onRetryError,
  onChangeModel,
  onTryFallback,
  onPickSuggestion,
  liveToolCalls,
  pdfCitationFileId,
}: ChatMessageProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(message.content)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      const ta = textareaRef.current
      ta.focus()
      ta.setSelectionRange(ta.value.length, ta.value.length)
      ta.style.height = "auto"
      ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`
    }
  }, [isEditing])

  const isUser = message.role === "user"

  const activeConversationId = useStore((s) => s.activeConversationId)
  const toggleMessageBookmark = useStore((s) => s.toggleMessageBookmark)
  const createArtifact = useStore((s) => s.createArtifact)
  const setConversationDocument = useStore((s) => s.setConversationDocument)
  const requestEditorReload = useStore((s) => s.requestEditorReload)
  const setActiveView = useStore((s) => s.setActiveView)
  const bookmark = useMessageBookmark(message.id)
  const isBookmarked = bookmark !== null

  const handleBookmark = () => {
    if (!activeConversationId) return
    const result = toggleMessageBookmark(activeConversationId, message.id)
    toast.success(result ? "Bookmarked" : "Removed bookmark")
  }

  const [pickerBlocks, setPickerBlocks] = useState<DetectedBlock[] | null>(null)

  const saveBlockAsArtifact = (
    b: DetectedBlock,
    label: string
  ) => {
    if (!activeConversationId) return
    const lang = (b.language ?? "").toLowerCase()
    const kind: ArtifactKind = lang === "json" ? "json" : "code"
    createArtifact({
      conversationId: activeConversationId,
      messageId: message.id,
      kind,
      language: b.language,
      title: label,
      content: b.code,
    })
  }

  const saveWholeAsMarkdown = () => {
    if (!activeConversationId) return
    createArtifact({
      conversationId: activeConversationId,
      messageId: message.id,
      kind: "markdown",
      content: message.content,
    })
  }

  const handleSaveAsArtifact = () => {
    if (!activeConversationId) return
    const blocks = extractCodeBlocks(message.content)

    if (blocks.length === 0) {
      saveWholeAsMarkdown()
      toast.success("Saved as artifact")
      return
    }

    if (blocks.length === 1) {
      const b = blocks[0]
      saveBlockAsArtifact(b, `Code${b.language ? ` (${b.language})` : ""}`)
      toast.success("Saved 1 code artifact")
      return
    }

    // >1 blocks — open the picker
    setPickerBlocks(blocks)
  }

  const handlePickerConfirm = (selection: SaveArtifactSelection) => {
    if (!pickerBlocks) return
    selection.blockIndices.forEach((i) => {
      const b = pickerBlocks[i]
      if (!b) return
      saveBlockAsArtifact(
        b,
        `Code ${i + 1}${b.language ? ` (${b.language})` : ""}`
      )
    })
    if (selection.alsoSaveAsMarkdown) saveWholeAsMarkdown()
    const total =
      selection.blockIndices.length + (selection.alsoSaveAsMarkdown ? 1 : 0)
    setPickerBlocks(null)
    toast.success(`Saved ${total} artifact${total === 1 ? "" : "s"}`)
  }

  const handleSendToEditor = () => {
    if (!activeConversationId) return
    setConversationDocument(activeConversationId, message.content)
    requestEditorReload()
    setActiveView("editor")
    toast.success("Sent to editor")
  }

  const handleCopy = async () => {
    try {
      await copyText(message.content)
      toast.success("Copied")
    } catch {
      toast.error("Failed to copy")
    }
  }

  const startEdit = () => {
    setEditValue(message.content)
    setIsEditing(true)
  }

  const cancelEdit = () => {
    setEditValue(message.content)
    setIsEditing(false)
  }

  const saveEdit = () => {
    const trimmed = editValue.trim()
    if (!trimmed || trimmed === message.content) {
      cancelEdit()
      return
    }
    onEditUserMessage(message.id, trimmed)
    setIsEditing(false)
  }

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      saveEdit()
    } else if (e.key === "Escape") {
      e.preventDefault()
      cancelEdit()
    }
  }

  return (
    <div
      id={`chat-message-${message.id}`}
      className={cn(
        "group/message animate-message-in scroll-mt-20",
        isBookmarked && "rounded-md ring-1 ring-amber-400/30"
      )}
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className={cn("flex", isUser ? "flex-row-reverse" : "flex-row")}>
        {message.error && !isUser ? (
          <ErrorBubble
            error={message.error}
            partialContent={message.content}
            onRetry={() => onRetryError?.(message.id)}
            onChangeModel={() => onChangeModel?.(message.id)}
            onTryFallback={(modelId) => onTryFallback?.(message.id, modelId)}
            onDelete={() => onDelete(message.id)}
          />
        ) : (
        <div className={cn("flex flex-col", isUser ? "items-end max-w-[90%]" : "items-start w-full")}>
          <div
            className={cn(
              "animate-content-in w-full",
              isUser
                ? "rounded-lg px-4 py-2 bg-[var(--user-bubble)] text-[var(--user-bubble-foreground)]"
                : "text-[var(--foreground)]"
            )}
          >
            {isEditing ? (
              <div className="flex flex-col gap-2">
                <Textarea
                  ref={textareaRef}
                  value={editValue}
                  onChange={(e) => {
                    setEditValue(e.target.value)
                    const ta = e.target as HTMLTextAreaElement
                    ta.style.height = "auto"
                    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`
                  }}
                  onKeyDown={handleEditKeyDown}
                  className="min-h-[44px] bg-background text-foreground text-sm resize-none"
                />
                <div className="flex gap-1 justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={cancelEdit}
                    className="h-7 gap-1"
                  >
                    <X size={14} />
                    Cancel
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={saveEdit}
                    className="h-7 gap-1"
                  >
                    <Check size={14} />
                    Save &amp; resend
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {message.reasoning && message.reasoning.trim().length > 0 && (
                  <ReasoningBlock
                    reasoning={message.reasoning}
                    content={message.content}
                    streaming={!message.content}
                    durationMs={message.reasoningDurationMs}
                  />
                )}
                {!isUser && (liveToolCalls?.length || message.toolCalls?.length) ? (
                  <ToolCallStrip
                    calls={
                      liveToolCalls && liveToolCalls.length > 0
                        ? liveToolCalls
                        : (message.toolCalls ?? []).map((t) => ({
                            id: t.id,
                            name: t.name,
                            argsLabel: t.argsLabel,
                            summary: t.summary,
                            status: "done" as const,
                          }))
                    }
                  />
                ) : null}
                {!isUser && message.content ? (
                  <MarkdownPreview
                    content={message.content}
                    className="markdown-chat-bubble text-sm p-0 overflow-visible"
                    pdfCitationFileId={pdfCitationFileId}
                  />
                ) : (
                  <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                )}
                {isUser &&
                  message.attachedFileIds &&
                  message.attachedFileIds.length > 0 && (
                    <MessageAttachments
                      fileIds={message.attachedFileIds}
                      align="end"
                    />
                  )}
                <p
                  className={cn(
                    "text-xs mt-1 opacity-60",
                    isUser
                      ? "text-[var(--user-bubble-foreground)]"
                      : "text-[var(--muted-foreground)]"
                  )}
                >
                  <MessageTime timestamp={message.timestamp} />
                </p>
              </>
            )}
          </div>

          {!isEditing && (
            <div
              className={cn(
                "flex gap-0.5 mt-1 transition-opacity",
                isBookmarked
                  ? "opacity-100"
                  : "opacity-0 group-hover/message:opacity-100",
                isUser ? "flex-row-reverse" : "flex-row"
              )}
            >
              <Button
                variant="ghost"
                size="icon"
                onClick={handleBookmark}
                className={cn(
                  "h-7 w-7",
                  isBookmarked && "text-amber-500 hover:text-amber-500"
                )}
                aria-label={isBookmarked ? "Remove bookmark" : "Bookmark message"}
                title={isBookmarked ? "Remove bookmark" : "Bookmark"}
              >
                <Bookmark
                  size={14}
                  fill={isBookmarked ? "currentColor" : "none"}
                />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCopy}
                className="h-7 w-7"
                aria-label="Copy message"
                title="Copy"
              >
                <Copy size={14} />
              </Button>
              {isUser && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={startEdit}
                  className="h-7 w-7"
                  aria-label="Edit message"
                  title="Edit and resend"
                >
                  <Pencil size={14} />
                </Button>
              )}
              {!isUser && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleSendToEditor}
                    className="h-7 w-7"
                    aria-label="Send to editor"
                    title="Send to editor"
                  >
                    <Send size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onRegenerateAssistantMessage(message.id)}
                    className="h-7 w-7"
                    aria-label="Regenerate response"
                    title="Regenerate"
                  >
                    <RotateCcw size={14} />
                  </Button>
                  {onForkFromMessage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onForkFromMessage(message.id)}
                      className="h-7 w-7"
                      aria-label="Branch from here"
                      title="Branch from here — start a new chat copied up to this message"
                    >
                      <GitBranch size={14} />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleSaveAsArtifact}
                    className="h-7 w-7"
                    aria-label="Save as artifact"
                    title="Save as artifact"
                  >
                    <Archive size={14} />
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onDelete(message.id)}
                className="h-7 w-7 text-[var(--destructive)] hover:text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                aria-label="Delete message"
                title="Delete"
              >
                <Trash2 size={14} />
              </Button>
            </div>
          )}
          {!isUser &&
            !isEditing &&
            isLastAssistant &&
            message.suggestions &&
            message.suggestions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {message.suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onPickSuggestion?.(s)}
                    className={cn(
                      "text-xs px-3 py-1 rounded-full border border-[var(--border)]",
                      "bg-[var(--background)]/60 text-[var(--foreground)]",
                      "hover:bg-[var(--accent)] hover:border-[var(--ring)] transition-colors",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
        </div>
        )}
      </div>
      <SaveArtifactDialog
        open={pickerBlocks !== null}
        blocks={pickerBlocks ?? []}
        onCancel={() => setPickerBlocks(null)}
        onConfirm={handlePickerConfirm}
      />
    </div>
  )
}

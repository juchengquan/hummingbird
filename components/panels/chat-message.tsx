"use client"

import { memo, useState, useRef, useEffect } from "react"
import type { Message } from "@/shared/types"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Copy, Pencil, Trash2, RotateCcw, Check, X, Bookmark, Archive, Send, GitBranch } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/shared/utils"
import { copyText } from "@/client/export"
import { extractCodeBlocks } from "@/shared/code-blocks"
import { MarkdownPreview } from "@/components/markdown-preview"
import { ToolCallStrip, type LiveToolCall } from "@/components/skills/tool-call-strip"
import { MessageAttachments } from "@/components/panels/message-attachments"
import { ReasoningBlock } from "@/components/panels/reasoning-block"
import { SourcesStrip } from "@/components/panels/sources-strip"
import { ErrorBubble } from "@/components/panels/error-bubble"
import { useStore, useMessageBookmark } from "@/client/hooks/use-store"
import type { ArtifactKind } from "@/shared/types"
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

function ChatMessageImpl({
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
  // Track which `[N]` citation the user just clicked so the SourcesStrip
  // can scroll-and-flash the matching card. Local state — the strip
  // observes the value, scrolls, flashes for 1.2s, then we're done.
  const [highlightedCitation, setHighlightedCitation] = useState<number | null>(null)

  // Derive the persisted webSearch results (if any) for the Sources
  // strip + `[N]` citation markers. We only thread through the
  // *persisted* tool calls — `liveToolCalls` is the in-flight buffer
  // used by the small status pill above, not for the final source list.
  const webSearchResults = (() => {
    const webCall = message.toolCalls?.find(
      (t) => t.name === "webSearch" && t.results && t.results.length > 0
    )
    return webCall?.results ?? null
  })()

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
            // Selection-driven actions (Explain / Quote) scope themselves
            // to assistant messages by matching this attribute. User
            // bubbles are intentionally excluded — selecting your own
            // text and asking the model to explain it would be weird.
            {...(!isUser ? { "data-selection-scope": `message-${message.id}` } : {})}
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
                    className="markdown-chat-bubble text-[15px] p-0 overflow-visible"
                    pdfCitationFileId={pdfCitationFileId}
                    sourceCount={webSearchResults?.length ?? 0}
                    onSourceClick={(idx) => setHighlightedCitation(idx)}
                  />
                ) : (
                  <p className="text-[15px] whitespace-pre-wrap">{message.content}</p>
                )}
                {!isUser && webSearchResults && webSearchResults.length > 0 && (
                  <SourcesStrip
                    results={webSearchResults}
                    highlightedIndex={highlightedCitation}
                  />
                )}
                {isUser &&
                  message.attachedFileIds &&
                  message.attachedFileIds.length > 0 && (
                    <MessageAttachments
                      fileIds={message.attachedFileIds}
                      align="end"
                    />
                  )}
              </>
            )}
          </div>

          {!isEditing && (
            <div
              className={cn(
                "flex items-center gap-1 mt-1",
                isUser ? "flex-row-reverse" : "flex-row"
              )}
            >
              {/* Actions cluster — sits at the bubble side (outer edge of
                  the row). flex-row-reverse on user messages flips the
                  visual order so actions stay anchored to the bubble. */}
              <div
                className={cn(
                  "flex gap-0.5 transition-opacity",
                  isBookmarked
                    ? "opacity-100"
                    : "opacity-0 group-hover/message:opacity-100"
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
              {/* Timestamp — sits next to (inner-side of) the action
                  cluster so it doesn't anchor at the bubble's outer edge.
                  Same hover-reveal as the actions. */}
              <p
                className={cn(
                  "text-xs text-[var(--muted-foreground)] px-1 transition-opacity",
                  isBookmarked
                    ? "opacity-60"
                    : "opacity-0 group-hover/message:opacity-60"
                )}
              >
                <MessageTime timestamp={message.timestamp} />
              </p>
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

/**
 * Memoized public export. Long conversations re-render the whole message
 * list every time the chat panel updates (typing flag, scroll position,
 * input value). With memo, only messages whose props actually changed
 * re-render — relies on the parent passing stable callback refs (it
 * does, via `useCallback` in chat.tsx).
 */
export const ChatMessage = memo(ChatMessageImpl)
ChatMessage.displayName = "ChatMessage"

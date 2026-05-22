"use client"

import { memo, useState, useRef, useEffect } from "react"
import type { Message } from "@/shared/types"
import { isWebSearchToolName } from "@/shared/skills/types"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Copy, Pencil, RotateCcw, Check, X, Bookmark, Archive, Send, GitBranch } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/shared/utils"
import { copyText } from "@/client/export"
import { extractCodeBlocks } from "@/shared/code-blocks"
import { MarkdownPreview } from "@/components/markdown-preview"
import { MessageLiveArtifacts } from "@/components/live-artifact/message-live-artifacts"
import { ToolCallStrip, type LiveToolCall } from "@/components/skills/tool-call-strip"
import { GeneratedImagesGallery } from "@/components/skills/generated-images-gallery"
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
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"

function formatTime(timestamp: Date | string): string {
  const date = new Date(timestamp)
  const hours = date.getHours()
  const minutes = date.getMinutes()
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

  // Derive the persisted web-search results (if any) for the Sources
  // strip + `[N]` citation markers. We only thread through the
  // *persisted* tool calls — `liveToolCalls` is the in-flight buffer
  // used by the small status pill above, not for the final source list.
  //
  // The single `webSearch` tool already merges results from multiple
  // providers server-side, so we just flatten any matching tool calls
  // on this message. `isWebSearchToolName` is used here so a future
  // additional web-search tool name (e.g. a separate "research" tool)
  // would slot in automatically.
  const webSearchResults = (() => {
    const calls = (message.toolCalls ?? []).filter(
      (t) => isWebSearchToolName(t.name) && t.results && t.results.length > 0
    )
    if (calls.length === 0) return null
    const merged = calls.flatMap((c) => c.results ?? [])
    return merged.length > 0 ? merged : null
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
  const uncompressRecap = useStore((s) => s.uncompressRecap)
  const createArtifact = useStore((s) => s.createArtifact)
  const appendToActiveDocumentOrCreate = useStore(
    (s) => s.appendToActiveDocumentOrCreate
  )
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

  // Shared sizing + hover-box treatment for every action button in the
  // toolbar. The inset ring on hover gives each button a visible boxed
  // outline so the affordance reads as a discrete target, not just a
  // tinted background.
  const actionBtnClass =
    "h-7 w-7 hover:ring-1 hover:ring-inset hover:ring-[var(--border)]"

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
    // Appends to the currently open document, creating one in the active
    // workspace if none exists yet. `---` separator between fragments
    // preserves prior content.
    appendToActiveDocumentOrCreate(message.content)
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

  // Recap and compressed messages take their own bespoke render paths
  // and skip the regular user/assistant bubble + actions row. They're
  // special enough that branching here keeps the main flow readable.
  if (message.kind === "recap") {
    return (
      <RecapCard
        message={message}
        onUndo={() => {
          if (!activeConversationId) return
          uncompressRecap(activeConversationId, message.id)
          toast.success("Restored compressed messages")
        }}
        index={index}
      />
    )
  }
  if (message.compressed) {
    return <CompressedRow message={message} index={index} />
  }

  return (
    <div
      id={`chat-message-${message.id}`}
      className={cn(
        // `min-w-0` lets this row shrink when it ends up inside a flex
        // parent; `overflow-x-clip` is a defensive backstop so a
        // pathologically wide child (long URL, monospaced code line,
        // a too-tall image, …) can never push the conversation
        // column past its `max-w-5xl` boundary on the right.
        "group/message animate-message-in scroll-mt-20 min-w-0 overflow-x-clip",
        isBookmarked && "rounded-md ring-1 ring-amber-400/30"
      )}
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className={cn("flex min-w-0 w-full", isUser ? "flex-row-reverse" : "flex-row")}>
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
        <div className={cn("flex flex-col min-w-0", isUser ? "items-end max-w-[90%]" : "items-start w-full")}>
          <div
            className={cn(
              // `min-w-0` lets the flex item shrink below its
              // intrinsic content width; `wrap-anywhere` is more
              // aggressive than `break-words` — it allows breaking at
              // any character when the content would otherwise
              // overflow, which is what we need for long URLs and
              // no-space code blobs in user messages. Without it the
              // bubble can push past `max-w-[90%]` on the right.
              "animate-content-in w-full min-w-0 wrap-anywhere",
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
                    // Suppress markdown-embedded `<img>` tags when this
                    // message already shows a gallery — keeps the
                    // model's helpful `![](url)` from double-rendering.
                    suppressImages={!!message.generatedImages?.length}
                  />
                ) : (
                  <p className="text-[15px] whitespace-pre-wrap wrap-anywhere">{message.content}</p>
                )}
                {!isUser && webSearchResults && webSearchResults.length > 0 && (
                  <SourcesStrip
                    results={webSearchResults}
                    highlightedIndex={highlightedCitation}
                  />
                )}
                {!isUser && <MessageLiveArtifacts messageId={message.id} />}
                {!isUser &&
                  message.generatedImages &&
                  message.generatedImages.length > 0 && (
                    <GeneratedImagesGallery images={message.generatedImages} />
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleBookmark}
                    className={cn(
                      actionBtnClass,
                      isBookmarked && "text-amber-500 hover:text-amber-500"
                    )}
                    aria-label={isBookmarked ? "Remove bookmark" : "Bookmark message"}
                  >
                    <Bookmark
                      size={14}
                      fill={isBookmarked ? "currentColor" : "none"}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {isBookmarked ? "Remove bookmark" : "Bookmark"}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleCopy}
                    className={actionBtnClass}
                    aria-label="Copy message"
                  >
                    <Copy size={14} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Copy</TooltipContent>
              </Tooltip>
              {isUser && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={startEdit}
                      className={actionBtnClass}
                      aria-label="Edit message"
                    >
                      <Pencil size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Edit and resend</TooltipContent>
                </Tooltip>
              )}
              {!isUser && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleSendToEditor}
                        className={actionBtnClass}
                        aria-label="Send to editor"
                      >
                        <Send size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Send to editor</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onRegenerateAssistantMessage(message.id)}
                        className={actionBtnClass}
                        aria-label="Retry response"
                      >
                        <RotateCcw size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Retry</TooltipContent>
                  </Tooltip>
                  {onForkFromMessage && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onForkFromMessage(message.id)}
                          className={actionBtnClass}
                          aria-label="Branch from here"
                        >
                          <GitBranch size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        Branch from here
                      </TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleSaveAsArtifact}
                        className={actionBtnClass}
                        aria-label="Save as artifact"
                      >
                        <Archive size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Save as artifact</TooltipContent>
                  </Tooltip>
                </>
              )}
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

/**
 * Synthetic recap message inserted by the "Compress older messages"
 * action. Rendered as a distinct full-width card with an Undo control
 * so it can't be confused with a regular assistant turn.
 */
function RecapCard({
  message,
  onUndo,
  index,
}: {
  message: Message
  onUndo: () => void
  index: number
}) {
  const count = message.recapMessageIds?.length ?? 0
  return (
    <div
      className="animate-message-in scroll-mt-20"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="my-3 rounded-md border border-dashed border-[var(--border)] bg-[var(--muted)]/30 px-3 py-2.5 text-sm">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
            <Archive size={11} />
            Recap of {count} compressed message{count === 1 ? "" : "s"}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onUndo}
            className="h-6 gap-1 text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            aria-label="Restore compressed messages"
          >
            <RotateCcw size={10} />
            Undo
          </Button>
        </div>
        <MarkdownPreview content={message.content} className="text-sm" />
      </div>
    </div>
  )
}

/**
 * Single-line muted placeholder for a compressed message. Keeps the
 * scroll position recognisable (so users can see the conversation
 * structure) without taking up vertical space. Includes a short
 * preview of the original content so users remember roughly what was
 * there.
 */
function CompressedRow({
  message,
  index,
}: {
  message: Message
  index: number
}) {
  const preview = message.content.replace(/\s+/g, " ").slice(0, 120)
  return (
    <div
      className="animate-message-in scroll-mt-20 -my-1"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-[var(--muted-foreground)]/80 italic">
        <span className="opacity-70 not-italic font-medium">
          {message.role === "user" ? "You" : "Assistant"}
        </span>
        <span className="opacity-60 truncate">
          {preview}
          {message.content.length > 120 ? "…" : ""}
        </span>
        <span className="opacity-60 not-italic shrink-0">(compressed)</span>
      </div>
    </div>
  )
}

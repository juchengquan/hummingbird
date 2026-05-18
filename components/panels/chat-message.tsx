"use client"

import { useState, useRef, useEffect } from "react"
import type { Message, MessageError } from "@/lib/types"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { User, Bot, Copy, Pencil, Trash2, RotateCcw, Check, X, Bookmark, AlertTriangle, ChevronDown, Archive, Send } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { copyText } from "@/lib/export"
import { extractCodeBlocks } from "@/lib/code-blocks"
import { MarkdownPreview } from "@/components/markdown-preview"
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
  streaming,
}: {
  reasoning: string
  /** When true (the message has reasoning but no content yet), open by default
   *  so the user sees the model is actively thinking. */
  streaming: boolean
}) {
  const [open, setOpen] = useState(streaming)
  // Re-open automatically when a new streaming session begins.
  useEffect(() => {
    if (streaming) setOpen(true)
  }, [streaming])
  return (
    <div className="mb-2 rounded-md border border-[var(--border)] bg-[var(--background)]/60 text-[var(--muted-foreground)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-xs hover:bg-[var(--accent)]/50 rounded-md transition-colors"
        aria-expanded={open}
      >
        <ChevronDown
          size={12}
          className={cn("transition-transform", !open && "-rotate-90")}
        />
        <span>{streaming ? "Thinking…" : "Reasoning"}</span>
      </button>
      {open && (
        <pre className="px-3 pb-2 pt-0 text-[11px] whitespace-pre-wrap break-words font-mono leading-relaxed">
          {reasoning}
        </pre>
      )}
    </div>
  )
}

interface ChatMessageProps {
  message: Message
  index: number
  onDelete: (messageId: string) => void
  onEditUserMessage: (messageId: string, newContent: string) => void
  onRegenerateAssistantMessage: (messageId: string) => void
  onRetryError?: (messageId: string) => void
  onChangeModel?: () => void
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
  onDelete,
}: {
  error: MessageError
  partialContent: string
  onRetry: () => void
  onChangeModel?: () => void
  onDelete: () => void
}) {
  const [showDetails, setShowDetails] = useState(false)
  const title = ERROR_TITLES[error.code] ?? ERROR_TITLES.unknown
  return (
    <div className="rounded-lg border border-[var(--destructive)]/40 bg-[var(--destructive)]/5 px-4 py-3 max-w-[70%] space-y-2">
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
        <Button size="sm" variant="secondary" onClick={onRetry} className="h-7 gap-1.5 text-xs">
          <RotateCcw size={12} />
          Retry
        </Button>
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
  onDelete,
  onEditUserMessage,
  onRegenerateAssistantMessage,
  onRetryError,
  onChangeModel,
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
      <div className={cn("flex gap-3", isUser ? "flex-row-reverse" : "flex-row")}>
        <Avatar className="w-8 h-8 mt-1 animate-avatar-in">
          <AvatarImage src="" />
          <AvatarFallback className="text-xs">
            {isUser ? <User size={16} /> : <Bot size={16} />}
          </AvatarFallback>
        </Avatar>

        {message.error && !isUser ? (
          <ErrorBubble
            error={message.error}
            partialContent={message.content}
            onRetry={() => onRetryError?.(message.id)}
            onChangeModel={onChangeModel}
            onDelete={() => onDelete(message.id)}
          />
        ) : (
        <div className={cn("flex flex-col max-w-[70%]", isUser ? "items-end" : "items-start")}>
          <div
            className={cn(
              "rounded-lg px-4 py-2 animate-content-in w-full",
              isUser
                ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "bg-[var(--secondary)] text-[var(--foreground)]"
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
                  <ReasoningBlock reasoning={message.reasoning} streaming={!message.content} />
                )}
                {!isUser && message.content ? (
                  <MarkdownPreview
                    content={message.content}
                    className="markdown-chat-bubble text-sm p-0 overflow-visible"
                  />
                ) : (
                  <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                )}
                <p
                  className={cn(
                    "text-xs mt-1 opacity-60",
                    isUser
                      ? "text-[var(--primary-foreground)]"
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

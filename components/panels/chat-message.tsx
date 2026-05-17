"use client"

import { useState, useRef, useEffect } from "react"
import { Message } from "@/lib/types"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { User, Bot, Copy, Pencil, Trash2, RotateCcw, Check, X } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { copyText } from "@/lib/export"

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
  onDelete: (messageId: string) => void
  onEditUserMessage: (messageId: string, newContent: string) => void
  onRegenerateAssistantMessage: (messageId: string) => void
}

export function ChatMessage({
  message,
  index,
  onDelete,
  onEditUserMessage,
  onRegenerateAssistantMessage,
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
      className="group/message animate-message-in"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className={cn("flex gap-3", isUser ? "flex-row-reverse" : "flex-row")}>
        <Avatar className="w-8 h-8 mt-1 animate-avatar-in">
          <AvatarImage src="" />
          <AvatarFallback className="text-xs">
            {isUser ? <User size={16} /> : <Bot size={16} />}
          </AvatarFallback>
        </Avatar>

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
                <p className="text-sm whitespace-pre-wrap">{message.content}</p>
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
                "flex gap-0.5 mt-1 opacity-0 group-hover/message:opacity-100 transition-opacity",
                isUser ? "flex-row-reverse" : "flex-row"
              )}
            >
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
      </div>
    </div>
  )
}

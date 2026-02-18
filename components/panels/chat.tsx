"use client"

import { useState, useRef, useEffect, useMemo, useCallback } from "react"
import { useStore, useActiveConversation, useHydrated, useSessionStore } from "@/lib/hooks/use-store"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { InputGroup, InputGroupTextarea, InputGroupButton } from "@/components/ui/input-group"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { CustomScrollbar } from "@/components/ui/custom/scrollbar"
import { cn } from "@/lib/utils"
import { formatFileSize, getFileIcon } from "@/lib/file-utils"
import { Plus, Send, User, Bot, ChevronDown, Files, X } from "lucide-react"

// Helper function to format time in UTC to avoid hydration mismatch
function formatTime(timestamp: Date | string): string {
  const date = new Date(timestamp)
  const hours = date.getUTCHours()
  const minutes = date.getUTCMinutes()
  const ampm = hours >= 12 ? "PM" : "AM"
  const hour12 = hours % 12 || 12
  const minuteStr = minutes.toString().padStart(2, "0")
  return `${hour12}:${minuteStr} ${ampm}`
}

// Client-only time component to avoid hydration mismatch
function MessageTime({ timestamp }: { timestamp: Date | string }) {
  const [time, setTime] = useState<string>("")

  useEffect(() => {
    setTime(formatTime(timestamp))
  }, [timestamp])

  if (!time) return null
  return <>{time}</>
}

// Selected Files Popover Component
function SelectedFilesPopover() {
  const files = useStore((state) => state.files)
  const { selectedFileIds, toggleFileSelection } = useSessionStore()
  const selectedFiles = files.filter((f) => selectedFileIds.includes(f.id))

  return (
    <Popover>
      <PopoverTrigger asChild>
        <InputGroupButton
          size="icon-sm"
          className="rounded-full transition-transform hover:scale-110 active:scale-95"
          aria-label="View selected files"
        >
          <Files size={20} />
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        className="w-72 p-2"
        sideOffset={8}
      >
        <div className="text-sm font-medium text-[var(--foreground)] mb-2">
          Selected Files ({selectedFiles.length})
        </div>
        {selectedFiles.length === 0 ? (
          <p className="text-sm text-[var(--muted-foreground)] py-2">
            No files selected
          </p>
        ) : (
          <CustomScrollbar height="192px" innerClassName="space-y-1 pr-2">
            {selectedFiles.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-2 p-2 rounded hover:bg-[var(--secondary)] transition-colors cursor-pointer min-w-0"
              >
                <div className="shrink-0">{getFileIcon(file.type)}</div>
                <span className="flex-1 min-w-0 truncate text-sm text-[var(--foreground)]">
                  {file.name}
                </span>
                <button
                  onClick={() => toggleFileSelection(file.id)}
                  className="shrink-0 p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--destructive)] hover:text-[var(--destructive-foreground)] transition-colors"
                  aria-label="Remove file"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </CustomScrollbar>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function ChatPanel() {
  const { addMessage, isTyping, setIsTyping, setEditorContent } = useStore()
  const activeConversation = useActiveConversation()
  const hydrated = useHydrated()
  const [inputValue, setInputValue] = useState("")
  const [showScrollButton, setShowScrollButton] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const messages = useMemo(() => activeConversation?.messages || [], [activeConversation])

  // Auto-scroll to bottom when new messages appear (only if already at bottom)
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // Handle scroll event to show/hide scroll button
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement
    const { scrollTop, scrollHeight, clientHeight } = target
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100
    setShowScrollButton(!isAtBottom)
  }, [])

  // Scroll to bottom function
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
    setShowScrollButton(false)
  }, [])

  const simulateAIResponse = (userMessage: string) => {
    // Show typing indicator
    setIsTyping(true)

    // Simulate AI response delay
    setTimeout(() => {
      const responses = [
        "That's an interesting question! Let me think about it...",
        "I understand what you're asking. Here's my response:",
        "Thanks for sharing that! Based on what you've told me, I would say:",
        "That's a great point. Here's my take on it:",
        "I appreciate you asking! Here's what I think:",
      ]

      const randomResponse = responses[Math.floor(Math.random() * responses.length)]
      const additionalContent = `\n\nRegarding "${userMessage}": This is a mock response for testing purposes. In a real implementation, this would connect to an AI API to generate contextual responses based on your input.`

      addMessage({
        role: "assistant",
        content: randomResponse + additionalContent,
      })

      setIsTyping(false)
    }, 300) // Random delay between 1.5-2.5 seconds
  }

  const handleSendMessage = () => {
    if (!inputValue.trim()) return

    const messageContent = inputValue.trim()

    addMessage({
      role: "user",
      content: messageContent,
    })

    // Sync to editor panel
    setEditorContent(messageContent)

    setInputValue("")

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }

    // Trigger AI response
    simulateAIResponse(messageContent)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value)
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`
    }
  }

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
    <div className="flex flex-col h-full relative">
      <div className="flex-1 min-h-0 overflow-hidden pb-[10vh]">
        <ScrollArea className="max-h-[90vh] h-[90vh] px-4" onScroll={handleScroll}>
          <div className="py-4 pb-20 space-y-4">
            {messages.length === 0 ? (
            <div className="text-center text-[var(--muted-foreground)] py-8">
              <p className="text-sm">Start a conversation</p>
            </div>
          ) : (
            messages.map((message, index) => (
              <div
                key={message.id}
                className="animate-message-in"
                style={{ animationDelay: `${index * 50}ms` }}
              >
                <div
                  className={cn(
                    "flex gap-3",
                    message.role === "user" ? "flex-row-reverse" : "flex-row"
                  )}
                >
                  {/* Avatar */}
                  <Avatar className="w-8 h-8 mt-1 animate-avatar-in">
                    <AvatarImage src="" />
                    <AvatarFallback className="text-xs">
                      {message.role === "user" ? (
                        <User size={16} />
                      ) : (
                        <Bot size={16} />
                      )}
                    </AvatarFallback>
                  </Avatar>

                  {/* Message Content */}
                  <div
                    className={cn(
                      "max-w-[70%] rounded-lg px-4 py-2 animate-content-in",
                      message.role === "user"
                        ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                        : "bg-[var(--secondary)] text-[var(--foreground)]"
                    )}
                  >
                    <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                    <p
                      className={cn(
                        "text-xs mt-1 opacity-60",
                        message.role === "user"
                          ? "text-[var(--primary-foreground)]"
                          : "text-[var(--muted-foreground)]"
                      )}
                    >
                      <MessageTime timestamp={message.timestamp} />
                    </p>
                  </div>
                </div>
              </div>
            ))
          )}

          {/* Typing indicator */}
          {isTyping && (
            <div className="flex gap-3">
              <Avatar className="w-8 h-8 mt-1">
                <AvatarFallback className="text-xs">
                  <Bot size={16} />
                </AvatarFallback>
              </Avatar>
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

      {/* Scroll to bottom button */}
      {/* {showScrollButton && ( */}
      <Button
        variant="secondary"
        size="icon"
        className="absolute bottom-20 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-md animate-scroll-button-in"
        onClick={scrollToBottom}
        aria-label="Scroll to bottom"
      >
        <ChevronDown size={18} />
      </Button>
      {/* )} */}

      {/* Input Bar - fixed at bottom, grows upwards */}
      <div className="absolute bottom-2 left-0 right-0 border-[var(--border)] px-4 bg-background-transparant animate-input-bar-in">
        <InputGroup className="max-w-4xl mx-auto rounded-[1vw] bg-background">
          <InputGroupButton
            // variant="default"
            size="icon-sm"
            className="ml-2 rounded-full transition-transform hover:scale-110 active:scale-95"
            aria-label="Add attachments"
          >
            <Plus size={20} />
          </InputGroupButton>
          <SelectedFilesPopover />
          <InputGroupTextarea
            ref={textareaRef}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Ask me anthing!"
            rows={1}
            className="min-h-[44px] max-h-[160px] m-2 transition-all focus:ring-2 focus:ring-primary/30"
            style={{
              // scrollbarWidth: "thin",
              scrollbarColor: "var(--muted-foreground) transparent",
              // scrollbarGutter: "stable",
            }}
          />
          {/* <InputGroupButton
            variant="default"
            size="icon-sm"
            className="rounded-full"
            onClick={handleSendMessage}
            disabled={!inputValue.trim()}
            aria-label="Send message"
          >
            <Send size={18} />
          </InputGroupButton> */}
        </InputGroup>
        <p className="text-xs text-center text-[var(--muted-foreground)] mt-2 italic">
          AI is not silver bullet!
        </p>
      </div>
    </div>
  )
}

"use client"

import { useState, useRef, useEffect, useMemo, useCallback } from "react"
import { toast } from "sonner"
import { useStore, useHydrated } from "@/lib/hooks/use-store"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { InputGroup, InputGroupTextarea, InputGroupButton } from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ChatResourcesPanel } from "@/components/panels/chat-resources-panel"
import { ChatMessage } from "@/components/panels/chat-message"
import { Plus, Bot, ChevronDown, Square } from "lucide-react"
import { CHAT_MODELS } from "@/lib/models"
import type { Message } from "@/lib/types"

export function ChatPanel() {
  const addMessage = useStore((state) => state.addMessage)
  const deleteMessage = useStore((state) => state.deleteMessage)
  const updateMessage = useStore((state) => state.updateMessage)
  const appendToMessage = useStore((state) => state.appendToMessage)
  const truncateMessagesAfter = useStore((state) => state.truncateMessagesAfter)
  const isTyping = useStore((state) => state.isTyping)
  const setIsTyping = useStore((state) => state.setIsTyping)
  const chatModel = useStore((state) => state.chatModel)
  const setChatModel = useStore((state) => state.setChatModel)
  const files = useStore((state) => state.files)
  const activeConversationId = useStore((state) => state.activeConversationId)
  const conversations = useStore((state) => state.conversations)
  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) || null,
    [conversations, activeConversationId]
  )
  const hydrated = useHydrated()
  const [inputValue, setInputValue] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [, setShowScrollButton] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const messages = useMemo(() => activeConversation?.messages || [], [activeConversation])

  // Auto-scroll the ScrollArea viewport (not via scrollIntoView, which can
  // scroll unintended ancestors) when new messages or the typing indicator appear.
  useEffect(() => {
    const end = messagesEndRef.current
    if (!end) return
    const viewport = end.closest(
      '[data-slot="scroll-area-viewport"]'
    ) as HTMLElement | null
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [messages, isTyping])

  // Handle scroll event to show/hide scroll button
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement
    const { scrollTop, scrollHeight, clientHeight } = target
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100
    setShowScrollButton(!isAtBottom)
  }, [])

  // Scroll the ScrollArea viewport directly — never via scrollIntoView,
  // which can scroll unintended ancestors.
  const scrollToBottom = useCallback(() => {
    const end = messagesEndRef.current
    if (!end) return
    const viewport = end.closest(
      '[data-slot="scroll-area-viewport"]'
    ) as HTMLElement | null
    if (viewport) {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" })
    }
    setShowScrollButton(false)
  }, [])

  // Mock fallback used when the AI Gateway key isn't configured.
  const mockAIResponse = useCallback(
    (userMessage: string) => {
      setIsTyping(true)
      setTimeout(() => {
        const aiContent = `_Mock response (set \`AI_GATEWAY_API_KEY\` to enable real AI)_\n\nRegarding "${userMessage}": this is placeholder text.`
        addMessage({ role: "assistant", content: aiContent })
        setIsTyping(false)
      }, 300)
    },
    [setIsTyping, addMessage]
  )

  // Build the message list and file context the API expects, sent up to and
  // including the most recent user message.
  const callChatAPI = useCallback(
    async (history: Message[]) => {
      const conv = conversations.find((c) => c.id === activeConversationId)
      const fileSummaries =
        conv?.selectedFileIds
          .map((id) => files.find((f) => f.id === id))
          .filter((f): f is NonNullable<typeof f> => Boolean(f))
          .map((f) => ({ name: f.name, size: f.size, type: f.type })) ?? []

      const controller = new AbortController()
      abortControllerRef.current = controller
      setIsTyping(true)
      setIsStreaming(true)
      let placeholder: Message | null = null
      let firstChunk = true

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: chatModel,
            messages: history.map((m) => ({ role: m.role, content: m.content })),
            files: fileSummaries,
          }),
        })

        if (res.status === 401) {
          setIsTyping(false)
          setIsStreaming(false)
          const lastUser = [...history].reverse().find((m) => m.role === "user")
          if (lastUser) mockAIResponse(lastUser.content)
          return
        }

        if (!res.ok || !res.body) {
          throw new Error(`Chat request failed (${res.status})`)
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          if (firstChunk) {
            setIsTyping(false)
            placeholder = addMessage({ role: "assistant", content: chunk })
            firstChunk = false
          } else if (placeholder) {
            appendToMessage(placeholder.id, chunk)
          }
        }

        const tail = decoder.decode()
        if (tail && placeholder) appendToMessage(placeholder.id, tail)

        if (firstChunk) {
          addMessage({
            role: "assistant",
            content: "_The model returned an empty response._",
          })
        }
      } catch (err) {
        const aborted =
          (err instanceof DOMException && err.name === "AbortError") ||
          controller.signal.aborted
        if (aborted) {
          if (placeholder) appendToMessage(placeholder.id, "\n\n_[stopped]_")
        } else {
          const message = err instanceof Error ? err.message : "Unknown error"
          toast.error(`Chat failed: ${message}`)
          if (!placeholder) {
            addMessage({
              role: "assistant",
              content: `_Error: ${message}_`,
            })
          }
        }
      } finally {
        setIsTyping(false)
        setIsStreaming(false)
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null
        }
      }
    },
    [
      activeConversationId,
      addMessage,
      appendToMessage,
      chatModel,
      conversations,
      files,
      mockAIResponse,
      setIsTyping,
    ]
  )

  const callChatAPIRef = useRef(callChatAPI)
  useEffect(() => {
    callChatAPIRef.current = callChatAPI
  }, [callChatAPI])

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort()
  }, [])

  const handleSendMessage = () => {
    if (!inputValue.trim() || isStreaming) return

    const messageContent = inputValue.trim()
    const userMessage = addMessage({
      role: "user",
      content: messageContent,
    })

    setInputValue("")

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
    <div className="flex h-full">
      {/* Messages column */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0 relative">
        <div className="flex-1 min-h-0 overflow-hidden">
          <ScrollArea className="max-w-5xl mx-auto max-h-[95vh] h-[95vh] px-4" onScroll={handleScroll}>
            <div className="max-w-5xl mx-auto px-4 py-4 pb-24 space-y-4">
              {messages.length === 0 ? (
                <div className="text-center text-[var(--muted-foreground)] py-8">
                  <p className="text-sm">Start a conversation</p>
                </div>
              ) : (
                messages.map((message, index) => (
                  <ChatMessage
                    key={message.id}
                    message={message}
                    index={index}
                    onDelete={deleteMessage}
                    onEditUserMessage={handleEditUserMessage}
                    onRegenerateAssistantMessage={handleRegenerateAssistantMessage}
                  />
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
        <Button
          variant="secondary"
          size="icon"
          className="absolute bottom-20 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-md animate-scroll-button-in"
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
        >
          <ChevronDown size={18} />
        </Button>

        {/* Input Bar - fixed at bottom of messages column, grows upwards */}
        <div className="absolute bottom-2 inset-x-0 border-[var(--border)] px-4 bg-background-transparant animate-input-bar-in">
          <InputGroup className="max-w-4xl mx-auto rounded-[1vw] bg-background">
            <InputGroupButton
              size="icon-sm"
              className="ml-2 rounded-full transition-transform hover:scale-110 active:scale-95"
              aria-label="Add attachments"
            >
              <Plus size={20} />
            </InputGroupButton>
            <InputGroupTextarea
              ref={textareaRef}
              value={inputValue}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask me anthing!"
              rows={1}
              className="min-h-[44px] max-h-[160px] m-2 transition-all focus:outline-none focus:ring-2 focus:ring-primary/30"
              style={{
                scrollbarColor: "var(--muted-foreground) transparent",
              }}
            />
            {isStreaming && (
              <InputGroupButton
                size="icon-sm"
                onClick={handleStop}
                className="mr-2 rounded-full bg-[var(--destructive)]/10 text-[var(--destructive)] hover:bg-[var(--destructive)]/20 transition-transform hover:scale-110 active:scale-95"
                aria-label="Stop generating"
                title="Stop"
              >
                <Square size={14} fill="currentColor" />
              </InputGroupButton>
            )}
          </InputGroup>
          <div className="mt-2 flex items-center justify-center gap-3">
            <Select value={chatModel} onValueChange={setChatModel}>
              <SelectTrigger
                size="sm"
                className="h-6 text-xs gap-1 border-none bg-transparent hover:bg-[var(--secondary)]"
                aria-label="Model"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(
                  CHAT_MODELS.reduce<Record<string, typeof CHAT_MODELS>>((acc, m) => {
                    if (!acc[m.provider]) acc[m.provider] = []
                    acc[m.provider].push(m)
                    return acc
                  }, {})
                ).map(([provider, models]) => (
                  <SelectGroup key={provider}>
                    <SelectLabel>{provider}</SelectLabel>
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-[var(--muted-foreground)] italic">
              AI is not a silver bullet!
            </span>
          </div>
        </div>
      </div>

      {/* Resources side panel */}
      <ChatResourcesPanel />
    </div>
  )
}

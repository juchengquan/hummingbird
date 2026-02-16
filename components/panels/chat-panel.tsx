"use client"

import { useState } from "react"
import { useStore } from "@/lib/hooks/use-store"
import { PanelContainer } from "@/components/panel-container"
import { Plus, MessageSquare, Search, MoreVertical, Trash2, Edit3 } from "lucide-react"
import { cn } from "@/lib/utils"
import { format } from "date-fns"

export function ChatSessionsPanel() {
  const {
    conversations,
    activeConversationId,
    createConversation,
    deleteConversation,
    renameConversation,
    setActiveConversation,
  } = useStore()

  const [searchQuery, setSearchQuery] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState("")

  const filteredConversations = conversations.filter((conv) =>
    conv.title.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleCreateConversation = () => {
    createConversation()
  }

  const handleStartRename = (id: string, title: string) => {
    setEditingId(id)
    setEditingTitle(title)
  }

  const handleSaveRename = () => {
    if (editingId && editingTitle.trim()) {
      renameConversation(editingId, editingTitle.trim())
    }
    setEditingId(null)
    setEditingTitle("")
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSaveRename()
    } else if (e.key === "Escape") {
      setEditingId(null)
      setEditingTitle("")
    }
  }

  return (
    <PanelContainer
      title="Sessions"
    >
      <div className="flex flex-col h-full">
        {/* New conversation button */}
        <div className="p-3 border-b border-[var(--border)]">
          <button
            onClick={handleCreateConversation}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-[var(--primary)] text-[var(--primary-foreground)] rounded-md font-medium text-sm hover:bg-[#d97706] transition-colors"
          >
            <Plus size={16} />
            New Session
          </button>
        </div>

        {/* Search */}
        <div className="p-3 border-b border-[var(--border)]">
          <div className="relative">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
            />
            <input
              type="text"
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-[var(--secondary)] border border-[var(--border)] rounded-md text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:border-[var(--primary)]"
            />
          </div>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {filteredConversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-4">
              <MessageSquare
                size={32}
                className="text-[var(--muted-foreground)] mb-2"
              />
              <p className="text-sm text-[var(--muted-foreground)]">
                {searchQuery
                  ? "No conversations found"
                  : "No conversations yet"}
              </p>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {filteredConversations.map((conv) => (
                <div
                  key={conv.id}
                  className={cn(
                    "group flex items-center gap-2 p-3 rounded-md cursor-pointer transition-all",
                    activeConversationId === conv.id
                      ? "bg-[var(--secondary)] border border-[var(--primary)]"
                      : "hover:bg-[var(--secondary)] border border-transparent"
                  )}
                  onClick={() => setActiveConversation(conv.id)}
                >
                  <MessageSquare
                    size={16}
                    className={cn(
                      "flex-shrink-0",
                      activeConversationId === conv.id
                        ? "text-[var(--primary)]"
                        : "text-[var(--muted-foreground)]"
                    )}
                  />

                  {editingId === conv.id ? (
                    <input
                      type="text"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={handleSaveRename}
                      onKeyDown={handleKeyDown}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      className="flex-1 bg-transparent border-b border-[var(--primary)] text-sm text-[var(--foreground)] focus:outline-none"
                    />
                  ) : (
                    <>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-[var(--foreground)] truncate">
                          {conv.title}
                        </p>
                        <p className="text-xs text-[var(--muted-foreground)]">
                          {format(conv.updatedAt, "MMM d, h:mm a")}
                        </p>
                      </div>
                    </>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleStartRename(conv.id, conv.title)
                      }}
                      className="p-1 rounded hover:bg-[var(--muted)] transition-colors"
                      aria-label="Rename conversation"
                    >
                      <Edit3 size={14} className="text-[var(--muted-foreground)]" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteConversation(conv.id)
                      }}
                      className="p-1 rounded hover:bg-[var(--destructive)] transition-colors"
                      aria-label="Delete conversation"
                    >
                      <Trash2 size={14} className="text-[var(--muted-foreground)] hover:text-[var(--destructive-foreground)]" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </PanelContainer>
  )
}

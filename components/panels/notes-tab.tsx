"use client"

import { useMemo, useState } from "react"
import { format } from "date-fns"
import { Bookmark, Trash2, Plus, StickyNote, MessageSquare } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  useStore,
  useConversationNotes,
  useActiveConversation,
} from "@/lib/hooks/use-store"
import type { Message } from "@/lib/types"

function messagePreview(content: string, max = 120): string {
  const trimmed = content.trim().replace(/\s+/g, " ")
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max - 1) + "…"
}

function scrollToMessage(messageId: string) {
  const el = document.getElementById(`chat-message-${messageId}`)
  if (!el) {
    toast.error("Message not found")
    return
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" })
}

export function NotesTab() {
  const activeConversation = useActiveConversation()
  const notes = useConversationNotes()
  const createNote = useStore((s) => s.createNote)
  const updateNoteBody = useStore((s) => s.updateNoteBody)
  const deleteNote = useStore((s) => s.deleteNote)
  const [mounted, setMounted] = useState(false)

  if (!mounted && typeof window !== "undefined") {
    queueMicrotask(() => setMounted(true))
  }

  const messageById = useMemo(() => {
    const map = new Map<string, Message>()
    activeConversation?.messages.forEach((m) => map.set(m.id, m))
    return map
  }, [activeConversation])

  const handleAddNote = () => {
    if (!activeConversation) return
    createNote({ conversationId: activeConversation.id, body: "" })
  }

  if (!activeConversation) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 text-center text-xs text-[var(--muted-foreground)]">
        Select a conversation to add notes.
      </div>
    )
  }

  return (
    <>
      <div className="shrink-0 px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
        <p className="text-[11px] text-[var(--muted-foreground)]">
          {notes.length === 0
            ? "No notes yet"
            : `${notes.length} ${notes.length === 1 ? "note" : "notes"}`}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleAddNote}
          className="h-7 gap-1 text-xs"
          aria-label="Add note"
        >
          <Plus size={14} />
          New note
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-2">
        {notes.length === 0 ? (
          <div className="h-full min-h-[120px] flex flex-col items-center justify-center gap-2 px-3 text-center text-xs text-[var(--muted-foreground)] italic rounded-md border border-dashed border-[var(--border)]">
            <StickyNote size={20} />
            <span>
              Bookmark an assistant message or click <strong>New note</strong>{" "}
              to capture a thought.
            </span>
          </div>
        ) : (
          notes.map((note) => {
            const anchor = note.messageId ? messageById.get(note.messageId) : null
            const isBookmark = note.messageId !== null
            return (
              <article
                key={note.id}
                className={cn(
                  "rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-2 space-y-1.5",
                  isBookmark && "border-amber-500/40"
                )}
              >
                {isBookmark && (
                  <button
                    type="button"
                    onClick={() => note.messageId && scrollToMessage(note.messageId)}
                    disabled={!anchor}
                    className={cn(
                      "w-full text-left flex items-start gap-1.5 text-[11px] rounded px-1 py-1 -mx-1",
                      anchor
                        ? "hover:bg-[var(--accent)] text-[var(--muted-foreground)]"
                        : "text-[var(--muted-foreground)]/60"
                    )}
                    title={anchor ? "Jump to message" : "Message no longer exists"}
                  >
                    {anchor ? (
                      <>
                        <Bookmark
                          size={11}
                          fill="currentColor"
                          className="text-amber-500 mt-0.5 shrink-0"
                        />
                        <span className="line-clamp-2">
                          {messagePreview(anchor.content)}
                        </span>
                      </>
                    ) : (
                      <>
                        <MessageSquare size={11} className="mt-0.5 shrink-0" />
                        <span className="italic">Bookmarked message deleted</span>
                      </>
                    )}
                  </button>
                )}

                <Textarea
                  value={note.body}
                  onChange={(e) => updateNoteBody(note.id, e.target.value)}
                  placeholder={isBookmark ? "Add commentary…" : "Write a note…"}
                  className="min-h-[44px] text-xs resize-none border-none shadow-none p-1 focus-visible:ring-0"
                />

                <div className="flex items-center justify-between text-[10px] text-[var(--muted-foreground)]">
                  <span>
                    {mounted && format(new Date(note.updatedAt), "MMM d, yyyy")}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => deleteNote(note.id)}
                    className="h-6 w-6 text-[var(--muted-foreground)] hover:text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                    aria-label="Delete note"
                    title="Delete"
                  >
                    <Trash2 size={12} />
                  </Button>
                </div>
              </article>
            )
          })
        )}
      </div>
    </>
  )
}

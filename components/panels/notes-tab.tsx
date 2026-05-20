"use client"

import { useEffect, useMemo, useState } from "react"
import { format } from "date-fns"
import { Bookmark, Trash2, Plus, StickyNote, MessageSquare } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/shared/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  useStore,
  useWorkspaceNotes,
  useActiveConversation,
} from "@/client/hooks/use-store"
import type { Message } from "@/shared/types"
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog"
import { TabEmptyState } from "@/components/panels/tab-empty-state"

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
  const notes = useWorkspaceNotes()
  const conversations = useStore((s) => s.conversations)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const createNote = useStore((s) => s.createNote)
  const updateNoteBody = useStore((s) => s.updateNoteBody)
  const deleteNote = useStore((s) => s.deleteNote)
  const [mounted, setMounted] = useState(false)
  // Two-step delete: trash icon stages the id; the AlertDialog confirms.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Build a messageId → message map across every conversation in the
  // workspace, so bookmark notes from other conversations still resolve.
  const messageById = useMemo(() => {
    const map = new Map<string, Message>()
    for (const c of conversations) {
      if (c.workspaceId !== activeWorkspaceId) continue
      for (const m of c.messages) map.set(m.id, m)
    }
    return map
  }, [conversations, activeWorkspaceId])

  const handleAddNote = () => {
    // Notes are workspace-scoped. If there's an active conversation, the
    // new note records it as the source; otherwise it's a workspace-level
    // free-form note (conversationId = null).
    createNote({
      conversationId: activeConversation?.id ?? null,
      body: "",
    })
  }

  return (
    <>
      <div className="shrink-0 h-11 px-3 border-b border-[var(--border)] flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] text-[var(--muted-foreground)]">
            {notes.length === 0
              ? "No notes yet"
              : `${notes.length} ${notes.length === 1 ? "note" : "notes"}`}
          </p>
        </div>
        <button
          type="button"
          onClick={handleAddNote}
          aria-label="Add note"
          title="Add note"
          className="shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] transition-colors"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-2">
        {notes.length === 0 ? (
          <TabEmptyState icon={StickyNote}>
            Bookmark an assistant message or click <strong>New note</strong>{" "}
            to capture a thought.
          </TabEmptyState>
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
                    onClick={() => setConfirmDeleteId(note.id)}
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
      <DeleteConfirmDialog
        open={confirmDeleteId !== null}
        onOpenChange={(open) => !open && setConfirmDeleteId(null)}
        title="Delete this note?"
        description={(() => {
          const note = confirmDeleteId
            ? notes.find((n) => n.id === confirmDeleteId)
            : null
          const preview = note?.body.trim().slice(0, 100)
          const undone = (
            <span className="font-medium text-[var(--foreground)]">
              This action cannot be undone.
            </span>
          )
          if (!preview) return undone
          return (
            <>
              &ldquo;{preview}
              {note && note.body.trim().length > 100 ? "…" : ""}&rdquo;
              <br />
              {undone}
            </>
          )
        })()}
        onConfirm={() => {
          if (confirmDeleteId) deleteNote(confirmDeleteId)
        }}
      />
    </>
  )
}

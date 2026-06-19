"use client"

import { useCallback, useEffect, useState } from "react"
import { Check, Loader2, Pencil, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { getSupabaseBrowserClient } from "@/client/supabase/client"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { cn } from "@/shared/utils"

interface MemoryRow {
  id: string
  fact: string
  category: string | null
}

/**
 * Manage cross-conversation memory.
 *
 * On open, reads the signed-in user's active facts via the browser
 * Supabase client (RLS scopes every read/write to the user — no userId
 * needed in the query). Lists them grouped by category, with per-row
 * inline edit + delete, plus a destructive "Clear all". Empty state +
 * a count. Mirrors the controlled `open`/`onClose` + on-open fetch shape
 * of `CustomInstructionsDialog`.
 *
 * Anonymous / unconfigured: `getSupabaseBrowserClient()` returns null →
 * zero calls; the panel shows the empty state.
 */
export function MemoryPanel({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [rows, setRows] = useState<MemoryRow[]>([])
  const [loading, setLoading] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  const load = useCallback(async () => {
    const client = getSupabaseBrowserClient()
    if (!client) {
      setRows([])
      return
    }
    setLoading(true)
    try {
      const { data, error } = await client
        .from("user_memories")
        .select("id, fact, category")
        .eq("status", "active")
        .order("updated_at", { ascending: false })
      if (error) {
        setRows([])
        return
      }
      setRows(
        (data ?? []).map((r) => ({
          id: r.id,
          fact: r.fact,
          category: r.category ?? null,
        }))
      )
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Refetch whenever the dialog opens. Reset any in-progress edit.
  useEffect(() => {
    if (open) {
      setEditingId(null)
      setDraft("")
      void load()
    }
  }, [open, load])

  const startEdit = (row: MemoryRow) => {
    setEditingId(row.id)
    setDraft(row.fact)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft("")
  }

  const saveEdit = async (id: string) => {
    const next = draft.trim()
    if (!next) {
      cancelEdit()
      return
    }
    const client = getSupabaseBrowserClient()
    if (!client) return
    // Optimistic — reflect the edit locally, then write through (RLS).
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, fact: next } : r)))
    setEditingId(null)
    setDraft("")
    try {
      const { error } = await client
        .from("user_memories")
        .update({ fact: next, updated_at: new Date().toISOString() })
        .eq("id", id)
      if (error) {
        toast.error("Couldn't save that change")
        void load()
      }
    } catch {
      toast.error("Couldn't save that change")
      void load()
    }
  }

  const deleteRow = async (id: string) => {
    const client = getSupabaseBrowserClient()
    if (!client) return
    setRows((prev) => prev.filter((r) => r.id !== id))
    try {
      const { error } = await client
        .from("user_memories")
        .delete()
        .eq("id", id)
      if (error) {
        toast.error("Couldn't delete that memory")
        void load()
      }
    } catch {
      toast.error("Couldn't delete that memory")
      void load()
    }
  }

  const clearAll = async () => {
    const client = getSupabaseBrowserClient()
    if (!client) return
    const prev = rows
    setRows([])
    try {
      // RLS scopes the delete to the signed-in user's own rows.
      const { error } = await client
        .from("user_memories")
        .delete()
        .eq("status", "active")
      if (error) {
        toast.error("Couldn't clear memories")
        setRows(prev)
      } else {
        toast.success("Cleared all memories")
      }
    } catch {
      toast.error("Couldn't clear memories")
      setRows(prev)
    }
  }

  // Group by category for display; uncategorized facts fall under "Other".
  const groups = new Map<string, MemoryRow[]>()
  for (const row of rows) {
    const key = row.category?.trim() || "Other"
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }
  const groupKeys = [...groups.keys()].sort((a, b) => {
    // Keep "Other" last; everything else alphabetical.
    if (a === "Other") return 1
    if (b === "Other") return -1
    return a.localeCompare(b)
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Memory</DialogTitle>
          <DialogDescription>
            Durable facts the assistant remembers about you across chats.
            They&apos;re distilled automatically as you chat and injected into
            every conversation. Edit or remove anything below.
          </DialogDescription>
        </DialogHeader>

        <div className="text-xs text-[var(--muted-foreground)]">
          {loading
            ? "Loading…"
            : `${rows.length} ${rows.length === 1 ? "memory" : "memories"}`}
        </div>

        <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2
                size={18}
                className="animate-spin text-[var(--muted-foreground)]"
              />
            </div>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-[var(--muted-foreground)]">
              No memories yet — they&apos;ll appear here as you chat.
            </div>
          ) : (
            <div className="space-y-4">
              {groupKeys.map((key) => (
                <div key={key}>
                  <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)] mb-1.5">
                    {key}
                  </p>
                  <ul className="space-y-1">
                    {groups.get(key)!.map((row) => (
                      <li
                        key={row.id}
                        className={cn(
                          "group flex items-center gap-2 rounded-md px-2 py-1.5",
                          "hover:bg-[var(--accent)] transition-colors"
                        )}
                      >
                        {editingId === row.id ? (
                          <>
                            <Input
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void saveEdit(row.id)
                                if (e.key === "Escape") cancelEdit()
                              }}
                              autoFocus
                              className="h-7 text-sm flex-1"
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 shrink-0"
                              aria-label="Save"
                              onClick={() => void saveEdit(row.id)}
                            >
                              <Check size={14} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 shrink-0"
                              aria-label="Cancel"
                              onClick={cancelEdit}
                            >
                              <X size={14} />
                            </Button>
                          </>
                        ) : (
                          <>
                            <span className="flex-1 text-sm leading-snug">
                              {row.fact}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                              aria-label="Edit memory"
                              onClick={() => startEdit(row)}
                            >
                              <Pencil size={13} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-[var(--destructive)]"
                              aria-label="Delete memory"
                              onClick={() => void deleteRow(row.id)}
                            >
                              <Trash2 size={13} />
                            </Button>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            onClick={() => void clearAll()}
            disabled={loading || rows.length === 0}
            className="text-[var(--destructive)] hover:text-[var(--destructive)]"
          >
            <Trash2 size={14} className="mr-1.5" />
            Clear all
          </Button>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

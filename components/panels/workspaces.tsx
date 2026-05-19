"use client"

import * as React from "react"
import { useStore } from "@/lib/hooks/use-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  FolderOpen,
  Plus,
  MessageSquare,
  Files,
  Edit2,
  Trash2,
  Check,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { format } from "date-fns"

export function WorkspacesPanel() {
  const {
    workspaces,
    activeWorkspaceId,
    setActiveWorkspace,
    createWorkspace,
    renameWorkspace,
    setWorkspaceSystemPrompt,
    deleteWorkspace,
    conversations,
    resources,
  } = useStore()

  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [editingName, setEditingName] = React.useState("")
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null)
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  const countsByWorkspace = React.useMemo(() => {
    const counts: Record<string, { chats: number; files: number }> = {}
    for (const w of workspaces) counts[w.id] = { chats: 0, files: 0 }
    for (const c of conversations) {
      if (counts[c.workspaceId]) counts[c.workspaceId].chats += 1
    }
    for (const r of resources) {
      if (counts[r.workspaceId]) counts[r.workspaceId].files += 1
    }
    return counts
  }, [workspaces, conversations, resources])

  const handleCreate = () => {
    const ws = createWorkspace("New Workspace")
    setActiveWorkspace(ws.id)
    setEditingId(ws.id)
    setEditingName(ws.name)
  }

  const startEdit = (id: string, name: string) => {
    setEditingId(id)
    setEditingName(name)
  }

  const saveEdit = () => {
    if (editingId && editingName.trim()) {
      renameWorkspace(editingId, editingName.trim())
    }
    setEditingId(null)
    setEditingName("")
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditingName("")
  }

  const formatDate = (d: Date | string) => {
    if (!mounted) return ""
    try {
      return format(new Date(d), "MMM d, yyyy")
    } catch {
      return ""
    }
  }

  return (
    <div className="h-full w-full flex flex-col">
      <div className="shrink-0 px-6 py-4 border-b border-[var(--border)] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <SidebarTrigger className="md:hidden shrink-0" />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-[var(--foreground)] truncate">Workspaces</h1>
            <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
              {workspaces.length} {workspaces.length === 1 ? "workspace" : "workspaces"}
            </p>
          </div>
        </div>
        <Button onClick={handleCreate} size="sm" className="shrink-0">
          <Plus size={14} className="mr-1" /> New Workspace
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {workspaces.map((ws) => {
            const counts = countsByWorkspace[ws.id] ?? { chats: 0, files: 0 }
            const isActive = ws.id === activeWorkspaceId
            const isEditing = editingId === ws.id
            return (
              <div
                key={ws.id}
                className={cn(
                  "group relative rounded-lg border p-4 transition-colors cursor-pointer",
                  isActive
                    ? "border-primary bg-primary/5"
                    : "border-[var(--border)] hover:border-[var(--ring)] hover:bg-accent/40"
                )}
                onClick={() => {
                  if (!isEditing) setActiveWorkspace(ws.id)
                }}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      "shrink-0 rounded-md p-2",
                      isActive ? "bg-primary/10 text-primary" : "bg-accent text-[var(--foreground)]"
                    )}
                  >
                    <FolderOpen size={18} />
                  </div>

                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <div
                        className="flex items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Input
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEdit()
                            if (e.key === "Escape") cancelEdit()
                          }}
                          className="h-7 text-sm"
                          autoFocus
                        />
                        <Button variant="ghost" size="icon-sm" onClick={saveEdit}>
                          <Check size={14} />
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={cancelEdit}>
                          <X size={14} />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-medium truncate text-[var(--foreground)]">
                          {ws.name}
                        </h3>
                        {isActive && (
                          <span className="text-[10px] font-medium uppercase tracking-wide text-primary">
                            Active
                          </span>
                        )}
                      </div>
                    )}

                    <div className="mt-2 flex items-center gap-4 text-xs text-[var(--muted-foreground)]">
                      <span className="flex items-center gap-1">
                        <MessageSquare size={12} />
                        {counts.chats} {counts.chats === 1 ? "chat" : "chats"}
                      </span>
                      <span className="flex items-center gap-1">
                        <Files size={12} />
                        {counts.files} {counts.files === 1 ? "file" : "files"}
                      </span>
                    </div>

                    <div className="mt-3 text-[11px] text-[var(--muted-foreground)] space-y-0.5">
                      <div>Created {formatDate(ws.createdAt)}</div>
                      <div>Updated {formatDate(ws.updatedAt)}</div>
                    </div>

                    <div
                      className="mt-3"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <label className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] font-medium">
                        System prompt
                      </label>
                      <Textarea
                        value={ws.systemPrompt ?? ""}
                        onChange={(e) =>
                          setWorkspaceSystemPrompt(ws.id, e.target.value)
                        }
                        onKeyDown={(e) => e.stopPropagation()}
                        placeholder="Optional. Prepended to every chat in this workspace."
                        className="mt-1 text-xs resize-none min-h-[44px]"
                        rows={2}
                      />
                    </div>
                  </div>
                </div>

                {!isEditing && (
                  <div
                    className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-7 w-7"
                      onClick={() => startEdit(ws.id, ws.name)}
                      aria-label="Rename workspace"
                    >
                      <Edit2 size={13} />
                    </Button>
                    {workspaces.length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="h-7 w-7 hover:text-red-500"
                        onClick={() => setConfirmDeleteId(ws.id)}
                        aria-label="Delete workspace"
                      >
                        <Trash2 size={13} />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {/* Create-new card */}
          <button
            type="button"
            onClick={handleCreate}
            className="rounded-lg border border-dashed border-[var(--border)] p-4 flex flex-col items-center justify-center gap-2 text-[var(--muted-foreground)] hover:border-primary hover:text-primary hover:bg-primary/5 transition-colors min-h-[140px]"
          >
            <Plus size={20} />
            <span className="text-sm font-medium">New Workspace</span>
          </button>
        </div>
      </ScrollArea>

      <AlertDialog
        open={confirmDeleteId !== null}
        onOpenChange={(open) => !open && setConfirmDeleteId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the workspace along with its chats and
              file associations. Uploaded files shared with other workspaces will
              be kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDeleteId) deleteWorkspace(confirmDeleteId)
                setConfirmDeleteId(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

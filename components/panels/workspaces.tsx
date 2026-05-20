"use client"

import * as React from "react"
import { useStore } from "@/lib/hooks/use-store"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog"
import {
  ArrowLeft,
  FolderOpen,
  Plus,
  MessageSquare,
  Pin,
  Settings2,
  Trash2,
} from "lucide-react"
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable"
import { cn } from "@/lib/utils"
import { ResourcesSidebar } from "@/components/sidebars/resources"
import { format } from "date-fns"
import { WorkspaceDetailSheet } from "@/components/panels/workspace-detail-sheet"
import { WorkspaceRow } from "@/components/panels/workspace-row"

export function WorkspacesPanel() {
  const {
    workspaces,
    activeWorkspaceId,
    setActiveWorkspace,
    createWorkspace,
    deleteWorkspace,
    reorderWorkspaces,
    conversations,
    resources,
    createConversation,
    setActiveConversation,
    setActiveView,
    togglePin,
  } = useStore()

  const [openDetailId, setOpenDetailId] = React.useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null)
  const [mounted, setMounted] = React.useState(false)
  // When set, the panel shows that workspace's detail page instead of the
  // index list. Clicking a row in the index opens detail (and sets active
  // as a side effect). Cleared by the back button.
  const [focusedWorkspaceId, setFocusedWorkspaceId] = React.useState<string | null>(null)
  const focusedWorkspace = focusedWorkspaceId
    ? workspaces.find((w) => w.id === focusedWorkspaceId) ?? null
    : null

  // dnd-kit: PointerSensor requires an 8px drag distance before activating,
  // so clicking the grip handle to select the workspace still works without
  // triggering a drag. KeyboardSensor gives us full a11y (Tab to handle,
  // Space to pick up, arrows to move, Space to drop).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

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

  // Creating a new workspace opens its settings sheet immediately so the
  // user lands in the rename field with a focused surface.
  const handleCreate = () => {
    const ws = createWorkspace("New Workspace")
    setActiveWorkspace(ws.id)
    setOpenDetailId(ws.id)
  }

  const formatDate = (d: Date | string) => {
    if (!mounted) return ""
    try {
      return format(new Date(d), "MMM d, yyyy")
    } catch {
      return ""
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = workspaces.map((w) => w.id)
    const fromIdx = ids.indexOf(String(active.id))
    const toIdx = ids.indexOf(String(over.id))
    if (fromIdx === -1 || toIdx === -1) return
    reorderWorkspaces(arrayMove(ids, fromIdx, toIdx))
  }

  const workspaceToDelete = confirmDeleteId
    ? workspaces.find((w) => w.id === confirmDeleteId)
    : null

  const focusedWorkspaceConversations = focusedWorkspaceId
    ? conversations.filter((c) => c.workspaceId === focusedWorkspaceId)
    : []

  const openConversation = (conversationId: string) => {
    setActiveConversation(conversationId)
    setActiveView("chat")
  }

  const handleNewChatInFocused = () => {
    if (!focusedWorkspace) return
    const conv = createConversation(focusedWorkspace.id)
    openConversation(conv.id)
  }

  return (
    <div className="h-full w-full flex flex-row min-h-0">
      <div className="flex-1 min-w-0 flex flex-col">
      {focusedWorkspace ? (
        /* === Detail view === */
        <>
          <div className="shrink-0 px-6 py-4 border-b border-[var(--border)] flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setFocusedWorkspaceId(null)}
                aria-label="Back to workspaces"
                title="Back to workspaces"
                className="shrink-0"
              >
                <ArrowLeft size={16} />
              </Button>
              <FolderOpen size={18} className="shrink-0 text-primary" />
              <h1 className="text-xl font-semibold text-[var(--foreground)] truncate">
                {focusedWorkspace.name}
              </h1>
              {focusedWorkspace.id === activeWorkspaceId && (
                <span className="text-[10px] font-medium uppercase tracking-wide text-primary shrink-0">
                  Active
                </span>
              )}
            </div>
            <div className="shrink-0 flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOpenDetailId(focusedWorkspace.id)}
                className="gap-1.5"
                aria-label="Open workspace settings"
              >
                <Settings2 size={14} />
                <span className="hidden sm:inline">Settings</span>
              </Button>
              {workspaces.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDeleteId(focusedWorkspace.id)}
                  aria-label="Delete workspace"
                  className="text-[var(--muted-foreground)] hover:text-red-500 gap-1.5"
                >
                  <Trash2 size={14} />
                </Button>
              )}
              <Button onClick={handleNewChatInFocused} size="sm" className="gap-1.5">
                <Plus size={14} /> New chat
              </Button>
            </div>
          </div>

          <ScrollArea className="flex-1">
            <div className="p-6 max-w-3xl mx-auto">
              <h2 className="text-xs uppercase tracking-wide text-[var(--muted-foreground)] font-medium mb-3">
                Chats ({focusedWorkspaceConversations.length})
              </h2>
              {focusedWorkspaceConversations.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--muted-foreground)]">
                  No chats yet in this workspace.
                  <button
                    type="button"
                    onClick={handleNewChatInFocused}
                    className="ml-1 text-primary hover:underline"
                  >
                    Start one →
                  </button>
                </div>
              ) : (
                <ul className="space-y-1">
                  {[...focusedWorkspaceConversations]
                    .sort((a, b) => {
                      if (a.pinned && !b.pinned) return -1
                      if (!a.pinned && b.pinned) return 1
                      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
                    })
                    .map((conv) => {
                      const lastMessage = conv.messages.at(-1)
                      const preview = lastMessage?.content?.replace(/\s+/g, " ").trim() ?? ""
                      return (
                        <li key={conv.id}>
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => openConversation(conv.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault()
                                openConversation(conv.id)
                              }
                            }}
                            className="group flex items-start gap-3 rounded-md px-3 py-2.5 cursor-pointer hover:bg-accent/40 transition-colors"
                          >
                            <MessageSquare
                              size={14}
                              className="shrink-0 mt-0.5 text-[var(--muted-foreground)]"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <h3 className="text-sm font-medium truncate text-[var(--foreground)]">
                                  {conv.title}
                                </h3>
                                {conv.pinned && (
                                  <Pin size={11} className="shrink-0 text-amber-500 fill-amber-500" />
                                )}
                              </div>
                              <div className="text-xs text-[var(--muted-foreground)] truncate">
                                {preview || (
                                  <span className="italic">No messages yet</span>
                                )}
                              </div>
                              <div className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
                                {conv.messages.length}{" "}
                                {conv.messages.length === 1 ? "message" : "messages"} ·{" "}
                                Updated {formatDate(conv.updatedAt)}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                togglePin(conv.id)
                              }}
                              aria-label={conv.pinned ? "Unpin chat" : "Pin chat"}
                              title={conv.pinned ? "Unpin" : "Pin"}
                              className={cn(
                                "shrink-0 p-1 rounded transition-opacity",
                                conv.pinned
                                  ? "text-amber-500"
                                  : "opacity-0 group-hover:opacity-100 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                              )}
                            >
                              <Pin size={12} className={conv.pinned ? "fill-amber-500" : ""} />
                            </button>
                          </div>
                        </li>
                      )
                    })}
                </ul>
              )}
            </div>
          </ScrollArea>
        </>
      ) : (
        /* === Index view === */
        <>
      <div className="shrink-0 px-6 py-4 border-b border-[var(--border)] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <SidebarTrigger className="md:hidden shrink-0" />
          <h1 className="text-xl font-semibold text-[var(--foreground)] truncate">
            {workspaces.length} {workspaces.length === 1 ? "workspace" : "workspaces"}
          </h1>
        </div>
        <Button onClick={handleCreate} size="sm" className="shrink-0">
          <Plus size={14} className="mr-1" /> New Workspace
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={workspaces.map((w) => w.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="p-6 space-y-3">
              {workspaces.map((ws) => {
                const counts = countsByWorkspace[ws.id] ?? { chats: 0, files: 0 }
                return (
                  <WorkspaceRow
                    key={ws.id}
                    workspaceId={ws.id}
                    name={ws.name}
                    updatedAt={ws.updatedAt}
                    counts={counts}
                    isActive={ws.id === activeWorkspaceId}
                    deletable={workspaces.length > 1}
                    onActivate={() => setActiveWorkspace(ws.id)}
                    onOpenDetail={() => {
                      setActiveWorkspace(ws.id)
                      setFocusedWorkspaceId(ws.id)
                    }}
                    onOpenSettings={() => setOpenDetailId(ws.id)}
                    onRequestDelete={() => setConfirmDeleteId(ws.id)}
                    formatDate={formatDate}
                  />
                )
              })}
            </div>
          </SortableContext>
        </DndContext>
      </ScrollArea>
        </>
      )}

      <DeleteConfirmDialog
        open={confirmDeleteId !== null}
        onOpenChange={(open) => !open && setConfirmDeleteId(null)}
        title={
          <>Delete &ldquo;{workspaceToDelete?.name ?? "workspace"}&rdquo;?</>
        }
        description={
          <>
            This will permanently delete the workspace along with its chats and
            file associations. Uploaded files shared with other workspaces will
            be kept.{" "}
            <span className="font-medium text-[var(--foreground)]">
              This action cannot be undone.
            </span>
          </>
        }
        onConfirm={() => {
          if (confirmDeleteId) deleteWorkspace(confirmDeleteId)
        }}
      />
      </div>
      <ResourcesSidebar mode={focusedWorkspace ? "chat" : "workspaces"} />
      <WorkspaceDetailSheet
        workspaceId={openDetailId}
        onClose={() => setOpenDetailId(null)}
      />
    </div>
  )
}

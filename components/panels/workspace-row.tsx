"use client"

import * as React from "react"
import {
  ArrowRight,
  Files,
  Folder,
  FolderOpen,
  GripVertical,
  KanbanSquare,
  MessageSquare,
  Settings2,
  Trash2,
} from "lucide-react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"

import { Button } from "@/components/ui/button"
import { cn } from "@/shared/utils"

interface WorkspaceRowProps {
  workspaceId: string
  name: string
  updatedAt: Date | string
  counts: { chats: number; files: number; tasksDone: number; tasksTotal: number }
  /** Show the project N/M done chip when true (only meaningful if the
   *  workspace is in project mode). */
  isProject: boolean
  isActive: boolean
  deletable: boolean
  /** Single-click on the row — set active without leaving the index view. */
  onActivate: () => void
  /** Explicit "go into" — opens the detail page. Triggered by the hover
   *  arrow button or double-click. */
  onOpenDetail: () => void
  onOpenSettings: () => void
  onRequestDelete: () => void
  formatDate: (d: Date | string) => string
}

export function WorkspaceRow({
  workspaceId,
  name,
  updatedAt,
  counts,
  isProject,
  isActive,
  deletable,
  onActivate,
  onOpenDetail,
  onOpenSettings,
  onRequestDelete,
  formatDate,
}: WorkspaceRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: workspaceId })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onActivate}
      onDoubleClick={onOpenDetail}
      className={cn(
        "group relative rounded-lg border px-4 py-3 transition-colors cursor-pointer flex items-center gap-3",
        isActive
          ? "border-primary bg-primary/5"
          : "border-[var(--border)] hover:border-[var(--ring)] hover:bg-accent/40",
        // Hide the source row during drag — dnd-kit renders a transformed
        // ghost of the same element to follow the pointer.
        isDragging && "opacity-40 z-10"
      )}
    >
      {/* Drag handle — `listeners` from useSortable starts the drag. */}
      <button
        type="button"
        aria-label="Drag to reorder"
        title="Drag to reorder"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        className="shrink-0 cursor-grab active:cursor-grabbing text-[var(--muted-foreground)] hover:text-[var(--foreground)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity -ml-1"
      >
        <GripVertical size={14} />
      </button>

      <div
        className={cn(
          "shrink-0 rounded-md p-2",
          isActive ? "bg-primary/10 text-primary" : "bg-accent text-[var(--foreground)]"
        )}
      >
        {/* Active workspace shows the open-folder mark; idle ones get the
            closed folder so the active state reads at a glance. */}
        {isActive ? <FolderOpen size={18} /> : <Folder size={18} />}
      </div>

      <div className="flex-1 min-w-0 flex items-center gap-2">
        <h3 className="text-sm font-medium truncate text-[var(--foreground)]">
          {name}
        </h3>
        {isActive && (
          <span className="text-[10px] font-medium uppercase tracking-wide text-primary">
            Active
          </span>
        )}
      </div>

      <div className="shrink-0 hidden sm:flex items-center gap-4 text-xs text-[var(--muted-foreground)]">
        {isProject && (
          <span
            className="flex items-center gap-1 tabular-nums"
            title="Project tasks done"
          >
            <KanbanSquare size={12} />
            {counts.tasksDone}/{counts.tasksTotal}
          </span>
        )}
        <span className="flex items-center gap-1">
          <MessageSquare size={12} />
          {counts.chats} {counts.chats === 1 ? "chat" : "chats"}
        </span>
        <span className="flex items-center gap-1">
          <Files size={12} />
          {counts.files} {counts.files === 1 ? "file" : "files"}
        </span>
        <span>Updated {formatDate(updatedAt)}</span>
      </div>

      <div
        className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-7 w-7"
          onClick={onOpenDetail}
          aria-label="Open workspace"
          title="Open workspace"
        >
          <ArrowRight size={13} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-7 w-7"
          onClick={onOpenSettings}
          aria-label="Open workspace settings"
          title="Settings"
        >
          <Settings2 size={13} />
        </Button>
        {deletable && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7 hover:text-red-500"
            onClick={onRequestDelete}
            aria-label={`Delete workspace "${name}"`}
            title="Delete"
          >
            <Trash2 size={13} />
          </Button>
        )}
      </div>
    </div>
  )
}

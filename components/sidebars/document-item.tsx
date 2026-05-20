"use client"

import { useEffect, useRef, useState } from "react"
import { Check, MoreVertical, Pencil, Trash2, X } from "lucide-react"

import type { Document } from "@/shared/types"
import { Button } from "@/components/ui/button"
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/shared/utils"

interface DocumentItemProps {
  document: Document
  isActive: boolean
  onSelect: () => void
  onRename: (title: string) => void
  onDelete: () => void
}

/**
 * Sidebar row for a workspace document. Mirrors `ConversationItem`: click
 * to open, inline rename on the kebab → Rename menu, delete with confirm.
 */
export function DocumentItem({
  document,
  isActive,
  onSelect,
  onRename,
  onDelete,
}: DocumentItemProps) {
  const [isRenaming, setIsRenaming] = useState(false)
  const [draft, setDraft] = useState(document.title)
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isRenaming])

  const startRename = () => {
    setMenuOpen(false)
    setDraft(document.title)
    setIsRenaming(true)
  }

  const commitRename = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== document.title) onRename(trimmed)
    setIsRenaming(false)
  }

  const cancelRename = () => {
    setDraft(document.title)
    setIsRenaming(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") commitRename()
    else if (e.key === "Escape") cancelRename()
  }

  return (
    <div
      className={cn(
        "group/document relative flex w-full items-center gap-2 overflow-visible rounded-md px-2 py-1 text-sm cursor-pointer",
        isActive &&
          "bg-[var(--sidebar-accent)] text-[var(--sidebar-accent-foreground)]",
        !isActive &&
          "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}
      onClick={onSelect}
    >
      {isRenaming ? (
        <div
          className="flex flex-1 items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={commitRename}
            className="flex-1 px-1 py-0.5 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button variant="ghost" size="icon" onClick={commitRename} className="h-6 w-6">
            <Check size={14} />
          </Button>
          <Button variant="ghost" size="icon" onClick={cancelRename} className="h-6 w-6">
            <X size={14} />
          </Button>
        </div>
      ) : (
        <>
          <span className="truncate flex-1">
            {document.title || "Untitled"}
          </span>

          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="opacity-0 group-hover/document:opacity-100 p-1 rounded hover:bg-[var(--sidebar-accent)] transition-all"
                aria-label="More options"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical size={14} />
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="w-36 p-1 z-[100]"
              side="right"
              align="start"
              onClick={(e) => e.stopPropagation()}
            >
              <Button
                variant="ghost"
                onClick={startRename}
                className="w-full justify-start gap-2 cursor-pointer"
              >
                <Pencil size={16} />
                <span>Rename</span>
              </Button>
              <Button
                variant="ghost"
                onClick={() => setDeleteOpen(true)}
                className="w-full justify-start gap-2 text-[var(--destructive)] hover:text-[var(--destructive)] hover:bg-[var(--destructive)]/10 cursor-pointer"
              >
                <Trash2 size={16} />
                <span>Delete</span>
              </Button>
              <DeleteConfirmDialog
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                title="Delete document?"
                description={
                  <>
                    This action cannot be undone. &ldquo;
                    {document.title || "Untitled"}&rdquo; and its contents
                    will be removed.
                  </>
                }
                onConfirm={onDelete}
              />
            </PopoverContent>
          </Popover>
        </>
      )}
    </div>
  )
}

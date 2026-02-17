"use client"

import { useState, useRef, useEffect } from "react"
import { Conversation } from "@/lib/hooks/use-store"
import { Pin, PinOff, Pencil, Trash2, MoreVertical, Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

interface ConversationItemProps {
  conversation: Conversation
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
  onRename: (title: string) => void
  onPin: () => void
}

export function ConversationItem({
  conversation,
  isActive,
  onSelect,
  onDelete,
  onRename,
  onPin,
}: ConversationItemProps) {
  const [isRenaming, setIsRenaming] = useState(false)
  const [newTitle, setNewTitle] = useState(conversation.title)
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isRenaming])

  const handleRename = () => {
    setMenuOpen(false)
    setNewTitle(conversation.title)
    setIsRenaming(true)
  }

  const handleSaveRename = () => {
    if (newTitle.trim() && newTitle !== conversation.title) {
      onRename(newTitle.trim())
    }
    setIsRenaming(false)
  }

  const handleCancelRename = () => {
    setNewTitle(conversation.title)
    setIsRenaming(false)
  }

  const handlePin = () => {
    setMenuOpen(false)
    onPin()
  }

  const handleMenuClose = (open: boolean) => {
    setMenuOpen(open)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSaveRename()
    } else if (e.key === "Escape") {
      handleCancelRename()
    }
  }

  return (
    <div
      className={cn(
        "group/conversation relative flex w-full items-center gap-2 overflow-visible rounded-md p-2 text-sm cursor-pointer",
        isActive && "bg-[var(--sidebar-accent)] text-[var(--sidebar-accent-foreground)]",
        !isActive && "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}
      onClick={onSelect}
    >
      {isRenaming ? (
        <div className="flex flex-1 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <input
            ref={inputRef}
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleSaveRename}
            className="flex-1 px-1 py-0.5 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button variant="ghost" size="icon" onClick={handleSaveRename} className="h-6 w-6">
            <Check size={14} />
          </Button>
          <Button variant="ghost" size="icon" onClick={handleCancelRename} className="h-6 w-6">
            <X size={14} />
          </Button>
        </div>
      ) : (
        <>
          {conversation.pinned && (
            <Pin size={12} className="shrink-0 text-amber-500" />
          )}
          <span className="truncate flex-1">{conversation.title}</span>

          <Popover open={menuOpen} onOpenChange={handleMenuClose}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="opacity-0 group-hover/conversation:opacity-100 p-1 rounded hover:bg-[var(--sidebar-accent)] transition-all"
                aria-label="More options"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical size={14} />
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="w-40 p-1"
              side="right"
              align="start"
              onClick={(e) => e.stopPropagation()}
            >
              <Button
                variant="ghost"
                onClick={handlePin}
                className="w-full justify-start gap-2 cursor-pointer"
              >
                {conversation.pinned ? <PinOff size={16} /> : <Pin size={16} />}
                <span>{conversation.pinned ? "Unpin" : "Pin"}</span>
              </Button>
              <Button
                variant="ghost"
                onClick={handleRename}
                className="w-full justify-start gap-2 cursor-pointer"
              >
                <Pencil size={16} />
                <span>Rename</span>
              </Button>
              <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    className="w-full justify-start gap-2 text-[var(--destructive)] hover:text-[var(--destructive)] hover:bg-[var(--destructive)]/10 cursor-pointer"
                  >
                    <Trash2 size={16} />
                    <span>Delete</span>
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This action cannot be undone. This will permanently delete &quot;{conversation.title}&quot; and remove it from your history.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel variant="outline">Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={onDelete}>Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </PopoverContent>
          </Popover>
        </>
      )}
    </div>
  )
}

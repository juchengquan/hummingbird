"use client"

import { useState, useRef, useEffect } from "react"
import { Conversation } from "@/shared/types"
import { Pin, PinOff, Pencil, Trash2, MoreVertical, Check, X, Download, Copy, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { cn } from "@/shared/utils"
import {
  conversationToMarkdown,
  copyText,
  downloadAsFile,
  safeFilename,
} from "@/client/export"
import { ConversationSummaryDialog } from "@/components/conversation-summary-dialog"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover"
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog"

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
  const [summaryOpen, setSummaryOpen] = useState(false)
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

  const handleExportMarkdown = () => {
    setMenuOpen(false)
    const md = conversationToMarkdown(conversation)
    downloadAsFile(`${safeFilename(conversation.title)}.md`, md)
    toast.success("Conversation exported")
  }

  const handleCopyMarkdown = async () => {
    setMenuOpen(false)
    try {
      await copyText(conversationToMarkdown(conversation))
      toast.success("Copied as Markdown")
    } catch {
      toast.error("Failed to copy to clipboard")
    }
  }

  const handleSummarise = () => {
    setMenuOpen(false)
    setSummaryOpen(true)
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
        "group/conversation relative flex w-full items-center gap-2 overflow-visible rounded-md px-2 py-0.5 text-xs cursor-pointer",
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
              className="w-40 p-1 z-[100]"
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
                onClick={handleSummarise}
                className="w-full justify-start gap-2 cursor-pointer"
              >
                <Sparkles size={16} />
                <span>Summarise</span>
              </Button>
              <Button
                variant="ghost"
                onClick={handleRename}
                className="w-full justify-start gap-2 cursor-pointer"
              >
                <Pencil size={16} />
                <span>Rename</span>
              </Button>
              <Button
                variant="ghost"
                onClick={handleExportMarkdown}
                className="w-full justify-start gap-2 cursor-pointer"
              >
                <Download size={16} />
                <span>Export as .md</span>
              </Button>
              <Button
                variant="ghost"
                onClick={handleCopyMarkdown}
                className="w-full justify-start gap-2 cursor-pointer"
              >
                <Copy size={16} />
                <span>Copy as Markdown</span>
              </Button>
              <Button
                variant="ghost"
                onClick={() => setDeleteDialogOpen(true)}
                className="w-full justify-start gap-2 text-[var(--destructive)] hover:text-[var(--destructive)] hover:bg-[var(--destructive)]/10 cursor-pointer"
              >
                <Trash2 size={16} />
                <span>Delete</span>
              </Button>
              <DeleteConfirmDialog
                open={deleteDialogOpen}
                onOpenChange={setDeleteDialogOpen}
                title="Delete conversation?"
                description={
                  <>
                    This action cannot be undone. This will permanently delete &ldquo;{conversation.title}&rdquo; and remove it from your history.
                  </>
                }
                onConfirm={onDelete}
              />
            </PopoverContent>
          </Popover>
          <ConversationSummaryDialog
            conversation={summaryOpen ? conversation : null}
            onClose={() => setSummaryOpen(false)}
          />
        </>
      )}
    </div>
  )
}

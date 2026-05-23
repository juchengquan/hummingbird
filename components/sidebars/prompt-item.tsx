"use client"

import { useState } from "react"
import { MoreVertical, Pencil, Trash2 } from "lucide-react"

import type { Prompt } from "@/shared/types"
import { Button } from "@/components/ui/button"
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/shared/utils"

interface PromptItemProps {
  prompt: Prompt
  isActive: boolean
  /** Click row → insert into chat. The sidebar resolves whether to open
   *  the variable-fill modal first. */
  onSelect: () => void
  onEdit: () => void
  onDelete: () => void
}

/**
 * Sidebar row for a saved prompt. Mirrors `DocumentItem`'s shape: click
 * row to use, hover-revealed kebab for edit / delete. Variable count is
 * a small muted badge on the right when present.
 *
 * Edit happens in `PromptDialog` (opened via `onEdit`) rather than
 * inline — prompts have multi-line bodies, so inline rename isn't
 * the right affordance.
 */
export function PromptItem({
  prompt,
  isActive,
  onSelect,
  onEdit,
  onDelete,
}: PromptItemProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  return (
    <div
      className={cn(
        "group/prompt relative flex w-full items-center gap-2 overflow-visible rounded-md px-2 py-1 text-sm cursor-pointer",
        isActive &&
          "bg-[var(--sidebar-accent)] text-[var(--sidebar-accent-foreground)]",
        !isActive &&
          "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}
      onClick={onSelect}
    >
      <span className="flex-1 min-w-0 truncate" title={prompt.name}>
        {prompt.name}
      </span>

      {prompt.variables.length > 0 && (
        <span
          className={cn(
            "shrink-0 rounded-md px-1 py-0.5 text-[10px] font-mono",
            "bg-[var(--muted)]/40 text-[var(--muted-foreground)]",
            // Hide the badge when the kebab is hovering so the row
            // doesn't visually crowd.
            "group-hover/prompt:hidden"
          )}
          title={`${prompt.variables.length} ${prompt.variables.length === 1 ? "variable" : "variables"}`}
        >
          {prompt.variables.length}
        </span>
      )}

      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Prompt actions for "${prompt.name}"`}
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen(true)
            }}
            className={cn(
              "h-5 w-5 shrink-0 text-[var(--muted-foreground)]",
              "opacity-0 group-hover/prompt:opacity-100 focus-visible:opacity-100",
              menuOpen && "opacity-100"
            )}
          >
            <MoreVertical size={12} />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-32 p-1"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMenuOpen(false)
              onEdit()
            }}
            className="w-full justify-start gap-2"
          >
            <Pencil size={12} />
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMenuOpen(false)
              setDeleteOpen(true)
            }}
            className="w-full justify-start gap-2 text-[var(--destructive)] hover:text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
          >
            <Trash2 size={12} />
            Delete
          </Button>
        </PopoverContent>
      </Popover>

      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete prompt?"
        description={`"${prompt.name}" will be removed from your library.`}
        onConfirm={onDelete}
      />
    </div>
  )
}

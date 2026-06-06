"use client"

import { useState } from "react"
import { Boxes, Link2, MessageSquare, MessagesSquare, NotebookPen, Paperclip, Plus, StickyNote } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/shared/utils"
import type { CanvasNodeKind } from "@/shared/canvas/types"

export interface AddableItem {
  id: string
  label: string
  sublabel?: string
}

/** Addable items per projected kind, already filtered to exclude what's
 *  on the canvas. Computed by the panel from the workspace selectors. */
export type AddableGroups = Record<
  Exclude<CanvasNodeKind, "sticky">,
  AddableItem[]
>

const GROUP_META: Array<{
  kind: Exclude<CanvasNodeKind, "sticky">
  label: string
  icon: typeof Boxes
}> = [
  { kind: "conversation", label: "Conversations", icon: MessagesSquare },
  { kind: "chat-message", label: "Messages", icon: MessageSquare },
  { kind: "artifact", label: "Artifacts", icon: Boxes },
  { kind: "note", label: "Notes", icon: NotebookPen },
  { kind: "file", label: "Files", icon: Paperclip },
  { kind: "url-bookmark", label: "Links", icon: Link2 },
]

export function CanvasToolbar({
  addable,
  onAdd,
  onAddSticky,
}: {
  addable: AddableGroups
  onAdd: (kind: Exclude<CanvasNodeKind, "sticky">, id: string) => void
  onAddSticky: () => void
}) {
  const [open, setOpen] = useState(false)
  const totalAddable = GROUP_META.reduce(
    (sum, g) => sum + addable[g.kind].length,
    0
  )

  return (
    <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="secondary" className="h-8 gap-1.5 shadow-sm">
            <Plus size={14} />
            Add to canvas
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <div className="p-1.5 border-b border-[var(--border)]">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2"
              onClick={() => {
                onAddSticky()
                setOpen(false)
              }}
            >
              <StickyNote size={14} className="text-amber-500" />
              New sticky note
            </Button>
          </div>
          <ScrollArea className="max-h-[60vh]">
            <div className="p-1.5 space-y-2">
              {totalAddable === 0 && (
                <p className="px-2 py-3 text-xs text-[var(--muted-foreground)] text-center">
                  Everything in this workspace is already on the canvas.
                </p>
              )}
              {GROUP_META.map(({ kind, label, icon: Icon }) => {
                const items = addable[kind]
                if (items.length === 0) return null
                return (
                  <div key={kind}>
                    <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                      <Icon size={11} />
                      {label}
                      <span className="ml-auto tabular-nums opacity-70">
                        {items.length}
                      </span>
                    </div>
                    {items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          onAdd(kind, item.id)
                          setOpen(false)
                        }}
                        className={cn(
                          "w-full text-left rounded-md px-2 py-1.5",
                          "hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)]",
                          "transition-colors"
                        )}
                      >
                        <div className="text-xs truncate">{item.label}</div>
                        {item.sublabel && (
                          <div className="text-[10px] text-[var(--muted-foreground)] truncate">
                            {item.sublabel}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  )
}

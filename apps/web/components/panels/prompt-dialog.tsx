"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Trash2 } from "lucide-react"

import { useStore } from "@/client/hooks/use-store"
import { parseTemplate } from "@/shared/prompts/expand"
import type { Prompt } from "@/shared/types"
import { cn } from "@/shared/utils"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

/**
 * Create / edit / delete dialog for a single Prompt. Opened from:
 *  - the "+" action on the Prompts sidebar group → create mode
 *  - a row's Edit affordance → edit mode (pre-filled)
 *
 * The original plan called for a two-pane "Manage Prompts" dialog with
 * a list on the left. The sidebar already provides the list view, so
 * this dialog is single-prompt — simpler, less screen real estate.
 *
 * Slug auto-derives from name on first save (handled in the store's
 * `createPrompt`); once saved, the slug stays stable across renames
 * unless the user explicitly edits it. See docs/_done/PLAN-prompt-library.md.
 */

export interface PromptDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When set, the dialog opens in edit mode pre-filled with this
   *  prompt's fields. When omitted, opens in create mode. */
  prompt?: Prompt | null
}

export function PromptDialog({ open, onOpenChange, prompt }: PromptDialogProps) {
  const createPrompt = useStore((s) => s.createPrompt)
  const updatePrompt = useStore((s) => s.updatePrompt)
  const deletePrompt = useStore((s) => s.deletePrompt)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const isEdit = !!prompt

  const [name, setName] = useState("")
  const [template, setTemplate] = useState("")
  const nameRef = useRef<HTMLInputElement>(null)

  // Reset local fields whenever the dialog reopens with a different
  // prompt — important when the dialog instance is reused across
  // multiple rows.
  useEffect(() => {
    if (!open) return
    setName(prompt?.name ?? "")
    setTemplate(prompt?.template ?? "")
    // Auto-focus name on open; tiny delay so Radix's focus management
    // doesn't fight us.
    const t = setTimeout(() => nameRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [open, prompt?.id, prompt?.name, prompt?.template])

  // Derived: variables list refreshes as the template changes. Read-
  // only — purely for the user to see what they'll be asked to fill in.
  const variables = useMemo(() => parseTemplate(template).variables, [template])

  const canSave = name.trim().length > 0 && template.length > 0

  function handleSave() {
    if (!canSave) return
    if (isEdit && prompt) {
      updatePrompt(prompt.id, { name, template })
    } else {
      createPrompt({ workspaceId: activeWorkspaceId, name, template })
    }
    onOpenChange(false)
  }

  function handleDelete() {
    if (!prompt) return
    deletePrompt(prompt.id)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit prompt" : "New prompt"}</DialogTitle>
          <DialogDescription>
            Save a reusable template. Use{" "}
            <code className="px-1 py-0.5 rounded bg-[var(--muted)] text-xs">
              {"{variable}"}
            </code>{" "}
            markers — you&apos;ll be asked to fill them in when inserting.
            Use <code className="text-[10px] bg-[var(--muted)]/40 rounded px-0.5">
              {"{{"}
            </code>{" "}and{" "}
            <code className="text-[10px] bg-[var(--muted)]/40 rounded px-0.5">
              {"}}"}
            </code>{" "}for literal braces.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label
              htmlFor="prompt-name"
              className="text-xs font-medium text-[var(--muted-foreground)]"
            >
              Name
            </label>
            <Input
              id="prompt-name"
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Rewrite in voice"
              maxLength={120}
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="prompt-template"
              className="text-xs font-medium text-[var(--muted-foreground)]"
            >
              Template
            </label>
            <textarea
              id="prompt-template"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder={
                "Rewrite the following text in the voice of {persona}:\n\n{text}"
              }
              rows={8}
              className={cn(
                "w-full min-h-[10rem] rounded-md border border-[var(--border)] bg-[var(--background)]",
                "px-3 py-2 text-sm font-mono leading-snug",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]",
                "resize-y"
              )}
              maxLength={8000}
            />
          </div>

          {variables.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-[var(--muted-foreground)]">
                Variables detected ({variables.length})
              </p>
              <div className="flex flex-wrap gap-1">
                {variables.map((v) => (
                  <span
                    key={v}
                    className={cn(
                      "inline-flex items-center rounded-md px-1.5 py-0.5",
                      "bg-[var(--muted)]/60 text-[var(--foreground)] text-[10px] font-mono"
                    )}
                  >
                    {v}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="sm:justify-between gap-2 sm:gap-0">
          <div>
            {isEdit && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleDelete}
                className="text-[var(--destructive)] hover:text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
              >
                <Trash2 size={14} />
                Delete
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              size="sm"
              onClick={handleSave}
              disabled={!canSave}
            >
              {isEdit ? "Save changes" : "Create"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

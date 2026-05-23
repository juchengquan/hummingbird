"use client"

import { useEffect, useRef, useState } from "react"

import { expandTemplate } from "@/shared/prompts/expand"
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
 * Variable fill-in modal — opens when a prompt with `{{variable}}`
 * markers is clicked from the sidebar. One text input per variable,
 * tab between them. Submit (Enter on last field or click Insert)
 * expands the template and hands the result to `onInsert` (which the
 * sidebar wires to `setPendingChatInput`); Cancel/Esc dismisses
 * without inserting.
 *
 * Single-line text inputs in v1 — the plan flags richer variable
 * types (multi-line, URL, enum) as deferred. Plain text covers the
 * 90% case for "rewrite in {{voice}}" style prompts.
 */

export interface PromptVariableFillProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  prompt: Prompt | null
  onInsert: (expanded: string) => void
}

export function PromptVariableFill({
  open,
  onOpenChange,
  prompt,
  onInsert,
}: PromptVariableFillProps) {
  const [fills, setFills] = useState<Record<string, string>>({})
  const firstInputRef = useRef<HTMLInputElement>(null)

  // Reset on every (open × prompt) change. Keying off prompt.id keeps
  // the slot-state clean if the dialog is reused for a different
  // prompt without unmounting.
  useEffect(() => {
    if (!open) return
    setFills({})
    const t = setTimeout(() => firstInputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [open, prompt?.id])

  if (!prompt) return null

  const allFilled = prompt.variables.every((v) => (fills[v] ?? "").length > 0)

  function handleInsert() {
    if (!prompt) return
    // Allow inserting even with partial fills — missing markers stay
    // as `{{var}}` in the chat input so the user can edit in place if
    // they want. Empty-string values intentionally substitute empty
    // (see expandTemplate docs).
    onInsert(expandTemplate(prompt.template, fills))
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Fill in: {prompt.name}</DialogTitle>
          <DialogDescription className="text-xs">
            {prompt.variables.length}{" "}
            {prompt.variables.length === 1 ? "variable" : "variables"} —
            press Enter on the last field to insert.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleInsert()
          }}
          className="space-y-3"
        >
          {prompt.variables.map((variable, i) => (
            <div key={variable} className="space-y-1">
              <label
                htmlFor={`var-${variable}`}
                className={cn(
                  "text-xs font-medium text-[var(--muted-foreground)]",
                  "font-mono"
                )}
              >
                {variable}
              </label>
              <Input
                id={`var-${variable}`}
                ref={i === 0 ? firstInputRef : undefined}
                value={fills[variable] ?? ""}
                onChange={(e) =>
                  setFills((prev) => ({ ...prev, [variable]: e.target.value }))
                }
                autoComplete="off"
              />
            </div>
          ))}

          <DialogFooter className="gap-2 sm:gap-0">
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={!allFilled}>
              Insert
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

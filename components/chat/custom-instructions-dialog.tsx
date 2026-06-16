"use client"

import { useEffect, useState } from "react"

import { useStore } from "@/client/hooks/use-store"
import {
  ACCOUNT_INSTRUCTIONS_MAX,
  useAccountInstructions,
} from "@/client/hooks/store/slices/account-instructions"
import { useSyncEnabled } from "@/client/hooks/use-sync-enabled"
import { writeAccountInstructions } from "@/client/supabase/account-instructions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/shared/utils"

/**
 * Account-level custom instructions editor. Two free-text fields applied
 * to every chat as the base of the system-prompt cascade — beneath any
 * workspace voice, thread instructions, or active persona. Local-first;
 * syncs to the user's profile when signed in. Opened from AccountMenu.
 *
 * Mirrors the per-conversation `ThreadInstructionsDialog`: a controlled
 * `open`/`onClose`, drafts seeded from the store when the dialog opens,
 * and saved on explicit Save (not per-keystroke).
 */
export function CustomInstructionsDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const setAccountInstructions = useStore((s) => s.setAccountInstructions)
  const { about, style } = useAccountInstructions()
  // `userId` is non-null only when signed in AND cloud sync is enabled
  // (folds in the local-only opt-out). Anonymous / local-only users get
  // `null` → the write-through is skipped → zero Supabase calls.
  const { userId } = useSyncEnabled()
  const [aboutDraft, setAboutDraft] = useState("")
  const [styleDraft, setStyleDraft] = useState("")

  // Re-seed drafts whenever the dialog opens. Closing without saving
  // discards the drafts — matches the thread-instructions editor.
  useEffect(() => {
    if (open) {
      setAboutDraft(about)
      setStyleDraft(style)
    }
  }, [open, about, style])

  const save = () => {
    setAccountInstructions({ about: aboutDraft, style: styleDraft })
    // Best-effort write-through to the user's profile row when signed in.
    // Not awaited — local state is already updated and authoritative.
    if (userId) {
      void writeAccountInstructions(userId, {
        about: aboutDraft,
        style: styleDraft,
      })
    }
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Custom instructions</DialogTitle>
          <DialogDescription>
            Applied to every chat, across all workspaces — beneath any
            workspace voice, thread instructions, or active persona.
          </DialogDescription>
        </DialogHeader>

        <label className="text-sm font-medium" htmlFor="ci-about">
          What should the model know about you?
        </label>
        <Textarea
          id="ci-about"
          value={aboutDraft}
          onChange={(e) =>
            setAboutDraft(e.target.value.slice(0, ACCOUNT_INSTRUCTIONS_MAX))
          }
          maxLength={ACCOUNT_INSTRUCTIONS_MAX}
          rows={5}
          className="min-h-[120px] resize-y text-sm"
          placeholder="e.g. I'm a backend engineer; I run Postgres 16 on Hetzner; I prefer TypeScript."
        />
        <div className="text-right text-xs text-[var(--muted-foreground)]">
          {aboutDraft.length.toLocaleString()} /{" "}
          {ACCOUNT_INSTRUCTIONS_MAX.toLocaleString()}
        </div>

        <label className="text-sm font-medium" htmlFor="ci-style">
          How should the model respond?
        </label>
        <Textarea
          id="ci-style"
          value={styleDraft}
          onChange={(e) =>
            setStyleDraft(e.target.value.slice(0, ACCOUNT_INSTRUCTIONS_MAX))
          }
          maxLength={ACCOUNT_INSTRUCTIONS_MAX}
          rows={5}
          className={cn("min-h-[120px] resize-y text-sm")}
          placeholder="e.g. Be terse and direct. No preamble. Show code first, explanation after."
        />
        <div className="text-right text-xs text-[var(--muted-foreground)]">
          {styleDraft.length.toLocaleString()} /{" "}
          {ACCOUNT_INSTRUCTIONS_MAX.toLocaleString()}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

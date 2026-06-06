"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"

import { useStore } from "@/client/hooks/use-store"
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
import type { Conversation } from "@/shared/types"
import { cn } from "@/shared/utils"

/** Max characters per conversation prompt. Matches `Workspace.systemPrompt`'s
 *  cap and the agent-py `ChatRequest.system` cap (20,000). */
const MAX_CHARS = 20_000

interface ThreadInstructionsDialogProps {
  conversation: Conversation | null
  onClose: () => void
}

/** "Thread instructions" — the per-conversation tier in the chat-send
 *  cascade documented in `docs/PLAN-conversation-system-prompt.md`.
 *  Long-lived context narrower than the workspace voice + broader
 *  than a per-turn persona swap. Persists in `Conversation.systemPrompt`
 *  via the store mutator; saved on explicit Save (not on every keystroke
 *  — the conversation row otherwise updates per-message and a debounced
 *  field would inflate `updatedAt` churn). */
export function ThreadInstructionsDialog({
  conversation,
  onClose,
}: ThreadInstructionsDialogProps) {
  const setConversationSystemPrompt = useStore(
    (s) => s.setConversationSystemPrompt,
  )
  const [draft, setDraft] = useState("")

  // Re-seed the draft whenever the dialog opens against a different
  // conversation. Closing the dialog without saving discards the
  // draft — matches the workspace-prompt editor's behaviour.
  useEffect(() => {
    if (conversation) setDraft(conversation.systemPrompt)
  }, [conversation])

  if (!conversation) return null

  const handleSave = () => {
    setConversationSystemPrompt(conversation.id, draft)
    toast.success(
      draft.trim().length === 0
        ? "Thread instructions cleared"
        : "Thread instructions saved",
    )
    onClose()
  }

  const handleClear = () => {
    setDraft("")
  }

  const charCount = draft.length
  const overCap = charCount > MAX_CHARS
  const showWarning = charCount > MAX_CHARS * 0.9

  return (
    <Dialog open={!!conversation} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Thread instructions</DialogTitle>
          <DialogDescription>
            Long-lived context for this conversation. Applied to every
            turn alongside the workspace voice and any active persona —
            switching personas does not clear these instructions.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. We're planning Q4 OKRs. Assume the engineering org has 3 teams. Refer to the attached doc as the source of truth."
          className="min-h-[200px] font-mono text-sm"
          autoFocus
        />

        <div className="flex items-center justify-between text-xs">
          <span
            className={cn(
              "text-[var(--muted-foreground)]",
              showWarning && "text-amber-600 dark:text-amber-400",
              overCap && "text-[var(--destructive)]",
            )}
            aria-live="polite"
          >
            {charCount.toLocaleString()} / {MAX_CHARS.toLocaleString()} characters
          </span>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="ghost"
            onClick={handleClear}
            disabled={draft.length === 0}
          >
            Clear
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={overCap}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

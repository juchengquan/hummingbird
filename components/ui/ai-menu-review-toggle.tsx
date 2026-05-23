"use client"

import * as React from "react"
import { BookOpenCheck } from "lucide-react"

import { useStore } from "@/client/hooks/use-store"
import { cn } from "@/shared/utils"

/**
 * "Review changes" toggle. When ON (default), AI `edit`-mode output
 * lands as Plate suggestion marks the user can accept / reject per
 * chunk; when OFF, the AI replaces the selected text directly.
 *
 * Rendered as a footer row in the AI menu so it sits near the input
 * the user just typed but doesn't compete with the action items
 * above. Click toggles; the toggle persists per-user (lives in
 * `editorPrefs.aiReviewChanges` via the Zustand store).
 *
 * Only mount this for command states (`cursorCommand`,
 * `selectionCommand`). In the suggestion states the AI has already
 * produced output — flipping the toggle then can't change anything
 * for this turn.
 */
export function AIMenuReviewToggle() {
  const aiReviewChanges = useStore((s) => s.editorPrefs.aiReviewChanges)
  const setEditorPref = useStore((s) => s.setEditorPref)

  return (
    <button
      type="button"
      role="switch"
      aria-checked={aiReviewChanges}
      onClick={() => setEditorPref("aiReviewChanges", !aiReviewChanges)}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-xs border-t border-border",
        "text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
        "select-none"
      )}
    >
      <BookOpenCheck size={14} className="shrink-0" />
      <span className="grow text-left">Review changes</span>
      <span
        className={cn(
          "inline-flex h-4 w-7 items-center rounded-full transition-colors",
          aiReviewChanges ? "bg-emerald-500" : "bg-muted"
        )}
      >
        <span
          className={cn(
            "inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform",
            aiReviewChanges ? "translate-x-3.5" : "translate-x-0.5"
          )}
        />
      </span>
    </button>
  )
}

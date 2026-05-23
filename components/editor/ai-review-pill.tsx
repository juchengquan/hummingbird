"use client"

import * as React from "react"
import { Check, ChevronDown, ChevronUp, Sparkles, X } from "lucide-react"
import { useEditorRef, usePluginOption } from "platejs/react"
import { AIChatPlugin } from "@platejs/ai/react"
import { suggestionPlugin } from "@/components/editor/plugins/suggestion-kit"

import { Button } from "@/components/ui/button"
import { cn } from "@/shared/utils"

import {
  findPendingAiSuggestions,
  rejectRemainingAiSuggestions,
} from "@/client/editor/reject-remaining-ai-suggestions"

/**
 * Floating bottom-center pill that surfaces "N AI changes pending"
 * + Accept-all / Reject-remaining / jump-to-next while the editor
 * carries unresolved AI suggestions.
 *
 * Why a separate pill (not a tooltip on a single change): the
 * per-block accept/reject affordance from Plate's BlockSuggestion
 * card is hover-only, which is discovery-hostile for new users.
 * This pill makes the review flow visible without needing the user
 * to find the hover state first.
 *
 * "Reject remaining" is the meaningful gap vs. the existing AI
 * menu's "Discard" — the AI menu reverts the entire session
 * (including chunks the user has individually accepted via the
 * BlockSuggestion card), while this rejects only suggestions
 * still in pending state.
 */
export function AIReviewPill() {
  const editor = useEditorRef()
  // Re-render when the suggestion plugin's `activeId` changes (user
  // moved between suggestions). Doesn't cover accept/reject set
  // changes — those need the interval poll below.
  usePluginOption(suggestionPlugin, "activeId")

  const [pending, setPending] = React.useState<string[]>([])

  // Plate doesn't broadcast suggestion-set membership changes — there's
  // no editor option that flips when a suggestion is accepted/rejected
  // by `acceptSuggestion()` / `rejectSuggestion()`. Cheap workaround:
  // poll the editor on a short interval, but only while we already
  // know there's something to review or after a streaming session
  // (the more permissive gate keeps the poll dormant on idle docs).
  React.useEffect(() => {
    const tick = () => setPending(findPendingAiSuggestions(editor))
    tick() // initial read
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [editor])

  // Hide while there's nothing to review. Also hide while the AI is
  // streaming — `AILoadingBar` is the active surface at that point.
  const status = usePluginOption(AIChatPlugin, "chat")?.status
  const streaming = status === "streaming" || status === "submitted"
  if (streaming || pending.length === 0) return null

  const acceptAll = () => {
    // Reuse Plate's existing transform — same path as the AI menu's
    // "Accept" action.
    editor.getTransforms(AIChatPlugin).aiChat.accept()
    editor.tf.focus({ edge: "end" })
  }

  const rejectRemaining = () => {
    rejectRemainingAiSuggestions(editor)
    editor.tf.focus({ edge: "end" })
  }

  const focusFirst = () => focusSuggestion(editor, pending[0])
  const focusLast = () => focusSuggestion(editor, pending[pending.length - 1])

  return (
    <div
      role="region"
      aria-label="AI review"
      className={cn(
        "-translate-x-1/2 absolute bottom-4 left-1/2 z-20",
        "flex items-center gap-2 rounded-md border border-border bg-popover",
        "px-3 py-1.5 text-foreground text-sm shadow-md backdrop-blur-sm"
      )}
    >
      <Sparkles size={14} className="text-amber-500 shrink-0" />
      <span className="tabular-nums">
        {pending.length} AI {pending.length === 1 ? "change" : "changes"} pending
      </span>

      <div className="mx-1 h-4 w-px bg-border" />

      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs gap-1"
        onClick={focusFirst}
        aria-label="Jump to first pending change"
        title="Jump to first (Shift+Tab)"
      >
        <ChevronUp size={12} />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs gap-1"
        onClick={focusLast}
        aria-label="Jump to last pending change"
        title="Jump to last (Tab)"
      >
        <ChevronDown size={12} />
      </Button>

      <div className="mx-1 h-4 w-px bg-border" />

      <Button
        size="sm"
        variant="secondary"
        className="h-7 px-2 text-xs gap-1"
        onClick={acceptAll}
        title="Accept all (⌘↵)"
      >
        <Check size={12} />
        Accept all
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
        onClick={rejectRemaining}
        title="Reject remaining (Esc)"
      >
        <X size={12} />
        Reject remaining
      </Button>
    </div>
  )
}

/** Set the suggestion plugin's active id so the existing
 *  decoration's hover-active styling kicks in. Plate's
 *  BlockSuggestionCard reads this to highlight the focused chunk. */
function focusSuggestion(editor: ReturnType<typeof useEditorRef>, id: string) {
  editor.setOption(suggestionPlugin, "activeId", id)
}

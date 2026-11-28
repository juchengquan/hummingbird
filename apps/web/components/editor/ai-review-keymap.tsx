"use client"

import { useEditorRef, useHotkeys } from "platejs/react"
import { suggestionPlugin } from "@/components/editor/plugins/suggestion-kit"
import { AIChatPlugin } from "@platejs/ai/react"

import {
  findPendingAiSuggestions,
  rejectRemainingAiSuggestions,
} from "@/client/editor/reject-remaining-ai-suggestions"

/**
 * Mounts keyboard shortcuts that drive the AI review surface:
 *
 *   Tab            → focus next pending suggestion
 *   Shift+Tab      → focus previous pending suggestion
 *   ⌘↵ / Ctrl+↵    → accept all + dismiss
 *   Esc            → reject remaining + dismiss
 *
 * All handlers walk the editor for pending suggestions at the
 * moment of the keypress (cheap O(nodes) walk) — no polling, no
 * stale memoised pending sets. When the walk returns empty, the
 * handler returns early without calling `preventDefault`, so the
 * key falls through to the editor's normal behaviour (e.g. `Esc`
 * dismissing the AI menu, `Tab` inserting a tab character).
 *
 * Y / N letter shortcuts were considered and dropped — too easy
 * to fire by accident while typing, and Word / Google Docs Track
 * Changes don't have them either. Acceptance lives on the
 * BlockSuggestion card's ✓/✕ buttons (existing) and on the
 * review pill's Accept-all / Reject-remaining controls.
 *
 * Renders nothing — side-effect-only component mounted alongside
 * the editor.
 */
export function AIReviewKeymap() {
  const editor = useEditorRef()

  useHotkeys(
    "tab",
    (e) => {
      const pending = findPendingAiSuggestions(editor)
      if (pending.length === 0) return
      e.preventDefault()
      const activeId = editor.getOption(suggestionPlugin, "activeId")
      const idx = activeId ? pending.indexOf(activeId) : -1
      const nextIdx = idx === -1 ? 0 : (idx + 1) % pending.length
      editor.setOption(suggestionPlugin, "activeId", pending[nextIdx])
    },
    { enableOnContentEditable: true },
    [editor]
  )

  useHotkeys(
    "shift+tab",
    (e) => {
      const pending = findPendingAiSuggestions(editor)
      if (pending.length === 0) return
      e.preventDefault()
      const activeId = editor.getOption(suggestionPlugin, "activeId")
      const idx = activeId ? pending.indexOf(activeId) : -1
      const prevIdx =
        idx === -1
          ? pending.length - 1
          : (idx - 1 + pending.length) % pending.length
      editor.setOption(suggestionPlugin, "activeId", pending[prevIdx])
    },
    { enableOnContentEditable: true },
    [editor]
  )

  useHotkeys(
    "mod+enter",
    (e) => {
      const pending = findPendingAiSuggestions(editor)
      if (pending.length === 0) return
      e.preventDefault()
      editor.getTransforms(AIChatPlugin).aiChat.accept()
    },
    { enableOnContentEditable: true },
    [editor]
  )

  useHotkeys(
    "esc",
    (e) => {
      const pending = findPendingAiSuggestions(editor)
      if (pending.length === 0) return
      e.preventDefault()
      rejectRemainingAiSuggestions(editor)
    },
    { enableOnContentEditable: true },
    [editor]
  )

  return null
}

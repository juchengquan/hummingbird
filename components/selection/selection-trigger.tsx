"use client"

import { useCallback, useEffect, useState } from "react"

import { SelectionToolbar } from "@/components/selection/selection-toolbar"
import { SelectionChip } from "@/components/selection/selection-chip"
import { ExplainPopover } from "@/components/selection/explain-popover"
import { ExplainSheet } from "@/components/selection/explain-sheet"
import { useIsTouchDevice } from "@/client/hooks/use-is-touch-device"
import {
  useSelection,
  type ActiveSelection,
} from "@/client/hooks/use-selection"
import { useStore } from "@/client/hooks/use-store"
import type { Message, ToolCallResult } from "@/shared/types"

interface SelectionTriggerProps {
  /** Conversation history up to and including the message the
   *  selection lives in. Caller's job to slice. */
  resolveContext: (scope: string) => Message[] | null
  /** Current chat model id; forwarded to the popover. */
  chatModel: string
  /** Workspace-level system prompt for the request. */
  workspaceSystemPrompt?: string
  /** Skills payload for the request — same shape as the chat panel
   *  passes to /api/chat. */
  skills?: Array<{ id: string }>
  /** Called when the user clicks "Quote in reply". The host (ChatPanel)
   *  decides what to do — typically: append a blockquote to the input,
   *  focus the textarea. */
  onQuote: (text: string) => void
  /** Called when the user pins an explanation from the popover. Host
   *  forwards to `pinExplanation` on the store (which knows the active
   *  conversation id). */
  onPin: (input: {
    selection: string
    content: string
    model: string
    results: ToolCallResult[]
  }) => void
}

/**
 * Wires up the selection-driven action surface (Phase 1: desktop only).
 *
 * Owns the selection-state lifecycle: when the user selects text inside
 * an assistant message, the floating toolbar appears above the
 * selection. Clicking Explain opens a streamed popover anchored to the
 * selection; clicking Quote fires `onQuote`.
 *
 * Mobile branching (touch device → chip + bottom sheet) is Phase 3.
 * For now, we render the desktop surface unconditionally — touch users
 * fall back to the OS selection menu and can still use the action
 * we'd later show on the chip via `⌘E`, which won't fire on touch.
 *
 * `⌘E` runs Explain whenever there's an active selection. `Esc`
 * dismisses both the popover and the toolbar.
 */
export function SelectionTrigger({
  resolveContext,
  chatModel,
  workspaceSystemPrompt,
  skills,
  onQuote,
  onPin,
}: SelectionTriggerProps) {
  const active = useSelection({ scopeSelector: "[data-selection-scope]" })

  // When the user opens the popover, we snapshot the selection here so
  // it survives the user clicking inside the popover (which collapses
  // the underlying browser selection).
  const [explainTarget, setExplainTarget] = useState<{
    text: string
    rect: DOMRect
    context: Message[]
  } | null>(null)

  const startExplain = useCallback(
    (sel: ActiveSelection) => {
      const ctx = resolveContext(sel.scope)
      if (!ctx) return
      setExplainTarget({ text: sel.text, rect: sel.rect, context: ctx })
    },
    [resolveContext]
  )

  // Subscribe to the cross-component action bus. The command palette
  // fires actions here when the user invokes them via `⌘K` — focus
  // moves to the palette input which collapses the document selection,
  // so we can't read it ourselves at that moment. The palette snapshots
  // it on open and dispatches a payload with the captured rect.
  const pendingAction = useStore((s) => s.pendingSelectionAction)
  const clearSelectionAction = useStore((s) => s.clearSelectionAction)
  useEffect(() => {
    if (!pendingAction) return
    if (pendingAction.type === "explain") {
      const ctx = resolveContext(pendingAction.scope)
      if (ctx) {
        const r = pendingAction.rect
        const rect = new DOMRect(r.left, r.top, r.width, r.height)
        setExplainTarget({ text: pendingAction.text, rect, context: ctx })
      }
    } else if (pendingAction.type === "quote") {
      onQuote(pendingAction.text)
    }
    clearSelectionAction()
  }, [pendingAction, resolveContext, onQuote, clearSelectionAction])

  // ⌘E (or Ctrl+E on non-Mac) runs Explain on the current selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.key.toLowerCase() !== "e") return
      if (!active) return
      // Don't hijack if the user is typing in an input/textarea — they
      // may have system-level ⌘E bindings.
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
        return
      }
      e.preventDefault()
      startExplain(active)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [active, startExplain])

  // Touch-device branching: mobile gets a single-action chip + bottom
  // sheet; desktop gets the toolbar + anchored popover. Both share the
  // streaming hook (`useExplainStream`) so behavior is identical;
  // only layout differs. iPad Safari sometimes reports `maxTouchPoints
  // > 0` while running with a Magic Keyboard — accept that the user
  // gets the touch UI in that case, since OS selection still works.
  const isTouch = useIsTouchDevice()

  const pinHandler = ({ content, results }: { content: string; results: ToolCallResult[] }) => {
    if (!explainTarget) return
    onPin({
      selection: explainTarget.text,
      content,
      model: chatModel,
      results,
    })
  }

  return (
    <>
      {active && !explainTarget && (
        isTouch ? (
          <SelectionChip
            selection={active}
            onExplain={() => startExplain(active)}
          />
        ) : (
          <SelectionToolbar
            selection={active}
            onExplain={() => startExplain(active)}
            onQuote={() => onQuote(active.text)}
          />
        )
      )}
      {explainTarget && (
        isTouch ? (
          <ExplainSheet
            selection={explainTarget.text}
            contextMessages={explainTarget.context}
            model={chatModel}
            workspaceSystemPrompt={workspaceSystemPrompt}
            skills={skills}
            onPin={pinHandler}
            onClose={() => setExplainTarget(null)}
          />
        ) : (
          <ExplainPopover
            anchorRect={explainTarget.rect}
            selection={explainTarget.text}
            contextMessages={explainTarget.context}
            model={chatModel}
            workspaceSystemPrompt={workspaceSystemPrompt}
            skills={skills}
            onPin={pinHandler}
            onClose={() => setExplainTarget(null)}
          />
        )
      )}
    </>
  )
}

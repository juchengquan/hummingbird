"use client"
import "client-only"

import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Selection state observed by `SelectionTrigger`. `rect` is the bounding
 * client rect of the selection at the moment it was captured — callers
 * use it to position floating UI. The trigger keeps the rect updated on
 * scroll so the toolbar stays attached to the selection.
 */
export interface ActiveSelection {
  text: string
  rect: DOMRect
  /** The data-selection-scope attribute value of the closest matching
   *  ancestor — e.g. `"message-<msgId>"`. Used by the trigger to confirm
   *  the selection landed inside content it cares about (assistant
   *  messages, currently) and to derive the message id when needed. */
  scope: string
}

interface UseSelectionOptions {
  /** Selector matched against an ancestor of the selection's common
   *  container. Selections that don't match are ignored. Pass an
   *  attribute selector to read out the scope value, e.g.
   *  `"[data-selection-scope]"`. */
  scopeSelector: string
  /** Debounce in ms before publishing a selection change. Stops the
   *  toolbar flickering during drag-selection. */
  debounceMs?: number
}

/**
 * Tracks the user's current text selection scoped to a given marker.
 * Returns `null` when there's no selection, the selection is collapsed,
 * or the selection doesn't fall inside an element matching
 * `scopeSelector`.
 *
 * Updates the `rect` field whenever the page scrolls so floating UI
 * stays glued to the selection. Cleared on click outside the scope.
 */
export function useSelection({
  scopeSelector,
  debounceMs = 150,
}: UseSelectionOptions): ActiveSelection | null {
  const [selection, setSelection] = useState<ActiveSelection | null>(null)
  const timerRef = useRef<number | null>(null)

  // Reusable compute step — invoked on selectionchange (debounced) and
  // synchronously on scroll (cheap; just re-reads the existing range).
  const compute = useCallback((): ActiveSelection | null => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null

    const text = sel.toString().trim()
    if (text.length === 0) return null

    const range = sel.getRangeAt(0)
    // Walk up from common ancestor to find the scope marker.
    let node: Node | null = range.commonAncestorContainer
    while (node && node.nodeType !== 1) node = node.parentNode
    const el = node as Element | null
    if (!el) return null

    const scopeEl = el.closest(scopeSelector) as HTMLElement | null
    if (!scopeEl) return null

    const scope = scopeEl.dataset.selectionScope ?? ""
    if (!scope) return null

    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null

    return { text, rect, scope }
  }, [scopeSelector])

  // Subscribe to selectionchange with a small debounce so dragging
  // doesn't fire a toolbar flicker on every mousemove.
  useEffect(() => {
    const onSelectionChange = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        const next = compute()
        setSelection((prev) => {
          if (!prev && !next) return prev
          if (prev && next && prev.text === next.text && prev.scope === next.scope) {
            // Same selection, same scope — keep prev (skip rect-only diff
            // to avoid an extra render; scroll handler manages rect).
            return prev
          }
          return next
        })
      }, debounceMs)
    }

    document.addEventListener("selectionchange", onSelectionChange)
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange)
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [compute, debounceMs])

  // Keep the rect glued to the selection while the page scrolls.
  // Without this the toolbar drifts off-screen relative to the text.
  useEffect(() => {
    if (!selection) return
    const update = () => {
      const next = compute()
      if (!next) {
        setSelection(null)
        return
      }
      setSelection((prev) => (prev ? { ...prev, rect: next.rect } : prev))
    }
    window.addEventListener("scroll", update, { passive: true, capture: true })
    return () => {
      window.removeEventListener("scroll", update, { capture: true })
    }
  }, [selection, compute])

  return selection
}

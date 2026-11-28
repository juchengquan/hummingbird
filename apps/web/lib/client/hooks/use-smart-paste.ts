"use client"
import "client-only"

/**
 * `useSmartPaste` — owns the chat input's smart-paste chip state.
 *
 * Lifecycle the panel used to manage inline:
 *  - On paste: if the pasted text *is* the input (or close to it), run
 *    `detectPasteKind` and stash the detection.
 *  - On input change: auto-dismiss when the pasted snippet has been
 *    edited out enough that the chip's "apply this prompt" semantics
 *    would surprise.
 *  - On send / explicit cancel: dismiss.
 *
 * Returns state + the two event handlers + an explicit `dismiss`. The
 * panel keeps the apply action (it touches the textarea ref and
 * `setInputValue`, which are panel concerns).
 */

import { useCallback, useState } from "react"

import { detectPasteKind, type PasteDetection } from "@/shared/smart-paste/detect"

export interface UseSmartPasteResult {
  /** Active chip detection, or null when no chip should render. */
  detection: PasteDetection | null
  /** Wire as the textarea's `onPaste` handler. */
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  /** Call from the textarea's `onChange` after the new value has been
   *  set; auto-dismisses the chip when the user has edited the input
   *  enough that the originally-pasted snippet is no longer there. */
  syncFromInput: (nextInputValue: string) => void
  /** Explicit dismissal (e.g. send fired, or the user closed the chip). */
  dismiss: () => void
}

export function useSmartPaste(): UseSmartPasteResult {
  const [detection, setDetection] = useState<PasteDetection | null>(null)

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const pasted = e.clipboardData.getData("text")
      if (!pasted) return
      // Only show the chip when the paste *is* the input (or close to
      // it). If the user is pasting into an existing draft, the chip's
      // "replace input" semantics would be surprising — bail in that
      // case.
      const ta = e.currentTarget
      const existing = ta.value.trim()
      if (
        existing.length > 0 &&
        !pasted.includes(existing) &&
        !existing.includes(pasted.slice(0, 40))
      ) {
        return
      }
      const next = detectPasteKind(pasted)
      if (next) setDetection(next)
    },
    []
  )

  const syncFromInput = useCallback((nextInputValue: string) => {
    setDetection((current) => {
      if (!current) return current
      // The "is the original snippet still here?" check uses the first
      // 80 chars — long enough to be a fingerprint, short enough to
      // survive light edits at the end.
      return nextInputValue.includes(current.snippet.slice(0, 80))
        ? current
        : null
    })
  }, [])

  const dismiss = useCallback(() => setDetection(null), [])

  return { detection, onPaste, syncFromInput, dismiss }
}

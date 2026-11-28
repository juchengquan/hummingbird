"use client"
import "client-only"

/**
 * `usePromptMentionAutocomplete` — the `@` prompt-mention menu state
 * machine, lifted out of `components/panels/chat.tsx`. Sibling of
 * `useSlashAutocomplete`; the two are mutually exclusive (each needs its
 * own leading char) and share the pure `navigateAutocomplete` reducer for
 * keyboard handling.
 *
 * Picking a prompt expands its template into the input (replacing the
 * `@slug`); prompts carrying `{variable}` markers route through a fill
 * modal first — this hook owns the `fillPrompt` state for that modal and
 * the `completeFill` callback the modal calls back with the expanded
 * text. Programmatic input writes bypass the textarea's onChange-driven
 * auto-grow, so the panel's `resizeInput` callback runs the rAF resize.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import { navigateAutocomplete } from "@/shared/autocomplete-nav"
import { expandTemplate } from "@/shared/prompts/expand"
import {
  isTypingPromptMention,
  matchPromptMentions,
} from "@/shared/prompts/mention-parser"
import type { Prompt } from "@/shared/types"

export interface UsePromptMentionAutocompleteOptions {
  /** Live chat-input value; the match set derives from it. */
  inputValue: string
  /** Prompt library to match `@slug` against. */
  prompts: Prompt[]
  /** Replace the chat input with the expanded template. */
  setInputValue: (value: string) => void
  /** rAF resize + focus + caret-to-end after a programmatic input write.
   *  Programmatic value changes don't trigger the Textarea's own
   *  onChange-driven auto-resize, so the panel runs it explicitly. */
  resizeInput: () => void
}

export interface UsePromptMentionAutocompleteResult {
  /** True iff the menu should render (has matches and isn't dismissed). */
  open: boolean
  matches: Prompt[]
  activeIndex: number
  setActiveIndex: (index: number) => void
  /** Apply a prompt: expand inline, or open the fill modal if it has
   *  `{variable}` markers. */
  pick: (prompt: Prompt) => void
  /** Feed a keydown to the menu. Returns true iff it consumed the key. */
  onKeyDown: (e: React.KeyboardEvent) => boolean
  /** Prompt routed to the variable-fill modal, or null when closed. */
  fillPrompt: Prompt | null
  setFillPrompt: (prompt: Prompt | null) => void
  /** Complete a fill-modal insert: drop the expanded text into the
   *  input, close the modal, reset the highlight, resize. */
  completeFill: (expanded: string) => void
}

export function usePromptMentionAutocomplete({
  inputValue,
  prompts,
  setInputValue,
  resizeInput,
}: UsePromptMentionAutocompleteOptions): UsePromptMentionAutocompleteResult {
  const [activeIndex, setActiveIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [fillPrompt, setFillPrompt] = useState<Prompt | null>(null)

  const matches = useMemo(
    () =>
      isTypingPromptMention(inputValue)
        ? matchPromptMentions(inputValue.slice(1), prompts)
        : [],
    [inputValue, prompts]
  )

  const open = !dismissed && matches.length > 0

  useEffect(() => {
    setActiveIndex((i) => (i >= matches.length ? 0 : i))
  }, [matches.length])

  // Re-arm once the input no longer starts with `@` (see the slash hook's
  // sibling note — the match set is already empty by then).
  useEffect(() => {
    if (!inputValue.startsWith("@") && dismissed) setDismissed(false)
  }, [inputValue, dismissed])

  const pick = useCallback(
    (prompt: Prompt) => {
      if (prompt.variables.length > 0) {
        // Defer expansion to the fill modal; it calls back via
        // `completeFill` with the expanded text.
        setFillPrompt(prompt)
        return
      }
      // No variables — expand (a no-op substitution) straight into the
      // input, clearing the `@slug` token entirely.
      setInputValue(expandTemplate(prompt.template, {}))
      setActiveIndex(0)
      resizeInput()
    },
    [setInputValue, resizeInput]
  )

  const completeFill = useCallback(
    (expanded: string) => {
      setInputValue(expanded)
      setFillPrompt(null)
      setActiveIndex(0)
      resizeInput()
    },
    [setInputValue, resizeInput]
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!open) return false
      const nav = navigateAutocomplete(e.key, matches.length, activeIndex)
      if (nav.kind === "passthrough") return false
      e.preventDefault()
      switch (nav.kind) {
        case "move":
          setActiveIndex(nav.index)
          break
        case "pick": {
          const prompt = matches[activeIndex]
          if (prompt) pick(prompt)
          break
        }
        case "dismiss":
          setDismissed(true)
          break
      }
      return true
    },
    [open, matches, activeIndex, pick]
  )

  return {
    open,
    matches,
    activeIndex,
    setActiveIndex,
    pick,
    onKeyDown,
    fillPrompt,
    setFillPrompt,
    completeFill,
  }
}

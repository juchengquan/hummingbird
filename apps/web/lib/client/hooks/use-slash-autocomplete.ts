"use client"
import "client-only"

/**
 * `useSlashAutocomplete` — the `/` slash-command menu state machine,
 * lifted out of `components/panels/chat.tsx`.
 *
 * Owns the highlighted-row index, the Escape-dismiss flag (re-armed once
 * the input stops being a slash token), the derived match set, and the
 * keyboard navigation. The *actions* a pick triggers (running an instant
 * command, rewriting the input, focusing the textarea) stay panel
 * concerns and are injected as callbacks. The shared up/down/enter/escape
 * branch logic lives in `navigateAutocomplete` (pure, tested) so this
 * hook and `usePromptMentionAutocomplete` stay in lock-step.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import { navigateAutocomplete } from "@/shared/autocomplete-nav"
import type { CommandId } from "@/shared/commands/registry"
import { isTypingSlashCommand } from "@/shared/skills/slash-parser"
import { matchSlashMenu, type SlashMenuEntry } from "@/shared/slash-resolver"
import type { Agent } from "@/shared/types"

export interface UseSlashAutocompleteOptions {
  /** Live chat-input value; the match set derives from it. */
  inputValue: string
  /** Active-workspace personas, folded into the slash surface so
   *  `/<slug>` triggers resolve alongside skills, commands, and modes. */
  agents: Agent[]
  /** Run an instant (argKind `'none'`) command. Wraps the panel's
   *  `useSlashCommands().run`. */
  runCommand: (id: CommandId) => void
  /** Replace the chat input — complete to `/trigger ` or clear it. */
  setInputValue: (value: string) => void
  /** Re-focus the textarea after a pick. */
  focusInput: () => void
}

export interface UseSlashAutocompleteResult {
  /** True iff the menu should render (has matches and isn't dismissed). */
  open: boolean
  matches: SlashMenuEntry[]
  activeIndex: number
  setActiveIndex: (index: number) => void
  /** Apply a menu entry (run-and-clear for instant commands, otherwise
   *  complete the trigger). */
  pick: (entry: SlashMenuEntry) => void
  /** Feed a keydown to the menu. Returns true iff the menu consumed it
   *  (caller should then stop — don't send / move the caret). */
  onKeyDown: (e: React.KeyboardEvent) => boolean
}

export function useSlashAutocomplete({
  inputValue,
  agents,
  runCommand,
  setInputValue,
  focusInput,
}: UseSlashAutocompleteOptions): UseSlashAutocompleteResult {
  const [activeIndex, setActiveIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)

  const matches = useMemo<SlashMenuEntry[]>(
    () =>
      isTypingSlashCommand(inputValue)
        ? matchSlashMenu(inputValue.slice(1), { agents })
        : [],
    [inputValue, agents]
  )

  const open = !dismissed && matches.length > 0

  // Keep the highlighted row in range as the match set shrinks while
  // typing.
  useEffect(() => {
    setActiveIndex((i) => (i >= matches.length ? 0 : i))
  }, [matches.length])

  // Re-arm once the input no longer starts with `/`, so a prior Escape
  // doesn't keep the menu closed forever. By the time this fires the
  // match set is already empty (not a slash token), so the visible menu
  // state is identical to the old inline onChange re-arm.
  useEffect(() => {
    if (!inputValue.startsWith("/") && dismissed) setDismissed(false)
  }, [inputValue, dismissed])

  const pick = useCallback(
    (entry: SlashMenuEntry) => {
      // Skill picks and arg-taking commands complete to `/trigger ` so
      // the user types the body. Instant commands (argKind 'none') run
      // immediately and clear the input.
      const instant = entry.kind === "command" && entry.argKind === "none"
      if (instant) {
        runCommand(entry.id as CommandId)
        setInputValue("")
      } else {
        setInputValue(`/${entry.trigger} `)
      }
      setActiveIndex(0)
      focusInput()
    },
    [runCommand, setInputValue, focusInput]
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
          const entry = matches[activeIndex]
          if (entry) pick(entry)
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

  return { open, matches, activeIndex, setActiveIndex, pick, onKeyDown }
}

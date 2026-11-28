"use client"
import "client-only"

/**
 * `useAttachmentMentionAutocomplete` — the `#` attachment-mention menu
 * state machine. Sibling of `useSlashAutocomplete` (`/`) and
 * `usePromptMentionAutocomplete` (`@`); the three are mutually
 * exclusive (each needs its own leading char) and share the pure
 * `navigateAutocomplete` reducer for keyboard handling.
 *
 * Picking an entry attaches the file or bookmark to the active
 * conversation via the existing toggle mutators
 * (`toggleConversationFileSelection`,
 * `toggleConversationUrlBookmarkSelection`, plus the
 * `addConversationFile` join for private files) and **clears the
 * `#token` from the input** — the attachment now lives on the
 * conversation row, not in the message text the model will see.
 *
 * Caller supplies the source pools so the hook stays composable. If
 * the active conversation has already attached the picked item, the
 * pick is a no-op on the store but still clears the token from the
 * input — matches the existing context picker's "click to toggle"
 * semantics without surprising the user when they re-pick the same
 * row.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  isTypingAttachmentMention,
  matchAttachmentMentions,
  type AttachmentMentionMatch,
  type AttachmentMentionSources,
} from "@/shared/attachment-mentions/parser"
import { navigateAutocomplete } from "@/shared/autocomplete-nav"

export interface UseAttachmentMentionAutocompleteOptions {
  /** Live chat-input value; the match set derives from it. */
  inputValue: string
  /** Source pools. The hook stays pure; the caller resolves these
   *  from the store and passes them in. */
  sources: AttachmentMentionSources
  /** Active conversation id — required to invoke the toggle mutators.
   *  When `null`, picks become a no-op (defensive — there should be no
   *  composer to type into without an active conv anyway). */
  activeConversationId: string | null
  /** Toggle a workspace file's attachment on the active conversation. */
  toggleConversationFileSelection: (fileId: string) => void
  /** Attach (idempotent) a private file to the active conversation. */
  addConversationFile: (conversationId: string, fileId: string) => void
  /** Toggle a URL bookmark's attachment on the active conversation. */
  toggleConversationUrlBookmarkSelection: (bookmarkId: string) => void
  /** Replace the chat-input value. The hook calls this on pick to
   *  drop the `#token`. */
  setInputValue: (value: string) => void
  /** rAF resize + focus + caret-to-end after a programmatic input
   *  write. Same shim the `@`-mention hook uses. */
  resizeInput: () => void
}

export interface UseAttachmentMentionAutocompleteResult {
  open: boolean
  matches: AttachmentMentionMatch[]
  activeIndex: number
  setActiveIndex: (index: number) => void
  pick: (entry: AttachmentMentionMatch) => void
  /** Feed a keydown. Returns true iff the menu consumed the key. */
  onKeyDown: (e: React.KeyboardEvent) => boolean
}

export function useAttachmentMentionAutocomplete({
  inputValue,
  sources,
  activeConversationId,
  toggleConversationFileSelection,
  addConversationFile,
  toggleConversationUrlBookmarkSelection,
  setInputValue,
  resizeInput,
}: UseAttachmentMentionAutocompleteOptions): UseAttachmentMentionAutocompleteResult {
  const [activeIndex, setActiveIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)

  const matches = useMemo(
    () =>
      isTypingAttachmentMention(inputValue)
        ? matchAttachmentMentions(inputValue.slice(1), sources)
        : [],
    [inputValue, sources],
  )

  const open = !dismissed && matches.length > 0

  useEffect(() => {
    setActiveIndex((i) => (i >= matches.length ? 0 : i))
  }, [matches.length])

  // Same re-arm pattern as the `@` + `/` hooks: once the input stops
  // being a `#` token, clear the dismissed flag so the next time the
  // user types `#` the menu opens again.
  useEffect(() => {
    if (!inputValue.startsWith("#") && dismissed) setDismissed(false)
  }, [inputValue, dismissed])

  const pick = useCallback(
    (entry: AttachmentMentionMatch) => {
      if (!activeConversationId) return
      switch (entry.kind) {
        case "workspaceFile":
          toggleConversationFileSelection(entry.id)
          break
        case "conversationFile":
          // Private files use `addConversationFile` (idempotent insert)
          // rather than a toggle — the file is already "in" the
          // conversation's private lane; mentioning it re-asserts the
          // attachment without surprising the user by detaching it.
          addConversationFile(activeConversationId, entry.id)
          break
        case "bookmark":
          toggleConversationUrlBookmarkSelection(entry.id)
          break
      }
      setInputValue("")
      setActiveIndex(0)
      resizeInput()
    },
    [
      activeConversationId,
      toggleConversationFileSelection,
      addConversationFile,
      toggleConversationUrlBookmarkSelection,
      setInputValue,
      resizeInput,
    ],
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
    [open, matches, activeIndex, pick],
  )

  return {
    open,
    matches,
    activeIndex,
    setActiveIndex,
    pick,
    onKeyDown,
  }
}

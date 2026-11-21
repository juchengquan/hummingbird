import "client-only"

import { useCallback, useEffect, useRef, useState } from "react"

import {
  clearFindHighlights,
  computeFindRanges,
  scrollRectIntoViewport,
  setCurrentFindRange,
  supportsHighlightApi,
} from "@/client/find/highlight"
import { findMatchOffsets, wrapIndex } from "@/shared/find/match"

const VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]'
/** Wait this long after the last keystroke before searching. */
const QUERY_DEBOUNCE_MS = 120
/** While a reply streams, re-search at most this often. */
const CONTENT_THROTTLE_MS = 300
const FLASH_MS = 1200

interface Opts {
  /** Any element inside the messages ScrollArea (the chat's end sentinel). */
  anchorRef: React.RefObject<HTMLElement | null>
  /** The open conversation's messages. Used to re-search as content changes
   *  (streaming) and, without the Highlight API, to match whole messages. */
  messages: readonly { id: string; content: string }[]
  /** Closes find when it changes (switching conversations). */
  resetKey: string | null
}

export interface ConversationFind {
  open: boolean
  query: string
  setQuery: (q: string) => void
  total: number
  current: number
  /** Bumped on every openFind, so the bar re-focuses on a repeated ⌘F. */
  focusToken: number
  next: () => void
  prev: () => void
  openFind: (prefill?: string) => void
  close: () => void
}

/**
 * In-conversation find. With the CSS Custom Highlight API (current
 * Chromium, Safari, Firefox) every occurrence in the visible message text is
 * highlighted in place. Without it, find falls back to whole messages:
 * next/prev jump between messages whose content matches and flash them.
 */
export function useConversationFind({ anchorRef, messages, resetKey }: Opts): ConversationFind {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [total, setTotal] = useState(0)
  const [current, setCurrent] = useState(0)
  const [focusToken, setFocusToken] = useState(0)

  // Switching conversations closes find (state reset during render, the
  // React-recommended way to reset on a prop change).
  const [prevResetKey, setPrevResetKey] = useState(resetKey)
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey)
    setOpen(false)
    setQuery("")
    setTotal(0)
    setCurrent(0)
  }

  // Matches: Ranges on the Highlight-API path, message ids on the fallback.
  const rangesRef = useRef<Range[]>([])
  const idsRef = useRef<string[]>([])
  const currentRef = useRef(0)
  const queryRef = useRef(query)
  const messagesRef = useRef(messages)
  const openRef = useRef(open)
  const throttleRef = useRef<number | null>(null)
  // Fallback path: the message currently flashed, so a quick next/prev moves
  // the ring instead of leaving two.
  const flashRef = useRef<{ el: HTMLElement; timer: number } | null>(null)
  useEffect(() => {
    queryRef.current = query
    messagesRef.current = messages
    openRef.current = open
  })

  const viewport = useCallback(
    () => (anchorRef.current?.closest(VIEWPORT_SELECTOR) as HTMLElement | null) ?? null,
    [anchorRef],
  )

  const clearFlash = useCallback(() => {
    const f = flashRef.current
    if (!f) return
    window.clearTimeout(f.timer)
    f.el.classList.remove("hb-find-flash")
    flashRef.current = null
  }, [])

  const flash = useCallback(
    (el: HTMLElement) => {
      clearFlash()
      // Restart the animation even when re-flashing the same message.
      void el.offsetWidth
      el.classList.add("hb-find-flash")
      flashRef.current = { el, timer: window.setTimeout(clearFlash, FLASH_MS) }
    },
    [clearFlash],
  )

  const reveal = useCallback(
    (idx: number) => {
      const vp = viewport()
      if (supportsHighlightApi()) {
        const range = rangesRef.current[idx]
        if (!range) return
        setCurrentFindRange(range)
        if (vp) scrollRectIntoViewport(vp, range.getBoundingClientRect())
      } else {
        const id = idsRef.current[idx]
        const el = id ? document.getElementById(`chat-message-${id}`) : null
        if (!el) return
        if (vp) scrollRectIntoViewport(vp, el.getBoundingClientRect())
        flash(el)
      }
    },
    [viewport, flash],
  )

  /** Re-run the search. `fresh` (a new query, or find just opened) starts at
   *  the first match and scrolls to it. Otherwise (content changed while a
   *  reply streams) the position is kept, clamped, and nothing scrolls, so
   *  the view doesn't jump while the user reads. */
  const search = useCallback(
    (fresh: boolean) => {
      const q = queryRef.current
      let count: number
      if (supportsHighlightApi()) {
        const vp = viewport()
        rangesRef.current = vp ? computeFindRanges(vp, q) : []
        count = rangesRef.current.length
      } else {
        idsRef.current =
          q.trim() === ""
            ? []
            : messagesRef.current.filter((m) => findMatchOffsets(m.content, q).length > 0).map((m) => m.id)
        count = idsRef.current.length
      }
      const idx = fresh ? 0 : Math.min(currentRef.current, Math.max(0, count - 1))
      currentRef.current = idx
      setTotal(count)
      setCurrent(idx)
      if (count === 0) {
        setCurrentFindRange(null)
        return
      }
      if (fresh) reveal(idx)
      else if (supportsHighlightApi()) setCurrentFindRange(rangesRef.current[idx])
    },
    [viewport, reveal],
  )

  // New query (or find opened): debounced fresh search.
  useEffect(() => {
    if (!open) return
    const handle = window.setTimeout(() => search(true), QUERY_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [open, query, search])

  // Content changed while open (streaming, edits): throttled, so a stream of
  // tokens re-searches every CONTENT_THROTTLE_MS instead of never.
  useEffect(() => {
    if (!openRef.current || throttleRef.current !== null) return
    throttleRef.current = window.setTimeout(() => {
      throttleRef.current = null
      if (openRef.current) search(false)
    }, CONTENT_THROTTLE_MS)
  }, [messages, search])

  // Closing (or unmounting) drops every highlight and pending search.
  useEffect(() => {
    if (open) return
    rangesRef.current = []
    idsRef.current = []
    currentRef.current = 0
    if (throttleRef.current !== null) {
      window.clearTimeout(throttleRef.current)
      throttleRef.current = null
    }
    clearFlash()
    clearFindHighlights()
  }, [open, clearFlash])
  useEffect(
    () => () => {
      if (throttleRef.current !== null) window.clearTimeout(throttleRef.current)
      clearFlash()
      clearFindHighlights()
    },
    [clearFlash],
  )

  const step = useCallback(
    (dir: 1 | -1) => {
      const count = supportsHighlightApi() ? rangesRef.current.length : idsRef.current.length
      if (count === 0) return
      const idx = wrapIndex(currentRef.current, count, dir)
      currentRef.current = idx
      setCurrent(idx)
      reveal(idx)
    },
    [reveal],
  )
  const next = useCallback(() => step(1), [step])
  const prev = useCallback(() => step(-1), [step])

  const openFind = useCallback((prefill?: string) => {
    setOpen(true)
    if (prefill) setQuery(prefill)
    setFocusToken((t) => t + 1)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setQuery("")
    setTotal(0)
    setCurrent(0)
  }, [])

  return { open, query, setQuery, total, current, focusToken, next, prev, openFind, close }
}

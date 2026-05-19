import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Auto-scroll + scroll-to-bottom UX for the chat panel's Radix ScrollArea.
 *
 * What this owns:
 *  - A ref placed at the end of the message list. The hook resolves the
 *    `[data-slot="scroll-area-viewport"]` ancestor at runtime — Radix
 *    nests the actual scroll container a few levels deep so listeners
 *    on the root never fire.
 *  - Auto-scrolls to the bottom whenever `messageCount` or `isTyping`
 *    changes (new message arrived, typing indicator appeared).
 *  - Watches the viewport's scroll position and surfaces a
 *    `showScrollButton` flag once the user is meaningfully above the
 *    most recent message (> 250 px from the bottom, roughly accounting
 *    for the message list's pb-44 padding).
 *  - `scrollToBottom()` performs a smooth scroll and suppresses the
 *    listener for 800 ms so the button doesn't flicker mid-glide.
 *
 * Kept as a hook (not a component) because the caller renders both the
 * ref'd sentinel and the floating scroll-to-bottom button itself.
 */
export function useChatScroll(options: {
  messageCount: number
  isTyping: boolean
}): {
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  showScrollButton: boolean
  scrollToBottom: () => void
} {
  const { messageCount, isTyping } = options
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  // Suppresses the scroll listener while a smooth auto-scroll is in
  // flight so it doesn't flag itself as "user scrolled away".
  const autoScrollingRef = useRef(false)

  // Snap to bottom whenever the message list grows or the typing
  // indicator toggles. Direct scroll on the viewport — `scrollIntoView`
  // can scroll unintended ancestors.
  useEffect(() => {
    const end = messagesEndRef.current
    if (!end) return
    const viewport = end.closest(
      '[data-slot="scroll-area-viewport"]'
    ) as HTMLElement | null
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [messageCount, isTyping])

  // Attach the scroll listener to the actual viewport. Threshold is
  // relative to the messages list's pb-44 padding (176 px) plus a small
  // buffer so the button appears once the user has clearly scrolled
  // off the most recent message.
  useEffect(() => {
    const end = messagesEndRef.current
    if (!end) return
    const viewport = end.closest(
      '[data-slot="scroll-area-viewport"]'
    ) as HTMLElement | null
    if (!viewport) return
    const handler = () => {
      if (autoScrollingRef.current) return
      const distanceFromBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      setShowScrollButton(distanceFromBottom > 250)
    }
    handler() // initial reading
    viewport.addEventListener("scroll", handler, { passive: true })
    return () => viewport.removeEventListener("scroll", handler)
  }, [messageCount])

  const scrollToBottom = useCallback(() => {
    const end = messagesEndRef.current
    if (!end) return
    const viewport = end.closest(
      '[data-slot="scroll-area-viewport"]'
    ) as HTMLElement | null
    if (!viewport) return
    autoScrollingRef.current = true
    setShowScrollButton(false)
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" })
    // 800 ms covers a long page; the smooth-scroll engine itself
    // short-circuits if the user starts interacting earlier.
    setTimeout(() => {
      autoScrollingRef.current = false
    }, 800)
  }, [])

  return { messagesEndRef, showScrollButton, scrollToBottom }
}

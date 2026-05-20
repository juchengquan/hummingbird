"use client"

import { Sparkles, Quote } from "lucide-react"
import { useLayoutEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import type { ActiveSelection } from "@/client/hooks/use-selection"
import { cn } from "@/shared/utils"

const TOOLBAR_OFFSET = 10 // px above the selection by default

interface SelectionToolbarProps {
  selection: ActiveSelection
  onExplain: () => void
  onQuote: () => void
}

/**
 * Floating action toolbar rendered above the user's text selection on
 * desktop. Coexists with the native right-click menu — never overrides
 * it. Positioned via `position: fixed` so it doesn't move with the
 * surrounding layout; the parent updates `selection.rect` on scroll so
 * we re-render in place.
 *
 * Flips below the selection when there's no room above (selection near
 * the top of the viewport).
 */
export function SelectionToolbar({
  selection,
  onExplain,
  onQuote,
}: SelectionToolbarProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; flipped: boolean }>({
    top: 0,
    left: 0,
    flipped: false,
  })

  // Layout effect: compute position after the toolbar's own size is
  // known so we can centre it horizontally over the selection and
  // detect "not enough room above → flip below".
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const r = selection.rect

    const wantTop = r.top - h - TOOLBAR_OFFSET
    // Two reasons to flip below the selection:
    //  (1) Too close to the top of the viewport — the toolbar wouldn't fit.
    //  (2) There's content directly above the selection (typical when
    //      selecting mid-paragraph) — putting the toolbar there would
    //      overlap text. Detect via elementFromPoint at the spot the
    //      toolbar's middle would land. Skip the check if we already
    //      know we have to flip.
    const tooHigh = wantTop < 8
    let contentAbove = false
    if (!tooHigh) {
      const probeY = wantTop + h / 2
      const probeX = r.left + r.width / 2
      const hit = document.elementFromPoint(probeX, probeY) as HTMLElement | null
      // Treat any element inside the same selection scope as "content";
      // background / margin / sidebar elements don't carry the scope
      // attribute and won't trip this.
      if (hit && hit.closest("[data-selection-scope]")) contentAbove = true
    }
    const flipped = tooHigh || contentAbove
    const top = flipped ? r.bottom + TOOLBAR_OFFSET : wantTop

    // Centre on the selection, but clamp to viewport so we don't
    // float off the left/right edge for very-edge selections.
    let left = r.left + r.width / 2 - w / 2
    if (left < 8) left = 8
    const maxLeft = window.innerWidth - w - 8
    if (left > maxLeft) left = maxLeft

    setPos({ top, left, flipped })
  }, [selection])

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Selection actions"
      data-flipped={pos.flipped}
      className={cn(
        "fixed z-50 flex items-center gap-0.5 rounded-md border bg-[var(--popover)] shadow-md p-0.5",
        "animate-in fade-in-0 zoom-in-95 duration-100"
      )}
      style={{ top: pos.top, left: pos.left }}
      // Prevent mousedown from collapsing the selection before our
      // click handler runs.
      onMouseDown={(e) => e.preventDefault()}
    >
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs gap-1.5"
        onClick={onExplain}
        title="Explain (⌘E)"
      >
        <Sparkles size={12} />
        Explain
        <kbd className="ml-1 hidden md:inline text-[10px] px-1 py-0 rounded border bg-[var(--muted)]/40 text-[var(--muted-foreground)]">
          ⌘E
        </kbd>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs gap-1.5"
        onClick={onQuote}
        title="Quote in reply"
      >
        <Quote size={12} />
        Quote
      </Button>
    </div>
  )
}

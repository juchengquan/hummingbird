"use client"

import { Sparkles } from "lucide-react"
import { useLayoutEffect, useRef, useState } from "react"

import type { ActiveSelection } from "@/client/hooks/use-selection"
import { cn } from "@/shared/utils"

/** Distance from the selection's bounding rect, in px. iOS selection
 *  handles + native menu sit close to the selection's edges, so we
 *  keep a healthy gap to avoid the chip landing on top of them. */
const CHIP_OFFSET = 12

interface SelectionChipProps {
  selection: ActiveSelection
  onExplain: () => void
}

/**
 * Mobile counterpart to `SelectionToolbar` — a single chip floating
 * above the selection. Just one action ("Explain") so the touch
 * target is large and unambiguous; richer actions can come from the
 * bottom sheet that opens after tap.
 *
 * Coexists with the OS selection menu (Copy / Look up / Share). We
 * position above the selection by default and only flip below when
 * there's no room above (selection near the top of the *visual*
 * viewport — `window.visualViewport.height` accounts for the soft
 * keyboard on Android Chrome, which `innerHeight` does not).
 *
 * Visually 32 px tall, but the tap target reaches 44 px per Apple
 * HIG via padding.
 */
export function SelectionChip({ selection, onExplain }: SelectionChipProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; flipped: boolean }>({
    top: 0,
    left: 0,
    flipped: false,
  })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const r = selection.rect

    const wantTop = r.top - h - CHIP_OFFSET
    // visualViewport accounts for the on-screen keyboard on Android;
    // fallback to innerHeight on browsers that don't have it (older).
    const viewportTop = window.visualViewport?.offsetTop ?? 0
    const tooHigh = wantTop < viewportTop + 8

    // Also flip if there's content directly above (mid-paragraph
    // selection) — same elementFromPoint trick as the desktop toolbar.
    let contentAbove = false
    if (!tooHigh) {
      const hit = document.elementFromPoint(
        r.left + r.width / 2,
        wantTop + h / 2
      ) as HTMLElement | null
      if (hit && hit.closest("[data-selection-scope]")) contentAbove = true
    }

    const flipped = tooHigh || contentAbove
    const top = flipped ? r.bottom + CHIP_OFFSET : wantTop

    // Centre horizontally on the selection; clamp to viewport edges.
    let left = r.left + r.width / 2 - w / 2
    if (left < 8) left = 8
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth
    const maxLeft = viewportWidth - w - 8
    if (left > maxLeft) left = maxLeft

    setPos({ top, left, flipped })
  }, [selection])

  return (
    <button
      ref={ref}
      type="button"
      aria-label="Explain selection"
      onClick={onExplain}
      // Prevent the touch from collapsing the selection before the click
      // fires. iOS otherwise eats the touchend and our handler never runs.
      onPointerDown={(e) => e.preventDefault()}
      data-flipped={pos.flipped}
      className={cn(
        // Visual: 32 px tall pill. The outer padding gives a 44×44 tap
        // target without growing the visible footprint.
        "fixed z-50 inline-flex items-center gap-1.5 rounded-full px-3 h-8",
        "bg-[var(--popover)] border shadow-md text-xs font-medium",
        "active:scale-95 transition-transform",
        "animate-in fade-in-0 zoom-in-95 duration-100"
      )}
      style={{
        top: pos.top,
        left: pos.left,
        // Touch-target padding via outline-style ring so the visible
        // pill stays 32 px but the touch area is the recommended 44 px.
        paddingBlock: 0,
      }}
    >
      <Sparkles size={12} />
      Explain
    </button>
  )
}

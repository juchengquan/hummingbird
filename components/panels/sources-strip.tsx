"use client"

import { useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/shared/utils"
import type { ToolCallResult } from "@/shared/types"

interface SourcesStripProps {
  results: ToolCallResult[]
  /** Citation index the user just clicked (1-based). Triggers a
   *  scroll-into-view + transient highlight on the matching card. */
  highlightedIndex?: number | null
  className?: string
}

/**
 * Horizontal scrollable strip of web-search source cards rendered below
 * an assistant message. Pairs with the `[N]` markers rewritten by the
 * markdown post-processor — clicking a marker passes the matching index
 * via `highlightedIndex` to scroll-and-flash the corresponding card.
 *
 * Hides itself when there are no results. Renders cards inline (no
 * scroll) for ≤2 sources so the layout doesn't look broken; switches
 * to a snap-scroll strip with peek-next-card at ≥3.
 *
 * Accessibility: `role="region"` + `aria-roledescription="carousel"`
 * with per-card aria-labels carrying the full title.
 */
export function SourcesStrip({
  results,
  highlightedIndex,
  className,
}: SourcesStripProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Array<HTMLAnchorElement | null>>([])
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [flashIndex, setFlashIndex] = useState<number | null>(null)

  // Track which scroll affordances apply. Cheap — runs on scroll + resize.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const update = () => {
      setCanScrollLeft(el.scrollLeft > 4)
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4)
    }
    update()
    el.addEventListener("scroll", update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener("scroll", update)
      ro.disconnect()
    }
  }, [results.length])

  // Scroll the targeted card into view + flash a ring on it.
  useEffect(() => {
    if (highlightedIndex == null) return
    const idx = highlightedIndex - 1
    const card = cardRefs.current[idx]
    if (!card) return
    card.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" })
    setFlashIndex(idx)
    const t = window.setTimeout(() => setFlashIndex(null), 1200)
    return () => window.clearTimeout(t)
  }, [highlightedIndex])

  if (results.length === 0) return null

  const scrollable = results.length >= 3
  const scrollBy = (delta: number) => {
    scrollerRef.current?.scrollBy({ left: delta, behavior: "smooth" })
  }

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label="Sources"
      className={cn("relative mt-2", className)}
    >
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] mb-1">
        {results.length} source{results.length === 1 ? "" : "s"}
      </div>

      {scrollable && canScrollLeft && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Scroll sources left"
          onClick={() => scrollBy(-300)}
          className="absolute left-0 top-1/2 -translate-y-1/2 z-10 h-7 w-7 rounded-full bg-[var(--background)] border shadow-sm hidden md:flex"
        >
          <ChevronLeft size={14} />
        </Button>
      )}
      {scrollable && canScrollRight && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Scroll sources right"
          onClick={() => scrollBy(300)}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-10 h-7 w-7 rounded-full bg-[var(--background)] border shadow-sm hidden md:flex"
        >
          <ChevronRight size={14} />
        </Button>
      )}

      <div
        ref={scrollerRef}
        className={cn(
          scrollable
            ? "flex gap-2 overflow-x-auto snap-x snap-mandatory scroll-px-2 pb-2 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:bg-[var(--border)] [&::-webkit-scrollbar-thumb]:rounded-full"
            : "grid grid-cols-1 sm:grid-cols-2 gap-2"
        )}
      >
        {results.map((result, idx) => (
          <SourceCard
            key={`${idx}-${result.url}`}
            index={idx + 1}
            result={result}
            scrollable={scrollable}
            flashed={flashIndex === idx}
            ref={(el) => {
              cardRefs.current[idx] = el
            }}
          />
        ))}
      </div>
    </div>
  )
}

interface SourceCardProps {
  index: number
  result: ToolCallResult
  scrollable: boolean
  flashed: boolean
  ref: (el: HTMLAnchorElement | null) => void
}

function SourceCard({ index, result, scrollable, flashed, ref }: SourceCardProps) {
  let domain = ""
  try {
    domain = new URL(result.url).hostname.replace(/^www\./, "")
  } catch {
    domain = result.url
  }

  const faviconUrl = domain
    ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32`
    : null

  return (
    <a
      ref={ref}
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Source ${index}: ${result.title || result.url}`}
      className={cn(
        "group relative shrink-0 rounded-md border bg-[var(--card)] p-2.5 text-xs hover:bg-[var(--secondary)] transition-colors block",
        scrollable ? "w-[280px] snap-start" : "w-full",
        flashed && "ring-2 ring-[var(--primary)] ring-offset-1 ring-offset-[var(--background)]"
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] text-[var(--muted-foreground)] mb-1">
        {faviconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={faviconUrl}
            alt=""
            width={12}
            height={12}
            className="rounded-sm shrink-0"
            loading="lazy"
          />
        ) : null}
        <span className="truncate flex-1">{domain}</span>
        <span className="font-mono text-[var(--muted-foreground)] shrink-0">
          [{index}]
        </span>
        <ExternalLink
          size={10}
          className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
        />
      </div>
      <div className="font-medium line-clamp-1 leading-snug">
        {result.title || result.url}
      </div>
      <div className="text-[var(--muted-foreground)] line-clamp-2 mt-1 leading-snug">
        {result.snippet}
      </div>
    </a>
  )
}

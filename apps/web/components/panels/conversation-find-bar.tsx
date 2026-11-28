"use client"

import { useEffect, useRef } from "react"
import { ChevronDown, ChevronUp, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/shared/utils"

/** Floating find bar for in-conversation find (⌘F). State lives in
 *  `useConversationFind`; this only renders it. */
export function ConversationFindBar({
  query,
  setQuery,
  total,
  current,
  focusToken,
  next,
  prev,
  close,
}: {
  query: string
  setQuery: (q: string) => void
  total: number
  current: number
  focusToken: number
  next: () => void
  prev: () => void
  close: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  // Focus + select on open and on every repeated ⌘F.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusToken])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault()
      if (e.shiftKey) prev()
      else next()
    } else if (e.key === "Escape") {
      e.preventDefault()
      close()
    }
  }

  const blank = query.trim() === ""
  const noResults = !blank && total === 0
  const count = blank ? "" : noResults ? "No results" : `${current + 1} / ${total}`

  return (
    <div
      role="search"
      aria-label="Find in conversation"
      className="absolute right-4 top-2 z-20 flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--popover)] px-2 py-1 shadow-md"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in conversation…"
        aria-label="Find in conversation"
        className="w-48 bg-transparent text-sm text-[var(--popover-foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
      />
      <span
        aria-live="polite"
        className={cn(
          "min-w-[4.5rem] text-right text-[11px] tabular-nums",
          noResults ? "text-[var(--destructive)]" : "text-[var(--muted-foreground)]",
        )}
      >
        {count}
      </span>
      <Button size="icon-xs" variant="ghost" onClick={prev} disabled={total === 0} aria-label="Previous match">
        <ChevronUp />
      </Button>
      <Button size="icon-xs" variant="ghost" onClick={next} disabled={total === 0} aria-label="Next match">
        <ChevronDown />
      </Button>
      <Button size="icon-xs" variant="ghost" onClick={close} aria-label="Close find">
        <X />
      </Button>
    </div>
  )
}

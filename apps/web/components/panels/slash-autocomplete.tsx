"use client"

import "client-only"

import type { LucideIcon } from "lucide-react"

import { cn } from "@/shared/utils"

/**
 * One row in the autocomplete menu. Symbol-agnostic on purpose: the
 * slash-commands feature feeds it skill triggers under `/`, and the
 * prompt-library Phase 3 will feed it prompt slugs under `@` (see
 * `docs/PLAN-slash-commands.md` — two-symbol model). Keep this
 * component free of skill- or prompt-specific knowledge.
 */
export interface SlashAutocompleteEntry {
  /** Stable key + identity for the caller's `onPick`. */
  id: string
  /** The token shown after the trigger char, e.g. "search". */
  label: string
  /** Secondary text — skill name / prompt description. Optional. */
  hint?: string
  icon?: LucideIcon
  /** Optional section header. When entries carry groups, a label row
   *  is rendered above the first entry of each new group. Entries are
   *  assumed pre-sorted by group (the menu doesn't reorder). */
  groupLabel?: string
}

/**
 * Presentational floating menu rendered above the chat input. All
 * keyboard handling lives in the parent (the textarea owns keydown);
 * this component only renders the list, highlights `activeIndex`, and
 * reports hover / click. Returns null when there are no entries so the
 * caller can mount it unconditionally.
 */
export function SlashAutocomplete({
  triggerChar,
  entries,
  activeIndex,
  onHoverIndex,
  onPick,
}: {
  triggerChar: string
  entries: SlashAutocompleteEntry[]
  activeIndex: number
  onHoverIndex: (index: number) => void
  onPick: (entry: SlashAutocompleteEntry) => void
}) {
  if (entries.length === 0) return null
  return (
    <div
      role="listbox"
      aria-label="Command suggestions"
      className={cn(
        "absolute bottom-full left-0 right-0 mb-2 z-20",
        "max-h-64 overflow-y-auto rounded-xl border border-[var(--border)]",
        "bg-[var(--popover)] shadow-lg p-1"
      )}
    >
      {entries.map((entry, i) => {
        const Icon = entry.icon
        const active = i === activeIndex
        // Section header when this entry starts a new group.
        const showGroup =
          entry.groupLabel !== undefined &&
          entry.groupLabel !== entries[i - 1]?.groupLabel
        return (
          <div key={entry.id}>
            {showGroup && (
              <div className="px-2.5 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]/70 select-none">
                {entry.groupLabel}
              </div>
            )}
          <button
            type="button"
            role="option"
            aria-selected={active}
            // Use onMouseDown (not onClick) so the pick fires before the
            // textarea's blur — keeps focus in the input after picking.
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(entry)
            }}
            onMouseEnter={() => onHoverIndex(i)}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left",
              active ? "bg-[var(--accent)]" : "hover:bg-[var(--accent)]/50"
            )}
          >
            {Icon && (
              <Icon
                size={15}
                className="shrink-0 text-[var(--muted-foreground)]"
              />
            )}
            <span className="font-mono text-[13px] text-[var(--foreground)] shrink-0">
              {triggerChar}
              {entry.label}
            </span>
            {entry.hint && (
              <span className="truncate text-[12px] text-[var(--muted-foreground)]">
                {entry.hint}
              </span>
            )}
          </button>
          </div>
        )
      })}
    </div>
  )
}

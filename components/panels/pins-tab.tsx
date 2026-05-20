"use client"

import { useState } from "react"
import { Pin, Trash2, ChevronDown, ChevronRight } from "lucide-react"
import { format } from "date-fns"

import { Button } from "@/components/ui/button"
import { MarkdownPreview } from "@/components/markdown-preview"
import { SourcesStrip } from "@/components/panels/sources-strip"
import { TabEmptyState } from "@/components/panels/tab-empty-state"
import {
  useConversationPinnedExplanations,
  useStore,
} from "@/client/hooks/use-store"
import { truncateSelectionForLabel } from "@/shared/selection-prompts"
import { cn } from "@/shared/utils"

/**
 * Right-rail tab listing pinned explanations for the active
 * conversation. Each card is expand-on-click — collapsed shows just
 * the selection snippet + a quick action row; expanded reveals the
 * full markdown answer + Sources strip (when web search produced
 * results).
 *
 * Pins are session-only (see `PinnedExplanation` in lib/shared/types.ts
 * and the `pinnedExplanations` slice in use-store.ts) — they survive
 * conversation switches within a session but vanish on reload. This
 * is by design: ephemeral surface, no DB schema, no sync.
 */
export function PinsTab() {
  const pins = useConversationPinnedExplanations()
  const unpinExplanation = useStore((s) => s.unpinExplanation)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (pins.length === 0) {
    return (
      <div className="p-3">
        <TabEmptyState icon={Pin}>
          No pinned explanations yet. Select text in an assistant
          message and click <b>Explain</b> → <b>Pin</b> to save the
          answer here.
        </TabEmptyState>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 p-2 overflow-y-auto">
      {pins.map((pin) => {
        const isExpanded = expanded.has(pin.id)
        return (
          <div
            key={pin.id}
            className="rounded-md border bg-[var(--card)] overflow-hidden"
          >
            <button
              type="button"
              onClick={() => toggle(pin.id)}
              className="w-full text-left px-2.5 py-2 flex items-start gap-1.5 hover:bg-[var(--secondary)] transition-colors"
              aria-expanded={isExpanded}
            >
              <span className="mt-0.5 text-[var(--muted-foreground)] shrink-0">
                {isExpanded ? (
                  <ChevronDown size={12} />
                ) : (
                  <ChevronRight size={12} />
                )}
              </span>
              <span className="flex-1 min-w-0">
                <span
                  className="text-xs italic line-clamp-2 leading-snug"
                  title={pin.selection}
                >
                  “{truncateSelectionForLabel(pin.selection, 140)}”
                </span>
                <span className="text-[10px] text-[var(--muted-foreground)] block mt-1">
                  {format(new Date(pin.createdAt), "MMM d, HH:mm")} · {pin.model}
                </span>
              </span>
            </button>
            {isExpanded && (
              <div className={cn("border-t px-2.5 py-2 text-xs")}>
                <MarkdownPreview
                  content={pin.content}
                  className="markdown-chat-bubble text-[12px] p-0 overflow-visible"
                  sourceCount={pin.results?.length ?? 0}
                />
                {pin.results && pin.results.length > 0 && (
                  <SourcesStrip results={pin.results} />
                )}
                <div className="flex justify-end mt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[10px] gap-1 text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                    onClick={() => unpinExplanation(pin.id)}
                  >
                    <Trash2 size={10} />
                    Unpin
                  </Button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

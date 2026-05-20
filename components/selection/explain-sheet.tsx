"use client"

import { Loader2, Pin } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet"
import { MarkdownPreview } from "@/components/markdown-preview"
import { SourcesStrip } from "@/components/panels/sources-strip"
import { useExplainStream } from "@/client/hooks/use-explain-stream"
import { useStore } from "@/client/hooks/use-store"
import { truncateSelectionForLabel } from "@/shared/selection-prompts"
import type { Message, ToolCallResult } from "@/shared/types"

interface ExplainSheetProps {
  selection: string
  contextMessages: Message[]
  model?: string
  workspaceSystemPrompt?: string
  skills?: Array<{ id: string }>
  onPin?: (input: { content: string; results: ToolCallResult[] }) => void
  onClose: () => void
}

/**
 * Mobile counterpart to `ExplainPopover` — a bottom sheet that opens
 * when the user taps the SelectionChip. Slides up from the bottom,
 * dismisses on tap-outside, swipe-down (via the Radix Dialog overlay)
 * or the close button.
 *
 * Streaming + mock-on-401 lives in `useExplainStream`; this file is
 * layout only. Reuses MarkdownPreview + SourcesStrip so [N] citations
 * and source cards render the same as on desktop.
 */
export function ExplainSheet({
  selection,
  contextMessages,
  model,
  workspaceSystemPrompt,
  skills,
  onPin,
  onClose,
}: ExplainSheetProps) {
  const chatModel = useStore((s) => s.chatModel)
  const effectiveModel = model ?? chatModel
  const [highlightedCitation, setHighlightedCitation] = useState<number | null>(null)

  const { streamed, toolResults, done, errorMsg } = useExplainStream({
    selection,
    contextMessages,
    model: effectiveModel,
    workspaceSystemPrompt,
    skills,
  })

  const canPin = !!onPin && done && !errorMsg && streamed.length > 0
  const handlePin = useCallback(() => {
    if (!canPin || !onPin) return
    onPin({ content: streamed, results: toolResults })
    onClose()
  }, [canPin, onPin, streamed, toolResults, onClose])

  const headerLabel = useMemo(
    () => truncateSelectionForLabel(selection, 80),
    [selection]
  )

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        className="rounded-t-xl p-0 max-h-[75vh] flex flex-col"
      >
        {/* Drag-handle indicator. Visual only — Radix Dialog already
            handles overlay-tap-to-dismiss; swipe-down on touch
            collapses the document selection which closes the trigger,
            and the parent unmounts the sheet via onClose. */}
        <div className="flex items-center justify-center pt-2.5 pb-1">
          <div className="h-1 w-10 rounded-full bg-[var(--border)]" />
        </div>

        <div className="px-4 pb-2 flex items-start gap-2 border-b">
          <div className="flex-1 min-w-0">
            <SheetTitle className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] font-normal">
              Explaining
            </SheetTitle>
            <div
              className="text-sm italic line-clamp-2 text-[var(--muted-foreground)] mt-0.5"
              title={selection}
            >
              “{headerLabel}”
            </div>
          </div>
          {!done && (
            <Loader2
              size={14}
              className="animate-spin text-[var(--muted-foreground)] shrink-0 mt-1.5"
            />
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 text-sm leading-relaxed">
          {errorMsg ? (
            <p className="text-[var(--destructive)] text-sm">{errorMsg}</p>
          ) : streamed ? (
            <>
              <MarkdownPreview
                content={streamed}
                className="markdown-chat-bubble text-[14px] p-0 overflow-visible"
                sourceCount={toolResults.length}
                onSourceClick={(idx) => setHighlightedCitation(idx)}
              />
              {toolResults.length > 0 && (
                <SourcesStrip
                  results={toolResults}
                  highlightedIndex={highlightedCitation}
                />
              )}
            </>
          ) : (
            <p className="text-[var(--muted-foreground)] text-xs italic">
              Thinking…
            </p>
          )}
        </div>

        <div className="px-4 py-2 border-t flex items-center justify-between text-xs text-[var(--muted-foreground)]"
          style={{
            // Lift the footer above the home-bar / safe-area inset on
            // notched iOS devices so action targets stay reachable.
            paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom, 0px))",
          }}
        >
          <span className="truncate">{effectiveModel}</span>
          {done && !errorMsg && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="hover:text-[var(--foreground)] transition-colors"
                onClick={() => {
                  navigator.clipboard
                    .writeText(streamed)
                    .then(() => toast.success("Copied"))
                    .catch(() => toast.error("Copy failed"))
                }}
              >
                Copy
              </button>
              {canPin && (
                <button
                  type="button"
                  className="hover:text-[var(--foreground)] transition-colors inline-flex items-center gap-1"
                  onClick={() => {
                    handlePin()
                    toast.success("Pinned")
                  }}
                >
                  <Pin size={12} />
                  Pin
                </button>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

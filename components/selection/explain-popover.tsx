"use client"

import { Loader2, Pin, X } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { MarkdownPreview } from "@/components/markdown-preview"
import { SourcesStrip } from "@/components/panels/sources-strip"
import { useExplainStream } from "@/client/hooks/use-explain-stream"
import { useStore } from "@/client/hooks/use-store"
import { truncateSelectionForLabel } from "@/shared/selection-prompts"
import type { Message, ToolCallResult } from "@/shared/types"
import { cn } from "@/shared/utils"

const POPOVER_WIDTH = 440
const POPOVER_GAP = 12 // distance from the selection's bounding rect

interface ExplainPopoverProps {
  /** Anchor rect — typically the user's selection rect at the moment
   *  they triggered Explain. We pin the popover to this once; further
   *  selection changes don't reposition us (the user is reading now). */
  anchorRect: DOMRect
  /** Full text the user selected. Displayed in the header for context. */
  selection: string
  /** The conversation history to send as context — everything up to
   *  and including the message the selection lives in. */
  contextMessages: Message[]
  /** Optional model override; defaults to the conversation's model. */
  model?: string
  /** Workspace-level system prompt to forward. */
  workspaceSystemPrompt?: string
  /** Skills to include (matches the chat route's payload shape). */
  skills?: Array<{ id: string }>
  /** When set, the popover surfaces a Pin button + `⌘↵` shortcut.
   *  Called with the streamed content + captured tool-result rows.
   *  After pinning the popover closes via `onClose`. */
  onPin?: (input: { content: string; results: ToolCallResult[] }) => void
  onClose: () => void
}

/**
 * Desktop streamed-answer popover anchored to the right of the user's
 * selection (or left when there's no room). Dismisses on Esc or
 * click-away. Streaming + mock-on-401 lives in `useExplainStream`;
 * this file is layout only.
 */
export function ExplainPopover({
  anchorRect,
  selection,
  contextMessages,
  model,
  workspaceSystemPrompt,
  skills,
  onPin,
  onClose,
}: ExplainPopoverProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; side: "left" | "right" }>({
    top: 0,
    left: 0,
    side: "right",
  })
  const [highlightedCitation, setHighlightedCitation] = useState<number | null>(null)
  const chatModel = useStore((s) => s.chatModel)
  const effectiveModel = model ?? chatModel

  const { streamed, toolResults, done, errorMsg } = useExplainStream({
    selection,
    contextMessages,
    model: effectiveModel,
    workspaceSystemPrompt,
    skills,
  })

  // Position the popover once, relative to the anchor rect. We don't
  // track scroll — the user wants to read what was returned, and
  // moving the popover while they read would be hostile.
  useLayoutEffect(() => {
    const r = anchorRect
    const room = {
      right: window.innerWidth - r.right,
      left: r.left,
    }
    const side: "left" | "right" =
      room.right >= POPOVER_WIDTH + POPOVER_GAP ? "right" : "left"

    const left =
      side === "right"
        ? Math.min(window.innerWidth - POPOVER_WIDTH - 8, r.right + POPOVER_GAP)
        : Math.max(8, r.left - POPOVER_WIDTH - POPOVER_GAP)

    // Pin the popover so its top aligns roughly with the selection
    // top, but clamp to the viewport so it doesn't run off bottom.
    const maxTop = window.innerHeight - 100
    const top = Math.max(8, Math.min(maxTop, r.top))
    setPos({ top, left, side })
  }, [anchorRect])

  // Pin → forward to the host + dismiss. Guarded so we never pin an
  // empty / errored / still-streaming popover.
  const canPin = !!onPin && done && !errorMsg && streamed.length > 0
  const handlePin = useCallback(() => {
    if (!canPin || !onPin) return
    onPin({ content: streamed, results: toolResults })
    onClose()
  }, [canPin, onPin, streamed, toolResults, onClose])

  // Keyboard: Esc dismisses; ⌘↵ / Ctrl↵ pins.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canPin) {
        e.preventDefault()
        handlePin()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose, canPin, handlePin])

  // Dismiss on click outside the popover.
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const el = containerRef.current
      if (el && !el.contains(e.target as Node)) onClose()
    }
    // Defer subscribing so the click that *opened* us doesn't trip it.
    const t = window.setTimeout(() => {
      document.addEventListener("pointerdown", onPointer)
    }, 0)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener("pointerdown", onPointer)
    }
  }, [onClose])

  const headerLabel = useMemo(
    () => truncateSelectionForLabel(selection, 60),
    [selection]
  )

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Explanation"
      className={cn(
        "fixed z-50 rounded-lg border bg-[var(--popover)] shadow-xl",
        "flex flex-col max-h-[70vh]",
        "animate-in fade-in-0 zoom-in-95 duration-100",
        pos.side === "right" ? "origin-left" : "origin-right"
      )}
      style={{ top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
            Explaining
          </div>
          <div
            className="text-xs italic truncate text-[var(--muted-foreground)]"
            title={selection}
          >
            “{headerLabel}”
          </div>
        </div>
        {!done && (
          <Loader2 size={12} className="animate-spin text-[var(--muted-foreground)] shrink-0" />
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={onClose}
          aria-label="Close"
          title="Close (Esc)"
        >
          <X size={12} />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 text-sm leading-relaxed">
        {errorMsg ? (
          <p className="text-[var(--destructive)] text-sm">{errorMsg}</p>
        ) : streamed ? (
          <>
            <MarkdownPreview
              content={streamed}
              className="markdown-chat-bubble text-[13px] p-0 overflow-visible"
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

      <div className="px-3 py-1.5 border-t flex items-center justify-between text-[10px] text-[var(--muted-foreground)]">
        <span>{effectiveModel}</span>
        {done && !errorMsg && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="hover:text-[var(--foreground)] transition-colors"
              onClick={() => {
                navigator.clipboard
                  .writeText(streamed)
                  .then(() => toast.success("Copied explanation to clipboard"))
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
                  toast.success("Pinned to side panel")
                }}
                title="Pin to side panel (⌘↵)"
              >
                <Pin size={10} />
                Pin
                <kbd className="ml-0.5 text-[9px] px-1 rounded border bg-[var(--muted)]/40">
                  ⌘↵
                </kbd>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

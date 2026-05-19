"use client"

import { useEffect, useState } from "react"
import { ChevronDown, Copy } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { copyText } from "@/lib/export"
import { MarkdownPreview } from "@/components/markdown-preview"

interface ReasoningBlockProps {
  reasoning: string
  /** The assistant message's `content`. When non-empty the model has
   *  moved on from reasoning to the answer — we use this transition to
   *  swap the header label from "Thinking…" to "Reasoning". */
  content: string
  /** When true (the message has reasoning but no content yet), open by
   *  default so the user sees the model is actively thinking. */
  streaming: boolean
  /** Total reasoning time in ms, persisted on the message. Shown as
   *  "Thought for X.X s" in the collapsed header once streaming
   *  finishes. */
  durationMs?: number
}

/**
 * Collapsible "Thinking…" → "Reasoning" panel rendered above the main
 * assistant message text for models that stream reasoning tokens
 * (DeepSeek R1, Claude thinking variants). Auto-opens when a new
 * streaming session begins so the user sees the model is working.
 *
 * Extracted from chat-message.tsx to keep the parent under control.
 */
export function ReasoningBlock({
  reasoning,
  content,
  streaming,
  durationMs,
}: ReasoningBlockProps) {
  const [open, setOpen] = useState(streaming)

  // Re-open automatically when a new streaming session begins. The lint
  // rule flags this; legitimate use of useEffect for prop sync — we
  // only want auto-open when `streaming` transitions, not on every
  // render.
  useEffect(() => {
    if (streaming) setOpen(true)
  }, [streaming])

  const isLive = streaming && !content

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    void copyText(reasoning)
    toast.success("Reasoning copied")
  }

  return (
    <div className="group/reasoning mb-2 text-[var(--muted-foreground)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2 py-1 text-xs hover:bg-[var(--accent)]/50 rounded-md transition-colors min-w-0"
        aria-expanded={open}
      >
        <span className="shrink-0">{isLive ? "Thinking…" : "Reasoning"}</span>
        {isLive && (
          <span
            aria-hidden
            className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--muted-foreground)] animate-pulse shrink-0"
          />
        )}
        {!isLive && durationMs !== undefined && durationMs > 0 && (
          <span className="shrink-0 text-[10px] opacity-70" title="Total reasoning time">
            · {(durationMs / 1000).toFixed(1)}s
          </span>
        )}
        <ChevronDown
          size={12}
          className={cn("transition-transform shrink-0", !open && "-rotate-90")}
        />
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div className="relative px-2 pb-2 pt-1 max-h-[40vh] overflow-y-auto">
            <div className="sticky top-1 z-10 flex justify-end -mb-7 pr-2 pointer-events-none">
              <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy reasoning"
                title="Copy reasoning"
                className="pointer-events-auto p-1 rounded bg-[var(--background)]/80 backdrop-blur-sm opacity-0 group-hover/reasoning:opacity-100 focus-visible:opacity-100 hover:bg-[var(--accent)]/50 transition-opacity"
              >
                <Copy size={12} />
              </button>
            </div>
            <MarkdownPreview
              content={reasoning}
              className="text-xs opacity-90 pr-7 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

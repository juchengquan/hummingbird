"use client"

import { Loader2, X } from "lucide-react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { MarkdownPreview } from "@/components/markdown-preview"
import { SourcesStrip } from "@/components/panels/sources-strip"
import { apiClient } from "@/client/api-client"
import { useStore } from "@/client/hooks/use-store"
import {
  explainSelectionPrompt,
  truncateSelectionForLabel,
} from "@/shared/selection-prompts"
import type { ChatRequestInput } from "@/shared/api-schemas"
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
  onClose: () => void
}

/**
 * Streamed-answer popover anchored to the right of the user's
 * selection (or left when there's no room). Dismisses on Esc or
 * click-away (handled by the parent).
 *
 * Reuses the existing /api/chat route via a synthetic user turn; the
 * full conversation history is sent so the model can answer "what does
 * this mean?" in context. The result is NOT persisted — it's
 * ephemeral until the user pins it (Phase 2 of the plan).
 *
 * Rendering reuses MarkdownPreview + SourcesStrip, so citation markers
 * and source cards work for free when web search runs.
 */
export function ExplainPopover({
  anchorRect,
  selection,
  contextMessages,
  model,
  workspaceSystemPrompt,
  skills,
  onClose,
}: ExplainPopoverProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; side: "left" | "right" }>({
    top: 0,
    left: 0,
    side: "right",
  })
  const [streamed, setStreamed] = useState("")
  const [toolResults, setToolResults] = useState<ToolCallResult[]>([])
  const [highlightedCitation, setHighlightedCitation] = useState<number | null>(null)
  const [done, setDone] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const chatModel = useStore((s) => s.chatModel)

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

  // Dismiss on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  // Dismiss on click outside the popover. We attach to the document
  // pointerdown so a single tap anywhere outside closes it.
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

  // Build the request body once on mount.
  const requestBody = useMemo<ChatRequestInput>(() => {
    const historyAsModelMessages = contextMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }))
    return {
      messages: [
        ...historyAsModelMessages,
        { role: "user" as const, content: explainSelectionPrompt(selection) },
      ],
      model: model ?? chatModel,
      workspaceSystemPrompt,
      skills,
    }
  }, [contextMessages, selection, model, chatModel, workspaceSystemPrompt, skills])

  // Kick the stream once.
  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    const run = async () => {
      const result = await apiClient.chat.stream(requestBody, {
        signal: controller.signal,
      })
      if (!result.ok || !result.body) {
        if (!cancelled) {
          setErrorMsg(
            result.error?.message ?? `Request failed (HTTP ${result.status}).`
          )
          setDone(true)
        }
        return
      }
      const reader = result.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        while (true) {
          const { done: streamDone, value } = await reader.read()
          if (streamDone) break
          buffer += decoder.decode(value, { stream: true })
          // SSE frames separated by blank line.
          const frames = buffer.split("\n\n")
          buffer = frames.pop() ?? ""
          for (const frame of frames) {
            if (!frame.startsWith("data:")) continue
            const payload = frame.slice(5).trim()
            if (!payload) continue
            let parsed: {
              type?: string
              value?: string
              code?: string
              message?: string
              results?: Array<{ title?: string; url?: string; snippet?: string }>
            }
            try {
              parsed = JSON.parse(payload)
            } catch {
              continue
            }
            if (cancelled) break
            if (parsed.type === "text" && typeof parsed.value === "string") {
              setStreamed((prev) => prev + parsed.value)
            } else if (parsed.type === "tool_result" && Array.isArray(parsed.results)) {
              const cleaned = parsed.results
                .filter(
                  (r): r is { title: string; url: string; snippet: string } =>
                    typeof r?.title === "string" &&
                    typeof r?.url === "string" &&
                    typeof r?.snippet === "string"
                )
              if (cleaned.length > 0) setToolResults(cleaned)
            } else if (parsed.type === "error") {
              setErrorMsg(parsed.message ?? "Request failed.")
              setDone(true)
              return
            } else if (parsed.type === "done") {
              setDone(true)
              return
            }
          }
        }
        setDone(true)
      } catch (err) {
        if (controller.signal.aborted) return
        const message = err instanceof Error ? err.message : "Stream failed."
        setErrorMsg(message)
        setDone(true)
      }
    }

    run().catch(() => {
      // Swallow — error state already surfaced via setErrorMsg.
    })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [requestBody])

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
          <p className="text-[var(--destructive)] text-sm">
            {errorMsg}
          </p>
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
        <span>{model ?? chatModel}</span>
        {done && !errorMsg && (
          <button
            type="button"
            className="hover:text-[var(--foreground)] transition-colors"
            onClick={() => {
              // Pin-to-side-panel ships in Phase 2 of the plan; for now
              // we copy the explanation to clipboard so it's not lost.
              navigator.clipboard
                .writeText(streamed)
                .then(() => toast.success("Copied explanation to clipboard"))
                .catch(() => toast.error("Copy failed"))
            }}
          >
            Copy
          </button>
        )}
      </div>
    </div>
  )
}

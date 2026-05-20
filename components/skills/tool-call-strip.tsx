"use client"

import { Globe, Loader2, Check, Wrench } from "lucide-react"
import { cn } from "@/shared/utils"

import type { ToolCallResult } from "@/shared/types"

export interface LiveToolCall {
  id: string
  name: string
  argsLabel?: string
  status: "running" | "done"
  summary?: string
  /** Result entries from the tool (currently only `webSearch`).
   *  Carried through to the persisted record so the Sources strip
   *  survives reload. */
  results?: ToolCallResult[]
}

interface ToolCallStripProps {
  calls: LiveToolCall[]
  className?: string
}

/**
 * Inline pills rendered above an assistant message's text while the
 * model is running tools — e.g. "🌐 Searching the web for 'react server
 * components'…" → "🌐 Searched the web · 5 results".
 *
 * Transient: the chat panel clears the underlying state when the stream
 * ends. The durable record of "this answer used web search" lives as a
 * markdown footer the server appends to the message content.
 */
export function ToolCallStrip({ calls, className }: ToolCallStripProps) {
  if (calls.length === 0) return null
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 mb-2", className)}>
      {calls.map((call) => {
        const Icon = iconFor(call.name)
        const text = labelFor(call)
        return (
          <span
            key={call.id}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] border",
              call.status === "running"
                ? "border-[var(--primary)]/40 bg-[var(--primary)]/10 text-[var(--primary)]"
                : "border-[var(--border)] bg-[var(--muted)]/40 text-[var(--muted-foreground)]"
            )}
          >
            <Icon size={10} />
            {call.status === "running" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <Check size={10} />
            )}
            <span className="truncate max-w-[260px]">{text}</span>
          </span>
        )
      })}
    </div>
  )
}

function iconFor(name: string) {
  if (name === "webSearch") return Globe
  return Wrench
}

function labelFor(call: LiveToolCall): string {
  if (call.name === "webSearch") {
    if (call.status === "running") {
      return call.argsLabel ? `Searching for "${call.argsLabel}"…` : "Searching the web…"
    }
    return call.summary
      ? `Searched the web · ${call.summary}`
      : "Searched the web"
  }
  // Generic fallback.
  if (call.status === "running") return `${call.name}…`
  return `${call.name}${call.summary ? ` · ${call.summary}` : ""}`
}

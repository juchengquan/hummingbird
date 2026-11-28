"use client"

import { FileSearch, Globe, Loader2, Check, Wrench } from "lucide-react"
import { cn } from "@/shared/utils"

import type { ToolCallResult } from "@/shared/types"
import {
  isSearchFilesToolName,
  isWebSearchToolName,
} from "@/shared/skills/types"

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
  if (isWebSearchToolName(name)) return Globe
  if (isSearchFilesToolName(name)) return FileSearch
  return Wrench
}

function labelFor(call: LiveToolCall): string {
  if (isWebSearchToolName(call.name)) {
    if (call.status === "running") {
      return call.argsLabel
        ? `Searching the web for "${call.argsLabel}"…`
        : "Searching the web…"
    }
    return call.summary
      ? `Searched the web · ${call.summary}`
      : "Searched the web"
  }
  if (isSearchFilesToolName(call.name)) {
    if (call.status === "running") {
      // argsLabel is set by the chat side from the query string —
      // we don't try to look up the file name here (would require a
      // store read; the model already references the file by name
      // in the surrounding response text).
      return call.argsLabel
        ? `Searching attached files for "${call.argsLabel}"…`
        : "Searching attached files…"
    }
    return call.summary
      ? `Searched attached files · ${call.summary}`
      : "Searched attached files"
  }
  // Generic fallback.
  if (call.status === "running") return `${call.name}…`
  return `${call.name}${call.summary ? ` · ${call.summary}` : ""}`
}

"use client"
import "client-only"

/**
 * Pure helpers for the chat stream's tool-call buffer. `useChatSend`
 * keeps the buffer in a local variable for the lifetime of one stream
 * (mirrored into React state for the live pills) and, when the stream
 * ends, persists the completed calls onto the message via
 * `setMessageToolCalls` — that durable record is what keeps the tool
 * pills, the Sources strip and the `[N]` citation buttons after the
 * live buffer is cleared.
 *
 * The buffer used to be read back from React state captured at send
 * start, which never contained the placeholder created mid-stream, so
 * nothing was ever persisted. Keeping the accumulation here (pure, local
 * to the stream) removes that stale-closure dependency.
 */

import type { LiveToolCall } from "@/components/skills/tool-call-strip"
import type { ToolCallRecord, ToolCallResult } from "@/shared/types"

/** Append a running call for a `tool_call` frame. */
export function startToolCall(
  calls: readonly LiveToolCall[],
  call: { id: string; name: string; args?: unknown }
): LiveToolCall[] {
  const query = (call.args as { query?: unknown } | undefined)?.query
  return [
    ...calls,
    {
      id: call.id,
      name: call.name,
      argsLabel: typeof query === "string" ? query : undefined,
      status: "running",
    },
  ]
}

/** Keep only well-formed `{title, url, snippet}` result entries. */
export function sanitizeToolResults(raw: unknown): ToolCallResult[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.filter(
    (r): r is ToolCallResult =>
      typeof r?.title === "string" &&
      typeof r?.url === "string" &&
      typeof r?.snippet === "string"
  )
}

/** Mark the call matching a `tool_result` frame as done. */
export function finishToolCall(
  calls: readonly LiveToolCall[],
  result: { id: string; summary?: string; results?: unknown }
): LiveToolCall[] {
  const results = sanitizeToolResults(result.results)
  return calls.map((t) =>
    t.id === result.id
      ? { ...t, status: "done", summary: result.summary, results }
      : t
  )
}

/**
 * The durable record for a finished stream. Drops in-flight (running)
 * entries — a tool that never returned doesn't belong on the message —
 * and omits an empty `results` array.
 */
export function toPersistedToolCalls(
  calls: readonly LiveToolCall[]
): ToolCallRecord[] {
  return calls
    .filter((t) => t.status === "done")
    .map(({ id, name, argsLabel, summary, results }) => ({
      id,
      name,
      argsLabel,
      summary,
      ...(results && results.length > 0 ? { results } : {}),
    }))
}

"use client"
import "client-only"

import { useEffect, useMemo, useState } from "react"

import { apiClient } from "@/client/api-client"
import {
  explainSelectionPrompt,
  truncateSelectionForLabel,
} from "@/shared/selection-prompts"
import type { ChatRequestInput } from "@/shared/api-schemas"
import type { Message, ToolCallResult } from "@/shared/types"

interface UseExplainStreamArgs {
  selection: string
  contextMessages: Message[]
  model: string
  workspaceSystemPrompt?: string
  skills?: Array<{ id: string }>
}

interface UseExplainStreamResult {
  /** Streamed markdown so far. */
  streamed: string
  /** Source rows captured from any tool_result frame with results
   *  (currently `webSearch`). */
  toolResults: ToolCallResult[]
  /** True once the stream terminates (done frame, error frame, network
   *  error, or auth-fallback mock). */
  done: boolean
  /** Non-null when the stream failed in a way the popover/sheet should
   *  surface in destructive style. `auth` errors are *not* set here —
   *  they swap `streamed` to the mock instead. */
  errorMsg: string | null
}

/**
 * Owns the SSE streaming lifecycle for selection-driven Explain.
 * Both `ExplainPopover` (desktop) and `ExplainSheet` (mobile) consume
 * the same state; the only difference is layout.
 *
 * On 401 (HTTP) or auth-coded error frame (mid-stream), surfaces a
 * labeled mock explanation through `streamed` instead of `errorMsg`,
 * mirroring the chat panel's `mockAIResponse` UX. Other error codes
 * (rate_limit / provider / network / etc.) populate `errorMsg`.
 */
export function useExplainStream({
  selection,
  contextMessages,
  model,
  workspaceSystemPrompt,
  skills,
}: UseExplainStreamArgs): UseExplainStreamResult {
  const [streamed, setStreamed] = useState("")
  const [toolResults, setToolResults] = useState<ToolCallResult[]>([])
  const [done, setDone] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Build the request body once. Re-runs only when the selection /
  // context / model identity changes, which in practice never happens
  // for a single popover instance — but keeps the effect deps honest.
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
      model,
      workspaceSystemPrompt,
      skills,
    }
  }, [contextMessages, selection, model, workspaceSystemPrompt, skills])

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    const run = async () => {
      const result = await apiClient.chat.stream(requestBody, {
        signal: controller.signal,
      })
      if (!result.ok || !result.body) {
        if (cancelled) return
        if (result.status === 401 || result.error?.code === "auth") {
          setStreamed(mockExplanation(selection))
          setDone(true)
          return
        }
        setErrorMsg(
          result.error?.message ?? `Request failed (HTTP ${result.status}).`
        )
        setDone(true)
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
              const cleaned = parsed.results.filter(
                (r): r is { title: string; url: string; snippet: string } =>
                  typeof r?.title === "string" &&
                  typeof r?.url === "string" &&
                  typeof r?.snippet === "string"
              )
              if (cleaned.length > 0) setToolResults(cleaned)
            } else if (parsed.type === "error") {
              if (parsed.code === "auth") {
                setStreamed(mockExplanation(selection))
              } else {
                setErrorMsg(parsed.message ?? "Request failed.")
              }
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
      // Errors surfaced via setErrorMsg above; swallow to satisfy lint.
    })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [requestBody, selection])

  return { streamed, toolResults, done, errorMsg }
}

/**
 * Labeled mock explanation surfaced when the AI Gateway key isn't
 * configured. Mirrors `mockAIResponse` in the chat panel so the
 * "missing key" experience is consistent.
 */
function mockExplanation(selection: string): string {
  const short = truncateSelectionForLabel(selection, 80)
  return [
    "_Mock explanation (set `AI_GATEWAY_API_KEY` to enable real AI)_",
    "",
    `With a configured AI Gateway key, the model would explain the passage "${short}" in light of this conversation, in 2-3 paragraphs.`,
    "",
    "If web search is enabled, sources would be cited with `[N]` markers and a Sources strip below.",
  ].join("\n")
}

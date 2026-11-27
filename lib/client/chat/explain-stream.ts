import "client-only"

/**
 * The Explain-selection popover's stream, below `useExplainStream`
 * (React-free, so it is testable with injected seams).
 *
 * * **On agent-py's backends** (`python-runs`, and `python` — agent-py
 *   configured; `explainOnRuns`): an **ephemeral** interactive run on
 *   agent-py's runs API (wave 12, Q125/Q135/Q136) on a fresh thread —
 *   the conversation history + the explain prompt, the chat model, the
 *   workspace prompt, **no skills or tools** (`buildExplainRunInput`).
 *   agent-py keeps it in memory only, so nothing is saved to the
 *   conversation or to the user's tasks. A signed-out caller's run is
 *   anonymous; its run token is not persisted (`tokens: null`) — nothing
 *   rejoins a popover after a reload. No no-key mock: a failed run shows
 *   its message; `auth_required` the sign-in message; a deploy with no
 *   model provider says so (Q131) and starts nothing.
 * * **Otherwise** (`ts`, `ts-service`, agent-py unconfigured — until wave
 *   13): today's `/api/chat` request, skills included, with the labelled
 *   mock on a missing AI key.
 *
 * `streamExplanation` returns `abort` — closing the popover: a started run
 * is cancelled server-side, a Next request aborted; nothing is reported to
 * the sink afterwards.
 */

import type { ChatBackendOption, ChatStreamOptions, ChatStreamResult } from "@/client/api-client"
import { buildExplainRunInput } from "@/client/runs/build-input"
import type { RunSession, RunSessionOptions } from "@/client/runs/session"
import type { RunsTarget, StartRunRequest } from "@/client/runs/types"
import { AUTH_REQUIRED_CODE, AUTH_REQUIRED_MESSAGE, isAuthRequiredError } from "@/shared/api-errors"
import type { ChatRequestInput } from "@/shared/api-schemas"
import { explainSelectionPrompt, truncateSelectionForLabel } from "@/shared/selection-prompts"
import { NO_MODEL_PROVIDER_HINT, NO_MODEL_PROVIDER_MESSAGE } from "@/shared/served-models"
import type { Message, ToolCallResult } from "@/shared/types"

export interface ExplainRequest {
  selection: string
  contextMessages: readonly Message[]
  model: string
  workspaceSystemPrompt?: string
  /** Sent on the Next route only (Q135: a run on agent-py takes none). */
  skills?: Array<{ id: string }>
}

/** Where the stream's state goes (the hook's `useState` setters). */
export interface ExplainSink {
  append(text: string): void
  /** Drop the text so far (a run stream's reset: rejoin / rewind). */
  reset(): void
  sources(results: ToolCallResult[]): void
  /** The labelled no-key mock (Next route only). */
  mock(text: string): void
  error(message: string): void
  /** `REQUIRE_AUTH_FOR_AI` refused a signed-out caller: offer sign-in. */
  authRequired(): void
  done(): void
}

export interface ExplainDeps {
  /** The runs target when Explain runs on agent-py, else `null` (the Next
   *  route) — `resolveExplainTarget`. */
  resolveRunsTarget(): Promise<RunsTarget | null>
  /** `() => import("@/client/runs/session")` — lazy, as chat's. */
  loadSession(): Promise<{
    startRunSession(body: StartRunRequest, opts: RunSessionOptions): RunSession
  }>
  /** `apiClient.chat.stream` (the Next route). */
  chatStream(body: ChatRequestInput, options?: ChatStreamOptions): Promise<ChatStreamResult>
  /** agent-py serves no model on this deploy (`noModelProvider`, Q131). */
  noModelProvider(): boolean
}

/** Whether Explain runs on agent-py's runs API: the agent-py backends
 *  (`python-runs`, `python`) when agent-py is configured. `ts` /
 *  `ts-service` keep the Next route until wave 13. Pure. */
export function explainOnRuns(chatBackend: ChatBackendOption, agentPyConfigured: boolean): boolean {
  return agentPyConfigured && (chatBackend === "python-runs" || chatBackend === "python")
}

export const NO_MODEL_PROVIDER_EXPLAIN = `${NO_MODEL_PROVIDER_MESSAGE} ${NO_MODEL_PROVIDER_HINT}`

export function streamExplanation(req: ExplainRequest, sink: ExplainSink, deps: ExplainDeps): () => void {
  let aborted = false
  let session: RunSession | null = null
  const controller = new AbortController()
  // Every report goes through here: nothing after `abort`.
  const live: ExplainSink = {
    append: (t) => !aborted && sink.append(t),
    reset: () => !aborted && sink.reset(),
    sources: (r) => !aborted && sink.sources(r),
    mock: (t) => !aborted && sink.mock(t),
    error: (m) => !aborted && sink.error(m),
    authRequired: () => !aborted && sink.authRequired(),
    done: () => !aborted && sink.done(),
  }

  const run = async () => {
    const target = await deps.resolveRunsTarget()
    if (aborted) return
    if (target === null) return streamFromNext(req, live, deps, controller.signal)
    if (deps.noModelProvider()) {
      live.error(NO_MODEL_PROVIDER_EXPLAIN)
      live.done()
      return
    }
    const mod = await deps.loadSession()
    if (aborted) return
    session = mod.startRunSession(
      buildExplainRunInput({
        history: req.contextMessages,
        prompt: explainSelectionPrompt(req.selection),
        model: req.model,
        systemPrompt: req.workspaceSystemPrompt,
      }),
      {
        target,
        tokens: null,
        sink: {
          frame: (f) => {
            if (f.type === "text" && typeof f.value === "string") live.append(f.value)
          },
          clear: () => live.reset(),
        },
      },
    )
    const { outcome } = await session.done
    if (outcome === null) return // detached
    if (outcome.type === "error") {
      if (outcome.code === AUTH_REQUIRED_CODE) {
        live.error(AUTH_REQUIRED_MESSAGE)
        live.authRequired()
      } else {
        live.error(outcome.message || "Request failed.")
      }
    }
    live.done()
  }

  run().catch((err: unknown) => {
    live.error(err instanceof Error ? err.message : "Stream failed.")
    live.done()
  })

  return () => {
    if (aborted) return
    aborted = true
    controller.abort()
    if (session) void session.cancel()
  }
}

/** Today's path: `/api/chat` (or `/v1/chat` per `chatStream`'s own rules —
 *  Explain passes no backend, so the Next route). */
async function streamFromNext(
  req: ExplainRequest,
  sink: ExplainSink,
  deps: ExplainDeps,
  signal: AbortSignal,
): Promise<void> {
  const body: ChatRequestInput = {
    messages: [
      ...req.contextMessages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: explainSelectionPrompt(req.selection) },
    ],
    model: req.model,
    workspaceSystemPrompt: req.workspaceSystemPrompt,
    skills: req.skills,
  }
  const result = await deps.chatStream(body, { signal })
  if (!result.ok || !result.body) {
    // REQUIRE_AUTH_FOR_AI: say so + offer sign-in; never the no-key mock.
    if (isAuthRequiredError(result.error)) {
      sink.error(AUTH_REQUIRED_MESSAGE)
      sink.authRequired()
    } else if (result.status === 401 || result.error?.code === "auth") {
      sink.mock(mockExplanation(req.selection))
    } else {
      sink.error(result.error?.message ?? `Request failed (HTTP ${result.status}).`)
    }
    sink.done()
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
        if (signal.aborted) return
        if (parsed.type === "text" && typeof parsed.value === "string") {
          sink.append(parsed.value)
        } else if (parsed.type === "tool_result" && Array.isArray(parsed.results)) {
          const cleaned = parsed.results.filter(
            (r): r is { title: string; url: string; snippet: string } =>
              typeof r?.title === "string" && typeof r?.url === "string" && typeof r?.snippet === "string",
          )
          if (cleaned.length > 0) sink.sources(cleaned)
        } else if (parsed.type === "error") {
          if (parsed.code === "auth") sink.mock(mockExplanation(req.selection))
          else sink.error(parsed.message ?? "Request failed.")
          sink.done()
          return
        } else if (parsed.type === "done") {
          sink.done()
          return
        }
      }
    }
    sink.done()
  } catch (err) {
    if (signal.aborted) return
    sink.error(err instanceof Error ? err.message : "Stream failed.")
    sink.done()
  }
}

/**
 * Labeled mock explanation surfaced when the AI Gateway key isn't
 * configured (the Next route only). Mirrors `mockAIResponse` in the chat
 * panel so the "missing key" experience is consistent.
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

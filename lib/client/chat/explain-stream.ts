import "client-only"

/**
 * The Explain-selection popover's stream, below `useExplainStream`
 * (React-free, so it is testable with injected seams).
 *
 * An **ephemeral** interactive run on agent-py's runs API (wave 12,
 * Q125/Q135/Q136) on a fresh thread — the conversation history + the
 * explain prompt, the chat model, the workspace prompt, **no skills or
 * tools** (`buildExplainRunInput`). agent-py keeps it in memory only, so
 * nothing is saved to the conversation or to the user's tasks. A
 * signed-out caller's run is anonymous; its run token is not persisted
 * (`tokens: null`) — nothing rejoins a popover after a reload. No mock: a
 * failed run shows its message; `auth_required` the sign-in message; a
 * deploy with no model provider says so (Q131) and starts nothing.
 *
 * `streamExplanation` returns `abort` — closing the popover: a started run
 * is cancelled server-side; nothing is reported to the sink afterwards.
 */

import { buildExplainRunInput } from "@/client/runs/build-input"
import type { RunSession, RunSessionOptions } from "@/client/runs/session"
import type { RunsTarget, StartRunRequest } from "@/client/runs/types"
import { AUTH_REQUIRED_CODE, AUTH_REQUIRED_MESSAGE } from "@/shared/api-errors"
import { explainSelectionPrompt } from "@/shared/selection-prompts"
import { NO_MODEL_PROVIDER_HINT, NO_MODEL_PROVIDER_MESSAGE } from "@/shared/served-models"
import type { Message } from "@/shared/types"

export interface ExplainRequest {
  selection: string
  contextMessages: readonly Message[]
  model: string
  workspaceSystemPrompt?: string
}

/** Where the stream's state goes (the hook's `useState` setters). */
export interface ExplainSink {
  append(text: string): void
  /** Drop the text so far (a run stream's reset: rejoin / rewind). */
  reset(): void
  error(message: string): void
  /** `REQUIRE_AUTH_FOR_AI` refused a signed-out caller: offer sign-in. */
  authRequired(): void
  done(): void
}

export interface ExplainDeps {
  /** Where the run goes — `resolveRunsTarget`. */
  resolveRunsTarget(): Promise<RunsTarget>
  /** `() => import("@/client/runs/session")` — lazy, as chat's. */
  loadSession(): Promise<{
    startRunSession(body: StartRunRequest, opts: RunSessionOptions): RunSession
  }>
  /** agent-py serves no model on this deploy (`noModelProvider`, Q131). */
  noModelProvider(): boolean
}

export const NO_MODEL_PROVIDER_EXPLAIN = `${NO_MODEL_PROVIDER_MESSAGE} ${NO_MODEL_PROVIDER_HINT}`

export function streamExplanation(req: ExplainRequest, sink: ExplainSink, deps: ExplainDeps): () => void {
  let aborted = false
  let session: RunSession | null = null
  // Every report goes through here: nothing after `abort`.
  const live: ExplainSink = {
    append: (t) => !aborted && sink.append(t),
    reset: () => !aborted && sink.reset(),
    error: (m) => !aborted && sink.error(m),
    authRequired: () => !aborted && sink.authRequired(),
    done: () => !aborted && sink.done(),
  }

  const run = async () => {
    const target = await deps.resolveRunsTarget()
    if (aborted) return
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
    if (session) void session.cancel()
  }
}

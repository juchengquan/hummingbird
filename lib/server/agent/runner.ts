import "server-only"

/**
 * The agent runner — slice 5 of the event model. Two parts:
 *
 *  - `runAgentLoop` — the pure orchestration: status → per-step
 *    (cancel check → start → runStep → end) → terminal. The model
 *    call is injected as a `RunStepFn` so the loop's control flow
 *    (step budget, cancellation, event sequencing, settle-once) is
 *    unit-testable with a fake step, no live model needed.
 *
 *  - `makeStreamTextStep` — the production `RunStepFn`: one
 *    `streamText` call per step with `stopWhen: stepCountIs(1)` so we
 *    checkpoint after each tool round-trip. It maps the AI-SDK
 *    `fullStream` parts onto the `RunEmitter` (token / reasoning /
 *    tool_input / tool_output / step_error) using the same part
 *    shapes the chat route relies on, and accumulates the response
 *    messages so the next step sees the tool results.
 *
 * The loop drives a `RunEmitter`; the route wires its sink to persist
 * (`appendEvent`) + stream. See `docs/PLAN-agent-event-model.md`.
 */

import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
} from "ai"

import type { RunEmitter } from "@/shared/agent/emitter"
import type { ToolCallResult } from "@/shared/types"

export interface RunStepContext {
  /** 1-based step number, matching the emitter's current step. */
  step: number
  signal: AbortSignal
  emitter: RunEmitter
}

export interface RunStepOutcome {
  /** false → the model called tools; loop again. true → final answer. */
  done: boolean
}

export type RunStepFn = (ctx: RunStepContext) => Promise<RunStepOutcome>

export interface AgentLoopOptions {
  emitter: RunEmitter
  maxSteps: number
  signal: AbortSignal
  /** Polled before each step so an out-of-band cancel (the DB status
   *  flipped by `/cancel`) stops the run between steps. */
  isCancelled: () => boolean | Promise<boolean>
  runStep: RunStepFn
}

/**
 * Drive a run to completion. Emits exactly one terminal event
 * (`status: cancelled` or `result: done|failed`) — the emitter drops
 * anything after, so a late tool callback can't append past the end.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const { emitter, maxSteps, signal, isCancelled, runStep } = opts
  emitter.status("running")
  try {
    for (let step = 1; step <= maxSteps; step++) {
      if (signal.aborted || (await isCancelled())) {
        emitter.status("cancelled")
        return
      }
      emitter.startStep()
      const outcome = await runStep({ step, signal, emitter })
      emitter.endStep()
      if (outcome.done) {
        emitter.result("done")
        return
      }
    }
    // Hit the step cap without a final answer. Settle anyway —
    // `finalText` falls back to the accumulated token text downstream.
    emitter.result("done")
  } catch (err) {
    if (signal.aborted) {
      emitter.status("cancelled")
      return
    }
    emitter.result("failed", {
      error: err instanceof Error ? err.message : "Run failed",
    })
  }
}

// --------------------------------------------------------------------
// Production step: one streamText call mapped onto the emitter.
// --------------------------------------------------------------------

export interface StreamTextStepConfig {
  model: LanguageModel
  system: string
  /** Mutable history — each step appends the model's response +
   *  tool messages so the next step sees them. */
  messages: ModelMessage[]
  /** AI-SDK tool map (same objects the chat route builds from
   *  `SERVER_SKILLS` + MCP). */
  tools: Record<string, unknown>
  /** Tool names whose call/result should NOT surface as tool pills —
   *  e.g. `setPlan`, which already shows up as the plan/todo list. The
   *  model still sees the tool result; only the UI event is suppressed. */
  silentTools?: Set<string>
  /** Coalesce streamed token deltas into one `token` event per this many
   *  chars (per channel), cutting the per-token event + DB-write volume
   *  while keeping streaming visually smooth. Flushes on channel switch,
   *  before any non-token part, and at stream end. Defaults to 96. */
  tokenFlushChars?: number
}

/**
 * Build the production `RunStepFn`. Closes over a mutable `messages`
 * array; each invocation runs one `streamText` step, emits its parts,
 * appends the response messages, and reports whether the model
 * produced a final answer (`finishReason !== 'tool-calls'`).
 */
export function makeStreamTextStep(config: StreamTextStepConfig): RunStepFn {
  const { model, system, messages, tools, silentTools } = config
  const flushChars = config.tokenFlushChars ?? 96

  return async ({ signal, emitter }) => {
    const hasTools = Object.keys(tools).length > 0
    const result = streamText({
      abortSignal: signal,
      model,
      system,
      messages,
      // One model round-trip per loop step so we checkpoint after each
      // tool result rather than letting streamText run the whole loop.
      stopWhen: stepCountIs(1),
      ...(hasTools
        ? { tools: tools as Parameters<typeof streamText>[0]["tools"] }
        : {}),
    })

    // Coalesce token deltas per channel: buffer until `flushChars`, a
    // channel switch, or a non-token part, then emit one `token` event.
    // One DB row per ~chunk instead of per token, with the wire still
    // updating frequently enough to read as live streaming.
    const coalescer = makeTokenCoalescer(emitter, flushChars)

    let finishReason = "stop"
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta": {
          coalescer.push("text", partText(part))
          break
        }
        case "reasoning-delta": {
          coalescer.push("reasoning", partText(part))
          break
        }
        case "tool-call": {
          coalescer.flushAll()
          const p = part as {
            toolCallId?: string
            toolName?: string
            input?: unknown
          }
          if (silentTools?.has(p.toolName ?? "")) break
          emitter.toolInput(p.toolCallId ?? "", p.toolName ?? "", p.input ?? {})
          break
        }
        case "tool-result": {
          coalescer.flushAll()
          const p = part as {
            toolCallId?: string
            toolName?: string
            output?: unknown
          }
          if (silentTools?.has(p.toolName ?? "")) break
          const { summary, results } = summarizeToolOutput(p.output)
          emitter.toolOutput(
            p.toolCallId ?? "",
            p.toolName ?? "",
            summary,
            results
          )
          break
        }
        case "tool-error": {
          coalescer.flushAll()
          const p = part as { toolName?: string; error?: unknown }
          const msg =
            p.error instanceof Error
              ? p.error.message
              : typeof p.error === "string"
                ? p.error
                : "Tool error"
          // Non-fatal: the model usually recovers next step.
          emitter.stepError(`${p.toolName ?? "tool"}: ${msg}`, true)
          break
        }
        case "finish-step":
        case "finish": {
          const p = part as { finishReason?: string }
          if (p.finishReason) finishReason = p.finishReason
          break
        }
        default:
          break
      }
    }
    // Emit any trailing buffered text/reasoning for this step.
    coalescer.flushAll()

    // Feed the model's response (assistant + tool messages) back in so
    // the next step continues the conversation.
    const response = await result.response
    if (response?.messages?.length) messages.push(...response.messages)

    // `tool-calls` means the model wants another round; anything else
    // (stop / length / content-filter) ends the run.
    return { done: finishReason !== "tool-calls" }
  }
}

function partText(part: unknown): string {
  const p = part as { delta?: string; text?: string }
  return p.delta ?? p.text ?? ""
}

/**
 * Per-channel token buffer. `push` accumulates a delta and emits a
 * single coalesced `token` event once the buffer reaches `flushChars`;
 * switching channels flushes the other channel first so text/reasoning
 * stay correctly interleaved. Exposed for unit testing the boundary
 * logic without driving a live model. Only needs the emitter's `token`.
 */
export function makeTokenCoalescer(
  emitter: Pick<RunEmitter, "token">,
  flushChars: number
) {
  let textBuf = ""
  let reasoningBuf = ""
  const flush = (channel: "text" | "reasoning") => {
    if (channel === "text" && textBuf) {
      emitter.token(textBuf, "text")
      textBuf = ""
    } else if (channel === "reasoning" && reasoningBuf) {
      emitter.token(reasoningBuf, "reasoning")
      reasoningBuf = ""
    }
  }
  return {
    push(channel: "text" | "reasoning", delta: string) {
      if (!delta) return
      if (channel === "text") {
        flush("reasoning")
        textBuf += delta
        if (textBuf.length >= flushChars) flush("text")
      } else {
        flush("text")
        reasoningBuf += delta
        if (reasoningBuf.length >= flushChars) flush("reasoning")
      }
    },
    flushAll() {
      flush("text")
      flush("reasoning")
    },
  }
}

/** Mirror the chat route's tool-output summarization: a one-line
 *  summary + (for web-search-shaped outputs) the results array for
 *  the Sources strip. */
function summarizeToolOutput(output: unknown): {
  summary: string
  results?: ToolCallResult[]
} {
  const o = output as
    | {
        results?: Array<{ title?: unknown; url?: unknown; snippet?: unknown }>
        fragments?: unknown[]
        error?: string
      }
    | undefined
  if (o?.error) return { summary: o.error }
  if (Array.isArray(o?.results)) {
    const n = o.results.length
    const results = o.results
      .map((r) => ({
        title: typeof r?.title === "string" ? r.title : "",
        url: typeof r?.url === "string" ? r.url : "",
        snippet: typeof r?.snippet === "string" ? r.snippet : "",
      }))
      .filter((r) => r.url)
    return { summary: `${n} result${n === 1 ? "" : "s"}`, results }
  }
  if (Array.isArray(o?.fragments)) {
    const n = o.fragments.length
    return { summary: `${n} excerpt${n === 1 ? "" : "s"}` }
  }
  return { summary: "done" }
}

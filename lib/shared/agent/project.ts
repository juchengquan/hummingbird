/**
 * Projection of a `TaskEvent` log into a renderable run view — the
 * "every view is a fold over the log" model from
 * `docs/PLAN-agent-event-model.md`.
 *
 * Pure + incremental: `reduceRun(view, event)` folds one event so the
 * live task card can tail the stream event-by-event, and `projectRun`
 * folds a whole log (resume / cold render). No I/O, no React.
 *
 * Robustness rules (a projection must never throw on a real stream):
 *  - Events fold in ascending `seq`; `projectRun` sorts defensively
 *    and ignores already-seen seqs (idempotent replay).
 *  - Unknown / future event kinds are ignored (the cursor still
 *    advances) so an adapter emitting a richer event set than this
 *    consumer understands degrades gracefully — see the multi-SDK
 *    adapter section of the plan.
 */

import type {
  PlanItem,
  RunStatus,
  TaskEvent,
  ToolOutputEvent,
} from "./events"
import type { ToolCallResult } from "@/shared/types"

export interface ToolCallView {
  toolCallId: string
  toolName: string
  args?: unknown
  summary?: string
  status: "running" | "done"
  results?: ToolCallResult[]
}

export interface TaskRunView {
  status: RunStatus
  /** Highest step number observed. */
  step: number
  /** Step ceiling from the latest `status` event that carried one. */
  maxSteps: number | null
  /** Accumulated answer text (token channel `"text"`). */
  text: string
  /** Accumulated reasoning (token channel `"reasoning"`). */
  reasoning: string
  /** Latest full todo list. */
  plan: PlanItem[]
  /** Tool calls in first-seen order; `tool_output` resolves the match. */
  toolCalls: ToolCallView[]
  /** Artifact ids referenced mid-run, in first-seen order. */
  artifactIds: string[]
  /** Most recent non-fatal step error message, else null. */
  lastStepError: string | null
  /** Fatal error from a `result: failed`, else null. */
  fatalError: string | null
  /** Final text from the `result` event, else null. */
  resultText: string | null
  /** Highest `seq` folded — the resume cursor to reconnect from. */
  cursor: number
  /** Set while the run is paused waiting for a human (HITL). Null
   *  otherwise. */
  pendingInput: PendingInput | null
}

export interface PendingInput {
  requestId: string
  kind: "approval" | "choice" | "input" | "ui-part"
  tool?: string
  toolCallId?: string
  args?: unknown
  prompt?: string
  options?: { id: string; label: string }[]
  multi?: boolean
  /** `kind: "ui-part"` — the generative-UI kind to render via the
   *  shared registry (`UI_KINDS[uiKind]`). */
  uiKind?: string
  /** `kind: "ui-part"` — props for the kind, pre-validated server-side. */
  uiProps?: unknown
}

export const EMPTY_RUN_VIEW: TaskRunView = {
  status: "queued",
  step: 0,
  maxSteps: null,
  text: "",
  reasoning: "",
  plan: [],
  toolCalls: [],
  artifactIds: [],
  lastStepError: null,
  fatalError: null,
  resultText: null,
  cursor: 0,
  pendingInput: null,
}

/** Fold a single event into a view, returning a new view. Events with
 *  `seq <= view.cursor` are treated as already-applied and returned
 *  unchanged (idempotent — safe to replay an overlapping window on
 *  reconnect). */
export function reduceRun(view: TaskRunView, event: TaskEvent): TaskRunView {
  if (event.seq <= view.cursor && view.cursor !== 0) return view
  // The cursor advances for *every* event we accept, including kinds
  // this consumer doesn't model — so an unknown future kind still
  // moves the resume point forward.
  const next: TaskRunView = {
    ...view,
    cursor: Math.max(view.cursor, event.seq),
    step: Math.max(view.step, event.step),
  }

  switch (event.kind) {
    case "token":
      if (event.channel === "reasoning") next.reasoning += event.text
      else next.text += event.text
      return next
    case "tool_input":
      next.toolCalls = upsertToolCall(view.toolCalls, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        status: "running",
      })
      return next
    case "tool_output":
      next.toolCalls = resolveToolCall(view.toolCalls, event)
      return next
    case "status":
      next.status = event.status
      if (typeof event.maxSteps === "number") next.maxSteps = event.maxSteps
      return next
    case "plan":
      next.plan = event.items
      return next
    case "step_error":
      next.lastStepError = event.message
      return next
    case "artifact_ref":
      next.artifactIds = view.artifactIds.includes(event.artifactId)
        ? view.artifactIds
        : [...view.artifactIds, event.artifactId]
      return next
    case "result":
      next.status = event.status
      next.resultText = event.finalText ?? next.text
      next.fatalError = event.status === "failed" ? event.error ?? "Run failed" : null
      return next
    case "approval":
      // Request opens a pending input; response clears it. Anything
      // else (the run already settled, a duplicate) is a no-op.
      if (event.phase === "request") {
        next.pendingInput = {
          requestId: event.approvalId,
          kind: event.requestKind ?? "approval",
          tool: event.tool,
          toolCallId: event.toolCallId,
          args: event.args,
          prompt: event.prompt,
          options: event.options,
          multi: event.multi,
          uiKind: event.uiKind,
          uiProps: event.uiProps,
        }
      } else if (event.phase === "response") {
        next.pendingInput = null
      }
      return next
    // step_start / step_end already handled by the `step` bump above;
    // handoff / compact carry no view state in v1 (the cursor + step
    // advance is enough). Reserved for later.
    case "step_start":
    case "step_end":
    case "handoff":
    case "compact":
      return next
    default:
      // Unknown/future kind — cursor already advanced; ignore payload.
      return next
  }
}

/** Fold a whole log into a view. Sorts by `seq` defensively and
 *  de-dups, so out-of-order or overlapping replay windows are safe. */
export function projectRun(events: TaskEvent[]): TaskRunView {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  let view = EMPTY_RUN_VIEW
  let lastSeq = -1
  for (const e of sorted) {
    if (e.seq === lastSeq) continue // duplicate seq — skip
    view = reduceRun(view, e)
    lastSeq = e.seq
  }
  return view
}

function upsertToolCall(
  calls: ToolCallView[],
  incoming: ToolCallView
): ToolCallView[] {
  const idx = calls.findIndex((c) => c.toolCallId === incoming.toolCallId)
  if (idx === -1) return [...calls, incoming]
  const merged = { ...calls[idx], ...incoming }
  const out = calls.slice()
  out[idx] = merged
  return out
}

function resolveToolCall(
  calls: ToolCallView[],
  event: ToolOutputEvent
): ToolCallView[] {
  const idx = calls.findIndex((c) => c.toolCallId === event.toolCallId)
  const resolved: Partial<ToolCallView> = {
    status: "done",
    summary: event.summary,
    ...(event.results ? { results: event.results } : {}),
  }
  if (idx === -1) {
    // Output without a prior input (rare — adapter emitted them out of
    // order, or input was dropped). Synthesize a done entry.
    return [
      ...calls,
      {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: "done",
        summary: event.summary,
        ...(event.results ? { results: event.results } : {}),
      },
    ]
  }
  const out = calls.slice()
  out[idx] = { ...calls[idx], ...resolved }
  return out
}

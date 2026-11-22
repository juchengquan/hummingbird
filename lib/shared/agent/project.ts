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
 *  - A resume marker (`status` with `resumedFromSeq`, or the legacy
 *    `restarted` flag — see `resumeDiscardRange`) un-folds the events a
 *    dead worker wrote past the checkpoint its reclaimed re-run resumed
 *    from: the view is rebuilt from the events up to that checkpoint,
 *    then the marker folds on top. Incremental tailing can do this
 *    because every view `reduceRun` returns remembers the events folded
 *    into it (a module-private side table, invisible to equality checks
 *    and serialisation).
 */

import {
  resumeDiscardRange,
  type PlanItem,
  type RunStatus,
  type TaskEvent,
  type ToolOutputEvent,
} from "./events"
import type { ToolCallResult } from "@/shared/types"
import type { VerificationResult } from "@/shared/verify"

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
  /** Citation-verification verdicts from the `result` event (research
   *  runs), else null. Surfaced onto the settled Message so
   *  `MessageVerification` renders. */
  verification: VerificationResult | null
  /** Highest `seq` folded — the resume cursor to reconnect from. */
  cursor: number
  /** Set while the run is paused waiting for a human (HITL). Null
   *  otherwise. */
  pendingInput: PendingInput | null
  /** Subagents spawned this run (from `handoff` events). */
  childRuns: ChildRunRef[]
}

export interface ChildRunRef {
  childTaskId: string
  agent: string
  subgoal: string
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
  verification: null,
  cursor: 0,
  pendingInput: null,
  childRuns: [],
}

/** The events folded into a view, newest first — a persistent list, so
 *  appending is O(1) and every view shares its predecessor's tail. */
interface FoldedLog {
  event: TaskEvent
  prev: FoldedLog | null
}

/** View → the events folded into it. Keyed weakly so a dropped view
 *  frees its log; kept off the view object itself so `TaskRunView`
 *  stays plain data. Retains the events, not intermediate views (those
 *  would pin a copy of the accumulated text per event). */
const FOLDED = new WeakMap<TaskRunView, FoldedLog>()

/** The view as it stood once every event with `seq <= after` was folded
 *  — i.e. with a resume marker's discard range un-folded. Rebuilt by
 *  re-folding the kept events (linear in the log, but markers are rare).
 *  A view that didn't come out of `reduceRun` has no history to rebuild
 *  from: fall back to a reset that keeps the step ceiling. */
function rollBackTo(view: TaskRunView, after: number): TaskRunView {
  if (view.cursor <= after) return view
  const log = FOLDED.get(view)
  if (!log) return { ...EMPTY_RUN_VIEW, maxSteps: view.maxSteps }
  const kept: TaskEvent[] = []
  for (let n: FoldedLog | null = log; n; n = n.prev) {
    if (n.event.seq <= after) kept.push(n.event)
  }
  let rebuilt = EMPTY_RUN_VIEW
  for (let i = kept.length - 1; i >= 0; i--) rebuilt = reduceRun(rebuilt, kept[i])
  return rebuilt
}

/** Fold a single event into a view, returning a new view. Events with
 *  `seq <= view.cursor` are treated as already-applied and returned
 *  unchanged (idempotent — safe to replay an overlapping window on
 *  reconnect). A resume marker first rolls the view back to its
 *  checkpoint (see the module doc). */
export function reduceRun(view: TaskRunView, event: TaskEvent): TaskRunView {
  if (event.seq <= view.cursor && view.cursor !== 0) return view
  const discard = resumeDiscardRange(event)
  const base = discard ? rollBackTo(view, discard.after) : view
  // The cursor advances for *every* event we accept, including kinds
  // this consumer doesn't model — so an unknown future kind still
  // moves the resume point forward.
  const next: TaskRunView = {
    ...base,
    cursor: Math.max(view.cursor, event.seq),
    step: Math.max(base.step, event.step),
  }
  FOLDED.set(next, { event, prev: FOLDED.get(base) ?? null })

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
      // A resumed run is executing again: whatever input the rolled-back
      // view was waiting on (a respond resumed from its paused
      // checkpoint) has been answered.
      if (discard) next.pendingInput = null
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
      if (event.verification) next.verification = event.verification
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
        // The respond path emits no `tool_output` for the call it answers:
        // it's over now (a declined one never ran).
        next.toolCalls = resolveAnsweredCall(base.toolCalls, event.approvalId, event.approved)
      }
      return next
    case "handoff": {
      if (event.phase !== "enter" || !event.childTaskId) return next
      if (view.childRuns.some((c) => c.childTaskId === event.childTaskId)) return next
      next.childRuns = [
        ...view.childRuns,
        { childTaskId: event.childTaskId, agent: event.agent, subgoal: event.subgoal ?? "" },
      ]
      return next
    }
    // step_start / step_end already handled by the `step` bump above;
    // compact carries no view state in v1 (the cursor + step
    // advance is enough). Reserved for later.
    case "step_start":
    case "step_end":
    case "compact":
      return next
    default:
      // Unknown/future kind — cursor already advanced; ignore payload.
      return next
  }
}

/**
 * Whether an event pushed out of band (Realtime) may be folded now: only
 * the one right after the cursor. `reduceRun` drops everything at or
 * before its cursor, so folding a later event would lose what the ordered
 * replay — which starts at 0 — hasn't delivered yet.
 */
export function isNextEvent(view: TaskRunView, event: TaskEvent): boolean {
  return event.seq === view.cursor + 1
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

/** The gated call an answer closes (its id is the approval's). */
function resolveAnsweredCall(
  calls: ToolCallView[],
  approvalId: string,
  approved: boolean | undefined
): ToolCallView[] {
  const call = calls.find((c) => c.toolCallId === approvalId)
  if (call?.status !== "running") return calls
  if (approved === false) return calls.filter((c) => c !== call)
  const summary = approved ? "Approved" : "Answered"
  return calls.map((c) => (c === call ? { ...c, status: "done", summary } : c))
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

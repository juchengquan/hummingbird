/**
 * The canonical agent event model — see `docs/PLAN-agent-event-model.md`.
 *
 * A long-running task is an append-only log of `TaskEvent`s; every
 * view (the live task card, the settled assistant message, a sidebar
 * status badge) is a *projection* of that log (see `./project.ts`).
 * This file is the IR: pure types + tiny guards, no I/O. When the
 * backend runs different agent SDKs underneath, each SDK gets a thin
 * adapter that maps its native stream into these events — so the
 * frontend never sees SDK-specific shapes.
 *
 * The plan sketched `payload: Json`; we refine to a discriminated
 * union on `kind` so the projection reducer is type-safe.
 */

import type { ToolCallResult } from "@/shared/types"

/** Lifecycle of a run. Mirrors the `tasks.status` column in
 *  `PLAN-long-running-tasks.md`. */
export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "cancelled"
  | "done"
  | "failed"

/** A run is terminal once it reaches one of these. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "cancelled",
  "done",
  "failed",
])

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

export type PlanItemStatus = "pending" | "in_progress" | "completed"

/** One row of the agent's live todo list (Deep-Agents style — the
 *  plan is durable state the UI projects, not a transient frame). */
export interface PlanItem {
  id: string
  text: string
  status: PlanItemStatus
}

export type TaskEventKind =
  | "token"
  | "tool_input"
  | "tool_output"
  | "step_start"
  | "step_end"
  | "status"
  | "plan"
  | "step_error"
  | "handoff"
  | "approval"
  | "compact"
  | "artifact_ref"
  | "result"

/** Fields every event carries regardless of kind. */
export interface TaskEventBase {
  runId: string
  /** Monotonic per run — the resume cursor. Gaps are not allowed;
   *  consumers fold in `seq` order. */
  seq: number
  /** Which agent step produced the event (one LLM call ≈ one step). */
  step: number
  /** ISO-8601. */
  createdAt: string
}

/** Raw text or reasoning delta. `channel` defaults to `"text"`. */
export interface TokenEvent extends TaskEventBase {
  kind: "token"
  text: string
  channel?: "text" | "reasoning"
}

/** A tool call started — args are final/complete at this point. */
export interface ToolInputEvent extends TaskEventBase {
  kind: "tool_input"
  toolCallId: string
  toolName: string
  args: unknown
}

/** A tool call resolved. */
export interface ToolOutputEvent extends TaskEventBase {
  kind: "tool_output"
  toolCallId: string
  toolName: string
  /** One-line user-facing summary, e.g. "5 results". */
  summary: string
  /** Detailed entries (e.g. web-search hits) for the Sources strip. */
  results?: ToolCallResult[]
}

export interface StepStartEvent extends TaskEventBase {
  kind: "step_start"
}

export interface StepEndEvent extends TaskEventBase {
  kind: "step_end"
}

export interface StatusEvent extends TaskEventBase {
  kind: "status"
  status: RunStatus
  /** Step ceiling, when known — drives an "N / M" progress display. */
  maxSteps?: number
}

/** Full todo list — carried in full each time (not deltas) per the
 *  Open-questions decision in the plan. */
export interface PlanEvent extends TaskEventBase {
  kind: "plan"
  items: PlanItem[]
}

/** Per-step failure, distinct from the fatal `result: failed`. */
export interface StepErrorEvent extends TaskEventBase {
  kind: "step_error"
  message: string
  /** True when the runner will retry the step; false = surfaced but
   *  the run continues past it. */
  willRetry: boolean
}

/** Sub-agent enter/exit (OpenAI/Deep-Agents). Reserved — single-agent
 *  runners never emit it; consumers tolerate its absence. */
export interface HandoffEvent extends TaskEventBase {
  kind: "handoff"
  agent: string
  phase: "enter" | "exit"
}

/** Human-in-the-loop approval gate (OpenAI mcp_approval). Reserved. */
export interface ApprovalEvent extends TaskEventBase {
  kind: "approval"
  approvalId: string
  phase: "request" | "response"
  tool?: string
  /** Only on `phase: "response"`. */
  approved?: boolean
}

/** History compaction mid-run (Claude compact boundary). */
export interface CompactEvent extends TaskEventBase {
  kind: "compact"
  summary?: string
}

/** A partial artifact produced/updated mid-run; links to the existing
 *  `artifacts` entity. */
export interface ArtifactRefEvent extends TaskEventBase {
  kind: "artifact_ref"
  artifactId: string
}

/** Terminal projection — written once when the run settles. */
export interface ResultEvent extends TaskEventBase {
  kind: "result"
  status: "done" | "failed"
  /** The final assistant text (also reconstructable from tokens, but
   *  carried here so a settled Message can be written without
   *  re-folding). */
  finalText?: string
  /** Present on `status: "failed"`. */
  error?: string
}

export type TaskEvent =
  | TokenEvent
  | ToolInputEvent
  | ToolOutputEvent
  | StepStartEvent
  | StepEndEvent
  | StatusEvent
  | PlanEvent
  | StepErrorEvent
  | HandoffEvent
  | ApprovalEvent
  | CompactEvent
  | ArtifactRefEvent
  | ResultEvent

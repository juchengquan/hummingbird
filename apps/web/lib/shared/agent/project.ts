/**
 * The renderable view of a task — what the tasks panel shows
 * (`lib/client/runs/tasks/chain.ts` folds a task's run streams into it).
 * Pure types + the empty view. No I/O, no React.
 */

import type { PlanItem, RunStatus } from "./events"
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

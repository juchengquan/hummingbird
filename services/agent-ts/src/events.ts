/**
 * TaskEvent IR — direct port of
 * `services/agent-py/src/agent_py/events.py`.
 *
 * The wire shape (DB row) is
 * `task_events(task_id, user_id, seq, step, kind, payload jsonb)`.
 * Kinds + payload shape match agent-py byte-for-byte so the
 * client-side projection reducer accepts rows from either producer.
 *
 * Phase 2 of PLAN-agent-ts covers `status / step_start / step_end /
 * token / result`. Tool / approval / plan / handoff land alongside
 * their owning feature ports (Phase 3+).
 */

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "cancelled"
  | "done"
  | "failed"

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  "cancelled",
  "done",
  "failed",
])

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status)
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

interface BaseFields {
  runId: string
  seq: number
  step: number
  createdAt: string
}

export type StatusEvent = BaseFields & {
  kind: "status"
  status: RunStatus
}

export type StepStartEvent = BaseFields & { kind: "step_start" }
export type StepEndEvent = BaseFields & { kind: "step_end" }

export type TokenEvent = BaseFields & {
  kind: "token"
  text: string
  channel?: "text" | "reasoning"
}

export type ResultEvent = BaseFields & {
  kind: "result"
  status: "done" | "failed"
  finalText?: string
  error?: string
}

export interface ToolCallResult {
  title: string
  url: string
  snippet: string
}

export type ToolInputEvent = BaseFields & {
  kind: "tool_input"
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
}

export type ToolOutputEvent = BaseFields & {
  kind: "tool_output"
  toolCallId: string
  toolName: string
  summary: string
  results?: ToolCallResult[]
}

export type StepErrorEvent = BaseFields & {
  kind: "step_error"
  message: string
  willRetry: boolean
}

export type TaskEvent =
  | StatusEvent
  | StepStartEvent
  | StepEndEvent
  | TokenEvent
  | ResultEvent
  | ToolInputEvent
  | ToolOutputEvent
  | StepErrorEvent

/**
 * Serialise an event's kind-specific fields into the jsonb `payload`
 * column. Keys match what agent-py writes via
 * `event_to_row_payload`, so the projection reducer accepts both.
 */
export function eventToRowPayload(event: TaskEvent): Record<string, unknown> {
  switch (event.kind) {
    case "status":
      return { status: event.status }
    case "token":
      return { text: event.text, channel: event.channel ?? "text" }
    case "result": {
      const out: Record<string, unknown> = { status: event.status }
      if (event.finalText !== undefined) out.finalText = event.finalText
      if (event.error !== undefined) out.error = event.error
      return out
    }
    case "tool_input":
      return {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      }
    case "tool_output": {
      const out: Record<string, unknown> = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        summary: event.summary,
      }
      if (event.results !== undefined) out.results = event.results
      return out
    }
    case "step_error":
      return { message: event.message, willRetry: event.willRetry }
    default:
      return {}
  }
}

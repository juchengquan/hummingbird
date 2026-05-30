import "server-only"

/**
 * Durable run state for HITL pause/resume — the foundation of the
 * `PLAN-agent-hitl-approvals.md` design. Stored in `tasks.checkpoint`
 * (JSONB) at the suspend point and loaded by the continuation
 * invocation so it can pick up exactly where it paused.
 *
 * Persists three things the event log can't rebuild:
 *  - `messages` — the model's `ModelMessage[]` history (raw tool I/O
 *    the event log only summarizes).
 *  - `step` / `seq` — counters to seed `RunEmitter` so the continuation
 *    keeps a monotonic event sequence instead of restarting at 1.
 *  - `config` — non-secret run setup (model, system, skills,
 *    workspaceId, maxSteps) so a fresh function can rebuild the same
 *    tool map and system prompt. Local-mode MCP creds are NOT
 *    persisted; the client re-supplies them when it responds.
 */

import type { ModelMessage } from "ai"

import type { TaskRequestInput } from "@/shared/api-schemas"

export interface CheckpointConfig {
  model: string
  workspaceSystemPrompt?: string
  workspaceId?: string
  skills: TaskRequestInput["skills"]
  maxSteps: number
  /** Approval-gated tool names from the original `start` request, so
   *  a continuation re-applies the same policy and a sensitive tool
   *  call on a later chunk still suspends. */
  requireApprovalFor?: string[]
  /** Task mode (`PLAN-deep-research.md`). `'research'` swaps the
   *  default system prompt for the research-mode loop. Persisted so
   *  every chunk after a yield keeps the same prompt. Untouched runs
   *  (older or default) read undefined → behave as `'default'`. */
  mode?: "default" | "research"
}

export interface RunCheckpoint {
  messages: ModelMessage[]
  /** Step number at the suspend point — the continuation emits from
   *  here. */
  step: number
  /** Highest `seq` already emitted — the continuation's emitter starts
   *  one above this. */
  seq: number
  config: CheckpointConfig
}

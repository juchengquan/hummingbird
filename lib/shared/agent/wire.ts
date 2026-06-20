/**
 * Wire codec for the agent event model — `TaskEvent` ↔ the AI-SDK-v5
 * UI message stream (see `docs/PLAN-agent-event-model.md`).
 *
 * Decision recap: we adopt the AI SDK v5 data-stream as the transport.
 * The task surface is driven by our own `reduceRun` projection (not
 * `useChat`'s built-in message assembly), and the resume cursor
 * (`seq`) must ride *every* event — neither of which fits the native
 * `text-delta` / `tool-output-available` part schemas (they have no
 * `seq` slot). So every `TaskEvent` travels as a single typed
 * **`data-agent-event`** part — the SDK's first-class custom-data
 * mechanism — carrying the whole event. The SDK's stream writer
 * forwards it verbatim; `useChat` hands it back under
 * `message.parts`, and the client validates + folds it.
 *
 * Validation: the wire is a boundary, so `fromDataPart` Zod-parses the
 * payload and returns `null` on anything malformed or foreign (a part
 * from another producer, version skew, a future kind this consumer
 * predates). Decoders never throw — graceful degradation, per the
 * multi-SDK rule.
 */

import { z } from "zod"

import type { TaskEvent } from "./events"

/** The AI-SDK data-part `type` that carries one `TaskEvent`. */
export const AGENT_EVENT_PART_TYPE = "data-agent-event" as const

/** An AI-SDK-v5 data part wrapping a single agent event. */
export interface AgentEventPart {
  type: typeof AGENT_EVENT_PART_TYPE
  data: TaskEvent
}

// --- schema --------------------------------------------------------

const base = {
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
}

const toolResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
})

// Mirrors `VerificationResult` in `@/shared/verify`. Carried on the
// terminal `result` event for research runs; this boundary validation is
// what lets a Python-emitted (agent-py) verification row survive the
// `rowToTaskEvent` re-parse. See `docs/PLAN-citation-verifiability.md`.
const verificationSchema = z.object({
  checks: z.array(
    z.object({
      claim: z.string(),
      status: z.enum(["supported", "unsupported", "partial"]),
      sourceIds: z.array(z.string()),
    })
  ),
  summary: z.object({
    supported: z.number(),
    partial: z.number(),
    unsupported: z.number(),
    total: z.number(),
  }),
})

const planItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
})

const runStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "cancelled",
  "done",
  "failed",
])

/** Discriminated union mirroring `TaskEvent` in `events.ts`. Kept in
 *  lockstep with that file — a new event kind needs a member here. */
export const TaskEventSchema: z.ZodType<TaskEvent> = z.discriminatedUnion(
  "kind",
  [
    z.object({
      ...base,
      kind: z.literal("token"),
      text: z.string(),
      channel: z.enum(["text", "reasoning"]).optional(),
    }),
    z.object({
      ...base,
      kind: z.literal("tool_input"),
      toolCallId: z.string(),
      toolName: z.string(),
      args: z.unknown(),
    }),
    z.object({
      ...base,
      kind: z.literal("tool_output"),
      toolCallId: z.string(),
      toolName: z.string(),
      summary: z.string(),
      results: z.array(toolResultSchema).optional(),
    }),
    z.object({ ...base, kind: z.literal("step_start") }),
    z.object({ ...base, kind: z.literal("step_end") }),
    z.object({
      ...base,
      kind: z.literal("status"),
      status: runStatusSchema,
      maxSteps: z.number().int().positive().optional(),
    }),
    z.object({
      ...base,
      kind: z.literal("plan"),
      items: z.array(planItemSchema),
    }),
    z.object({
      ...base,
      kind: z.literal("step_error"),
      message: z.string(),
      willRetry: z.boolean(),
    }),
    z.object({
      ...base,
      kind: z.literal("handoff"),
      agent: z.string(),
      phase: z.enum(["enter", "exit"]),
      childTaskId: z.string().optional(),
      subgoal: z.string().optional(),
    }),
    z.object({
      ...base,
      kind: z.literal("approval"),
      approvalId: z.string(),
      phase: z.enum(["request", "response"]),
      requestKind: z.enum(["approval", "choice", "input"]).optional(),
      tool: z.string().optional(),
      toolCallId: z.string().optional(),
      args: z.unknown().optional(),
      prompt: z.string().optional(),
      options: z
        .array(z.object({ id: z.string(), label: z.string() }))
        .optional(),
      multi: z.boolean().optional(),
      approved: z.boolean().optional(),
      selection: z.array(z.string()).optional(),
      value: z.string().optional(),
    }),
    z.object({
      ...base,
      kind: z.literal("compact"),
      summary: z.string().optional(),
    }),
    z.object({
      ...base,
      kind: z.literal("artifact_ref"),
      artifactId: z.string(),
    }),
    z.object({
      ...base,
      kind: z.literal("result"),
      status: z.enum(["done", "failed"]),
      finalText: z.string().optional(),
      error: z.string().optional(),
      verification: verificationSchema.optional(),
    }),
  ]
) as z.ZodType<TaskEvent>

// --- encode / decode -----------------------------------------------

/** Wrap an event as an AI-SDK data part for the stream writer. */
export function toDataPart(event: TaskEvent): AgentEventPart {
  return { type: AGENT_EVENT_PART_TYPE, data: event }
}

/** Validate + unwrap one part received over the wire. Returns `null`
 *  for anything that isn't a well-formed agent-event part — a foreign
 *  data part, a native AI-SDK part, version skew, or a future event
 *  kind this consumer doesn't model. Never throws. */
export function fromDataPart(part: unknown): TaskEvent | null {
  if (!part || typeof part !== "object") return null
  const p = part as { type?: unknown; data?: unknown }
  if (p.type !== AGENT_EVENT_PART_TYPE) return null
  const parsed = TaskEventSchema.safeParse(p.data)
  return parsed.success ? parsed.data : null
}

/** Decode a batch, dropping anything that doesn't validate. */
export function fromDataParts(parts: unknown[]): TaskEvent[] {
  const out: TaskEvent[] = []
  for (const part of parts) {
    const e = fromDataPart(part)
    if (e) out.push(e)
  }
  return out
}

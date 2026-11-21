import "client-only"

/**
 * Interrupts for chat on runs (Q35): what a paused turn waits for, and how
 * an answer becomes the `resume[]` of the run that continues it (Q24).
 * Wire shapes: RUN_EVENTS.md § 4.
 *
 * A run pauses with `RUN_FINISHED { outcome: { type: "interrupt",
 * interrupts } }`; the reducer hands them over as `PendingInterrupt`s
 * (`RunOutcome` `interrupt`), and `getRun(...).openInterrupts` gives the
 * same objects after a reload (`pendingInterrupts(run)`). Answering every
 * one of them — `buildResume` — and sending it with `resumeRun` starts the
 * resume run, whose stream opens with one `TOOL_CALL_RESULT` per answer.
 *
 * Pure.
 */

import type { Interrupt, ResumeEntry, Run } from "./types"

/** `Interrupt.reason` values agent-py sends (`requestKind`). */
export type InterruptReason = "approval" | "choice" | "input" | "ui-part"

/** An open interrupt, with its `metadata.hummingbird` unpacked for the
 *  answer cards. Unknown reasons are kept (`reason` is then a string the
 *  UI can't answer except by cancelling it). */
export interface PendingInterrupt {
  id: string
  reason: InterruptReason | (string & {})
  /** The question / prompt, when the tool gave one. */
  message?: string
  /** The tool call the interrupt holds (its pill is still running). */
  toolCallId?: string
  /** JSON Schema of the answer's `payload`. */
  responseSchema?: unknown
  /** ISO time after which it can only be cancelled. */
  expiresAt?: string
  /** The gated tool and its arguments. */
  tool?: string
  args?: Record<string, unknown>
  /** `choice`: the options, and whether several may be picked. */
  options?: Array<{ id: string; label: string }>
  multi?: boolean
  /** `ui-part`: the generative-UI part to render as the answer card. */
  uiKind?: string
  uiProps?: unknown
  /** The AG-UI interrupt as received. */
  raw: Interrupt
}

/** An answer, by reason — the `payload` shapes of RUN_EVENTS.md § 4.2 —
 *  or `{ cancelled: true }` to abandon the interrupt (an approval is then
 *  refused; any other tool gets "the user declined to answer"). */
export type InterruptAnswer =
  | { approved: boolean; args?: Record<string, unknown> }
  | { selection: string[] }
  | { value: string }
  | { uiAnswer: Record<string, unknown> }
  | { cancelled: true }

function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function toPendingInterrupt(raw: Interrupt): PendingInterrupt {
  const hb = obj(obj(raw.metadata)?.hummingbird) ?? {}
  const out: PendingInterrupt = { id: raw.id, reason: raw.reason, raw }
  if (typeof raw.message === "string") out.message = raw.message
  if (typeof raw.toolCallId === "string") out.toolCallId = raw.toolCallId
  if (raw.responseSchema !== undefined) out.responseSchema = raw.responseSchema
  if (typeof raw.expiresAt === "string") out.expiresAt = raw.expiresAt
  if (typeof hb.tool === "string") out.tool = hb.tool
  const args = obj(hb.args)
  if (args) out.args = args
  if (Array.isArray(hb.options)) {
    out.options = hb.options.flatMap((o) => {
      const opt = obj(o)
      return opt && typeof opt.id === "string" && typeof opt.label === "string"
        ? [{ id: opt.id, label: opt.label }]
        : []
    })
  }
  if (typeof hb.multi === "boolean") out.multi = hb.multi
  if (typeof hb.uiKind === "string") out.uiKind = hb.uiKind
  if (hb.uiProps !== undefined) out.uiProps = hb.uiProps
  return out
}

/** The open interrupts of a run resource (empty unless `interrupted`). */
export function pendingInterrupts(run: Pick<Run, "status" | "openInterrupts">): PendingInterrupt[] {
  if (run.status !== "interrupted") return []
  return (run.openInterrupts as Interrupt[]).map(toPendingInterrupt)
}

function payloadMatches(reason: string, answer: InterruptAnswer): boolean {
  switch (reason) {
    case "approval":
      return "approved" in answer
    case "choice":
      return "selection" in answer
    case "input":
      return "value" in answer
    case "ui-part":
      return "uiAnswer" in answer
    default:
      return false
  }
}

/**
 * `resume[]` answering exactly the given interrupts — one entry each, in
 * their order. Throws when an interrupt has no answer, an answer names no
 * open interrupt, or an answer's shape doesn't fit its reason (the backend
 * would refuse it with `409 invalid_state` / `400`). The coverage rule is
 * `@ag-ui/client`'s `buildResumeArray` (every open interrupt answered,
 * nothing else), and the session's agent checks it again before sending
 * (`onInitialize` with `pendingInterrupts`).
 */
export function buildResume(
  interrupts: readonly PendingInterrupt[],
  answers: Readonly<Record<string, InterruptAnswer>>,
): ResumeEntry[] {
  const open = new Set(interrupts.map((i) => i.id))
  const missing = interrupts.filter((i) => !(i.id in answers)).map((i) => i.id)
  if (missing.length > 0) throw new Error(`Unanswered interrupts: ${missing.join(", ")}`)
  const unknown = Object.keys(answers).filter((id) => !open.has(id))
  if (unknown.length > 0) throw new Error(`Answers for unknown interrupts: ${unknown.join(", ")}`)
  return interrupts.map((i) => {
    const answer = answers[i.id]
    if ("cancelled" in answer) return { interruptId: i.id, status: "cancelled" }
    if (!payloadMatches(i.reason, answer)) {
      throw new Error(`Answer for ${i.id} does not fit a "${i.reason}" interrupt.`)
    }
    return { interruptId: i.id, status: "resolved", payload: answer }
  })
}

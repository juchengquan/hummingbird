import "client-only"

/**
 * The chain fold (wave 6, Q69/Q75): one task's AG-UI streams — its root
 * run, then each run that answered it, in order — folded into the one
 * `TaskRunView` the task panel shows. Pure and synchronous: `foldChain`
 * folds whole logs; `ChainFold` keeps the logs and folds incrementally as
 * events arrive, re-folding only on a rewind (or an event for a run that
 * isn't the newest held).
 *
 * What a chain means here (RUN_EVENTS.md § 4.2, § 4.5):
 * - every run's `RUN_STARTED` starts its own progress: `step` restarts at
 *   0, the pending question is gone (the run answered it), the status is
 *   `running`;
 * - text, reasoning, tool calls, the plan, artifacts and sub-agents
 *   accumulate across the chain — a resume's opening `TOOL_CALL_RESULT`
 *   resolves the call its predecessor's stream started;
 * - the status, step and pending question are the last run's.
 *
 * Event mapping (RUN_EVENTS.md § 3): `STEP_STARTED step-N` → step;
 * `TEXT_MESSAGE_CONTENT` / `REASONING_MESSAGE_CONTENT` → text / reasoning;
 * `TOOL_CALL_*` → tool calls (args parsed at `END`, the result's
 * `{summary, results}` content and `isError`); `ACTIVITY_SNAPSHOT`
 * `hummingbird.plan` / `.verification` / `.artifact_ref`; `CUSTOM`
 * `hummingbird.step_error` → `lastStepError`, `.interrupt_pending` → the
 * pending question as it is raised, `.interrupt_resolved` → cleared (an
 * in-place answer), `.rewind` → the run's dead attempt discarded (§ 6.5);
 * `SUBAGENT_STARTED` → `childRuns`; the closing `RUN_FINISHED` (success →
 * `done` + `resultText`, interrupt → `paused` + its first interrupt,
 * cancelled) / `RUN_ERROR` (→ `failed` + `fatalError`); a
 * `MESSAGES_SNAPSHOT` (after a `gap`) replaces the run's output.
 *
 * `cursor` is unused (0): runs cursors are per run, and strings — the fold
 * keeps each run's last one (`ChainFold.cursorOf`).
 */

import { EMPTY_RUN_VIEW, type PendingInput, type TaskRunView, type ToolCallView } from "@/shared/agent/project"
import type { PlanItem } from "@/shared/agent/events"
import { compareCursors, cursorSeq, START_CURSOR } from "@/shared/runs/cursor"
import type { GeneratedImage, ToolCallResult } from "@/shared/types"
import { parseVerificationFrame } from "@/shared/verify"

import { toPendingInterrupt, type PendingInterrupt } from "../interrupts"
import type { AgUiEvent, Interrupt, RunCursor } from "../types"

export interface ChainItem {
  cursor: RunCursor | null
  event: AgUiEvent
}

export interface ChainRunLog {
  runId: string
  items: readonly ChainItem[]
}

const HB = "hummingbird."

type Ev = AgUiEvent & Record<string, unknown>

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** A `PendingInterrupt` as the view's `PendingInput` (the old task view's
 *  shape, which the answer cards render). */
export function pendingInputOf(p: PendingInterrupt): PendingInput {
  const kind = (["approval", "choice", "input", "ui-part"] as const).includes(
    p.reason as PendingInput["kind"],
  )
    ? (p.reason as PendingInput["kind"])
    : "approval"
  const out: PendingInput = { requestId: p.id, kind }
  if (p.tool) out.tool = p.tool
  if (p.toolCallId) out.toolCallId = p.toolCallId
  if (p.args) out.args = p.args
  if (p.message) out.prompt = p.message
  if (p.options) out.options = p.options
  if (p.multi !== undefined) out.multi = p.multi
  if (p.uiKind) out.uiKind = p.uiKind
  if (p.uiProps !== undefined) out.uiProps = p.uiProps
  return out
}

/** The fold's working state: the view plus what the view doesn't hold. */
interface Acc {
  view: TaskRunView
  /** toolCallId → the argument JSON received so far. */
  args: Map<string, string>
  /** The run whose events are being folded. */
  runId: string | null
}

function emptyAcc(): Acc {
  return { view: EMPTY_RUN_VIEW, args: new Map(), runId: null }
}

function upsertCall(calls: ToolCallView[], call: ToolCallView): ToolCallView[] {
  const i = calls.findIndex((c) => c.toolCallId === call.toolCallId)
  if (i === -1) return [...calls, call]
  const out = calls.slice()
  out[i] = { ...calls[i], ...call }
  return out
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function toolResultOf(event: Ev): { summary?: string; results?: ToolCallResult[] } {
  const content = typeof event.content === "string" ? parseJson(event.content) : undefined
  const body = rec(content)
  const out: { summary?: string; results?: ToolCallResult[] } = {}
  if (typeof body?.summary === "string") out.summary = body.summary
  else if (typeof event.content === "string") out.summary = event.content
  if (Array.isArray(body?.results)) out.results = body.results as ToolCallResult[]
  return out
}

function finishRunningCalls(calls: ToolCallView[]): ToolCallView[] {
  return calls.some((c) => c.status === "running")
    ? calls.map((c) => (c.status === "running" ? { ...c, status: "done" } : c))
    : calls
}

function stepOf(stepName: unknown): number | null {
  if (typeof stepName !== "string") return null
  const m = /^step-(\d+)$/.exec(stepName)
  return m ? Number(m[1]) : null
}

/** Fold one event of `runId` into the accumulator (in place; the view is
 *  replaced, never mutated, whenever it changes). */
function apply(acc: Acc, runId: string, raw: AgUiEvent): void {
  const event = raw as Ev
  let v = acc.view
  if (acc.runId !== runId) {
    // The next run of the chain: its own progress, and the question it
    // answered is no longer pending.
    acc.runId = runId
    v = { ...v, status: "running", step: 0, maxSteps: null, pendingInput: null, fatalError: null }
  }
  switch (event.type) {
    case "RUN_STARTED":
      break
    case "STEP_STARTED": {
      const n = stepOf(event.stepName)
      // The model is only called again with every call's result in hand.
      v = { ...v, toolCalls: finishRunningCalls(v.toolCalls), ...(n !== null ? { step: Math.max(v.step, n) } : {}) }
      break
    }
    case "TEXT_MESSAGE_CONTENT":
      if (typeof event.delta === "string" && event.delta) v = { ...v, text: v.text + event.delta }
      break
    case "REASONING_MESSAGE_CONTENT":
      if (typeof event.delta === "string" && event.delta) v = { ...v, reasoning: v.reasoning + event.delta }
      break
    case "TOOL_CALL_START": {
      const id = String(event.toolCallId)
      acc.args.set(id, "")
      v = {
        ...v,
        toolCalls: upsertCall(v.toolCalls, {
          toolCallId: id,
          toolName: String(event.toolCallName ?? ""),
          status: "running",
        }),
      }
      break
    }
    case "TOOL_CALL_ARGS": {
      const id = String(event.toolCallId)
      acc.args.set(id, (acc.args.get(id) ?? "") + (typeof event.delta === "string" ? event.delta : ""))
      break
    }
    case "TOOL_CALL_END": {
      const id = String(event.toolCallId)
      const text = acc.args.get(id)
      acc.args.delete(id)
      if (text) {
        const parsed = parseJson(text)
        const call = v.toolCalls.find((c) => c.toolCallId === id)
        if (call) v = { ...v, toolCalls: upsertCall(v.toolCalls, { ...call, args: parsed ?? text }) }
      }
      break
    }
    case "TOOL_CALL_RESULT": {
      const id = String(event.toolCallId)
      const meta = rec(rec(event.metadata)?.hummingbird)
      const existing = v.toolCalls.find((c) => c.toolCallId === id)
      v = {
        ...v,
        toolCalls: upsertCall(v.toolCalls, {
          toolCallId: id,
          toolName: existing?.toolName ?? (typeof meta?.toolName === "string" ? meta.toolName : ""),
          ...(existing?.args !== undefined ? { args: existing.args } : {}),
          ...toolResultOf(event),
          status: "done",
        }),
      }
      break
    }
    case "ACTIVITY_SNAPSHOT": {
      const content = rec(event.content)
      switch (event.activityType) {
        case `${HB}plan`:
          if (Array.isArray(content?.items)) v = { ...v, plan: content.items as PlanItem[] }
          break
        case `${HB}verification`: {
          const verification = parseVerificationFrame(content)
          if (verification) v = { ...v, verification }
          break
        }
        case `${HB}artifact_ref`: {
          const id = content?.artifactId
          if (typeof id === "string" && !v.artifactIds.includes(id)) v = { ...v, artifactIds: [...v.artifactIds, id] }
          break
        }
      }
      break
    }
    case "CUSTOM": {
      const value = rec(event.value)
      switch (event.name) {
        case `${HB}step_error`:
          if (typeof value?.message === "string") v = { ...v, lastStepError: value.message }
          break
        case `${HB}interrupt_pending`:
          if (value && typeof value.id === "string") {
            v = { ...v, pendingInput: pendingInputOf(toPendingInterrupt(value as unknown as Interrupt)) }
          }
          break
        case `${HB}interrupt_resolved`:
          v = { ...v, pendingInput: null }
          break
      }
      break
    }
    case "SUBAGENT_STARTED": {
      const id = event.subagentRunId
      if (typeof id === "string" && !v.childRuns.some((c) => c.childTaskId === id)) {
        const subgoal = rec(rec(event.metadata)?.hummingbird)?.subgoal
        v = {
          ...v,
          childRuns: [
            ...v.childRuns,
            {
              childTaskId: id,
              agent: typeof event.name === "string" ? event.name : "",
              subgoal: typeof subgoal === "string" ? subgoal : "",
            },
          ],
        }
      }
      break
    }
    case "MESSAGES_SNAPSHOT":
      v = foldSnapshot(v, event.messages)
      break
    case "RUN_FINISHED": {
      const outcome = rec(event.outcome)
      if (outcome?.type === "interrupt") {
        const first = Array.isArray(outcome.interrupts) ? (outcome.interrupts[0] as Interrupt | undefined) : undefined
        v = {
          ...v,
          status: "paused",
          pendingInput: first ? pendingInputOf(toPendingInterrupt(first)) : v.pendingInput,
        }
      } else if (outcome?.type === "cancelled") {
        v = { ...v, status: "cancelled", pendingInput: null }
      } else {
        const text = rec(event.result)?.text
        v = {
          ...v,
          status: "done",
          pendingInput: null,
          toolCalls: finishRunningCalls(v.toolCalls),
          resultText: typeof text === "string" ? text : v.text,
        }
      }
      break
    }
    case "RUN_ERROR":
      v = {
        ...v,
        status: "failed",
        pendingInput: null,
        fatalError: typeof event.message === "string" && event.message ? event.message : "Run failed",
      }
      break
  }
  acc.view = v
}

/** A `MESSAGES_SNAPSHOT` (this run's output only, § 6.3): its assistant
 *  text and tool calls. The caller has dropped what the run held before. */
function foldSnapshot(view: TaskRunView, messages: unknown): TaskRunView {
  if (!Array.isArray(messages)) return view
  let v = view
  for (const m of messages) {
    const msg = rec(m)
    if (!msg) continue
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") v = { ...v, text: v.text + msg.content }
      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          const call = rec(tc)
          const fn = rec(call?.function)
          if (typeof call?.id !== "string") continue
          const args = typeof fn?.arguments === "string" ? parseJson(fn.arguments) : undefined
          v = {
            ...v,
            toolCalls: upsertCall(v.toolCalls, {
              toolCallId: call.id,
              toolName: typeof fn?.name === "string" ? fn.name : "",
              ...(args !== undefined ? { args } : {}),
              status: "running",
            }),
          }
        }
      }
    } else if (msg.role === "tool" && typeof msg.toolCallId === "string") {
      const existing = v.toolCalls.find((c) => c.toolCallId === msg.toolCallId)
      v = {
        ...v,
        toolCalls: upsertCall(v.toolCalls, {
          toolCallId: msg.toolCallId,
          toolName: existing?.toolName ?? "",
          ...toolResultOf({ type: "TOOL_CALL_RESULT", content: msg.content } as Ev),
          status: "done",
        }),
      }
    }
  }
  return v
}

/** What a rewind leaves of a run's items: everything but the dead
 *  attempt's (`after < seq < the rewind's own seq`, § 6.5). */
function withoutDeadAttempt(items: readonly ChainItem[], after: number, rewindSeq: number): ChainItem[] {
  return items.filter((i) => {
    if (i.cursor === null) return true
    const seq = cursorSeq(i.cursor)
    return seq <= after || seq >= rewindSeq
  })
}

function rewindOf(item: ChainItem): number | null {
  const e = item.event as Ev
  if (e.type !== "CUSTOM" || e.name !== `${HB}rewind`) return null
  const after = rec(e.value)?.after
  const n = typeof after === "number" ? after : typeof after === "string" ? cursorSeq(after) : NaN
  return Number.isFinite(n) ? n : null
}

/** Fold whole logs, oldest run first. A rewind in a log discards the
 *  events of that run it supersedes first. Pure. */
export function foldChain(runs: readonly ChainRunLog[]): TaskRunView {
  const acc = emptyAcc()
  for (const run of runs) {
    for (const item of normaliseLog(run.items)) apply(acc, run.runId, item.event)
  }
  return acc.view
}

/** A run's log with each rewind's dead attempt removed, and everything
 *  before a `MESSAGES_SNAPSHOT` dropped (the snapshot replaces it). */
function normaliseLog(items: readonly ChainItem[]): ChainItem[] {
  let out: ChainItem[] = []
  for (const item of items) {
    const after = rewindOf(item)
    if (after !== null && item.cursor !== null) {
      out = withoutDeadAttempt(out, after, cursorSeq(item.cursor))
    }
    if (item.event.type === "MESSAGES_SNAPSHOT") {
      out = out.filter((i) => i.event.type === "RUN_STARTED")
    }
    out.push(item)
  }
  return out
}

function isImage(value: unknown): value is GeneratedImage {
  const img = rec(value)
  return (
    !!img &&
    typeof img.id === "string" &&
    typeof img.url === "string" &&
    typeof img.width === "number" &&
    typeof img.height === "number" &&
    typeof img.format === "string" &&
    typeof img.prompt === "string" &&
    (img.mode === "t2i" || img.mode === "i2i")
  )
}

/**
 * The images a task generated (`ACTIVITY_SNAPSHOT hummingbird.tool_image`,
 * RUN_EVENTS.md § 3.3), across its runs, once each, as chat stores them on
 * a message (`Message.generatedImages`): a Storage path when the worker
 * uploaded the image, a data URL with `localFilesOnly` (Q71). The URL a
 * model quotes in its text is the provider's temporary one; this is the
 * kept form. A rewound attempt's images are dropped with it. Pure.
 */
export function generatedImagesOf(runs: readonly ChainRunLog[]): GeneratedImage[] {
  const out = new Map<string, GeneratedImage>()
  for (const run of runs) {
    for (const item of normaliseLog(run.items)) {
      const e = item.event as Ev
      if (e.type !== "ACTIVITY_SNAPSHOT" || e.activityType !== `${HB}tool_image`) continue
      const images = rec(e.content)?.images
      if (!Array.isArray(images)) continue
      for (const img of images) {
        if (!isImage(img)) continue
        out.set(img.id, {
          id: img.id,
          url: img.url,
          ...(typeof img.storagePath === "string" ? { storagePath: img.storagePath } : {}),
          width: img.width,
          height: img.height,
          format: img.format,
          prompt: img.prompt,
          mode: img.mode,
        })
      }
    }
  }
  return [...out.values()]
}

/**
 * The incremental fold of one task's chain. `setLine(runIds)` names the
 * runs, oldest first (the root, then each run that answered the one
 * before — a dead branch is never on it); `push(runId, item)` folds one
 * event of one of them. Repeats (a cursor at or before the run's last)
 * are dropped, so re-reading a run from an earlier cursor is harmless.
 */
export class ChainFold {
  private logs_ = new Map<string, ChainItem[]>()
  private line: string[] = []
  private acc: Acc = emptyAcc()
  /** Runs whose closing event has been folded. */
  private closedRuns = new Set<string>()

  get view(): TaskRunView {
    return this.acc.view
  }

  get runIds(): readonly string[] {
    return this.line
  }

  /** Name the chain. A line that only grows keeps the fold; any other
   *  change re-folds from the logs it still names. */
  setLine(runIds: readonly string[]): boolean {
    const same = runIds.length === this.line.length && runIds.every((id, i) => id === this.line[i])
    if (same) return false
    const grows = this.line.every((id, i) => runIds[i] === id)
    this.line = [...runIds]
    for (const id of [...this.logs_.keys()]) if (!this.line.includes(id)) this.logs_.delete(id)
    if (!grows) this.refold()
    return true
  }

  /** The last cursor of a run (where to read it from next), `"0"` before any. */
  cursorOf(runId: string): RunCursor {
    const items = this.logs_.get(runId)
    for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
      const c = items![i].cursor
      if (c !== null) return c
    }
    return START_CURSOR
  }

  /** The logs held, in the line's order (for `generatedImagesOf`). */
  logs(): ChainRunLog[] {
    return this.line.flatMap((runId) => {
      const items = this.logs_.get(runId)
      return items ? [{ runId, items }] : []
    })
  }

  /** The run's closing event has been folded. */
  isClosed(runId: string): boolean {
    return this.closedRuns.has(runId)
  }

  /** Whether any event of the run has been folded. */
  has(runId: string): boolean {
    return (this.logs_.get(runId)?.length ?? 0) > 0
  }

  /** Fold one event; false when it changed nothing (a repeat, or a run
   *  not on the line). */
  push(runId: string, item: ChainItem): boolean {
    if (!this.line.includes(runId)) return false
    const log = this.logs_.get(runId) ?? []
    if (item.cursor !== null) {
      const last = this.cursorOf(runId)
      if (last !== START_CURSOR && compareCursors(item.cursor, last) <= 0) return false
    } else if (item.event.type === "RUN_STARTED" && log.some((i) => i.event.type === "RUN_STARTED")) {
      return false
    } else if (
      (item.event.type === "RUN_FINISHED" || item.event.type === "RUN_ERROR") &&
      this.closedRuns.has(runId)
    ) {
      return false
    }
    log.push(item)
    this.logs_.set(runId, log)
    if (item.event.type === "RUN_FINISHED" || item.event.type === "RUN_ERROR") this.closedRuns.add(runId)
    const newest = this.line.findLast((id) => this.logs_.has(id))
    if (rewindOf(item) !== null || item.event.type === "MESSAGES_SNAPSHOT" || runId !== newest) {
      this.refold()
    } else {
      apply(this.acc, runId, item.event)
    }
    return true
  }

  /** Forget a run's closing event — it was answered in place and goes on
   *  (a sub-agent, § 4.4) — so its stream can be followed again. */
  reopen(runId: string): void {
    const log = this.logs_.get(runId)
    if (!log || !this.closedRuns.has(runId)) return
    this.closedRuns.delete(runId)
    this.logs_.set(
      runId,
      log.filter((i) => i.event.type !== "RUN_FINISHED" && i.event.type !== "RUN_ERROR"),
    )
    this.refold()
  }

  private refold(): void {
    const acc = emptyAcc()
    for (const id of this.line) {
      const log = this.logs_.get(id)
      if (!log) continue
      const normal = normaliseLog(log)
      this.logs_.set(id, normal)
      for (const item of normal) apply(acc, id, item.event)
    }
    this.acc = acc
  }
}

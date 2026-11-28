import "client-only"

/**
 * The AG-UI → store step of chat on runs (Q37): a pure reducer from one
 * run's AG-UI events to the store updates chat makes today.
 *
 * `reduceRunEvent(state, event)` returns the next state and the ops the
 * event produced. The ops speak the vocabulary `use-chat-send` already
 * applies to an assistant placeholder — `NormalisedFrame`s, the envelope
 * `translateFrame` makes of `/v1/chat`'s frames — so wiring runs into chat
 * (wave 4b-A) reuses the existing per-frame handling unchanged:
 *
 * | AG-UI | op |
 * |---|---|
 * | `TEXT_MESSAGE_CONTENT` | `frame` `text` — every text message of the run appends to the one placeholder, no separator (as `/v1/chat`) |
 * | `REASONING_MESSAGE_CONTENT` | `frame` `reasoning` (the sink times it, as today) |
 * | `TOOL_CALL_START/ARGS/END` | `frame` `tool_call` at `END`, args parsed (= `tool-input-available`) |
 * | `TOOL_CALL_RESULT` | `frame` `tool_result` `{summary, results}` (content parsed by the translator); a result whose call this run never started (a resume run answering an interrupt, RUN_EVENTS.md § 4.2) first gets a synthetic `tool_call` |
 * | `ACTIVITY_SNAPSHOT` | `frame` of the matching `data-*` part via `translateDataPart` (content = today's `data`); `plan` / `artifact_ref` have no chat frame and are only kept in the view. A replacement of an already-applied append-only part becomes a `reset` |
 * | `CUSTOM hummingbird.gap` + `MESSAGES_SNAPSHOT` | `reset` — the message's run output is replaced by the snapshot's frames |
 * | `CUSTOM hummingbird.rewind` | `rewind { after }` — a background worker resumed from a checkpoint; the session restarts the stream if it showed events past `after` (interactive runs never rewind) |
 * | `CUSTOM hummingbird.interrupt_pending` | nothing — chat answers interrupts from `RUN_FINISHED`, which carries the same `Interrupt`s; the early notice is for the tasks panel (wave 6) |
 * | `RUN_FINISHED` / `RUN_ERROR` | `finished` with the `RunOutcome` (success + `memoryTainted` / interrupt / cancelled / error) |
 * | everything else (`STEP_*`, `SUBAGENT_*`, other `CUSTOM`s, unknown types) | nothing |
 *
 * The state keeps a compact view of the run's output (`RunTurnView`), so
 * any reset can be expressed as the frames that rebuild it
 * (`framesFromView`) — the invariant the fixture tests check: applying a
 * run's ops in order gives the same message as applying
 * `framesFromView(finalState.view)` once.
 *
 * Pure: no I/O, no clock, no store.
 */

import {
  parseToolOutput,
  translateDataPart,
  type NormalisedFrame,
} from "@/client/chat/sse-frame-translator"
import type { MessageError } from "@/shared/types"

import { messageErrorFor } from "./errors"
import { toPendingInterrupt, type PendingInterrupt } from "./interrupts"
import type { AgUiEvent, AgUiMessage, Interrupt, RunResult } from "./types"

/** How a run ended. */
export type RunOutcome =
  | { type: "success"; result: RunResult; memoryTainted: boolean }
  | { type: "interrupt"; interrupts: PendingInterrupt[] }
  | { type: "cancelled" }
  | { type: "error"; code: string; message: string; error: MessageError }

export type RunTurnOp =
  /** Apply one frame to the placeholder, exactly as a `/v1/chat` frame. */
  | { type: "frame"; frame: NormalisedFrame }
  /** Clear the placeholder's run output (content, reasoning, tool calls,
   *  parts), then apply these frames. */
  | { type: "reset"; frames: NormalisedFrame[] }
  /** The stream rewound (a background worker resumed from a checkpoint,
   *  RUN_EVENTS.md § 6.5): events with a cursor seq above `after` came from
   *  the dead attempt. The session handles it (`session.ts`): if it applied
   *  any, it replays the run from `"0"` and resets the message. */
  | { type: "rewind"; after: number }
  /** The run ended; nothing follows. */
  | { type: "finished"; outcome: RunOutcome }

/** A tool call as the view keeps it. */
export interface RunToolCall {
  id: string
  name: string
  /** Parsed arguments (`undefined` until `TOOL_CALL_END`, or when the
   *  call started in another run). */
  args?: unknown
  /** Set once its result arrived. */
  result?: Pick<NormalisedFrame, "summary" | "results">
}

/** An activity (part) as the view keeps it — the latest content per id. */
export interface RunActivity {
  messageId: string
  activityType: string
  content: unknown
}

/** The run's output so far, compactly — enough to rebuild the message. */
export interface RunTurnView {
  text: string
  reasoning: string
  toolCalls: RunToolCall[]
  activities: RunActivity[]
}

export interface RunTurnState {
  runId: string | null
  threadId: string | null
  view: RunTurnView
  /** Argument deltas of calls between `TOOL_CALL_START` and `END`. */
  openCalls: Record<string, { name: string; args: string }>
  /** Activities already applied as frames, by message id. */
  applied: Record<string, true>
  /** A gap was announced; the next `MESSAGES_SNAPSHOT` is this run's output. */
  awaitingSnapshot: boolean
  outcome: RunOutcome | null
}

/** `activityType` → the `data-*` frame type whose `data` its content is
 *  (RUN_EVENTS.md § 3.3). */
export const ACTIVITY_FRAME_TYPES: Readonly<Record<string, string>> = {
  "hummingbird.tool_image": "data-tool-image",
  "hummingbird.tool_file": "data-tool-file",
  "hummingbird.code_result": "data-code-result",
  "hummingbird.ui_part": "data-ui",
  "hummingbird.mcp_app": "data-mcp-app",
  "hummingbird.verification": "data-verification",
  "hummingbird.suggestions": "data-suggestions",
  "hummingbird.routed_model": "data-routed-model",
}

/** Parts the store *sets* (a later snapshot simply re-applies); every
 *  other part is appended, so replacing one needs a reset. */
const SET_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  "hummingbird.verification",
  "hummingbird.suggestions",
  "hummingbird.routed_model",
])

export const GAP_EVENT = "hummingbird.gap"
export const REWIND_EVENT = "hummingbird.rewind"
/** A question raised mid-run (RUN_EVENTS.md § 3.4); its value is the
 *  AG-UI `Interrupt` the closing `RUN_FINISHED` repeats. */
export const INTERRUPT_PENDING_EVENT = "hummingbird.interrupt_pending"

const EMPTY_VIEW: RunTurnView = { text: "", reasoning: "", toolCalls: [], activities: [] }

export function initialRunTurnState(): RunTurnState {
  return {
    runId: null,
    threadId: null,
    view: EMPTY_VIEW,
    openCalls: {},
    applied: {},
    awaitingSnapshot: false,
    outcome: null,
  }
}

/** Turn-level parts that annotate an answer rather than being one. */
const ANNOTATION_TYPES: ReadonlySet<string> = new Set([
  "hummingbird.routed_model",
  "hummingbird.suggestions",
  "hummingbird.verification",
])

/** Whether the view holds an answer — text, reasoning, a tool call or a
 *  content part (image, file, code result, UI part, MCP app). `false`
 *  for a finished run is chat's "the model returned an empty response". */
export function hasOutput(view: RunTurnView): boolean {
  return (
    view.text !== "" ||
    view.reasoning !== "" ||
    view.toolCalls.length > 0 ||
    view.activities.some(
      (a) => a.activityType in ACTIVITY_FRAME_TYPES && !ANNOTATION_TYPES.has(a.activityType),
    )
  )
}

function parseArgs(raw: string): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function toolCallFrame(call: RunToolCall): NormalisedFrame {
  return { type: "tool_call", id: call.id, name: call.name, args: call.args }
}

function toolResultFrame(id: string, result: RunToolCall["result"]): NormalisedFrame {
  return { type: "tool_result", id, summary: result?.summary, results: result?.results }
}

function activityFrame(activity: RunActivity): NormalisedFrame | null {
  const frameType = ACTIVITY_FRAME_TYPES[activity.activityType]
  return frameType ? translateDataPart(frameType, activity.content) : null
}

/** The frames that rebuild a view from an empty placeholder. */
export function framesFromView(view: RunTurnView): NormalisedFrame[] {
  const frames: NormalisedFrame[] = []
  if (view.reasoning) frames.push({ type: "reasoning", value: view.reasoning })
  if (view.text) frames.push({ type: "text", value: view.text })
  for (const call of view.toolCalls) {
    frames.push(toolCallFrame(call))
    if (call.result) frames.push(toolResultFrame(call.id, call.result))
  }
  for (const activity of view.activities) {
    const frame = activityFrame(activity)
    if (frame) frames.push(frame)
  }
  return frames
}

function upsertActivity(view: RunTurnView, activity: RunActivity): RunTurnView {
  const i = view.activities.findIndex((a) => a.messageId === activity.messageId)
  const activities =
    i === -1
      ? [...view.activities, activity]
      : view.activities.map((a, j) => (j === i ? activity : a))
  return { ...view, activities }
}

function withResult(
  view: RunTurnView,
  id: string,
  name: string,
  result: RunToolCall["result"],
): { view: RunTurnView; known: boolean } {
  const known = view.toolCalls.some((c) => c.id === id)
  const toolCalls = known
    ? view.toolCalls.map((c) => (c.id === id ? { ...c, result } : c))
    : [...view.toolCalls, { id, name, result }]
  return { view: { ...view, toolCalls }, known }
}

function hummingbirdMeta(value: unknown): Record<string, unknown> {
  const meta = (value as { hummingbird?: unknown } | null | undefined)?.hummingbird
  return meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}
}

/**
 * The view of AG-UI messages — a `MESSAGES_SNAPSHOT` after a `gap`, which
 * holds this run's output only (RUN_EVENTS.md § 6.3) — or the messages
 * `@ag-ui/client`'s apply pipeline accumulated for a run. Assistant texts
 * concatenate, reasoning messages too; tool calls come from assistant
 * `toolCalls`, their results from tool messages; activities in order.
 * User / system messages are not run output and are skipped.
 */
export function viewFromMessages(messages: readonly AgUiMessage[]): RunTurnView {
  let view: RunTurnView = { text: "", reasoning: "", toolCalls: [], activities: [] }
  for (const m of messages) {
    if (m.role === "assistant") {
      if (typeof m.content === "string") view = { ...view, text: view.text + m.content }
      for (const tc of m.toolCalls ?? []) {
        if (view.toolCalls.some((c) => c.id === tc.id)) continue
        view = {
          ...view,
          toolCalls: [
            ...view.toolCalls,
            { id: tc.id, name: tc.function.name, args: parseArgs(tc.function.arguments) },
          ],
        }
      }
    } else if (m.role === "reasoning") {
      view = { ...view, reasoning: view.reasoning + m.content }
    } else if (m.role === "tool") {
      const toolName = hummingbirdMeta((m as { metadata?: unknown }).metadata).toolName
      const parsed = parseToolOutput(m.content, m.error)
      view = withResult(view, m.toolCallId, typeof toolName === "string" ? toolName : "tool", parsed)
        .view
    } else if (m.role === "activity") {
      view = upsertActivity(view, {
        messageId: m.id,
        activityType: m.activityType,
        content: m.content,
      })
    }
  }
  return view
}

function outcomeOf(event: AgUiEvent): RunOutcome | null {
  if (event.type === "RUN_ERROR") {
    const e = event as { code?: unknown; message?: unknown }
    const code = typeof e.code === "string" && e.code ? e.code : "unknown"
    const message = typeof e.message === "string" ? e.message : "Run failed."
    return { type: "error", code, message, error: messageErrorFor(code, { detail: message }) }
  }
  if (event.type !== "RUN_FINISHED") return null
  const e = event as { outcome?: { type?: unknown; interrupts?: unknown }; result?: unknown }
  const type = e.outcome?.type ?? "success"
  if (type === "interrupt") {
    const raw = Array.isArray(e.outcome?.interrupts) ? (e.outcome.interrupts as Interrupt[]) : []
    return { type: "interrupt", interrupts: raw.map(toPendingInterrupt) }
  }
  if (type === "cancelled") return { type: "cancelled" }
  const result =
    e.result && typeof e.result === "object" && !Array.isArray(e.result)
      ? (e.result as RunResult)
      : {}
  return { type: "success", result, memoryTainted: result.memoryTainted === true }
}

type Step = { state: RunTurnState; ops: RunTurnOp[] }

function frame(f: NormalisedFrame): RunTurnOp {
  return { type: "frame", frame: f }
}

/**
 * Fold one AG-UI event into the run's state. Events after the run ended
 * are ignored. Unknown event types and `CUSTOM` names are ignored (Q22:
 * clients ignore what they don't know).
 */
export function reduceRunEvent(state: RunTurnState, event: AgUiEvent): Step {
  if (state.outcome) return { state, ops: [] }
  const e = event as unknown as Record<string, unknown>
  switch (event.type) {
    case "RUN_STARTED":
      return {
        state: {
          ...state,
          runId: typeof e.runId === "string" ? e.runId : state.runId,
          threadId: typeof e.threadId === "string" ? e.threadId : state.threadId,
        },
        ops: [],
      }

    case "TEXT_MESSAGE_CONTENT": {
      const delta = typeof e.delta === "string" ? e.delta : ""
      if (!delta) return { state, ops: [] }
      return {
        state: { ...state, view: { ...state.view, text: state.view.text + delta } },
        ops: [frame({ type: "text", value: delta })],
      }
    }

    case "REASONING_MESSAGE_CONTENT": {
      const delta = typeof e.delta === "string" ? e.delta : ""
      if (!delta) return { state, ops: [] }
      return {
        state: { ...state, view: { ...state.view, reasoning: state.view.reasoning + delta } },
        ops: [frame({ type: "reasoning", value: delta })],
      }
    }

    case "TOOL_CALL_START": {
      const id = e.toolCallId as string
      const name = typeof e.toolCallName === "string" ? e.toolCallName : "tool"
      return { state: { ...state, openCalls: { ...state.openCalls, [id]: { name, args: "" } } }, ops: [] }
    }

    case "TOOL_CALL_ARGS": {
      const id = e.toolCallId as string
      const open = state.openCalls[id]
      if (!open) return { state, ops: [] }
      const delta = typeof e.delta === "string" ? e.delta : ""
      return {
        state: { ...state, openCalls: { ...state.openCalls, [id]: { ...open, args: open.args + delta } } },
        ops: [],
      }
    }

    case "TOOL_CALL_END": {
      const id = e.toolCallId as string
      const open = state.openCalls[id]
      if (!open) return { state, ops: [] }
      const openCalls = { ...state.openCalls }
      delete openCalls[id]
      if (state.view.toolCalls.some((c) => c.id === id)) return { state: { ...state, openCalls }, ops: [] }
      const call: RunToolCall = { id, name: open.name, args: parseArgs(open.args) }
      return {
        state: { ...state, openCalls, view: { ...state.view, toolCalls: [...state.view.toolCalls, call] } },
        ops: [frame(toolCallFrame(call))],
      }
    }

    case "TOOL_CALL_RESULT": {
      const id = e.toolCallId as string
      const meta = hummingbirdMeta(e.metadata)
      const name =
        state.openCalls[id]?.name ??
        (typeof meta.toolName === "string" ? meta.toolName : "tool")
      const result = parseToolOutput(e.content)
      const { view, known } = withResult(state.view, id, name, result)
      const ops: RunTurnOp[] = []
      if (!known) ops.push(frame({ type: "tool_call", id, name }))
      ops.push(frame(toolResultFrame(id, result)))
      return { state: { ...state, view }, ops }
    }

    case "ACTIVITY_SNAPSHOT": {
      const messageId = e.messageId as string
      const activity: RunActivity = {
        messageId,
        activityType: typeof e.activityType === "string" ? e.activityType : "",
        content: e.content,
      }
      const view = upsertActivity(state.view, activity)
      const f = activityFrame(activity)
      if (!f) return { state: { ...state, view }, ops: [] }
      if (!state.applied[messageId] || SET_ACTIVITY_TYPES.has(activity.activityType)) {
        return {
          state: { ...state, view, applied: { ...state.applied, [messageId]: true } },
          ops: [frame(f)],
        }
      }
      // An appended part changed: rebuild the message from the view.
      return { state: { ...state, view }, ops: [{ type: "reset", frames: framesFromView(view) }] }
    }

    case "CUSTOM": {
      if (e.name === GAP_EVENT) return { state: { ...state, awaitingSnapshot: true }, ops: [] }
      if (e.name === REWIND_EVENT) {
        const after = (e.value as { after?: unknown } | null)?.after
        return { state, ops: [{ type: "rewind", after: typeof after === "number" ? after : 0 }] }
      }
      // INTERRUPT_PENDING_EVENT: deliberately nothing — the interrupt is
      // taken from RUN_FINISHED, so the turn's outcome has one source.
      return { state, ops: [] }
    }

    case "MESSAGES_SNAPSHOT": {
      // Only ever sent right after a gap (§ 6.3); a stray one is not this
      // run's output, so it is ignored rather than wiping the message.
      if (!state.awaitingSnapshot) return { state, ops: [] }
      const messages = Array.isArray(e.messages) ? (e.messages as AgUiMessage[]) : []
      const view = viewFromMessages(messages)
      const applied: Record<string, true> = {}
      for (const a of view.activities) if (activityFrame(a)) applied[a.messageId] = true
      return {
        state: { ...state, view, applied, openCalls: {}, awaitingSnapshot: false },
        ops: [{ type: "reset", frames: framesFromView(view) }],
      }
    }

    case "RUN_FINISHED":
    case "RUN_ERROR": {
      const outcome = outcomeOf(event)
      if (!outcome) return { state, ops: [] }
      return { state: { ...state, outcome }, ops: [{ type: "finished", outcome }] }
    }

    default:
      return { state, ops: [] }
  }
}

/** Fold a whole event sequence (tests, replays). */
export function reduceRunEvents(
  events: Iterable<AgUiEvent>,
  state: RunTurnState = initialRunTurnState(),
): Step {
  const ops: RunTurnOp[] = []
  let s = state
  for (const event of events) {
    const step = reduceRunEvent(s, event)
    s = step.state
    ops.push(...step.ops)
  }
  return { state: s, ops }
}

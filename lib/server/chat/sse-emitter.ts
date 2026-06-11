import "server-only"

/**
 * SSE emitter for the chat route — emits the AI SDK v5 UI message
 * stream protocol natively.
 *
 * Frames: `start` / `start-step` / `text-start` / `text-delta` /
 * `text-end` / `reasoning-start` / `reasoning-delta` /
 * `reasoning-end` / `tool-input-available` / `tool-output-available`
 * / `data-tool-image` / `data-suggestions` / `finish-step` /
 * `finish` / `[DONE]` terminator.
 *
 * The emitter hides the wire shape behind logical methods: callers
 * call `.text(delta)` / `.toolCall(id, name, args)` / etc. and the
 * emitter does the lifecycle bookkeeping (lazy `text-start`,
 * channel switches close the previous block so `useChat()` sees
 * matched start/end pairs).
 *
 * The legacy custom wire format (`{type:"text",value}` etc.) was
 * retired in B.3 of `docs/PLAN-useChat-adoption.md`. Mirrored in
 * `services/agent-ts/src/chat.ts` and
 * `services/agent-py/src/agent_py/chat.py`.
 */

import { randomUUID } from "node:crypto"

/** Header the AI SDK uses to advertise its UI-message-stream
 *  protocol version. Setting it on the response lets `useChat()`
 *  confirm the wire without sniffing the body. */
export const AI_SDK_STREAM_HEADER_NAME = "x-vercel-ai-ui-message-stream"
export const AI_SDK_STREAM_HEADER_VALUE = "v1"

export interface ToolImagePayload {
  id: string
  mode: "t2i" | "i2i"
  images: Array<{
    id: string
    url: string
    storagePath?: string
    width: number
    height: number
    format: string
    prompt: string
    mode: "t2i" | "i2i"
  }>
}

export interface ToolResultPayload {
  id: string
  name: string
  summary: string
  results?: Array<{ title: string; url: string; snippet: string }>
}

/** Per-request SSE emitter. Construct with a `writeLine` function
 *  that writes one already-formatted SSE frame
 *  (`data: <payload>\n\n`). Call `start()` exactly once at the top
 *  and `done()` / `endAfterError()` exactly once at the bottom;
 *  other methods are open-ended. */
export class ChatSseEmitter {
  private readonly writeLine: (line: string) => void

  private activeTextId: string | null = null
  private activeReasoningId: string | null = null

  constructor(writeLine: (line: string) => void) {
    this.writeLine = writeLine
  }

  /** Emit one JSON-shaped SSE frame. Internal — most callers go
   *  through the typed methods. */
  private send(payload: unknown): void {
    this.writeLine(`data: ${JSON.stringify(payload)}\n\n`)
  }

  /** Emit the literal `data: [DONE]\n\n` terminator. */
  private sendDoneTerminator(): void {
    this.writeLine("data: [DONE]\n\n")
  }

  /** Lifecycle prelude. Emits `start` and `start-step`. */
  start(): void {
    this.send({ type: "start" })
    this.send({ type: "start-step" })
  }

  text(delta: string): void {
    if (!delta) return
    this.closeReasoning()
    if (this.activeTextId === null) {
      this.activeTextId = randomUUID().replace(/-/g, "")
      this.send({ type: "text-start", id: this.activeTextId })
    }
    this.send({ type: "text-delta", id: this.activeTextId, delta })
  }

  reasoning(delta: string): void {
    if (!delta) return
    this.closeText()
    if (this.activeReasoningId === null) {
      this.activeReasoningId = randomUUID().replace(/-/g, "")
      this.send({ type: "reasoning-start", id: this.activeReasoningId })
    }
    this.send({
      type: "reasoning-delta",
      id: this.activeReasoningId,
      delta,
    })
  }

  toolCall(id: string, name: string, args: unknown): void {
    this.closeAllChannels()
    this.send({
      type: "tool-input-available",
      toolCallId: id,
      toolName: name,
      input: args ?? {},
    })
  }

  toolResult(payload: ToolResultPayload, isError = false): void {
    this.send({
      type: "tool-output-available",
      toolCallId: payload.id,
      // The AI SDK consumer reads the full output object via
      // `onData` / `message.parts[].output`; we stringify so the
      // wire shape matches what `JsonToSseTransformStream` expects.
      output: JSON.stringify({
        summary: payload.summary,
        ...(payload.results ? { results: payload.results } : {}),
      }),
      ...(isError ? { errorText: payload.summary } : {}),
    })
  }

  /** Emit a generated-image frame as a `data-tool-image` AI SDK v5
   *  custom data part. Parity with
   *  `services/agent-ts/src/image-persistence.ts`'s shape. */
  toolImage(payload: ToolImagePayload): void {
    this.send({
      type: "data-tool-image",
      id: payload.id,
      data: {
        id: payload.id,
        mode: payload.mode,
        images: payload.images,
      },
    })
  }

  /** Follow-up suggestion chips as a `data-suggestions` custom data
   *  part. */
  suggestions(values: string[]): void {
    if (values.length === 0) return
    this.send({
      type: "data-suggestions",
      data: { values },
    })
  }

  /** Generative-UI part — emits a `data-ui` AI SDK v5 custom data
   *  part carrying a validated `{ kind, props }` pair the model
   *  produced via the `renderUI` tool. The client's translator maps
   *  this to `{ type: "ui_part", ... }`; the send-pipeline appends
   *  it to `Message.uiParts` on the in-flight assistant message.
   *  See `docs/PLAN-generative-ui-parts.md`. */
  uiPart(payload: { id: string; kind: string; props: unknown }): void {
    this.send({
      type: "data-ui",
      id: payload.id,
      data: {
        id: payload.id,
        kind: payload.kind,
        props: payload.props,
      },
    })
  }

  /** Smart-routing transparency — emits a `data-routed-model` AI SDK v5
   *  custom data part carrying the concrete model the `auto` option
   *  resolved to for this turn. The client maps it to
   *  `{ type: "routed_model", value }` and stamps it onto
   *  `Message.routedModel` for the "routed to X" caption. See
   *  `docs/PLAN-model-routing.md`. */
  routedModel(modelId: string): void {
    this.send({
      type: "data-routed-model",
      data: { model: modelId },
    })
  }

  /** MCP App — emits a `data-mcp-app` AI SDK v5 custom data part
   *  carrying bundled HTML read from an MCP tool's `ui://` resource. The
   *  client maps it to `{ type: "mcp_app", ... }` and appends it to
   *  `Message.mcpApps`, rendering it in a sandboxed iframe. Read-only in
   *  phase 1 (no tool-call bridge). See `docs/PLAN-mcp-apps.md`. */
  mcpApp(payload: { id: string; serverId: string; html: string }): void {
    this.send({
      type: "data-mcp-app",
      id: payload.id,
      data: {
        id: payload.id,
        serverId: payload.serverId,
        html: payload.html,
      },
    })
  }

  error(code: string, message: string): void {
    this.closeAllChannels()
    // AI SDK error frames carry the human-readable text on
    // `errorText`; we keep the code in the same payload for
    // backend log correlation but consumers read `errorText`.
    this.send({ type: "error", errorText: message, code })
  }

  /** Lifecycle terminator for a successful stream. Closes any open
   *  channel, emits `finish-step` + `finish` + `[DONE]`. */
  done(): void {
    this.closeAllChannels()
    this.send({ type: "finish-step" })
    this.send({ type: "finish" })
    this.sendDoneTerminator()
  }

  /** Same as `done()` but skips the `finish` frame so the consumer
   *  can distinguish "completed with error" from "completed
   *  normally". Mirrors the agent-py / agent-ts error paths. */
  endAfterError(): void {
    this.closeAllChannels()
    this.sendDoneTerminator()
  }

  private closeText(): void {
    if (this.activeTextId === null) return
    this.send({ type: "text-end", id: this.activeTextId })
    this.activeTextId = null
  }

  private closeReasoning(): void {
    if (this.activeReasoningId === null) return
    this.send({ type: "reasoning-end", id: this.activeReasoningId })
    this.activeReasoningId = null
  }

  private closeAllChannels(): void {
    this.closeText()
    this.closeReasoning()
  }
}

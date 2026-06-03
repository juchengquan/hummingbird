import "server-only"

/**
 * Format-aware SSE emitter for the chat route.
 *
 * Two wire shapes share the same logical events:
 *   - `custom` — `{type: "text"|"reasoning"|"tool_call"|"tool_result"
 *     |"tool_image"|"suggestions"|"error"|"done", ...}`. The current
 *     chat panel consumer (`use-chat-send.ts`) reads this.
 *   - `ai-sdk` — the AI SDK v5 UI message stream: `start` /
 *     `start-step` / `text-start` / `text-delta` / `text-end` /
 *     `reasoning-start` / `reasoning-delta` / `reasoning-end` /
 *     `tool-input-available` / `tool-output-available` / `finish-step`
 *     / `finish` / `[DONE]` terminator, with our custom extras riding
 *     on `data-tool-image` and `data-suggestions` parts.
 *
 * The emitter hides the wire shape behind logical methods: callers
 * call `.text(delta)` / `.toolCall(id, name, args)` / etc. and the
 * emitter does the lifecycle bookkeeping (lazy `text-start` /
 * channel switches close the previous block) for the AI SDK path.
 *
 * Phase B.1c + B.1d of `docs/PLAN-useChat-adoption.md`. Companion
 * to the parallel implementations in `services/agent-ts/src/chat.ts`
 * and `services/agent-py/src/agent_py/chat.py`.
 */

import { randomUUID } from "node:crypto"

export type ChatFormat = "custom" | "ai-sdk"

/** Header the AI SDK uses to advertise its UI-message-stream
 *  protocol version. Setting it on responses that emit the AI SDK
 *  format lets `useChat()` confirm the wire without sniffing. */
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
 *  (`data: <payload>\n\n`). Call `start()` / `done()` / `error()`
 *  exactly once each; other methods are open-ended. */
export class ChatSseEmitter {
  private readonly writeLine: (line: string) => void
  readonly format: ChatFormat

  private activeTextId: string | null = null
  private activeReasoningId: string | null = null

  constructor(writeLine: (line: string) => void, format: ChatFormat) {
    this.writeLine = writeLine
    this.format = format
  }

  /** Emit one JSON-shaped SSE frame. Internal — most callers go
   *  through the typed methods. */
  private send(payload: unknown): void {
    this.writeLine(`data: ${JSON.stringify(payload)}\n\n`)
  }

  /** Emit the literal AI-SDK `data: [DONE]\n\n` terminator. The
   *  string is intentionally not JSON-quoted. */
  private sendDoneTerminator(): void {
    this.writeLine("data: [DONE]\n\n")
  }

  /** AI-SDK lifecycle prelude. Custom format emits nothing. */
  start(): void {
    if (this.format === "ai-sdk") {
      this.send({ type: "start" })
      this.send({ type: "start-step" })
    }
  }

  text(delta: string): void {
    if (!delta) return
    if (this.format === "custom") {
      this.send({ type: "text", value: delta })
      return
    }
    this.closeReasoning()
    if (this.activeTextId === null) {
      this.activeTextId = randomUUID().replace(/-/g, "")
      this.send({ type: "text-start", id: this.activeTextId })
    }
    this.send({ type: "text-delta", id: this.activeTextId, delta })
  }

  reasoning(delta: string): void {
    if (!delta) return
    if (this.format === "custom") {
      this.send({ type: "reasoning", value: delta })
      return
    }
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
    if (this.format === "custom") {
      this.send({ type: "tool_call", id, name, args: args ?? {} })
      return
    }
    this.closeAllChannels()
    this.send({
      type: "tool-input-available",
      toolCallId: id,
      toolName: name,
      input: args ?? {},
    })
  }

  toolResult(payload: ToolResultPayload, isError = false): void {
    if (this.format === "custom") {
      this.send({
        type: "tool_result",
        id: payload.id,
        name: payload.name,
        summary: payload.summary,
        ...(payload.results ? { results: payload.results } : {}),
        ...(isError ? { isError: true } : {}),
      })
      return
    }
    this.send({
      type: "tool-output-available",
      toolCallId: payload.id,
      // The AI SDK consumer reads the full output object via
      // `onData` / `message.parts[].output`; we stringify so the wire
      // shape matches what `JsonToSseTransformStream` expects.
      output: JSON.stringify({
        summary: payload.summary,
        ...(payload.results ? { results: payload.results } : {}),
      }),
      ...(isError ? { errorText: payload.summary } : {}),
    })
  }

  /** Emit a generated-image frame. Custom format uses `tool_image`;
   *  AI SDK rides on a custom `data-tool-image` part (parity with
   *  `services/agent-ts/src/image-persistence.ts`'s shape). */
  toolImage(payload: ToolImagePayload): void {
    if (this.format === "custom") {
      this.send({
        type: "tool_image",
        id: payload.id,
        mode: payload.mode,
        images: payload.images,
      })
      return
    }
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

  /** Follow-up suggestion chips. Custom format uses `suggestions`;
   *  AI SDK uses a `data-suggestions` custom data part — B.1d. */
  suggestions(values: string[]): void {
    if (values.length === 0) return
    if (this.format === "custom") {
      this.send({ type: "suggestions", values })
      return
    }
    this.send({
      type: "data-suggestions",
      data: { values },
    })
  }

  error(code: string, message: string): void {
    if (this.format === "custom") {
      this.send({ type: "error", code, message })
      return
    }
    this.closeAllChannels()
    this.send({ type: "error", errorText: message })
  }

  /** Lifecycle terminator. Must be called once at the end of a
   *  successful stream. After an `error()`, the route should still
   *  call this — for AI SDK it writes `[DONE]` so the consumer's
   *  finally-block fires; for custom it's the `done` frame. */
  done(): void {
    if (this.format === "custom") {
      this.send({ type: "done" })
      return
    }
    this.closeAllChannels()
    this.send({ type: "finish-step" })
    this.send({ type: "finish" })
    this.sendDoneTerminator()
  }

  /** Same as `done()` but skips the AI SDK `finish` frame so the
   *  consumer can distinguish "completed with error" from
   *  "completed normally". Mirrors the agent-py / agent-ts error
   *  paths. */
  endAfterError(): void {
    if (this.format === "custom") return
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

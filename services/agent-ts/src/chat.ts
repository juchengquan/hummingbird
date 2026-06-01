/**
 * Chat-turn streaming — port of
 * `services/agent-py/src/agent_py/chat.py`.
 *
 * Drives the AI SDK's `streamText({ model: anthropic(...), messages, tools })`
 * and re-emits the deltas as SSE in either the **custom** wire
 * format (matches the existing TS chat consumer) or the **AI SDK v5
 * UI message stream** format (matches what `@ai-sdk/react`'s
 * `useChat()` consumes natively).
 *
 * Phase 3 shipped text-only; this version adds tools (follow-up #2
 * in `PLAN-agent-ts-followups.md`). When `config.tools` is non-empty
 * we lean on the AI SDK's built-in agent loop (`stopWhen: stepCountIs(N)`)
 * — the SDK handles the call → execute → continue cycle and emits
 * `tool-call` / `tool-result` parts on `fullStream`. We re-emit
 * those as our custom-format `tool_call` / `tool_result` frames or
 * the AI SDK's `tool-input-available` / `tool-output-available`
 * frames, mirroring agent-py byte-for-byte.
 *
 * Custom format frames:
 *     data: {"type":"text","value":"<delta>"}\n\n
 *     data: {"type":"tool_call","id":<id>,"name":<name>,"args":<obj>}\n\n
 *     data: {"type":"tool_result","id":<id>,"name":<name>,"summary":<str>,"isError":<bool>}\n\n
 *     data: {"type":"tool_image","id":<id>,"mode":"t2i|i2i","images":[...]}\n\n
 *     data: {"type":"error","code":"upstream","message":"..."}\n\n
 *     data: {"type":"done"}\n\n
 *
 * AI SDK format frames (matches `JsonToSseTransformStream` in
 * the `ai` package): start / start-step / text-start / text-delta /
 * text-end / tool-input-available / tool-output-available /
 * finish-step / finish / `[DONE]`.
 */

import { anthropic, createAnthropic } from "@ai-sdk/anthropic"
import type { LanguageModel } from "ai"
import { stepCountIs, streamText } from "ai"

/** `streamText`'s `tools` field type — the same indirection
 *  `app/api/chat/route.ts` uses to avoid the deep `ToolSet`
 *  generic blowing up `tsc`'s instantiation depth budget. */
export type StreamTextTools = NonNullable<Parameters<typeof streamText>[0]["tools"]>

import { getEnv } from "./env"

export type ChatFormat = "custom" | "ai-sdk"

/** The HTTP response header the AI SDK uses to advertise its
 *  stream protocol version. Mirroring it lets `useChat()` consumers
 *  identify the stream without sniffing the body. */
export const AI_SDK_STREAM_HEADER_NAME = "x-vercel-ai-ui-message-stream"
export const AI_SDK_STREAM_HEADER_VALUE = "v1"

export const DEFAULT_MAX_TOKENS = 4096
/** Same default as agent-py's `DEFAULT_MAX_STEPS`. Six iterations
 *  is plenty for the multi-tool patterns we've seen in practice
 *  without leaving the model an infinite leash on a misbehaving
 *  prompt. */
export const DEFAULT_MAX_STEPS = 6

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

export interface ChatConfig {
  model: string
  messages: ChatMessage[]
  system?: string
  maxTokens?: number
  /** AI SDK toolset — keys are model-visible tool names. Empty /
   *  undefined falls back to the text-only path. */
  tools?: StreamTextTools
  /** Bound by `stopWhen: stepCountIs(N)`. Defaults to
   *  `DEFAULT_MAX_STEPS`. Only meaningful when `tools` is set. */
  maxSteps?: number
}

/** Build the Anthropic LanguageModel handle, applying
 *  `ANTHROPIC_BASE_URL` override when set. Returns null when no API
 *  key is configured — the route surfaces a fast-fail 503 in that
 *  case. */
export function resolveAnthropicModel(modelId: string): LanguageModel | null {
  const env = getEnv()
  if (!env.ANTHROPIC_API_KEY) return null
  if (env.ANTHROPIC_BASE_URL) {
    const custom = createAnthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      baseURL: env.ANTHROPIC_BASE_URL,
    })
    return custom(modelId)
  }
  return anthropic(modelId)
}

/** Format one JSON payload as an SSE `data: <json>\n\n` frame.
 *  Compact JSON (no whitespace) keeps per-token wire overhead minimal. */
export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** Optional per-frame interceptor — invoked once per emitted SSE
 *  frame BEFORE it's yielded. The route uses this to fire a
 *  `tool_image` frame after a `generateImage` tool result (Minimax
 *  URL persistence, follow-up #5). Returning frames are concatenated
 *  to the output stream after the original frame. */
export type FrameInterceptor = (frame: ToolResultFrame) => AsyncIterable<string>

/** Subset of the custom-format `tool_result` frame, surfaced to
 *  interceptors. The route uses this for the `generateImage` →
 *  `tool_image` persistence handoff. */
export interface ToolResultFrame {
  type: "tool_result"
  id: string
  name: string
  output: unknown
}

/** Drive the AI SDK stream and yield SSE frames in the **custom**
 *  format. Mirrors agent-py's `chat_stream` + `chat_stream_with_tools`
 *  (same loop, single entry point). */
export async function* chatStream(
  model: LanguageModel,
  config: ChatConfig,
  options: { onToolResult?: FrameInterceptor } = {},
): AsyncGenerator<string> {
  const hasTools = config.tools && Object.keys(config.tools).length > 0
  const stream = streamText({
    model,
    system: config.system,
    messages: config.messages.map((m) => ({ role: m.role, content: m.content })),
    maxOutputTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(hasTools
      ? {
          tools: config.tools,
          stopWhen: stepCountIs(config.maxSteps ?? DEFAULT_MAX_STEPS),
        }
      : {}),
  })

  try {
    for await (const part of stream.fullStream) {
      if (part.type === "text-delta" && part.text) {
        yield sseFrame({ type: "text", value: part.text })
      } else if (part.type === "tool-call") {
        const p = part as {
          toolCallId?: string
          toolName?: string
          input?: unknown
        }
        yield sseFrame({
          type: "tool_call",
          id: p.toolCallId ?? "",
          name: p.toolName ?? "",
          args: p.input ?? {},
        })
      } else if (part.type === "tool-result") {
        const p = part as {
          toolCallId?: string
          toolName?: string
          output?: unknown
        }
        const id = p.toolCallId ?? ""
        const name = p.toolName ?? ""
        const output = p.output
        const summary = summariseToolOutput(output)
        const isError = isToolError(output)
        yield sseFrame({
          type: "tool_result",
          id,
          name,
          summary,
          ...(isError ? { isError: true } : {}),
        })
        if (options.onToolResult) {
          for await (const extra of options.onToolResult({
            type: "tool_result",
            id,
            name,
            output,
          })) {
            yield extra
          }
        }
      } else if (part.type === "error") {
        yield sseFrame({
          type: "error",
          code: "upstream",
          message:
            part.error instanceof Error ? part.error.message : String(part.error),
        })
        return
      }
    }
  } catch (err) {
    yield sseFrame({
      type: "error",
      code: "upstream",
      message: err instanceof Error ? err.message : String(err),
    })
    return
  }
  yield sseFrame({ type: "done" })
}

/** Drive the AI SDK stream and yield SSE frames in the **AI SDK v5
 *  UI message stream** format. Mirrors agent-py's `chat_stream_ai_sdk`
 *  + `chat_stream_with_tools_ai_sdk` (same loop, single entry point). */
export async function* chatStreamAiSdk(
  model: LanguageModel,
  config: ChatConfig,
  options: { onToolResult?: FrameInterceptor } = {},
): AsyncGenerator<string> {
  const hasTools = config.tools && Object.keys(config.tools).length > 0

  yield sseFrame({ type: "start" })
  yield sseFrame({ type: "start-step" })

  const stream = streamText({
    model,
    system: config.system,
    messages: config.messages.map((m) => ({ role: m.role, content: m.content })),
    maxOutputTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(hasTools
      ? {
          tools: config.tools,
          stopWhen: stepCountIs(config.maxSteps ?? DEFAULT_MAX_STEPS),
        }
      : {}),
  })

  // Track the active text block id so we can close it cleanly when
  // a step boundary or tool call lands.
  let activeTextId: string | null = null
  const openText = (): string => {
    if (activeTextId) return activeTextId
    const id = crypto.randomUUID().replace(/-/g, "")
    activeTextId = id
    return id
  }
  const closeText = (): string[] => {
    if (!activeTextId) return []
    const out = [sseFrame({ type: "text-end", id: activeTextId })]
    activeTextId = null
    return out
  }

  try {
    for await (const part of stream.fullStream) {
      if (part.type === "text-delta" && part.text) {
        if (!activeTextId) {
          const id = openText()
          yield sseFrame({ type: "text-start", id })
        }
        yield sseFrame({ type: "text-delta", id: activeTextId!, delta: part.text })
      } else if (part.type === "tool-call") {
        for (const f of closeText()) yield f
        const p = part as {
          toolCallId?: string
          toolName?: string
          input?: unknown
        }
        yield sseFrame({
          type: "tool-input-available",
          toolCallId: p.toolCallId ?? "",
          toolName: p.toolName ?? "",
          input: p.input ?? {},
        })
      } else if (part.type === "tool-result") {
        const p = part as {
          toolCallId?: string
          toolName?: string
          output?: unknown
        }
        const id = p.toolCallId ?? ""
        const name = p.toolName ?? ""
        const output = p.output
        const isError = isToolError(output)
        yield sseFrame({
          type: "tool-output-available",
          toolCallId: id,
          output: stringifyToolOutput(output),
          ...(isError ? { errorText: summariseToolOutput(output) } : {}),
        })
        if (options.onToolResult) {
          for await (const extra of options.onToolResult({
            type: "tool_result",
            id,
            name,
            output,
          })) {
            yield extra
          }
        }
      } else if (part.type === "error") {
        for (const f of closeText()) yield f
        yield sseFrame({
          type: "error",
          errorText:
            part.error instanceof Error ? part.error.message : String(part.error),
        })
        yield "data: [DONE]\n\n"
        return
      }
    }
  } catch (err) {
    for (const f of closeText()) yield f
    yield sseFrame({
      type: "error",
      errorText: err instanceof Error ? err.message : String(err),
    })
    yield "data: [DONE]\n\n"
    return
  }

  for (const f of closeText()) yield f
  yield sseFrame({ type: "finish-step" })
  yield sseFrame({ type: "finish" })
  yield "data: [DONE]\n\n"
}

/** Produce a short human-readable summary string for a tool's output.
 *  Mirrors the shape `app/api/chat/route.ts` uses so the consumer sees
 *  the same `summary` field regardless of backend.
 *
 *  - `{ error: "..." }`           → the error text
 *  - `{ results: [...] }`         → "N results"  (webSearch shape)
 *  - `{ fragments: [...] }`       → "N excerpts" (searchFiles shape)
 *  - `{ images: [...] }`          → "N images"   (generateImage shape)
 *  - default                       → "done" */
export function summariseToolOutput(output: unknown): string {
  if (!output || typeof output !== "object") return "done"
  const o = output as {
    error?: unknown
    results?: unknown
    fragments?: unknown
    images?: unknown
    ok?: unknown
  }
  if (typeof o.error === "string" && o.error.length > 0) return o.error
  if (Array.isArray(o.results)) {
    const n = o.results.length
    return `${n} result${n === 1 ? "" : "s"}`
  }
  if (Array.isArray(o.fragments)) {
    const n = o.fragments.length
    return `${n} excerpt${n === 1 ? "" : "s"}`
  }
  if (Array.isArray(o.images)) {
    const n = o.images.length
    return `${n} image${n === 1 ? "" : "s"}`
  }
  return "done"
}

/** Tool result is an error when it has `ok: false` or a non-empty
 *  `error` string. Mirrors the `ImageGenResult` / `SearchFilesResult`
 *  shapes the existing skills return. */
export function isToolError(output: unknown): boolean {
  if (!output || typeof output !== "object") return false
  const o = output as { ok?: unknown; error?: unknown }
  if (o.ok === false) return true
  if (typeof o.error === "string" && o.error.length > 0) return true
  return false
}

/** Compact JSON serialization for tool output that travels in the
 *  AI SDK v5 `tool-output-available` `output` field. Strings pass
 *  through unchanged; everything else gets `JSON.stringify`'d. */
export function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

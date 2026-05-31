/**
 * Chat-turn streaming — port of
 * `services/agent-py/src/agent_py/chat.py` (Phase 4-1 text-only
 * slice).
 *
 * Drives the AI SDK's `streamText({ model: anthropic(...), messages })`
 * and re-emits the deltas as SSE in either the **custom** wire
 * format (matches the existing TS chat consumer) or the **AI SDK v5
 * UI message stream** format (matches what `@ai-sdk/react`'s
 * `useChat()` consumes natively).
 *
 * Custom format frames:
 *     data: {"type":"text","value":"<delta>"}\n\n
 *     data: {"type":"error","code":"upstream","message":"..."}\n\n
 *     data: {"type":"done"}\n\n
 *
 * AI SDK format frames (matches `JsonToSseTransformStream` in
 * the `ai` package):
 *     data: {"type":"start"}\n\n
 *     data: {"type":"start-step"}\n\n
 *     data: {"type":"text-start","id":"..."}\n\n
 *     data: {"type":"text-delta","id":"...","delta":"..."}\n\n
 *     data: {"type":"text-end","id":"..."}\n\n
 *     data: {"type":"finish-step"}\n\n
 *     data: {"type":"finish"}\n\n
 *     data: [DONE]\n\n
 *
 * Phase 3 ships text-only. Tools / skills / attachments / MCP follow
 * agent-py's Phase 4-3 pattern as a follow-up (see PLAN-agent-ts.md
 * Follow-up C).
 */

import { anthropic, createAnthropic } from "@ai-sdk/anthropic"
import type { LanguageModel } from "ai"
import { streamText } from "ai"

import { getEnv } from "./env"

export type ChatFormat = "custom" | "ai-sdk"

/** The HTTP response header the AI SDK uses to advertise its
 *  stream protocol version. Mirroring it lets `useChat()` consumers
 *  identify the stream without sniffing the body. */
export const AI_SDK_STREAM_HEADER_NAME = "x-vercel-ai-ui-message-stream"
export const AI_SDK_STREAM_HEADER_VALUE = "v1"

export const DEFAULT_MAX_TOKENS = 4096

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

export interface ChatConfig {
  model: string
  messages: ChatMessage[]
  system?: string
  maxTokens?: number
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

/** Drive the AI SDK stream and yield SSE frames in the **custom**
 *  format. Mirrors agent-py's `chat_stream`. */
export async function* chatStream(
  model: LanguageModel,
  config: ChatConfig,
): AsyncGenerator<string> {
  const stream = streamText({
    model,
    system: config.system,
    messages: config.messages.map((m) => ({ role: m.role, content: m.content })),
    maxOutputTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
  })

  try {
    for await (const part of stream.fullStream) {
      if (part.type === "text-delta" && part.text) {
        yield sseFrame({ type: "text", value: part.text })
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
 *  UI message stream** format. Per-message lifecycle is start →
 *  start-step → text-start → text-delta… → text-end → finish-step →
 *  finish → `[DONE]`. Error path closes the open text block, emits
 *  `error`, then `[DONE]` (no `finish`). Mirrors agent-py's
 *  `chat_stream_ai_sdk`. */
export async function* chatStreamAiSdk(
  model: LanguageModel,
  config: ChatConfig,
): AsyncGenerator<string> {
  const textId = crypto.randomUUID().replace(/-/g, "")

  yield sseFrame({ type: "start" })
  yield sseFrame({ type: "start-step" })
  yield sseFrame({ type: "text-start", id: textId })

  const stream = streamText({
    model,
    system: config.system,
    messages: config.messages.map((m) => ({ role: m.role, content: m.content })),
    maxOutputTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
  })

  try {
    for await (const part of stream.fullStream) {
      if (part.type === "text-delta" && part.text) {
        yield sseFrame({ type: "text-delta", id: textId, delta: part.text })
      } else if (part.type === "error") {
        yield sseFrame({ type: "text-end", id: textId })
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
    yield sseFrame({ type: "text-end", id: textId })
    yield sseFrame({
      type: "error",
      errorText: err instanceof Error ? err.message : String(err),
    })
    yield "data: [DONE]\n\n"
    return
  }

  yield sseFrame({ type: "text-end", id: textId })
  yield sseFrame({ type: "finish-step" })
  yield sseFrame({ type: "finish" })
  yield "data: [DONE]\n\n"
}

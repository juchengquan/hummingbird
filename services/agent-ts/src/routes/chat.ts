/**
 * `POST /v1/chat` — Phase 3 of PLAN-agent-ts.
 *
 * Mirrors agent-py's `/v1/chat`. Accepts a narrow request body
 * (messages + model + optional system + optional max_tokens),
 * dispatches on `?format=` to the custom or AI-SDK wire formatter,
 * and streams the result as `text/event-stream`.
 */

import { Hono } from "hono"
import { z } from "zod"

import { stream } from "hono/streaming"

import {
  AI_SDK_STREAM_HEADER_NAME,
  AI_SDK_STREAM_HEADER_VALUE,
  type ChatConfig,
  type ChatFormat,
  DEFAULT_MAX_TOKENS,
  chatStream,
  chatStreamAiSdk,
  resolveAnthropicModel,
} from "../chat"
import type { AuthVars } from "../middleware/auth"
import { requireAuth } from "../middleware/auth"

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(200_000),
})

const ChatRequestSchema = z.object({
  messages: z.array(MessageSchema).min(1).max(200),
  model: z.string().min(1).max(100),
  system: z.string().max(20_000).optional(),
  max_tokens: z.number().int().min(1).max(64_000).optional(),
})

export const chatRoutes = new Hono<{ Variables: AuthVars }>()

chatRoutes.post("/v1/chat", requireAuth, async (c) => {
  const formatRaw = c.req.query("format") ?? "custom"
  if (formatRaw !== "custom" && formatRaw !== "ai-sdk") {
    return c.json({ code: "invalid_format", message: "format must be 'custom' or 'ai-sdk'." }, 422)
  }
  const format: ChatFormat = formatRaw

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ code: "invalid_request", message: "Body must be JSON." }, 400)
  }

  const parsed = ChatRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        code: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid request body.",
      },
      422,
    )
  }

  const model = resolveAnthropicModel(parsed.data.model)
  if (model === null) {
    return c.json(
      { code: "auth", message: "ANTHROPIC_API_KEY is not configured." },
      503,
    )
  }

  const config: ChatConfig = {
    model: parsed.data.model,
    messages: parsed.data.messages,
    system: parsed.data.system,
    maxTokens: parsed.data.max_tokens ?? DEFAULT_MAX_TOKENS,
  }

  // Headers production reverse-proxies need so SSE doesn't get buffered.
  c.header("Content-Type", "text/event-stream")
  c.header("Cache-Control", "no-cache, no-transform")
  c.header("Connection", "keep-alive")
  c.header("X-Accel-Buffering", "no")
  if (format === "ai-sdk") {
    c.header(AI_SDK_STREAM_HEADER_NAME, AI_SDK_STREAM_HEADER_VALUE)
  }

  return stream(c, async (s) => {
    const gen = format === "ai-sdk" ? chatStreamAiSdk(model, config) : chatStream(model, config)
    for await (const frame of gen) {
      // Bail early if the client hung up — saves tokens on a tab close.
      if (s.aborted) return
      await s.write(frame)
    }
  })
})

/**
 * `POST /v1/chat`. Mirrors agent-py's `/v1/chat`. Accepts a narrow
 * request body (messages + model + optional system + optional
 * max_tokens + optional tools-enable knobs) and streams the result
 * as `text/event-stream` in the AI SDK v5 UI message stream format.
 *
 * The legacy custom wire format was retired in B.3 of
 * PLAN-useChat-adoption.md; the `?format=` query param is silently
 * ignored.
 *
 * Tools are enabled per-request by `enable_tools: true`. When on,
 * we walk the live TS skill registry (`@/server/skills/registry`)
 * for context-free tools (`webFetch`, `webSearch`, `generateImage`)
 * — `searchFiles` runs under per-user RLS impersonation via the
 * postgres pool (see `search-files.ts`).
 */

import { Hono } from "hono"
import { stream } from "hono/streaming"
import { z } from "zod"

import { ChatRequestSchema as SharedChatRequestSchema } from "@/shared/api-schemas"

import {
  AI_SDK_STREAM_HEADER_NAME,
  AI_SDK_STREAM_HEADER_VALUE,
  type ChatConfig,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOKENS,
  chatStreamAiSdk,
  generateChatSuggestions,
  resolveAnthropicModel,
} from "../chat"
import { getPool, hasPool } from "../db"
import { buildToolImageInterceptor } from "../image-persistence"
import type { AuthVars } from "../middleware/auth"
import { requireAuth } from "../middleware/auth"
import { createSlidingWindow, rateLimitKey } from "../rate-limit"
import { buildSkillNotes, buildToolSet } from "../skills"

/** Per-IP turn-rate bucket for /v1/chat. 30 turns/min/IP is generous
 *  for a human but tight enough to cap a misbehaving script before it
 *  burns serious tokens. Module-level so buckets survive across
 *  requests on the same Bun process. Mirrors `_chat_per_ip_limit` in
 *  `services/agent-py/src/agent_py/routers/chat.py` and the equivalent
 *  in `app/api/chat/route.ts`. */
const chatPerIpLimit = createSlidingWindow({ windowMs: 60_000, max: 30 })

/** Test seam — clears the global rate-limit bucket so per-test state
 *  doesn't leak between cases. */
export function _resetChatPerIpLimitForTest(): void {
  chatPerIpLimit._reset()
}

/** Idle watchdog window. If the upstream produces no SSE frame for
 *  this many ms, we abort with a synthetic `error` frame so a hung
 *  provider doesn't pin the connection open. Same 90s as the Next.js
 *  route's `IDLE_TIMEOUT_MS`. */
let IDLE_TIMEOUT_MS = 90_000

/** Test seam — shrink the watchdog window so tests don't sit for 90s. */
export function _setIdleTimeoutForTest(ms: number): void {
  IDLE_TIMEOUT_MS = ms
}

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(200_000),
})

const ChatRequestSchema = z.object({
  messages: z.array(MessageSchema).min(1).max(200),
  model: z.string().min(1).max(100),
  system: z.string().max(20_000).optional(),
  max_tokens: z.number().int().min(1).max(64_000).optional(),
  enable_tools: z.boolean().optional(),
  max_steps: z.number().int().min(1).max(20).optional(),
  /** Active workspace id — agent-py mirror. Used by `searchFiles`
   *  and cloud-mode MCP discovery. */
  workspace_id: z.string().max(64).optional(),
  /** Mirror of the chat client's "Store files locally" preference.
   *  Propagates to image persistence (skip Storage upload, fall back
   *  to data-URL). */
  local_files_only: z.boolean().optional(),
  /** Per-skill request entries — provider toggles + per-skill caps.
   *  Reuses the shared schema directly now that agent-ts and the
   *  root both run on Zod 4. */
  skills: SharedChatRequestSchema.shape.skills,
})

export const chatRoutes = new Hono<{ Variables: AuthVars }>()

chatRoutes.post("/v1/chat", requireAuth, async (c) => {
  // The route now always emits the AI SDK v5 UI message stream
  // format. The `?format=` query param was the dual-format switch
  // before B.3 retired the custom path; it's silently ignored if
  // sent.

  // Per-IP turn-rate gate. In-process, not shared across workers —
  // same caveat as the Next.js inline route — but suffices to cap a
  // misbehaving script before it lights serious tokens on fire.
  const verdict = chatPerIpLimit.consume(rateLimitKey(c))
  if (!verdict.allowed) {
    c.header("Retry-After", String(verdict.retryAfterSec))
    return c.json(
      {
        code: "rate_limit",
        message: "Too many chat turns. Slow down and retry.",
      },
      429,
    )
  }

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

  // Build the toolset + system-prompt fragment when the caller flips
  // enable_tools. Empty toolset (no skills configured) silently
  // degrades to the text-only path.
  const claims = c.get("claims")
  const userId = typeof claims.sub === "string" ? claims.sub : ""

  const reqSignal = c.req.raw.signal
  const skillEntries = parsed.data.skills ?? []
  const tools = parsed.data.enable_tools
    ? buildToolSet({
        skills: skillEntries,
        signal: reqSignal,
        userId,
        sql: hasPool() ? getPool() : null,
      })
    : undefined
  const hasTools = tools && Object.keys(tools).length > 0

  const skillNotes =
    parsed.data.enable_tools && hasTools
      ? buildSkillNotes({ skills: skillEntries })
      : null

  const composedSystem = composeSystemPrompt(parsed.data.system, skillNotes)

  const config: ChatConfig = {
    model: parsed.data.model,
    messages: parsed.data.messages,
    system: composedSystem,
    maxTokens: parsed.data.max_tokens ?? DEFAULT_MAX_TOKENS,
    ...(hasTools
      ? {
          tools,
          maxSteps: parsed.data.max_steps ?? DEFAULT_MAX_STEPS,
        }
      : {}),
  }

  // After a `generateImage` tool result, mirror Minimax URLs into
  // Supabase Storage and emit a `tool_image` frame. Mirrors
  // `maybeEmitImageFrame` in `app/api/chat/route.ts`.
  const onToolResult = buildToolImageInterceptor({
    userId,
    signal: reqSignal,
    localFilesOnly: parsed.data.local_files_only === true,
  })

  // Headers production reverse-proxies need so SSE doesn't get buffered.
  c.header("Content-Type", "text/event-stream")
  c.header("Cache-Control", "no-cache, no-transform")
  c.header("Connection", "keep-alive")
  c.header("X-Accel-Buffering", "no")
  c.header(AI_SDK_STREAM_HEADER_NAME, AI_SDK_STREAM_HEADER_VALUE)

  // Post-stream chips. Runs once on a successful turn before the
  // terminal `finish` frame; emits a `data-suggestions` part the
  // chat consumer renders as follow-up question chips. Mirrors the
  // Next.js inline path. PLAN-useChat-adoption.md Phase B.1d.
  const onComplete = async function* (
    assistantText: string,
  ): AsyncIterable<string> {
    const suggestions = await generateChatSuggestions(
      config.messages,
      assistantText,
      reqSignal,
    )
    if (suggestions.length === 0) return
    yield `data: ${JSON.stringify({
      type: "data-suggestions",
      data: { values: suggestions },
    })}\n\n`
  }

  return stream(c, async (s) => {
    const gen = chatStreamAiSdk(model, config, { onToolResult, onComplete })
    const iterator = gen[Symbol.asyncIterator]()
    // Idle watchdog: race each `next()` against a timeout so a hung
    // upstream (provider stalled, network half-open) can't pin the
    // SSE connection open past `IDLE_TIMEOUT_MS`. On timeout we close
    // the source generator + emit a synthetic `error` + `[DONE]` so
    // the consumer's finally fires cleanly. Mirrors `_IDLE_TIMEOUT_SEC`
    // on agent-py and the equivalent watchdog in the Next.js route.
    const idleSentinel = Symbol("idle")
    while (true) {
      if (s.aborted) {
        await iterator.return?.(undefined)
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<typeof idleSentinel>((resolve) => {
        timer = setTimeout(() => resolve(idleSentinel), IDLE_TIMEOUT_MS)
      })
      const next = iterator.next()
      const winner = await Promise.race([next, timeout])
      if (timer !== undefined) clearTimeout(timer)
      if (winner === idleSentinel) {
        await iterator.return?.(undefined)
        const secs = Math.round(IDLE_TIMEOUT_MS / 1000)
        await s.write(
          `data: ${JSON.stringify({
            type: "error",
            errorText: `Model stopped responding after ${secs}s of silence.`,
            code: "upstream",
          })}\n\n`,
        )
        await s.write("data: [DONE]\n\n")
        return
      }
      const result = winner as IteratorResult<string>
      if (result.done) return
      if (s.aborted) {
        await iterator.return?.(undefined)
        return
      }
      await s.write(result.value)
    }
  })
})

/** Stitch the user-supplied system prompt with the skill registry's
 *  fragment. Either / both can be null; we return null when both are
 *  empty so `streamText` skips the system field entirely. */
function composeSystemPrompt(
  userSystem: string | undefined,
  skillNotes: string | null,
): string | undefined {
  if (userSystem && skillNotes) return `${userSystem}\n\n${skillNotes}`
  if (userSystem) return userSystem
  if (skillNotes) return skillNotes
  return undefined
}

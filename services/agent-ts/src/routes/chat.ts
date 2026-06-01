/**
 * `POST /v1/chat` — Phase 3 of PLAN-agent-ts + follow-up #2 (tools).
 *
 * Mirrors agent-py's `/v1/chat`. Accepts a narrow request body
 * (messages + model + optional system + optional max_tokens +
 * optional tools-enable knobs), dispatches on `?format=` to the
 * custom or AI-SDK wire formatter, and streams the result as
 * `text/event-stream`.
 *
 * Tools are enabled per-request by `enable_tools: true`. When on,
 * we walk the live TS skill registry (`@/server/skills/registry`)
 * for context-free tools (`webFetch`, `webSearch`, `generateImage`)
 * — `searchFiles` is currently best-effort (registers but returns
 * `not_signed_in` until a postgres-based RLS impersonation lands;
 * see `skills.ts` for the note).
 */

import { Hono } from "hono"
import { stream } from "hono/streaming"
import { z } from "zod"

import {
  AI_SDK_STREAM_HEADER_NAME,
  AI_SDK_STREAM_HEADER_VALUE,
  type ChatConfig,
  type ChatFormat,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOKENS,
  chatStream,
  chatStreamAiSdk,
  resolveAnthropicModel,
} from "../chat"
import { buildToolImageInterceptor } from "../image-persistence"
import type { AuthVars } from "../middleware/auth"
import { requireAuth } from "../middleware/auth"
import { buildSkillNotes, buildToolSet, type SkillEntry } from "../skills"

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(200_000),
})

// Skill entries are validated structurally — we accept any object
// with a string `id` and pass per-skill config objects through
// untyped. Each skill's `buildTool` performs its own narrowing on
// the typed `imageGenConfig` / `webSearchConfig` / `webFetchConfig`
// fields it cares about. This deliberately diverges from the
// shared `ChatRequestSchema.skills` Zod schema because agent-ts is
// on Zod 3 while the root is on Zod 4 — incompatible types but the
// runtime wire shape is identical.
const SkillEntrySchema = z
  .object({
    id: z.string().max(40),
  })
  .passthrough()

const ChatRequestSchema = z.object({
  messages: z.array(MessageSchema).min(1).max(200),
  model: z.string().min(1).max(100),
  system: z.string().max(20_000).optional(),
  max_tokens: z.number().int().min(1).max(64_000).optional(),
  enable_tools: z.boolean().optional(),
  max_steps: z.number().int().min(1).max(20).optional(),
  /** Active workspace id — agent-py mirror. Unused today but accepted
   *  for forward-compat with the searchFiles RLS path. */
  workspace_id: z.string().max(64).optional(),
  /** Mirror of the chat client's "Store files locally" preference.
   *  Propagates to image persistence (skip Storage upload, fall back
   *  to data-URL). */
  local_files_only: z.boolean().optional(),
  /** Per-skill request entries — provider toggles + per-skill caps. */
  skills: z.array(SkillEntrySchema).max(20).optional(),
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

  // Build the toolset + system-prompt fragment when the caller flips
  // enable_tools. Empty toolset (no skills configured) silently
  // degrades to the text-only path.
  const claims = c.get("claims")
  const userId = typeof claims.sub === "string" ? claims.sub : ""

  const reqSignal = c.req.raw.signal
  // Cast through `unknown` because agent-ts Zod 3 produces a slightly
  // different inferred type than the lib/server skill registry
  // expects (which was authored against Zod 4 in the root). The
  // runtime shape is identical — both validate `{ id, ... }`.
  const skillEntries = (parsed.data.skills ?? []) as unknown as SkillEntry[]
  const tools = parsed.data.enable_tools
    ? buildToolSet({
        skills: skillEntries,
        signal: reqSignal,
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
  if (format === "ai-sdk") {
    c.header(AI_SDK_STREAM_HEADER_NAME, AI_SDK_STREAM_HEADER_VALUE)
  }

  return stream(c, async (s) => {
    const gen =
      format === "ai-sdk"
        ? chatStreamAiSdk(model, config, { onToolResult })
        : chatStream(model, config, { onToolResult })
    for await (const frame of gen) {
      // Bail early if the client hung up — saves tokens on a tab close.
      if (s.aborted) return
      await s.write(frame)
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

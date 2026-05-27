import "server-only"

import type { NextRequest } from "next/server"

import { createUIMessageStream, createUIMessageStreamResponse } from "ai"
import type { ModelMessage } from "ai"
import { NextResponse } from "next/server"

import { DEFAULT_CHAT_MODEL } from "@/shared/models"
import {
  ProviderUnavailableError,
  selectModel,
} from "@/server/model-provider"
import { categorizeError } from "@/shared/api-errors"
import { TaskRequestSchema } from "@/shared/api-schemas"
import {
  SERVER_SKILLS,
  type SkillRequestEntry,
} from "@/server/skills/registry"
import type { SkillId } from "@/shared/skills/types"
import { buildMcpTool, mcpToolName } from "@/server/mcp/tools"
import { loadEffectiveMcpServers } from "@/server/mcp/load-servers"
import { createSlidingWindow, rateLimitKey } from "@/server/rate-limit"
import { getSupabaseServerClient } from "@/server/supabase/server"
import type { TaskEvent } from "@/shared/agent/events"
import { RunEmitter } from "@/shared/agent/emitter"
import { toDataPart } from "@/shared/agent/wire"
import { makeStreamTextStep, runAgentLoop } from "@/server/agent/runner"
import { PLAN_TOOL_NAME, makePlanTool } from "@/server/agent/plan-tool"
import {
  appendEvent,
  createRun,
  isRunCancelled,
  updateRun,
} from "@/server/agent/store"

// The serverless function may keep streaming for a while; the actual
// ceiling is the deploy target's execution cap (see PLAN-agent-api.md).
// `maxSteps` is the in-loop bound regardless.
const DEFAULT_MAX_STEPS = 25
const MAX_MAX_STEPS = 50

// Per-IP abuse gates for the task route's tool calls, mirroring the
// chat route. `maxSteps` bounds a single run; these bound outbound
// volume across runs. Image gen gets a tighter, env-tunable ceiling
// because each call costs ~1–3¢ vs. fractions of a cent for web tools.
const taskWebToolLimit = createSlidingWindow({ windowMs: 60_000, max: 30 })
const TASK_IMAGE_GEN_PER_MINUTE = (() => {
  const raw = Number(process.env.MINIMAX_IMAGE_RATE_LIMIT_PER_MINUTE)
  if (!Number.isFinite(raw) || raw <= 0) return 5
  return Math.min(Math.floor(raw), 60)
})()
const taskImageGenLimit = createSlidingWindow({
  windowMs: 60_000,
  max: TASK_IMAGE_GEN_PER_MINUTE,
})

/** Pull the most recent user message text for the `tasks.goal` column. */
function lastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "user") continue
    if (typeof m.content === "string") return m.content
    if (Array.isArray(m.content)) {
      const textPart = m.content.find(
        (p): p is { type: "text"; text: string } =>
          typeof p === "object" &&
          p !== null &&
          (p as { type?: string }).type === "text"
      )
      if (textPart) return textPart.text
    }
    return ""
  }
  return ""
}

function buildTaskSystemPrompt(opts: {
  workspaceSystemPrompt?: string
  enabledSkillIds: SkillId[]
  skillRequestEntries: SkillRequestEntry[]
  mcpServers?: { name: string; toolCount: number }[]
}): string {
  const trimmedWorkspace = opts.workspaceSystemPrompt?.trim()
  const enabled = new Set<SkillId>(opts.enabledSkillIds)
  const entryById = new Map<string, SkillRequestEntry>(
    opts.skillRequestEntries.map((s) => [s.id, s])
  )
  const notes: string[] = []
  for (const skill of SERVER_SKILLS) {
    if (!enabled.has(skill.id)) continue
    const fragment = skill.promptFragment(entryById.get(skill.id))
    if (fragment) notes.push(fragment)
  }
  const skillsLine =
    notes.length > 0
      ? `Available capabilities:\n${notes.map((n) => `- ${n}`).join("\n")}`
      : null
  const activeMcp = (opts.mcpServers ?? []).filter((s) => s.toolCount > 0)
  const mcpLine =
    activeMcp.length > 0
      ? `You also have tools from connected MCP servers (prefixed ` +
        `\`mcp__<serverId>__<toolName>\`); call them when relevant. ` +
        `Connected:\n${activeMcp
          .map((s) => `- "${s.name}" (${s.toolCount} tools)`)
          .join("\n")}`
      : null
  return [
    trimmedWorkspace,
    "You are an autonomous agent inside the Hummingbird app, working on a " +
      "multi-step task. Start by calling `setPlan` with a short todo list " +
      "of the steps you intend to take, then update it (via `setPlan` " +
      "again) as steps move to 'in_progress' and 'completed'. Call the " +
      "available tools as needed and keep going until the task is " +
      "complete. When you have finished, write a clear final answer in " +
      "Markdown.",
    skillsLine,
    mcpLine,
  ]
    .filter(Boolean)
    .join("\n\n")
}

export async function POST(req: NextRequest) {
  const db = await getSupabaseServerClient()
  if (!db) {
    return NextResponse.json(
      { code: "unavailable", message: "Supabase is not configured." },
      { status: 503 }
    )
  }

  const { data: userData, error: authError } = await db.auth.getUser()
  if (authError || !userData.user) {
    return NextResponse.json(
      { code: "auth", message: "Unauthorized." },
      { status: 401 }
    )
  }
  const userId = userData.user.id

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json(
      { code: "invalid_request", message: "Body must be JSON." },
      { status: 400 }
    )
  }
  const parsed = TaskRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        code: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid request body.",
      },
      { status: 400 }
    )
  }
  const body = parsed.data
  const modelId = body.model || DEFAULT_CHAT_MODEL
  const maxSteps = Math.min(body.maxSteps ?? DEFAULT_MAX_STEPS, MAX_MAX_STEPS)
  const enabledSkillIds: SkillId[] = (body.skills ?? []).map(
    (s) => s.id as SkillId
  )
  const skillRequestEntries: SkillRequestEntry[] = body.skills ?? []

  // Resolve the model before opening the stream so an unconfigured
  // provider returns a clean 401 instead of an error mid-stream.
  let model
  try {
    model = selectModel(modelId)
  } catch (error) {
    if (error instanceof ProviderUnavailableError) {
      return NextResponse.json(
        { code: "auth", message: error.message },
        { status: 401 }
      )
    }
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }

  // Build the tool map from the enabled skills, gated by the same
  // per-IP buckets the chat route uses (image gen on its own tighter
  // ceiling). `maxSteps` bounds one run; these bound outbound volume.
  const ipKey = rateLimitKey(req)
  const consumeWebToolBudget = () => taskWebToolLimit.consume(ipKey)
  const consumeImageGenBudget = () => taskImageGenLimit.consume(ipKey)
  const enabledSet = new Set<SkillId>(enabledSkillIds)
  const entryById = new Map<string, SkillRequestEntry>(
    skillRequestEntries.map((s) => [s.id, s])
  )
  const tools: Record<string, unknown> = {}
  for (const skill of SERVER_SKILLS) {
    if (!enabledSet.has(skill.id)) continue
    const consumeBudget =
      skill.id === "imageGen" ? consumeImageGenBudget : consumeWebToolBudget
    const tool = skill.buildTool(entryById.get(skill.id), {
      signal: req.signal,
      consumeBudget,
    })
    if (tool) tools[skill.toolName] = tool
  }

  // Register MCP-exposed tools. Cloud-mode servers are looked up
  // server-side from `workspaceId`; local-mode servers arrive (with
  // creds) in `body.mcpServers`. Tool names are prefixed
  // `mcp__<serverId>__<toolName>` so they don't collide.
  const mcpServers = await loadEffectiveMcpServers(
    body.workspaceId,
    body.mcpServers
  )
  for (const server of mcpServers) {
    for (const descriptor of server.capabilities?.tools ?? []) {
      tools[mcpToolName(server.id, descriptor.name)] = buildMcpTool(
        server,
        descriptor,
        server.credentials
      )
    }
  }

  const runId = crypto.randomUUID()
  const goal = lastUserText(body.messages as ModelMessage[]).slice(0, 2000)
  try {
    await createRun(db, {
      id: runId,
      userId,
      conversationId: body.conversationId,
      goal,
      maxSteps,
    })
  } catch (error) {
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }

  const system = buildTaskSystemPrompt({
    workspaceSystemPrompt: body.workspaceSystemPrompt,
    enabledSkillIds,
    skillRequestEntries,
    mcpServers: mcpServers.map((s) => ({
      name: s.name,
      toolCount: s.capabilities?.tools?.length ?? 0,
    })),
  })

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Persistence runs off the hot path: the sink writes each event to
      // the wire immediately (smooth streaming) and chains the DB write
      // so inserts serialize without blocking the loop. We drain the
      // chain before returning so a resume read sees the full log.
      let chain: Promise<void> = Promise.resolve()
      const enqueue = (work: () => Promise<void>) => {
        chain = chain.then(work).catch((err) => {
          console.error("[tasks] persist:", err)
        })
      }
      const sink = (event: TaskEvent) => {
        writer.write(toDataPart(event))
        enqueue(() => appendEvent(db, event, userId))
        if (event.kind === "status") {
          enqueue(() =>
            updateRun(db, runId, userId, {
              status: event.status,
              step: event.step,
            })
          )
        } else if (event.kind === "result") {
          enqueue(() =>
            updateRun(db, runId, userId, {
              status: event.status,
              step: event.step,
              finished: true,
            })
          )
        }
      }

      const emitter = new RunEmitter({ runId, maxSteps }, sink)
      // The plan tool is bound to this run's emitter, so it's added here
      // (inside the run) rather than to the shared `tools` map above.
      const runTools: Record<string, unknown> = {
        ...tools,
        [PLAN_TOOL_NAME]: makePlanTool(emitter),
      }
      const runStep = makeStreamTextStep({
        model,
        system,
        messages: body.messages as ModelMessage[],
        tools: runTools,
        // setPlan surfaces as the plan/todo list, not a tool pill.
        silentTools: new Set([PLAN_TOOL_NAME]),
      })

      await runAgentLoop({
        emitter,
        maxSteps,
        signal: req.signal,
        isCancelled: () => isRunCancelled(db, runId, userId),
        runStep,
      })

      await chain
    },
  })

  return createUIMessageStreamResponse({ stream })
}

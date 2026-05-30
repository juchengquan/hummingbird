import "server-only"

/**
 * `POST /api/tasks` — start a long-running agent task.
 *
 * After Phase 6 steps 3+4 of `PLAN-agent-task-queue.md` this route is
 * a thin enqueuer: it validates the request, writes the initial
 * checkpoint, emits a synthetic `status:queued` event so the client's
 * resume stream has something to show immediately, enqueues a `start`
 * job, optionally bootstraps the worker for a few seconds (so short
 * runs feel synchronous instead of waiting on the minute-granularity
 * cron), and returns `202 { runId }`.
 *
 * Everything model-facing — system prompt, tool registration, the
 * actual loop — happens in `lib/server/agent/worker.ts`. The client
 * watches via `GET /api/tasks/:id/stream`.
 */

import type { NextRequest } from "next/server"
import type { ModelMessage } from "ai"
import { NextResponse } from "next/server"

import { DEFAULT_CHAT_MODEL } from "@/shared/models"
import {
  ProviderUnavailableError,
  selectModel,
} from "@/server/model-provider"
import { categorizeError } from "@/shared/api-errors"
import { TaskRequestSchema } from "@/shared/api-schemas"
import type { SkillId } from "@/shared/skills/types"
import type { SkillRequestEntry } from "@/server/skills/registry"
import { getSupabaseServerClient } from "@/server/supabase/server"
import { getSupabaseAdminClient } from "@/server/supabase/admin"
import type { TaskEvent } from "@/shared/agent/events"
import type { RunCheckpoint } from "@/server/agent/checkpoint"
import {
  appendEvent,
  createRun,
  saveCheckpoint,
} from "@/server/agent/store"
import { enqueueStartJob } from "@/server/agent/jobs"
import { processNextJob } from "@/server/agent/worker"

const DEFAULT_MAX_STEPS = 25
const MAX_MAX_STEPS = 50
/** Research-mode runs are by nature long (plan → per-section search →
 *  gap pass → synthesis). Bumped above the default so a plan of 8
 *  sub-questions × ~3 steps each fits without the user having to
 *  remember to override `maxSteps`. Still capped by `MAX_MAX_STEPS`. */
const RESEARCH_DEFAULT_MAX_STEPS = 35

/** Wall-clock budget for the inline bootstrap of the worker. Short
 *  enough that the POST returns quickly even on a slow first chunk,
 *  long enough that simple prompts often complete before the cron's
 *  next tick. */
const TASK_START_BOOTSTRAP_MS = (() => {
  const raw = Number(process.env.TASK_START_BOOTSTRAP_MS)
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw)
  return 8_000
})()

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
  const mode = body.mode ?? "default"
  const defaultMaxForMode =
    mode === "research" ? RESEARCH_DEFAULT_MAX_STEPS : DEFAULT_MAX_STEPS
  const maxSteps = Math.min(body.maxSteps ?? defaultMaxForMode, MAX_MAX_STEPS)

  // Fail fast on a misconfigured provider — the worker would otherwise
  // fail the job after the route has already returned 202.
  try {
    selectModel(modelId)
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

  // Local-mode MCP creds (`body.mcpServers`) live in the browser; the
  // background worker has no way to use them. Cloud-mode MCP works as
  // usual via `body.workspaceId`. Silently dropping `mcpServers` here
  // would surface as confusing tool-not-found errors deeper in; tell
  // the client up front so they can omit the field or fall back to the
  // chat route for local-mode-MCP workflows.
  if (body.mcpServers && body.mcpServers.length > 0) {
    return NextResponse.json(
      {
        code: "invalid_request",
        message:
          "Local-mode MCP servers aren't supported in async task mode. " +
          "Connect the server as a cloud-mode workspace MCP, or use the " +
          "chat route for this workflow.",
      },
      { status: 400 }
    )
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

  // The worker is system-driven; cast `skills` to the registry's
  // request-entry shape (same as the chat route does).
  const skillRequestEntries: SkillRequestEntry[] = body.skills ?? []
  const enabledSkillIds: SkillId[] = skillRequestEntries.map(
    (s) => s.id as SkillId
  )

  // Initial checkpoint — seq=1 because we're about to emit a single
  // `status:queued` event before any worker invocation. The worker
  // builds its emitter with `startSeq=1, startStep=0`; the runner's
  // first event then becomes seq=2 (`status:running`, auto-emitted at
  // step==0). `enabledSkillIds` is computed from `skills` in the
  // worker — we just persist the user-supplied shape.
  const checkpoint: RunCheckpoint = {
    messages: body.messages as ModelMessage[],
    step: 0,
    seq: 1,
    config: {
      model: modelId,
      workspaceSystemPrompt: body.workspaceSystemPrompt,
      workspaceId: body.workspaceId,
      skills: body.skills,
      maxSteps,
      requireApprovalFor: body.requireApprovalFor,
      mode,
      ...(body.allowedMcpServerIds
        ? { allowedMcpServerIds: body.allowedMcpServerIds }
        : {}),
    },
  }
  try {
    await saveCheckpoint(db, runId, userId, checkpoint)
  } catch (error) {
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }
  // Touch `enabledSkillIds` so the unused-import linter is happy
  // without dropping a reference that documents intent; the worker
  // recomputes from the persisted config.
  void enabledSkillIds

  // Synthetic `status:queued` event so the client's resume stream has
  // something to show during the brief window between POST and the
  // worker picking up.
  const queuedEvent: TaskEvent = {
    runId,
    seq: 1,
    step: 0,
    createdAt: new Date().toISOString(),
    kind: "status",
    status: "queued",
    maxSteps,
  }
  try {
    await appendEvent(db, queuedEvent, userId)
  } catch (err) {
    console.error("[tasks] queued-event:", err)
  }

  try {
    await enqueueStartJob(db, { taskId: runId, userId })
  } catch (error) {
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }

  // Bootstrap: run the worker once inline so short prompts complete
  // before the response returns (events are in `task_events` by the
  // time the client opens its resume stream). Best-effort; failures
  // here don't fail the POST — the cron picks the job up next minute.
  if (TASK_START_BOOTSTRAP_MS > 0) {
    const admin = getSupabaseAdminClient()
    if (admin) {
      try {
        await processNextJob(admin, { budgetMs: TASK_START_BOOTSTRAP_MS })
      } catch (err) {
        console.error("[tasks] bootstrap:", err)
      }
    }
  }

  return NextResponse.json({ runId }, { status: 202 })
}

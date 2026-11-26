import "server-only"

/**
 * `POST /api/tasks` — start a long-running agent task.
 *
 * After Phase 6 steps 3+4 of `PLAN-agent-task-queue.md` this route is
 * a thin enqueuer: it validates the request, creates the run with its
 * initial checkpoint (`create_task_run` RPC), emits a synthetic `status:queued` event so the client's
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
import { backendAcceptsModel } from "@/shared/backend-models"
import { categorizeError } from "@/shared/api-errors"
import {
  CHAT_BODY_MAX,
  TaskRequestSchema,
  type TaskRequestInput,
} from "@/shared/api-schemas"
import type { SkillId } from "@/shared/skills/types"
import type { SkillRequestEntry } from "@/server/skills/registry"
import { getSupabaseServerClient } from "@/server/supabase/server"
import type { TaskEvent } from "@/shared/agent/events"
import type { RunCheckpoint } from "@/server/agent/checkpoint"
import { appendEvent, appendSyntheticResult } from "@/server/agent/store"
import { enqueueStartJob } from "@/server/agent/jobs"
import { createTaskRun, taskWriteErrorResponse } from "@/server/agent/task-writes"
import { jsonBodyError, readJsonCapped } from "@/server/read-body-capped"

const DEFAULT_MAX_STEPS = 25
const MAX_MAX_STEPS = 50
/** Research-mode runs are by nature long (plan → per-section search →
 *  gap pass → synthesis). Bumped above the default so a plan of 8
 *  sub-questions × ~3 steps each fits without the user having to
 *  remember to override `maxSteps`. Still capped by `MAX_MAX_STEPS`. */
const RESEARCH_DEFAULT_MAX_STEPS = 35

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

/** The image types the worker can give the model (agent-py's
 *  `IMAGE_MEDIA_TYPES`). */
const IMAGE_FILE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** The media type of the first file part the worker can't give the model
 *  (agent-py's `_translate_file_block`), else null. Such a task is
 *  refused: nothing attached is dropped silently (B20). */
function unusableFilePart(messages: TaskRequestInput["messages"]): string | null {
  for (const { content } of messages) {
    if (typeof content === "string") continue
    for (const part of content) {
      if (part.type !== "file") continue
      const { mediaType, data } = part
      if (typeof data !== "string" || !data) return mediaType
      if (mediaType === "application/pdf" || IMAGE_FILE_TYPES.has(mediaType)) continue
      if (!mediaType.startsWith("text/") || /^https?:\/\//.test(data)) return mediaType
      const comma = data.startsWith("data:") ? data.indexOf(",") : -1
      const encoded = comma < 0 || data.slice(0, comma).endsWith(";base64")
      if (encoded && !BASE64.test(data.slice(comma + 1))) return mediaType
    }
  }
  return null
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

  const read = await readJsonCapped(req, CHAT_BODY_MAX)
  if (!read.ok) return jsonBodyError(read)
  const raw = read.value
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

  // The worker runs the task models only (Q55): anything else, the
  // resolved default and Auto included, is refused before anything is
  // created — it could only fail after the 202. The server never loads
  // agent-py's `/v1/models`, so this old path keeps the `anthropic/*` list.
  if (!backendAcceptsModel("agent-tasks", modelId)) {
    return NextResponse.json(
      {
        code: "unknown_model",
        message: `Tasks can't run the model "${modelId}". Choose one of the Anthropic models.`,
      },
      { status: 400 }
    )
  }
  const unusable = unusableFilePart(body.messages)
  if (unusable !== null) {
    return NextResponse.json(
      {
        code: "invalid_attachment",
        message: `A task can't take this ${unusable} attachment: use an image, a PDF or inline text.`,
      },
      { status: 400 }
    )
  }

  // No Next-side provider check: agent-py's worker calls the model with
  // its own key (an AI Gateway key here is neither needed nor used), and
  // the model is checked against what the worker runs above.

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

  // Run row + initial checkpoint in one `create_task_run` RPC (0034):
  // API callers can no longer INSERT `tasks` directly, so the run's
  // status / step budget / checkpoint are pinned server-side.
  try {
    await createTaskRun(db, {
      id: runId,
      conversationId: body.conversationId,
      goal,
      maxSteps,
      checkpoint,
    })
  } catch (error) {
    const { status, code, message } =
      taskWriteErrorResponse(error) ?? categorizeError(error)
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
    const { status, code, message } =
      taskWriteErrorResponse(error) ?? categorizeError(error)
    // No queued orphan (B18). Only while still queued: after an ambiguous
    // failure the job may exist and a worker may already run it.
    try {
      await appendSyntheticResult(db, runId, userId, {
        status: "failed",
        error: message,
        from: ["queued"],
      })
    } catch (settleError) {
      console.error("[tasks] fail-unqueued:", settleError)
    }
    return NextResponse.json({ code, message }, { status })
  }

  // The dedicated agent service (`services/agent-py/` or
  // `services/agent-ts/`) claims the job from its own poll loop —
  // typically within POLL_INTERVAL_SECONDS. The POST returns
  // immediately; the client opens its resume stream and tails
  // `task_events` as the service settles the run.
  return NextResponse.json({ runId }, { status: 202 })
}

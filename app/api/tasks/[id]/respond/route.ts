import "server-only"

/**
 * `POST /api/tasks/:id/respond` — resolve a HITL pause.
 *
 * After Phase 6 steps 3+4 of `PLAN-agent-task-queue.md` this route is
 * a thin enqueuer: it validates the human's answer, verifies the run
 * is actually paused, enqueues a `respond` job carrying the answer,
 * bootstraps the worker for a few seconds (so simple respond loops
 * feel synchronous), and returns 202. The worker pairs the answer
 * with the pending tool call in the checkpoint, executes the gated
 * tool (or synthesises a "declined" result for reject / `askUser`),
 * and continues the loop.
 *
 * The client watches via `GET /api/tasks/:id/stream` like for `start`.
 */

import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import { categorizeError } from "@/shared/api-errors"
import { RespondRequestSchema } from "@/shared/api-schemas"
import { getSupabaseServerClient } from "@/server/supabase/server"
import { getRun } from "@/server/agent/store"
import { enqueueRespondJob } from "@/server/agent/jobs"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: runId } = await params
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
  const parsed = RespondRequestSchema.safeParse(raw)
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

  // Local-mode MCP creds — see the start route. Async path can't carry
  // browser-held secrets, so reject up front.
  if (body.mcpServers && body.mcpServers.length > 0) {
    return NextResponse.json(
      {
        code: "invalid_request",
        message:
          "Local-mode MCP servers aren't supported in async task mode. " +
          "Run with cloud-mode MCP for HITL flows.",
      },
      { status: 400 }
    )
  }

  const run = await getRun(db, runId, userId)
  if (!run) {
    return NextResponse.json(
      { code: "not_found", message: "Run not found." },
      { status: 404 }
    )
  }
  if (run.status !== "paused") {
    return NextResponse.json(
      {
        code: "invalid_state",
        message: `Run is not paused (status=${run.status}).`,
      },
      { status: 409 }
    )
  }

  try {
    await enqueueRespondJob(db, {
      taskId: runId,
      userId,
      payload: {
        requestId: body.requestId,
        ...(body.approved !== undefined ? { approved: body.approved } : {}),
        ...(body.selection !== undefined ? { selection: body.selection } : {}),
        ...(body.value !== undefined ? { value: body.value } : {}),
        // PLAN-generative-ui-parts.md commit 3a — `uiAnswer` carries the
        // client's structured answer to a `renderUI` HITL gate so the
        // runner can mark the part `inert` with the picked option. The
        // back-compat `value` / `selection` ride alongside (the wire
        // shim in `respondBodyForUiAnswer` populates them too), so an
        // older runner still sees a consumable answer.
        ...(body.uiAnswer !== undefined ? { uiAnswer: body.uiAnswer } : {}),
        ...(body.args !== undefined ? { args: body.args } : {}),
      },
    })
  } catch (error) {
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }

  // The dedicated agent service claims the respond job from its
  // poll loop. POST returns immediately; the client tails
  // `task_events` as the service settles.
  return NextResponse.json({ ok: true }, { status: 202 })
}

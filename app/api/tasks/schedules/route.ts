import "server-only"

/**
 * `GET /api/tasks/schedules` — list the user's saved schedules.
 * `POST /api/tasks/schedules` — create a new one.
 *
 * The matching update + delete handlers live next to `[id]/route.ts`.
 * Step 7 of `PLAN-agent-task-queue.md`; uses the user-scoped Supabase
 * client so RLS enforces own-your-rows on every read and write.
 */

import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import { categorizeError } from "@/shared/api-errors"
import {
  ScheduleCreateSchema,
  ScheduleListResponseSchema,
  ScheduleResponseSchema,
} from "@/shared/api-schemas"
import { getSupabaseServerClient } from "@/server/supabase/server"
import { validateScheduleCron } from "@/server/agent/schedules"
import { taskWriteErrorResponse } from "@/server/agent/task-writes"
import { rowToSchedule } from "@/server/agent/schedule-codec"
import type { Database, Json } from "@/shared/supabase/types"
import { jsonBodyError, readJsonCapped } from "@/server/read-body-capped"

/** Body cap: name + prompt + systemPrompt top out around 40 KB. */
const SCHEDULE_BODY_MAX = 256 * 1024

export async function GET() {
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

  const { data, error } = await db
    .from("task_schedules")
    .select("*")
    .eq("user_id", userData.user.id)
    .order("created_at", { ascending: false })
  if (error) {
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }
  const schedules = (data ?? []).map(rowToSchedule)
  return NextResponse.json(
    ScheduleListResponseSchema.parse({ schedules })
  )
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

  const read = await readJsonCapped(req, SCHEDULE_BODY_MAX)
  if (!read.ok) return jsonBodyError(read)
  const raw = read.value
  const parsed = ScheduleCreateSchema.safeParse(raw)
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
  const timezone = body.timezone ?? "UTC"
  // Parseable AND at least 5 minutes between fires (0035's DB trigger
  // is only a coarse floor for direct PostgREST writes).
  const cronCheck = validateScheduleCron(body.cron, timezone, new Date())
  if (!cronCheck.ok) {
    return NextResponse.json(
      { code: "invalid_request", message: cronCheck.message },
      { status: 400 }
    )
  }
  const next = cronCheck.next

  const insert: Database["public"]["Tables"]["task_schedules"]["Insert"] = {
    user_id: userId,
    workspace_id: body.workspaceId,
    name: body.name,
    prompt: body.prompt,
    cron: body.cron,
    timezone,
    enabled: body.enabled ?? true,
    model: body.model ?? null,
    system_prompt: body.systemPrompt ?? null,
    skills: (body.skills ?? null) as Json | null,
    max_steps: body.maxSteps ?? null,
    next_run_at: next.toISOString(),
  }
  const { data, error } = await db
    .from("task_schedules")
    .insert(insert)
    .select("*")
    .single()
  if (error || !data) {
    // 0035's guard trigger: 54000 = per-user cap → 409, 22023 = cron
    // too frequent → 400.
    const { status, code, message } =
      taskWriteErrorResponse(error) ?? categorizeError(error ?? "Insert failed")
    return NextResponse.json({ code, message }, { status })
  }
  return NextResponse.json(ScheduleResponseSchema.parse(rowToSchedule(data)), {
    status: 201,
  })
}

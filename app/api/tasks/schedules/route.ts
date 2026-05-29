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
import { nextRunFromCron } from "@/server/agent/schedules"
import { rowToSchedule } from "@/server/agent/schedule-codec"
import type { Database, Json } from "@/shared/supabase/types"

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

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json(
      { code: "invalid_request", message: "Body must be JSON." },
      { status: 400 }
    )
  }
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
  const next = nextRunFromCron(body.cron, timezone, new Date())
  if (!next) {
    return NextResponse.json(
      {
        code: "invalid_request",
        message: `Couldn't parse cron "${body.cron}" with timezone "${timezone}".`,
      },
      { status: 400 }
    )
  }

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
    const { status, code, message } = categorizeError(error ?? "Insert failed")
    return NextResponse.json({ code, message }, { status })
  }
  return NextResponse.json(ScheduleResponseSchema.parse(rowToSchedule(data)), {
    status: 201,
  })
}

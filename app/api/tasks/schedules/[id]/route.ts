import "server-only"

/**
 * `PATCH /api/tasks/schedules/:id` — partial update.
 * `DELETE /api/tasks/schedules/:id` — drop it.
 *
 * The cron / timezone fields trigger a `next_run_at` recompute so the
 * tick picks up the new spec on its next run. Both routes are
 * RLS-scoped (own-your-rows) via the user-bound Supabase client.
 */

import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import { categorizeError } from "@/shared/api-errors"
import {
  ScheduleResponseSchema,
  ScheduleUpdateSchema,
} from "@/shared/api-schemas"
import { getSupabaseServerClient } from "@/server/supabase/server"
import { nextRunFromCron } from "@/server/agent/schedules"
import { rowToSchedule } from "@/server/agent/schedule-codec"
import type { Database, Json } from "@/shared/supabase/types"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
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
  const parsed = ScheduleUpdateSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        code: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid request body.",
      },
      { status: 400 }
    )
  }
  const patch = parsed.data

  // We need the current row's cron/timezone to recompute `next_run_at`
  // when either changes (and to validate the row exists).
  const { data: current, error: getErr } = await db
    .from("task_schedules")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle()
  if (getErr || !current) {
    return NextResponse.json(
      { code: "not_found", message: "Schedule not found." },
      { status: 404 }
    )
  }

  const update: Database["public"]["Tables"]["task_schedules"]["Update"] = {
    updated_at: new Date().toISOString(),
  }
  if (patch.name !== undefined) update.name = patch.name
  if (patch.prompt !== undefined) update.prompt = patch.prompt
  if (patch.workspaceId !== undefined) update.workspace_id = patch.workspaceId
  if (patch.enabled !== undefined) update.enabled = patch.enabled
  if (patch.model !== undefined) update.model = patch.model
  if (patch.systemPrompt !== undefined) update.system_prompt = patch.systemPrompt
  if (patch.skills !== undefined) update.skills = patch.skills as Json | null
  if (patch.maxSteps !== undefined) update.max_steps = patch.maxSteps

  // Recompute `next_run_at` when cron/tz change, otherwise leave as-is
  // so an edit doesn't push the next fire backward.
  const cronChanged = patch.cron !== undefined && patch.cron !== current.cron
  const tzChanged =
    patch.timezone !== undefined && patch.timezone !== current.timezone
  if (cronChanged || tzChanged) {
    const cron = patch.cron ?? current.cron
    const timezone = patch.timezone ?? current.timezone
    const next = nextRunFromCron(cron, timezone, new Date())
    if (!next) {
      return NextResponse.json(
        {
          code: "invalid_request",
          message: `Couldn't parse cron "${cron}" with timezone "${timezone}".`,
        },
        { status: 400 }
      )
    }
    update.cron = cron
    update.timezone = timezone
    update.next_run_at = next.toISOString()
  }

  const { data, error } = await db
    .from("task_schedules")
    .update(update)
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .single()
  if (error || !data) {
    const { status, code, message } = categorizeError(error ?? "Update failed")
    return NextResponse.json({ code, message }, { status })
  }
  return NextResponse.json(ScheduleResponseSchema.parse(rowToSchedule(data)))
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
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
  const { error } = await db
    .from("task_schedules")
    .delete()
    .eq("id", id)
    .eq("user_id", userData.user.id)
  if (error) {
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }
  return NextResponse.json({ ok: true })
}

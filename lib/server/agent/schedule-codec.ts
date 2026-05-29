import "server-only"

/**
 * Row ↔ wire codec for `task_schedules`. Same shape as the
 * persistence codec for `task_events`: pure, no I/O, lives next to
 * the routes that use it. Keeps the public response schema decoupled
 * from the snake-cased Postgres column names.
 */

import type {
  ScheduleResponse,
  TaskRequestInput,
} from "@/shared/api-schemas"
import type { Database } from "@/shared/supabase/types"

type ScheduleRow = Database["public"]["Tables"]["task_schedules"]["Row"]

export function rowToSchedule(row: ScheduleRow): ScheduleResponse {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    prompt: row.prompt,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
    model: row.model,
    systemPrompt: row.system_prompt,
    skills: (row.skills as TaskRequestInput["skills"]) ?? undefined,
    maxSteps: row.max_steps,
    lastRunAt: row.last_run_at,
    lastRunTaskId: row.last_run_task_id,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

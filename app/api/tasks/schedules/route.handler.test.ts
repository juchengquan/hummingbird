/**
 * Route-handler tests for `POST /api/tasks/schedules` — the cron
 * minimum-interval check and the mapping of 0035's guard-trigger
 * errors (per-user cap, too-frequent cron) to 4xx.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { NextRequest } from "next/server"

import { resetAgentMocks, supabaseClient } from "../_test/mock-agent-store"

const USER_ID = "11111111-1111-1111-1111-111111111111"

type InsertResult = { data: unknown; error: { message: string; code?: string } | null }

/** Signed-in client whose `task_schedules` insert returns `result`. */
function clientWithInsert(result: InsertResult) {
  const inserted: unknown[] = []
  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
    },
    from: () => ({
      insert: (row: unknown) => {
        inserted.push(row)
        return { select: () => ({ single: async () => result }) }
      },
    }),
  }
  return { client, inserted }
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tasks/schedules", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

const base = { workspaceId: "ws-1", name: "Daily", prompt: "Summarise the news." }

const row = {
  id: "s-1",
  user_id: USER_ID,
  workspace_id: "ws-1",
  name: "Daily",
  prompt: "Summarise the news.",
  cron: "0 8 * * *",
  timezone: "UTC",
  enabled: true,
  model: null,
  system_prompt: null,
  skills: null,
  max_steps: null,
  last_run_at: null,
  last_run_task_id: null,
  next_run_at: "2026-06-01T08:00:00.000Z",
  created_at: "2026-05-31T00:00:00.000Z",
  updated_at: "2026-05-31T00:00:00.000Z",
}

beforeEach(resetAgentMocks)

describe("POST /api/tasks/schedules — cron frequency", () => {
  test("every-minute cron → 400 and nothing is inserted", async () => {
    const { client, inserted } = clientWithInsert({ data: row, error: null })
    supabaseClient.value = client
    const { POST } = await import("./route")
    const res = await POST(post({ ...base, cron: "* * * * *" }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe("invalid_request")
    expect(body.message).toMatch(/every 5 minutes/)
    expect(inserted).toHaveLength(0)
  })

  test("a list with a short gap is rejected too", async () => {
    const { client, inserted } = clientWithInsert({ data: row, error: null })
    supabaseClient.value = client
    const { POST } = await import("./route")
    const res = await POST(post({ ...base, cron: "0,2 8 * * *" }))
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  test("a daily cron is inserted → 201", async () => {
    const { client, inserted } = clientWithInsert({ data: row, error: null })
    supabaseClient.value = client
    const { POST } = await import("./route")
    const res = await POST(post({ ...base, cron: "0 8 * * *" }))
    expect(res.status).toBe(201)
    expect(inserted).toHaveLength(1)
    // `last_run_at` is the dispatcher's — the route never writes it
    // (0035 column grants would reject it anyway).
    expect(inserted[0]).not.toHaveProperty("last_run_at")
  })
})

describe("POST /api/tasks/schedules — guard-trigger errors", () => {
  test("per-user cap (54000) → 409 limit_reached", async () => {
    const { client } = clientWithInsert({
      data: null,
      error: { message: "schedule limit reached (20 enabled schedules per user)", code: "54000" },
    })
    supabaseClient.value = client
    const { POST } = await import("./route")
    const res = await POST(post({ ...base, cron: "0 8 * * *" }))
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe("limit_reached")
  })

  test("DB cron guard (22023) → 400 invalid_request", async () => {
    const { client } = clientWithInsert({
      data: null,
      error: { message: "cron fires too often", code: "22023" },
    })
    supabaseClient.value = client
    const { POST } = await import("./route")
    const res = await POST(post({ ...base, cron: "0 8 * * *" }))
    expect(res.status).toBe(400)
  })
})

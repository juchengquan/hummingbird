/**
 * Route-handler tests for `PATCH /api/tasks/schedules/:id` — the model an
 * enabled schedule keeps (Q80): re-enabling one without a model, or clearing
 * the model of an enabled one, stores Haiku.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { NextRequest } from "next/server"

import { resetAgentMocks, supabaseClient } from "../../_test/mock-agent-store"

const USER_ID = "11111111-1111-1111-1111-111111111111"
const ID = "22222222-2222-2222-2222-222222222222"
const HAIKU = "anthropic/claude-haiku-4.5"

const current = {
  id: ID,
  user_id: USER_ID,
  workspace_id: "ws-1",
  name: "Daily",
  prompt: "Summarise the news.",
  cron: "0 8 * * *",
  timezone: "UTC",
  enabled: false,
  model: null as string | null,
  system_prompt: null,
  skills: null,
  max_steps: null,
  last_run_at: null,
  last_run_task_id: null,
  next_run_at: "2026-06-01T08:00:00.000Z",
  created_at: "2026-05-31T00:00:00.000Z",
  updated_at: "2026-05-31T00:00:00.000Z",
}

/** Signed-in client reading `row` and recording the update. */
function clientWith(row: typeof current) {
  const updates: Record<string, unknown>[] = []
  const read = {
    eq: () => read,
    maybeSingle: async () => ({ data: row, error: null }),
  }
  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
    },
    from: () => ({
      select: () => read,
      update: (patch: Record<string, unknown>) => {
        updates.push(patch)
        const chain = {
          eq: () => chain,
          select: () => chain,
          single: async () => ({ data: { ...row, ...patch }, error: null }),
        }
        return chain
      },
    }),
  }
  return { client, updates }
}

function patch(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/tasks/schedules/${ID}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

const params = { params: Promise.resolve({ id: ID }) }

beforeEach(resetAgentMocks)

describe("PATCH /api/tasks/schedules/:id — model (Q80)", () => {
  test("re-enabling a schedule without a model stores Haiku", async () => {
    const { client, updates } = clientWith({ ...current })
    supabaseClient.value = client
    const { PATCH } = await import("./route")
    const res = await PATCH(patch({ enabled: true }), params)
    expect(res.status).toBe(200)
    expect(updates[0].model).toBe(HAIKU)
    expect(((await res.json()) as { model: string }).model).toBe(HAIKU)
  })

  test("clearing the model of an enabled schedule stores Haiku", async () => {
    const { client, updates } = clientWith({ ...current, enabled: true, model: "anthropic/x" })
    supabaseClient.value = client
    const { PATCH } = await import("./route")
    await PATCH(patch({ model: null }), params)
    expect(updates[0].model).toBe(HAIKU)
  })

  test("a disabled schedule may keep no model; an edit leaves a model alone", async () => {
    const off = clientWith({ ...current })
    supabaseClient.value = off.client
    const { PATCH } = await import("./route")
    await PATCH(patch({ name: "Renamed" }), params)
    expect(off.updates[0]).not.toHaveProperty("model")

    const on = clientWith({ ...current, enabled: true, model: "anthropic/x" })
    supabaseClient.value = on.client
    await PATCH(patch({ name: "Renamed" }), params)
    expect(on.updates[0]).not.toHaveProperty("model")
  })
})

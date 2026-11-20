/**
 * Route-handler tests for `GET|POST /api/tasks/jobs/tick` — the cron
 * entry point. Covers the auth gate: header-only Bearer token (what
 * Vercel Cron sends), no `?secret=` query fallback, 503 when
 * `CRON_SECRET` is unset.
 *
 * `mock.module` is process-global; the real schedules module is spread
 * into the mock so any other importer still sees its full surface.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { NextRequest } from "next/server"

import * as realSchedules from "@/server/agent/schedules"

const dispatchDueSchedules = mock(async () => 2)
mock.module("@/server/agent/schedules", () => ({
  ...realSchedules,
  dispatchDueSchedules,
}))
mock.module("@/server/supabase/admin", () => ({
  getSupabaseAdminClient: () => ({}),
}))

const { GET, POST } = await import("./route")

const ORIGINAL_SECRET = process.env.CRON_SECRET
const SECRET = "tick-secret-123"

function req(opts: { auth?: string; query?: string; method?: string } = {}) {
  const headers: Record<string, string> = {}
  if (opts.auth !== undefined) headers.authorization = opts.auth
  return new NextRequest(`http://localhost/api/tasks/jobs/tick${opts.query ?? ""}`, {
    method: opts.method ?? "GET",
    headers,
  })
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET
  dispatchDueSchedules.mockClear()
})

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = ORIGINAL_SECRET
})

describe("/api/tasks/jobs/tick auth", () => {
  test("503 when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET
    const res = await GET(req({ auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(503)
    expect(dispatchDueSchedules).not.toHaveBeenCalled()
  })

  test("200 with the Bearer header (GET and POST)", async () => {
    const res = await GET(req({ auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ scheduledFired: 2 })
    const post = await POST(req({ auth: `Bearer ${SECRET}`, method: "POST" }))
    expect(post.status).toBe(200)
    expect(dispatchDueSchedules).toHaveBeenCalledTimes(2)
  })

  test("401 for ?secret= — the query parameter is no longer accepted", async () => {
    const res = await GET(req({ query: `?secret=${SECRET}` }))
    expect(res.status).toBe(401)
    expect(dispatchDueSchedules).not.toHaveBeenCalled()
  })

  test("401 for a wrong or malformed header", async () => {
    for (const auth of [`Bearer ${SECRET}x`, "Bearer nope", SECRET, ""]) {
      const res = await GET(req({ auth }))
      expect(res.status).toBe(401)
    }
    expect(dispatchDueSchedules).not.toHaveBeenCalled()
  })
})

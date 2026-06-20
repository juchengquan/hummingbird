/**
 * Route-handler integration tests for `POST /api/tasks/:id/cancel` —
 * small-followups #8. Covers: auth gates, 404 on missing run, idempotent
 * no-op on already-terminal runs (don't double-write `cancelled`), and
 * the happy-path status-flip wired through `updateRun`.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { NextRequest } from "next/server"

import {
  mocks,
  resetAgentMocks,
  signedIn,
  signedOut,
  supabaseClient,
} from "../../_test/mock-agent-store"

const RUN_ID = "33333333-3333-3333-3333-333333333333"
const USER_ID = "11111111-1111-1111-1111-111111111111"

function post(): NextRequest {
  return new NextRequest(`http://localhost/api/tasks/${RUN_ID}/cancel`, {
    method: "POST",
  })
}

const params = Promise.resolve({ id: RUN_ID })

beforeEach(() => {
  resetAgentMocks()
  // Default: a running run exists. Override per-test for the 404 /
  // wrong-status branches.
  mocks.getRun.mockImplementation(async () => ({
    id: RUN_ID,
    status: "running",
  }))
})

describe("POST /api/tasks/:id/cancel — gates", () => {
  test("503 when Supabase isn't configured", async () => {
    supabaseClient.value = null
    const { POST } = await import("./route")
    const res = await POST(post(), { params })
    expect(res.status).toBe(503)
    expect(mocks.updateRun).not.toHaveBeenCalled()
  })

  test("401 when not signed in", async () => {
    supabaseClient.value = signedOut()
    const { POST } = await import("./route")
    const res = await POST(post(), { params })
    expect(res.status).toBe(401)
    expect(mocks.updateRun).not.toHaveBeenCalled()
  })

  test("404 when the run doesn't exist", async () => {
    mocks.getRun.mockImplementation(async () => null)
    const { POST } = await import("./route")
    const res = await POST(post(), { params })
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe("not_found")
    expect(mocks.updateRun).not.toHaveBeenCalled()
  })
})

describe("POST /api/tasks/:id/cancel — state behaviour", () => {
  test.each([["queued"], ["running"], ["paused"]])(
    "non-terminal status (%s) → updateRun called with cancelled + finished",
    async (status) => {
      mocks.getRun.mockImplementation(async () => ({
        id: RUN_ID,
        status,
      }))
      const { POST } = await import("./route")
      const res = await POST(post(), { params })
      expect(res.status).toBe(200)
      expect((await res.json()).ok).toBe(true)
      expect(mocks.updateRun).toHaveBeenCalledTimes(1)
      const patch = mocks.updateRun.mock.calls[0][3] as {
        status: string
        finished: boolean
      }
      expect(patch.status).toBe("cancelled")
      expect(patch.finished).toBe(true)
    },
  )

  test.each([["done"], ["failed"], ["cancelled"]])(
    "terminal status (%s) → idempotent no-op (no double-write)",
    async (status) => {
      // The runner could land its own terminal between the cancel
      // intent and this check. Writing `cancelled` over `done` would
      // mis-categorise the run; the route leaves the row alone and
      // still returns 200 so the client UX is consistent.
      mocks.getRun.mockImplementation(async () => ({
        id: RUN_ID,
        status,
      }))
      const { POST } = await import("./route")
      const res = await POST(post(), { params })
      expect(res.status).toBe(200)
      expect((await res.json()).ok).toBe(true)
      expect(mocks.updateRun).not.toHaveBeenCalled()
    },
  )

  test("scoped to runId + authed user (RLS defense-in-depth)", async () => {
    const { POST } = await import("./route")
    await POST(post(), { params })
    expect(mocks.getRun.mock.calls[0][1]).toBe(RUN_ID)
    expect(mocks.getRun.mock.calls[0][2]).toBe(USER_ID)
    expect(mocks.updateRun.mock.calls[0][1]).toBe(RUN_ID)
    expect(mocks.updateRun.mock.calls[0][2]).toBe(USER_ID)
  })

  test("non-terminal parent → cancelChildTasks called with parentId + userId", async () => {
    const { POST } = await import("./route")
    const res = await POST(post(), { params })
    expect(res.status).toBe(200)
    expect(mocks.cancelChildTasks).toHaveBeenCalledTimes(1)
    expect(mocks.cancelChildTasks.mock.calls[0][1]).toBe(RUN_ID)
    expect(mocks.cancelChildTasks.mock.calls[0][2]).toBe(USER_ID)
  })

  test("already-terminal parent → cancelChildTasks NOT called", async () => {
    mocks.getRun.mockImplementation(async () => ({ id: RUN_ID, status: "done" }))
    const { POST } = await import("./route")
    const res = await POST(post(), { params })
    expect(res.status).toBe(200)
    expect(mocks.cancelChildTasks).not.toHaveBeenCalled()
  })
})

describe("POST /api/tasks/:id/cancel — store failures", () => {
  test("getRun throw → categorised error response", async () => {
    mocks.getRun.mockImplementation(async () => {
      throw new Error("postgres unreachable")
    })
    const { POST } = await import("./route")
    const res = await POST(post(), { params })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).not.toBe(200)
    expect(mocks.updateRun).not.toHaveBeenCalled()
  })

  test("updateRun throw → categorised error response", async () => {
    mocks.updateRun.mockImplementation(async () => {
      throw new Error("update failed")
    })
    const { POST } = await import("./route")
    const res = await POST(post(), { params })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).not.toBe(200)
  })
})

void signedIn

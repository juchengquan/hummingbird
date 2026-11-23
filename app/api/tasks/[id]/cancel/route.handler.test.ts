/**
 * Route-handler integration tests for `POST /api/tasks/:id/cancel` —
 * small-followups #8. Covers: auth gates, 404 on missing run, and the
 * cancel itself: one `cancel_task` RPC (0045, Q60) whatever the row's
 * status — it is the whole task, and a row that ended can have a live
 * resume after it — idempotent, with no status write of the route's own.
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
    expect(mocks.cancelTask).not.toHaveBeenCalled()
  })

  test("401 when not signed in", async () => {
    supabaseClient.value = signedOut()
    const { POST } = await import("./route")
    const res = await POST(post(), { params })
    expect(res.status).toBe(401)
    expect(mocks.cancelTask).not.toHaveBeenCalled()
  })

  test("404 when the run doesn't exist", async () => {
    mocks.getRun.mockImplementation(async () => null)
    const { POST } = await import("./route")
    const res = await POST(post(), { params })
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe("not_found")
    expect(mocks.cancelTask).not.toHaveBeenCalled()
  })
})

describe("POST /api/tasks/:id/cancel — state behaviour", () => {
  test.each([["queued"], ["running"], ["paused"], ["done"], ["failed"], ["cancelled"]])(
    "status %s → 200 through cancel_task (the whole task), no status write here",
    async (status) => {
      mocks.getRun.mockImplementation(async () => ({ id: RUN_ID, status }))
      const { POST } = await import("./route")
      const res = await POST(post(), { params })
      expect(res.status).toBe(200)
      expect((await res.json()).ok).toBe(true)
      expect(mocks.cancelTask).toHaveBeenCalledTimes(1)
      expect(mocks.cancelTask.mock.calls[0][1]).toBe(RUN_ID)
      // The RPC leaves an ended row as it is, so nothing is double-written.
      expect(mocks.updateRun).not.toHaveBeenCalled()
    },
  )

  test("scoped to runId + authed user (RLS defense-in-depth)", async () => {
    const { POST } = await import("./route")
    await POST(post(), { params })
    expect(mocks.getRun.mock.calls[0][1]).toBe(RUN_ID)
    expect(mocks.getRun.mock.calls[0][2]).toBe(USER_ID)
  })

  test("a child is cancelled the same way (the RPC skips it)", async () => {
    mocks.getRun.mockImplementation(async () => ({
      id: RUN_ID,
      status: "paused",
      parent_task_id: "44444444-4444-4444-4444-444444444444",
    }))
    const { POST } = await import("./route")
    const res = await POST(post(), { params })
    expect(res.status).toBe(200)
    expect(mocks.cancelTask.mock.calls[0][1]).toBe(RUN_ID)
  })

  test("idempotent: cancelling twice is 200 twice", async () => {
    const { POST } = await import("./route")
    expect((await POST(post(), { params })).status).toBe(200)
    expect((await POST(post(), { params })).status).toBe(200)
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
    expect(mocks.cancelTask).not.toHaveBeenCalled()
  })

  test("cancel_task throw → categorised error response", async () => {
    mocks.cancelTask.mockImplementation(async () => {
      throw new Error("update failed")
    })
    const { POST } = await import("./route")
    const res = await POST(post(), { params })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).not.toBe(200)
  })

  test("deleted meanwhile (P0002) → 404", async () => {
    const { TaskWriteError } = await import("@/server/agent/task-writes")
    mocks.cancelTask.mockImplementation(async () => {
      throw new TaskWriteError("cancel task: task not found", "P0002")
    })
    const { POST } = await import("./route")
    const res = await POST(post(), { params })
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe("not_found")
  })
})

void signedIn

/**
 * Route-handler integration tests for `POST /api/tasks/sweep` —
 * small-followups #8. Covers: auth gates, the simple pass-through to
 * `reconcileStaleRuns`, the response shape, and error mapping when
 * the store throws.
 */

import { beforeEach, describe, expect, test } from "bun:test"

import {
  mocks,
  resetAgentMocks,
  signedIn,
  signedOut,
  supabaseClient,
} from "../_test/mock-agent-store"

const USER_ID = "11111111-1111-1111-1111-111111111111"

beforeEach(resetAgentMocks)

describe("POST /api/tasks/sweep", () => {
  test("503 when Supabase isn't configured", async () => {
    supabaseClient.value = null
    const { POST } = await import("./route")
    const res = await POST()
    expect(res.status).toBe(503)
    expect(mocks.reconcileStaleRuns).not.toHaveBeenCalled()
  })

  test("401 when not signed in", async () => {
    supabaseClient.value = signedOut()
    const { POST } = await import("./route")
    const res = await POST()
    expect(res.status).toBe(401)
    expect(mocks.reconcileStaleRuns).not.toHaveBeenCalled()
  })

  test("happy path: 200 + `{ok:true, failed: N}` echoing the reconciled count", async () => {
    mocks.reconcileStaleRuns.mockImplementation(async () => 3)
    const { POST } = await import("./route")
    const res = await POST()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; failed: number }
    expect(body.ok).toBe(true)
    expect(body.failed).toBe(3)
  })

  test("reconcile zero (nothing stale) still returns 200 + failed: 0", async () => {
    const { POST } = await import("./route")
    const res = await POST()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; failed: number }
    expect(body.failed).toBe(0)
  })

  test("reconcileStaleRuns is RLS-scoped to the authed user", async () => {
    const { POST } = await import("./route")
    await POST()
    expect(mocks.reconcileStaleRuns).toHaveBeenCalledTimes(1)
    expect(mocks.reconcileStaleRuns.mock.calls[0][1]).toBe(USER_ID)
  })

  test("reconcileStaleRuns throw → categorised error response", async () => {
    mocks.reconcileStaleRuns.mockImplementation(async () => {
      throw new Error("reconcile failed")
    })
    const { POST } = await import("./route")
    const res = await POST()
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).not.toBe(200)
  })
})

void signedIn

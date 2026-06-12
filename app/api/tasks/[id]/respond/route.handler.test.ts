/**
 * Route-handler integration tests for `POST /api/tasks/:id/respond` —
 * small-followups #8. See `tasks/route.handler.test.ts` for the
 * rationale + the shared `_test/mock-agent-store` helper.
 *
 * Covers: auth, body validation, paused-state precondition (409),
 * not-found (404), local-mode-MCP rejection, the job payload shape
 * for each `requestKind` (approval / choice / input / **ui-part**), and
 * error mapping when `enqueueRespondJob` throws.
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

import type { RespondRequestInput } from "@/shared/api-schemas"

// --- Helpers ----------------------------------------------------------------

const RUN_ID = "22222222-2222-2222-2222-222222222222"
const USER_ID = "11111111-1111-1111-1111-111111111111"

function jsonPost(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/tasks/${RUN_ID}/respond`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

function rawPost(body: string): NextRequest {
  return new NextRequest(`http://localhost/api/tasks/${RUN_ID}/respond`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
  })
}

const params = Promise.resolve({ id: RUN_ID })

function pausedRun() {
  return { id: RUN_ID, status: "paused" }
}

function validBody(
  overrides: Partial<RespondRequestInput> = {},
): RespondRequestInput {
  return {
    requestId: "tu_1",
    ...overrides,
  } as RespondRequestInput
}

// --- Tests ------------------------------------------------------------------

beforeEach(() => {
  resetAgentMocks()
  // Default: a paused run exists. Override per-test for the 404 /
  // wrong-status branches.
  mocks.getRun.mockImplementation(async () => pausedRun())
})

describe("POST /api/tasks/:id/respond — auth + supabase gate", () => {
  test("503 when Supabase isn't configured", async () => {
    supabaseClient.value = null
    const { POST } = await import("./route")
    const res = await POST(jsonPost(validBody({ approved: true })), { params })
    expect(res.status).toBe(503)
    expect(mocks.enqueueRespondJob).not.toHaveBeenCalled()
  })

  test("401 when the user isn't signed in", async () => {
    supabaseClient.value = signedOut()
    const { POST } = await import("./route")
    const res = await POST(jsonPost(validBody({ approved: true })), { params })
    expect(res.status).toBe(401)
    expect(mocks.enqueueRespondJob).not.toHaveBeenCalled()
  })
})

describe("POST /api/tasks/:id/respond — body validation", () => {
  test("400 on non-JSON body", async () => {
    const { POST } = await import("./route")
    const res = await POST(rawPost("not json"), { params })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("invalid_request")
    expect(mocks.enqueueRespondJob).not.toHaveBeenCalled()
  })

  test("400 on missing requestId", async () => {
    const { POST } = await import("./route")
    const res = await POST(jsonPost({ approved: true }), { params })
    expect(res.status).toBe(400)
    expect(mocks.enqueueRespondJob).not.toHaveBeenCalled()
  })

  test("400 when local-mode MCP servers are provided", async () => {
    const { POST } = await import("./route")
    const res = await POST(
      jsonPost(
        validBody({
          approved: true,
          mcpServers: [
            {
              id: "srv-local",
              name: "local",
              url: "http://localhost:3001/mcp",
              transport: "http",
            },
          ],
        }),
      ),
      { params },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).message).toMatch(/Local-mode MCP/)
    expect(mocks.enqueueRespondJob).not.toHaveBeenCalled()
  })
})

describe("POST /api/tasks/:id/respond — state preconditions", () => {
  test("404 when the run doesn't exist", async () => {
    mocks.getRun.mockImplementation(async () => null)
    const { POST } = await import("./route")
    const res = await POST(jsonPost(validBody({ approved: true })), { params })
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe("not_found")
    expect(mocks.enqueueRespondJob).not.toHaveBeenCalled()
  })

  test.each([
    ["queued"],
    ["running"],
    ["done"],
    ["failed"],
    ["cancelled"],
  ])("409 when run status is %s (must be paused)", async (status) => {
    mocks.getRun.mockImplementation(async () => ({
      id: RUN_ID,
      status,
    }))
    const { POST } = await import("./route")
    const res = await POST(jsonPost(validBody({ approved: true })), { params })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe("invalid_state")
    expect(body.message).toMatch(new RegExp(`status=${status}`))
    expect(mocks.enqueueRespondJob).not.toHaveBeenCalled()
  })

  test("getRun is scoped to the authed user (RLS defense-in-depth)", async () => {
    const { POST } = await import("./route")
    await POST(jsonPost(validBody({ approved: true })), { params })
    expect(mocks.getRun).toHaveBeenCalledTimes(1)
    const [, runId, userId] = mocks.getRun.mock.calls[0]
    expect(runId).toBe(RUN_ID)
    expect(userId).toBe(USER_ID)
  })
})

describe("POST /api/tasks/:id/respond — payload shapes per requestKind", () => {
  test("approval kind — `approved` + optional edited `args` ride through", async () => {
    const { POST } = await import("./route")
    const res = await POST(
      jsonPost(
        validBody({ approved: true, args: { target: "edited-by-user" } }),
      ),
      { params },
    )
    expect(res.status).toBe(202)
    expect(mocks.enqueueRespondJob).toHaveBeenCalledTimes(1)
    const payload = mocks.enqueueRespondJob.mock.calls[0][1].payload
    expect(payload.requestId).toBe("tu_1")
    expect(payload.approved).toBe(true)
    expect(payload.args).toEqual({ target: "edited-by-user" })
  })

  test("approval kind — `approved=false` rides through (reject path)", async () => {
    const { POST } = await import("./route")
    await POST(jsonPost(validBody({ approved: false })), { params })
    const payload = mocks.enqueueRespondJob.mock.calls[0][1].payload
    expect(payload.approved).toBe(false)
  })

  test("choice kind — `selection` rides through", async () => {
    const { POST } = await import("./route")
    await POST(jsonPost(validBody({ selection: ["opt-a", "opt-b"] })), {
      params,
    })
    const payload = mocks.enqueueRespondJob.mock.calls[0][1].payload
    expect(payload.selection).toEqual(["opt-a", "opt-b"])
  })

  test("input kind — `value` rides through", async () => {
    const { POST } = await import("./route")
    await POST(jsonPost(validBody({ value: "Alice" })), { params })
    const payload = mocks.enqueueRespondJob.mock.calls[0][1].payload
    expect(payload.value).toBe("Alice")
  })

  test("ui-part kind — `uiAnswer` rides through (PLAN-generative-ui-parts 3a contract)", async () => {
    // The schema added `uiAnswer` in commit 3a (#184). The agent-py
    // poller parses it from the job payload. If this passthrough is
    // missing the runner only sees the back-compat `value` shim and
    // can't render an inert resolved part with the structured answer.
    const { POST } = await import("./route")
    await POST(
      jsonPost(
        validBody({
          value: "Ship",
          uiAnswer: { kind: "confirm", confirmed: true },
        }),
      ),
      { params },
    )
    const payload = mocks.enqueueRespondJob.mock.calls[0][1].payload
    expect(payload.uiAnswer).toEqual({ kind: "confirm", confirmed: true })
    // The back-compat shim still rides through too.
    expect(payload.value).toBe("Ship")
  })

  test("omitted fields are not present on the payload (no `undefined` keys)", async () => {
    // Conditional spread keeps the job row minimal — a downstream
    // poller that distinguishes "key absent" from "key=null" doesn't
    // pick up spurious nulls.
    const { POST } = await import("./route")
    await POST(jsonPost(validBody({ approved: true })), { params })
    const payload = mocks.enqueueRespondJob.mock.calls[0][1].payload
    expect(payload.requestId).toBe("tu_1")
    expect(payload.approved).toBe(true)
    expect("selection" in payload).toBe(false)
    expect("value" in payload).toBe(false)
    expect("uiAnswer" in payload).toBe(false)
    expect("args" in payload).toBe(false)
  })

  test("the enqueue is scoped to runId + authed user", async () => {
    const { POST } = await import("./route")
    await POST(jsonPost(validBody({ approved: true })), { params })
    const arg = mocks.enqueueRespondJob.mock.calls[0][1]
    expect(arg.taskId).toBe(RUN_ID)
    expect(arg.userId).toBe(USER_ID)
  })
})

describe("POST /api/tasks/:id/respond — store / queue failures", () => {
  test("enqueueRespondJob throw → typed error response", async () => {
    mocks.enqueueRespondJob.mockImplementation(async () => {
      throw new Error("queue insert failed")
    })
    const { POST } = await import("./route")
    const res = await POST(jsonPost(validBody({ approved: true })), { params })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).not.toBe(202)
  })
})

void signedIn // imported for symmetry with other route handler tests

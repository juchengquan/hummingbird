/**
 * Route-handler integration tests for `POST /api/tasks` — small-followups #8.
 *
 * The pure logic in the agent stack (`reduceRun`, `RunEmitter`,
 * `makeStreamTextStep` control flow, the SSE decoder) is unit-tested
 * upstream. THIS file exercises the HTTP handler itself: auth,
 * body validation, conditional rejections, the order of operations
 * across `createTaskRun` → synthetic queued event →
 * `enqueueStartJob`, and error-status mapping. The Supabase client +
 * store + jobs are mocked via the shared `_test/mock-agent-store.ts`
 * helper so each test runs in <50 ms without touching a real database.
 *
 * Mock-module note: `mock.module` is process-global, so the shared
 * helper registers the **union** of every store/jobs export every
 * task route imports. The order in which test files load doesn't
 * matter — the route under test always sees the full surface.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { NextRequest } from "next/server"

import {
  mocks,
  resetAgentMocks,
  signedOut,
  supabaseClient,
} from "./_test/mock-agent-store"

import type { ChatRequestInput, TaskRequestInput } from "@/shared/api-schemas"

// --- Helpers ----------------------------------------------------------------

function jsonPost(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tasks", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

function rawPost(body: string): NextRequest {
  return new NextRequest("http://localhost/api/tasks", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
  })
}

function validBody(
  overrides: Partial<TaskRequestInput> = {},
): TaskRequestInput {
  return {
    messages: [{ role: "user", content: "Write a haiku about birds." }],
    conversationId: "conv-1",
    model: "anthropic/claude-haiku-4.5",
    ...overrides,
  } as TaskRequestInput
}

// --- Tests ------------------------------------------------------------------

beforeEach(resetAgentMocks)

describe("POST /api/tasks — auth + supabase gate", () => {
  test("503 when Supabase isn't configured", async () => {
    supabaseClient.value = null
    const { POST } = await import("./route")
    const res = await POST(jsonPost(validBody()))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("unavailable")
    expect(mocks.createTaskRun).not.toHaveBeenCalled()
  })

  test("401 when the user isn't signed in", async () => {
    supabaseClient.value = signedOut()
    const { POST } = await import("./route")
    const res = await POST(jsonPost(validBody()))
    expect(res.status).toBe(401)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("auth")
    expect(mocks.createTaskRun).not.toHaveBeenCalled()
  })
})

describe("POST /api/tasks — body validation", () => {
  test("400 on non-JSON body", async () => {
    const { POST } = await import("./route")
    const res = await POST(rawPost("not json"))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("invalid_request")
  })

  test("400 on schema fail (missing required fields)", async () => {
    const { POST } = await import("./route")
    const res = await POST(jsonPost({ messages: [] }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe("invalid_request")
    expect(body.message).toBeTruthy()
  })

  test("400 when local-mode MCP servers are provided", async () => {
    // The async worker has no path to browser-held creds, so the route
    // rejects up front. Silently dropping would surface as
    // tool-not-found errors deeper in.
    const { POST } = await import("./route")
    const mcpServers: ChatRequestInput["mcpServers"] = [
      {
        id: "srv-local",
        name: "local",
        url: "http://localhost:3001/mcp",
        transport: "http",
      },
    ]
    const res = await POST(jsonPost(validBody({ mcpServers })))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe("invalid_request")
    expect(body.message).toMatch(/Local-mode MCP/)
    expect(mocks.createTaskRun).not.toHaveBeenCalled()
  })
})

describe("POST /api/tasks — a model the worker can't run (Q55)", () => {
  test.each([
    ["auto"],
    ["deepseek/deepseek-v4-flash"],
    ["claude-sonnet-4-6"],
    ["anthropic/claude-sonnet-4-5"],
    ["nobody/nothing"],
  ])("%s → 400 unknown_model, nothing created", async (model) => {
    const { POST } = await import("./route")
    const res = await POST(jsonPost(validBody({ model })))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe("unknown_model")
    expect(body.message).toBeTruthy()
    expect(mocks.createTaskRun).not.toHaveBeenCalled()
    expect(mocks.appendEvent).not.toHaveBeenCalled()
    expect(mocks.enqueueStartJob).not.toHaveBeenCalled()
  })

  test("the resolved default counts too", async () => {
    const { DEFAULT_CHAT_MODEL } = await import("@/shared/models")
    const { backendAcceptsModel } = await import("@/shared/backend-models")
    const { POST } = await import("./route")
    const res = await POST(jsonPost(validBody({ model: undefined })))
    expect(res.status).toBe(backendAcceptsModel("agent-service", DEFAULT_CHAT_MODEL) ? 202 : 400)
    if (res.status === 400) {
      expect((await res.json()).code).toBe("unknown_model")
      expect(mocks.createTaskRun).not.toHaveBeenCalled()
    }
  })

  test("every accepted model starts", async () => {
    const { modelsForBackend } = await import("@/shared/backend-models")
    const { POST } = await import("./route")
    for (const { id } of modelsForBackend("agent-service")) {
      expect((await POST(jsonPost(validBody({ model: id })))).status).toBe(202)
    }
  })
})

describe("POST /api/tasks — parts the worker can't give the model (B20)", () => {
  const parts = (part: unknown) =>
    validBody({
      messages: [{ role: "user", content: [{ type: "text", text: "Read" }, part] }],
    } as Partial<TaskRequestInput>)

  test.each([
    ["audio", { type: "file", mediaType: "audio/mpeg", data: "AAAA" }],
    ["no bytes", { type: "file", mediaType: "text/plain", data: "" }],
    ["not a string", { type: "file", mediaType: "application/pdf", data: { a: 1 } }],
    ["text by URL", { type: "file", mediaType: "text/plain", data: "https://x.test/a.txt" }],
    ["not base64", { type: "file", mediaType: "text/plain", data: "hello notes!" }],
  ])("%s → 400 invalid_attachment, nothing created", async (_name, part) => {
    const { POST } = await import("./route")
    const res = await POST(jsonPost(parts(part)))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("invalid_attachment")
    expect(mocks.createTaskRun).not.toHaveBeenCalled()
  })

  test.each([
    ["pdf", { type: "file", mediaType: "application/pdf", data: "JVBERi0=" }],
    ["pdf by URL", { type: "file", mediaType: "application/pdf", data: "https://x.test/a.pdf" }],
    ["text", { type: "file", mediaType: "text/markdown", data: "aGVsbG8=" }],
    ["text data URI", { type: "file", mediaType: "text/plain", data: "data:text/plain,hi%20you" }],
    ["image file", { type: "file", mediaType: "image/png", data: "cG5n" }],
    ["image", { type: "image", image: "data:image/png;base64,cG5n" }],
  ])("%s → accepted", async (_name, part) => {
    const { POST } = await import("./route")
    expect((await POST(jsonPost(parts(part)))).status).toBe(202)
  })
})

describe("POST /api/tasks — happy path", () => {
  test("returns 202 + runId; runs the persistence chain in order", async () => {
    const { POST } = await import("./route")
    const res = await POST(jsonPost(validBody()))
    expect(res.status).toBe(202)
    const body = (await res.json()) as { runId: string }
    expect(body.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )

    // The chain is: createTaskRun (run row + checkpoint, one RPC) →
    // appendEvent (queued) → enqueueStartJob. The queued event is the
    // client's first signal; the job must come last.
    expect(mocks.createTaskRun).toHaveBeenCalledTimes(1)
    expect(mocks.saveCheckpoint).not.toHaveBeenCalled()
    expect(mocks.appendEvent).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueStartJob).toHaveBeenCalledTimes(1)

    // All four writes share the same runId we returned.
    const createInput = mocks.createTaskRun.mock.calls[0][1] as {
      id: string
      conversationId: string
      maxSteps: number
    }
    expect(createInput.id).toBe(body.runId)
    expect(createInput.conversationId).toBe("conv-1")
    expect(createInput.maxSteps).toBe(25)
    const queuedEvent = mocks.appendEvent.mock.calls[0][1] as {
      runId: string
      kind: string
      status: string
      seq: number
    }
    expect(queuedEvent.runId).toBe(body.runId)
    expect(queuedEvent.kind).toBe("status")
    expect(queuedEvent.status).toBe("queued")
    expect(queuedEvent.seq).toBe(1)
    const jobArgs = mocks.enqueueStartJob.mock.calls[0][1] as {
      taskId: string
    }
    expect(jobArgs.taskId).toBe(body.runId)
  })

  test("persists the request shape onto the initial checkpoint", async () => {
    const { POST } = await import("./route")
    const reqBody = validBody({
      model: "anthropic/claude-sonnet-4.6",
      workspaceId: "ws-A",
      workspaceSystemPrompt: "Speak in haiku.",
      maxSteps: 12,
      requireApprovalFor: ["mcp__danger__write"],
      mode: "research",
    })
    await POST(jsonPost(reqBody))

    const checkpoint = (mocks.createTaskRun.mock.calls[0][1] as { checkpoint: unknown }).checkpoint as {
      messages: unknown[]
      step: number
      seq: number
      config: {
        model: string
        workspaceId: string
        workspaceSystemPrompt: string
        maxSteps: number
        requireApprovalFor: string[]
        mode: string
      }
    }
    expect(checkpoint.messages).toEqual(reqBody.messages)
    expect(checkpoint.step).toBe(0)
    expect(checkpoint.seq).toBe(1)
    expect(checkpoint.config.model).toBe("anthropic/claude-sonnet-4.6")
    expect(checkpoint.config.workspaceId).toBe("ws-A")
    expect(checkpoint.config.workspaceSystemPrompt).toBe("Speak in haiku.")
    expect(checkpoint.config.maxSteps).toBe(12)
    expect(checkpoint.config.requireApprovalFor).toEqual([
      "mcp__danger__write",
    ])
    expect(checkpoint.config.mode).toBe("research")
  })

  test("schema caps maxSteps at 50; over → 400 with no persistence", async () => {
    const { POST } = await import("./route")
    await POST(jsonPost(validBody({ maxSteps: 50 })))
    const checkpoint = (mocks.createTaskRun.mock.calls[0][1] as { checkpoint: unknown }).checkpoint as {
      config: { maxSteps: number }
    }
    expect(checkpoint.config.maxSteps).toBe(50)
    mocks.createTaskRun.mockClear()
    const res = await POST(jsonPost(validBody({ maxSteps: 999 })))
    expect(res.status).toBe(400)
    expect(mocks.createTaskRun).not.toHaveBeenCalled()
  })

  test("research mode bumps the default maxSteps (35 > 25)", async () => {
    const { POST } = await import("./route")
    await POST(jsonPost(validBody({ mode: "research" })))
    const checkpoint = (mocks.createTaskRun.mock.calls[0][1] as { checkpoint: unknown }).checkpoint as {
      config: { maxSteps: number }
    }
    expect(checkpoint.config.maxSteps).toBe(35)
  })

  test("queued event carries maxSteps for the client's progress bar", async () => {
    const { POST } = await import("./route")
    await POST(jsonPost(validBody({ maxSteps: 8 })))
    const queuedEvent = mocks.appendEvent.mock.calls[0][1] as {
      maxSteps: number
    }
    expect(queuedEvent.maxSteps).toBe(8)
  })

  test("a queued-event write failure does NOT block enqueuing the job", async () => {
    // The route logs and continues — the client's first signal can be
    // late, but the job MUST get enqueued or the run never starts.
    mocks.appendEvent.mockImplementation(async () => {
      throw new Error("postgres unreachable")
    })
    const { POST } = await import("./route")
    const res = await POST(jsonPost(validBody()))
    expect(res.status).toBe(202)
    expect(mocks.enqueueStartJob).toHaveBeenCalledTimes(1)
  })
})

describe("POST /api/tasks — store failures map to typed responses", () => {
  test("createTaskRun throw → typed error response; no job enqueued", async () => {
    mocks.createTaskRun.mockImplementation(async () => {
      throw new Error("unique constraint violation")
    })
    const { POST } = await import("./route")
    const res = await POST(jsonPost(validBody()))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(mocks.enqueueStartJob).not.toHaveBeenCalled()
  })

  test("create_task_run SQLSTATEs map to typed statuses; no job enqueued", async () => {
    const { TaskWriteError } = await import("@/server/agent/task-writes")
    const { POST } = await import("./route")
    const cases: Array<[string, number, string]> = [
      ["P0002", 404, "not_found"], // conversation isn't the caller's
      ["22023", 400, "invalid_request"], // bad maxSteps / checkpoint
      ["42501", 403, "forbidden"],
    ]
    for (const [sqlState, status, code] of cases) {
      mocks.createTaskRun.mockImplementation(async () => {
        throw new TaskWriteError("createTaskRun: rejected", sqlState)
      })
      const res = await POST(jsonPost(validBody()))
      expect(res.status).toBe(status)
      expect(((await res.json()) as { code: string }).code).toBe(code)
    }
    expect(mocks.enqueueStartJob).not.toHaveBeenCalled()
  })

  test("enqueue_task_job queue cap (54000) → 409 limit_reached", async () => {
    const { TaskWriteError } = await import("@/server/agent/task-writes")
    mocks.enqueueStartJob.mockImplementation(async () => {
      throw new TaskWriteError("enqueue start: too many queued jobs", "54000")
    })
    const { POST } = await import("./route")
    const res = await POST(jsonPost(validBody()))
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe("limit_reached")
    // No queued orphan (B18): the run just created is settled failed, and
    // only while still queued.
    expect(mocks.appendSyntheticResult).toHaveBeenCalledTimes(1)
    const [, failedRun, , opts] = mocks.appendSyntheticResult.mock.calls[0]
    expect(failedRun).toBe((mocks.createTaskRun.mock.calls[0][1] as { id: string }).id)
    expect(opts).toMatchObject({ status: "failed", from: ["queued"] })
  })

  test("enqueueStartJob throw surfaces an error response", async () => {
    mocks.enqueueStartJob.mockImplementation(async () => {
      throw new Error("queue write failed")
    })
    const { POST } = await import("./route")
    const res = await POST(jsonPost(validBody()))
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

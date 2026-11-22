import { describe, expect, test } from "bun:test"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "@/shared/supabase/types"

import type { RunCheckpoint } from "./checkpoint"
import { enqueueRespondJob, enqueueStartJob } from "./jobs"
import {
  TaskWriteError,
  cancelTask,
  createTaskRun,
  enqueueTaskJob,
  taskWriteErrorResponse,
} from "./task-writes"

type RpcResult = { data: unknown; error: { message: string; code?: string } | null }

/** A client whose only surface is `rpc`, recording every call. Any
 *  direct table write would throw (`from` is absent) — the point of
 *  0034 is that these paths never touch the tables directly. */
function fakeDb(result: RpcResult = { data: "job-1", error: null }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      return result
    },
  }
  return { db: db as unknown as SupabaseClient<Database>, calls }
}

const checkpoint: RunCheckpoint = {
  messages: [{ role: "user", content: "hi" }],
  step: 0,
  seq: 1,
  config: { model: "anthropic/claude-sonnet-4.6", skills: [], maxSteps: 12 },
}

describe("cancelTask", () => {
  test("calls cancel_task with the task alone (the owner is the caller's JWT)", async () => {
    const { db, calls } = fakeDb({ data: null, error: null })
    await cancelTask(db, "run-1")
    expect(calls).toEqual([{ fn: "cancel_task", args: { p_task_id: "run-1" } }])
  })

  test("an RPC error keeps its SQLSTATE", async () => {
    const { db } = fakeDb({ data: null, error: { message: "task not found", code: "P0002" } })
    const error = await cancelTask(db, "run-1").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TaskWriteError)
    expect(taskWriteErrorResponse(error)?.status).toBe(404)
  })
})

describe("createTaskRun", () => {
  test("calls create_task_run with the run + checkpoint", async () => {
    const { db, calls } = fakeDb({ data: null, error: null })
    await createTaskRun(db, {
      id: "run-1",
      conversationId: "conv-1",
      goal: "do it",
      maxSteps: 12,
      checkpoint,
    })
    expect(calls).toEqual([
      {
        fn: "create_task_run",
        args: {
          p_id: "run-1",
          p_conversation_id: "conv-1",
          p_goal: "do it",
          p_max_steps: 12,
          p_checkpoint: checkpoint,
        },
      },
    ])
  })

  test("an RPC error throws TaskWriteError carrying the SQLSTATE", async () => {
    const { db } = fakeDb({
      data: null,
      error: { message: "conversation not found", code: "P0002" },
    })
    const err = await createTaskRun(db, {
      id: "run-1",
      conversationId: "someone-elses",
      goal: "",
      maxSteps: 5,
      checkpoint,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TaskWriteError)
    expect((err as TaskWriteError).sqlState).toBe("P0002")
  })
})

describe("enqueueTaskJob + jobs.ts helpers", () => {
  test("start → enqueue_task_job with an empty payload; returns the job id", async () => {
    const { db, calls } = fakeDb()
    const id = await enqueueTaskJob(db, { taskId: "run-1", action: "start" })
    expect(id).toBe("job-1")
    expect(calls).toEqual([
      { fn: "enqueue_task_job", args: { p_task_id: "run-1", p_action: "start", p_payload: {} } },
    ])
  })

  test("scheduledAt is forwarded as ISO (the RPC clamps it)", async () => {
    const { db, calls } = fakeDb()
    await enqueueTaskJob(db, {
      taskId: "run-1",
      action: "start",
      scheduledAt: new Date("2026-01-01T00:00:00Z"),
    })
    expect(calls[0].args.p_scheduled_at).toBe("2026-01-01T00:00:00.000Z")
  })

  test("enqueueStartJob / enqueueRespondJob go through the RPC, never a table insert", async () => {
    const { db, calls } = fakeDb()
    await enqueueStartJob(db, { taskId: "run-1", userId: "u-1" })
    await enqueueRespondJob(db, {
      taskId: "run-1",
      userId: "u-1",
      payload: { requestId: "tu_1", approved: true },
    })
    expect(calls.map((c) => [c.fn, c.args.p_action])).toEqual([
      ["enqueue_task_job", "start"],
      ["enqueue_task_job", "respond"],
    ])
    expect(calls[1].args.p_payload).toEqual({ requestId: "tu_1", approved: true })
    // The owner is derived from the task row server-side.
    expect(calls[0].args).not.toHaveProperty("p_user_id")
  })

  test("RPC errors surface as TaskWriteError", async () => {
    const { db } = fakeDb({ data: null, error: { message: "task is not paused", code: "55000" } })
    const err = await enqueueRespondJob(db, {
      taskId: "run-1",
      userId: "u-1",
      payload: { requestId: "tu_1" },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TaskWriteError)
    expect((err as TaskWriteError).sqlState).toBe("55000")
  })
})

describe("taskWriteErrorResponse", () => {
  test.each([
    ["42501", 403, "forbidden"],
    ["P0002", 404, "not_found"],
    ["22023", 400, "invalid_request"],
    ["55000", 409, "invalid_state"],
    ["54000", 409, "limit_reached"],
  ])("SQLSTATE %s → %i %s", (sqlState, status, code) => {
    const mapped = taskWriteErrorResponse(new TaskWriteError("nope", sqlState))
    expect(mapped).toEqual({ status, code, message: "nope" })
  })

  test("accepts a raw PostgREST error object", () => {
    expect(taskWriteErrorResponse({ code: "54000", message: "schedule limit reached" })).toEqual({
      status: 409,
      code: "limit_reached",
      message: "schedule limit reached",
    })
  })

  test("unknown SQLSTATEs and non-errors fall through (null)", () => {
    expect(taskWriteErrorResponse(new TaskWriteError("x", "XX000"))).toBeNull()
    expect(taskWriteErrorResponse(new TaskWriteError("x"))).toBeNull()
    expect(taskWriteErrorResponse(new Error("plain"))).toBeNull()
    expect(taskWriteErrorResponse(null)).toBeNull()
  })
})

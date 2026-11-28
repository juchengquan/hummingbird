/**
 * The background-run calls against a fake `fetch`: the 202 start (and its
 * idempotent retry), the list's query string, in-place answers, the
 * delivered mark, and a refreshed token after a 401.
 */
import { describe, expect, test } from "bun:test"

import {
  answerRun,
  listRuns,
  listRunsQueryString,
  markRunDelivered,
  resumeBackgroundRun,
  startBackgroundRun,
} from "./background"
import { RunsError } from "./errors"
import { fakeFetch } from "./fixtures"
import type { RunsTarget, StartRunRequest } from "./types"

const TARGET: RunsTarget = { baseUrl: "https://agent.example", authToken: "jwt" }
const RUN = "8a6e0804-0000-4000-8000-00000000f907"
const BODY: StartRunRequest = {
  threadId: "11111111-2222-4333-8444-555555555555",
  runId: RUN,
  messages: [{ id: "u1", role: "user", content: "hi" }],
  forwardedProps: { mode: "background" },
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

describe("background runs", () => {
  test("start: a JSON POST with the bearer, 202 → the run id and status", async () => {
    const { fetch, calls } = fakeFetch(() => json({ runId: RUN, status: "queued" }, 202))
    expect(await startBackgroundRun(BODY, { target: TARGET, fetch })).toEqual({ runId: RUN, status: "queued" })
    expect(calls[0]).toMatchObject({
      url: "https://agent.example/v1/runs",
      method: "POST",
      headers: { Authorization: "Bearer jwt", "Content-Type": "application/json", Accept: "application/json" },
      body: BODY,
    })
  })

  test("start refuses an interactive body and an anonymous target before any request", async () => {
    const { fetch, calls } = fakeFetch(() => json({}))
    await expect(
      startBackgroundRun({ ...BODY, forwardedProps: {} }, { target: TARGET, fetch }),
    ).rejects.toMatchObject({ code: "invalid_request" })
    await expect(
      startBackgroundRun(BODY, { target: { baseUrl: "", authToken: null }, fetch }),
    ).rejects.toMatchObject({ code: "auth_required" })
    expect(calls).toHaveLength(0)
  })

  test("start: the refusals keep their codes", async () => {
    for (const code of ["limit_reached", "run_already_resumed", "run_answer_applied", "not_found"]) {
      const { fetch } = fakeFetch(() => json({ code, message: code }, code === "not_found" ? 404 : 409))
      const err = await startBackgroundRun(BODY, { target: TARGET, fetch }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(RunsError)
      expect(err).toMatchObject({ kind: "http", code })
    }
  })

  test("resume: background, previousRunId, resume[], no history", async () => {
    const { fetch, calls } = fakeFetch(() => json({ runId: "r1", status: "queued" }, 202))
    await resumeBackgroundRun(
      { runId: "r1", threadId: BODY.threadId, previousRunId: RUN, resume: [{ interruptId: "q", status: "cancelled" }] },
      { target: TARGET, fetch },
    )
    expect(calls[0].body).toEqual({
      threadId: BODY.threadId,
      runId: "r1",
      messages: [],
      resume: [{ interruptId: "q", status: "cancelled" }],
      forwardedProps: { mode: "background", previousRunId: RUN },
    })
  })

  test("list: the task filters as query parameters, status repeated", async () => {
    expect(
      listRunsQueryString({
        mode: "background",
        topLevel: true,
        current: true,
        delivered: false,
        status: ["succeeded", "failed"],
        pageSize: 50,
      }),
    ).toBe("?mode=background&topLevel=true&current=true&delivered=false&status=succeeded&status=failed&pageSize=50")
    const { fetch, calls } = fakeFetch(() => json({ runs: [], nextPageToken: null }))
    expect(await listRuns({ parentRunId: RUN }, { target: TARGET, fetch })).toEqual({ runs: [], nextPageToken: null })
    expect(calls[0].url).toBe(`https://agent.example/v1/runs?parentRunId=${RUN}`)
  })

  test("answer and delivered: POSTs on the run", async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: RUN, status: "interrupted", answerPending: true }, 202))
    await answerRun(RUN, [{ interruptId: "q", status: "resolved", payload: { approved: true } }], { target: TARGET, fetch })
    await markRunDelivered(RUN, { target: TARGET, fetch })
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", `https://agent.example/v1/runs/${RUN}/answers`],
      ["POST", `https://agent.example/v1/runs/${RUN}/delivered`],
    ])
    expect(calls[0].body).toEqual({ resume: [{ interruptId: "q", status: "resolved", payload: { approved: true } }] })
    expect(calls[1].body).toBeUndefined()
  })

  test("a 401 refreshes the token once and retries", async () => {
    let token = "old"
    const target: RunsTarget = {
      ...TARGET,
      getAuthToken: async (refresh) => {
        if (refresh) token = "new"
        return token
      },
    }
    const { fetch, calls } = fakeFetch((c) =>
      c.headers.Authorization === "Bearer new" ? json({ runs: [], nextPageToken: null }) : json({ code: "auth" }, 401),
    )
    await listRuns({}, { target, fetch })
    expect(calls.map((c) => c.headers.Authorization)).toEqual(["Bearer old", "Bearer new"])
  })
})

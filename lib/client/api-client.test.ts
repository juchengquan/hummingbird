/**
 * Tests for the api-client's agent-py calls (wave 13, Q142: agent-py is
 * the only backend). Each test drives a method with an explicit `target`
 * (agent-py's base URL + a token, or tokenless) and a stubbed fetch, and
 * asserts that the URL, Authorization header, and body wire shape match.
 *
 * The session-driven default (`resolveAgentPyTarget`) is covered by the
 * resolver tests in `api/backend-resolver.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { notifyAuthRequired, resetAuthRequiredNotice } from "./auth/auth-required"
import { apiClient, isAuthRequiredResult, type AgentPyTarget } from "./api-client"

const REMOTE: AgentPyTarget = {
  baseUrl: "https://agent-py.example",
  authToken: "jwt-test-token",
}

interface FetchCall {
  url: string
  method: string
  authorization?: string
  contentType?: string
  credentials?: RequestCredentials
  body?: unknown
}

const originalFetch = globalThis.fetch

function installFetchStub(response: {
  status?: number
  jsonBody?: unknown
}): FetchCall[] {
  const log: FetchCall[] = []
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input.toString()
    const method = init?.method ?? "GET"
    const headers = (init?.headers ?? {}) as Record<string, string>
    let body: unknown
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    log.push({
      url,
      method,
      authorization: headers["Authorization"] ?? headers["authorization"],
      contentType: headers["Content-Type"] ?? headers["content-type"],
      credentials: init?.credentials,
      body,
    })
    return new Response(JSON.stringify(response.jsonBody ?? {}), {
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
  return log
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("apiClient.url.fetch — dispatch", () => {

  test("remote dispatch posts to {baseUrl}/v1/url/fetch with bearer JWT", async () => {
    const log = installFetchStub({
      jsonBody: {
        ok: true,
        bookmark: {
          url: "https://example.com",
          title: "x",
          content: "",
          contentTruncated: false,
          contentHash: "0",
        },
      },
    })
    const result = await apiClient.url.fetch("https://example.com", {
      target: REMOTE,
    })
    expect(result.ok).toBe(true)
    expect(log[0].url).toBe("https://agent-py.example/v1/url/fetch")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
    expect(log[0].body).toEqual({ url: "https://example.com" })
  })
})

describe("apiClient.summarize — dispatch", () => {
  test("remote dispatch posts to {baseUrl}/v1/summarize for every mode", async () => {
    const log = installFetchStub({ jsonBody: { summary: "ok" } })
    await apiClient.summarize.file(
      { mode: "file", name: "n", text: "t" },
      { target: REMOTE },
    )
    await apiClient.summarize.conversation(
      {
        mode: "conversation",
        messages: [{ role: "user", content: "hi" }],
      },
      { target: REMOTE },
    )
    await apiClient.summarize.compress(
      {
        mode: "compress",
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
        ],
      },
      { target: REMOTE },
    )
    await apiClient.summarize.projectBreakdown(
      { mode: "project-breakdown", goal: "ship it" },
      { target: REMOTE },
    )
    expect(log).toHaveLength(4)
    for (const call of log) {
      expect(call.url).toBe("https://agent-py.example/v1/summarize")
      expect(call.authorization).toBe("Bearer jwt-test-token")
    }
    // Wire shape passes through unchanged — agent-py accepts the
    // camelCase TS shape directly (`existingTitles` via
    // `populate_by_name`).
    expect((log[0].body as { mode: string }).mode).toBe("file")
    expect((log[3].body as { mode: string }).mode).toBe("project-breakdown")
  })
})

describe("apiClient.mcp.proxy — dispatch", () => {
  test("remote dispatch posts to {baseUrl}/v1/mcp/{id}/{action} with bearer JWT", async () => {
    const log = installFetchStub({ jsonBody: { capabilities: {} } })
    const result = await apiClient.mcp.proxy(
      "discover",
      {
        server: { id: "srv-1", name: "x", url: "https://mcp.test", transport: "http" },
      },
      { target: REMOTE },
    )
    expect(result.ok).toBe(true)
    expect(log[0].url).toBe("https://agent-py.example/v1/mcp/srv-1/discover")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
  })

  test("server id path component is URL-encoded", async () => {
    installFetchStub({ jsonBody: { capabilities: {} } })
    const log = installFetchStub({ jsonBody: { capabilities: {} } })
    await apiClient.mcp.proxy(
      "discover",
      {
        server: {
          id: "srv with spaces",
          name: "x",
          url: "https://mcp.test",
          transport: "http",
        },
      },
      { target: REMOTE },
    )
    expect(log[0].url).toBe(
      "https://agent-py.example/v1/mcp/srv%20with%20spaces/discover",
    )
  })
})

describe("apiClient.images.refreshUrl — dispatch + wire shape", () => {
  test("remote dispatch converts storagePath → storage_path", async () => {
    const log = installFetchStub({
      jsonBody: { url: "https://cdn.example/signed" },
    })
    const url = await apiClient.images.refreshUrl("u-1/generated/img.png", {
      target: REMOTE,
    })
    expect(url).toBe("https://cdn.example/signed")
    expect(log[0].url).toBe("https://agent-py.example/v1/images/refresh-url")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
    expect(log[0].body).toEqual({ storage_path: "u-1/generated/img.png" })
  })
})

// Account-bound endpoints on agent-py.
describe("apiClient.files.refreshUrl — agent-py-only dispatch", () => {
  const storagePath = "u-1/generated/f1-report.csv"
  const signed = { url: "https://cdn.example/signed" }

  test("python → agent-py /v1/files/refresh-url, camelCase body", async () => {
    const log = installFetchStub({ jsonBody: signed })
    const url = await apiClient.files.refreshUrl(storagePath, {
      target: REMOTE,
    })
    expect(url).toBe(signed.url)
    expect(log).toHaveLength(1)
    expect(log[0].url).toBe("https://agent-py.example/v1/files/refresh-url")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
    expect(log[0].body).toEqual({ storagePath })
  })
})

describe("apiClient.artifacts.extractTable — agent-py-only dispatch", () => {
  const body = {
    reportText: "r",
    sources: [{ title: "t", url: "https://x.test", snippet: "s" }],
    columnHints: ["Price"],
  }
  const table = {
    columns: [{ id: "price", label: "Price", type: "text" as const }],
    rows: [],
    sources: [{ id: "s1", title: "t", url: "https://x.test", snippet: "s" }],
  }

  test("python → agent-py /v1/extract-table, body unchanged", async () => {
    const log = installFetchStub({ jsonBody: table })
    const res = await apiClient.artifacts.extractTable(body, {
      target: REMOTE,
    })
    expect(res).toEqual(table)
    expect(log).toHaveLength(1)
    expect(log[0].url).toBe("https://agent-py.example/v1/extract-table")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
    expect(log[0].body).toEqual(body)
  })
})

describe("apiClient.embed.file — agent-py-only dispatch", () => {
  const body = { fileId: "f-1", text: "hello" }
  const indexed = { status: "indexed" as const, sections: 1 }

  test("python → agent-py /v1/embed, body unchanged", async () => {
    const log = installFetchStub({ jsonBody: indexed })
    const res = await apiClient.embed.file(body, { target: REMOTE })
    expect(res).toEqual(indexed)
    expect(log).toHaveLength(1)
    expect(log[0].url).toBe("https://agent-py.example/v1/embed")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
    expect(log[0].body).toEqual(body)
  })

  test("a failed call resolves null", async () => {
    installFetchStub({ status: 500, jsonBody: { code: "embed_failed", message: "x" } })
    expect(await apiClient.embed.file(body, { target: REMOTE })).toBeNull()
  })
})

describe("apiClient.memory.extract — agent-py-only dispatch", () => {
  const body = { turnText: "User: I write Rust.", conversationId: "c-1" }

  test("python → agent-py /v1/memory/extract, body unchanged", async () => {
    const log = installFetchStub({ jsonBody: { ok: true } })
    const ok = await apiClient.memory.extract(body, { target: REMOTE })
    expect(ok).toBe(true)
    expect(log).toHaveLength(1)
    expect(log[0].url).toBe("https://agent-py.example/v1/memory/extract")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
    expect(log[0].body).toEqual(body)
  })

  test("a non-OK or off-schema answer resolves false", async () => {
    installFetchStub({ status: 401, jsonBody: { detail: "Invalid token." } })
    expect(await apiClient.memory.extract(body, { target: REMOTE })).toBe(false)
    installFetchStub({ jsonBody: { ok: "yes" } })
    expect(await apiClient.memory.extract(body, { target: REMOTE })).toBe(false)
  })
})

describe("apiClient.share.create — agent-py-only dispatch", () => {
  const body = {
    kind: "conversation" as const,
    conversationId: "10000000-0000-4000-8000-000000000001",
  }
  const created = { token: "abcdefghijklmnopqrstuv", kind: "conversation" as const }

  test("python → agent-py /v1/share with bearer, body unchanged", async () => {
    const log = installFetchStub({ jsonBody: created })
    const res = await apiClient.share.create(body, { target: REMOTE })
    expect(res).toEqual({ ok: true, status: 200, data: created })
    expect(log).toHaveLength(1)
    expect(log[0].url).toBe("https://agent-py.example/v1/share")
    expect(log[0].method).toBe("POST")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
    expect(log[0].body).toEqual(body)
  })

  test("error → message from either envelope ({ error } / { code, message })", async () => {
    installFetchStub({ status: 404, jsonBody: { error: "Conversation not found" } })
    expect(await apiClient.share.create(body, { target: REMOTE })).toEqual({
      ok: false,
      status: 404,
      error: "Conversation not found",
    })
    installFetchStub({
      status: 404,
      jsonBody: { code: "not_found", message: "Conversation not found" },
    })
    expect(
      await apiClient.share.create(body, { target: REMOTE }),
    ).toEqual({ ok: false, status: 404, error: "Conversation not found" })
  })
})

describe("apiClient.share.revoke — agent-py-only dispatch", () => {
  const token = "abc/def+ghi"

  test("python → DELETE agent-py /v1/share/{token} with bearer, no body", async () => {
    const log = installFetchStub({ jsonBody: { ok: true } })
    const res = await apiClient.share.revoke(token, { target: REMOTE })
    expect(res).toEqual({ ok: true, status: 200 })
    expect(log).toHaveLength(1)
    expect(log[0].url).toBe("https://agent-py.example/v1/share/abc%2Fdef%2Bghi")
    expect(log[0].method).toBe("DELETE")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
    expect(log[0].body).toBeUndefined()
    expect(log[0].contentType).toBeUndefined()
  })

  test("404 → not ok with the message", async () => {
    installFetchStub({ status: 404, jsonBody: { error: "Not found" } })
    expect(await apiClient.share.revoke(token, { target: REMOTE })).toEqual({
      ok: false,
      status: 404,
      error: "Not found",
    })
  })
})

describe("apiClient.share.resolve — public backend read", () => {
  const conversation = {
    kind: "conversation",
    conversationTitle: "Alice chat",
    messages: [
      { id: "m1", role: "user", content: "hi", reasoning: null, position: 1 },
      { id: "m2", role: "assistant", content: "hello", reasoning: "think", position: 2 },
    ],
    createdAt: "2026-01-01T12:30:00Z",
  }

  test("GET {base}/v1/share/{token}, anonymous (no bearer, no cookies)", async () => {
    const log = installFetchStub({ jsonBody: conversation })
    const res = await apiClient.share.resolve("tok/1", { baseUrl: "https://agent-py.example" })
    expect(res).toEqual({ ok: true, status: 200, data: conversation as never })
    expect(log).toHaveLength(1)
    expect(log[0].url).toBe("https://agent-py.example/v1/share/tok%2F1")
    expect(log[0].method).toBe("GET")
    expect(log[0].authorization).toBeUndefined()
    expect(log[0].credentials).toBe("omit")
  })

  test("same origin (empty prefix) → relative /v1 path", async () => {
    const log = installFetchStub({
      jsonBody: { kind: "document", documentTitle: "D", documentContent: "# D", createdAt: "x" },
    })
    const res = await apiClient.share.resolve("tok", { baseUrl: "" })
    expect(res.ok).toBe(true)
    expect(log[0].url).toBe("/v1/share/tok")
  })

  test("404 → notFound", async () => {
    installFetchStub({ status: 404, jsonBody: { code: "not_found", message: "Share not found." } })
    expect(await apiClient.share.resolve("tok", { baseUrl: "" })).toEqual({
      ok: false,
      status: 404,
      notFound: true,
    })
  })

  test("429 / malformed body → transient failure, not notFound", async () => {
    installFetchStub({ status: 429, jsonBody: { code: "rate_limit", message: "slow" } })
    expect(await apiClient.share.resolve("tok", { baseUrl: "" })).toEqual({
      ok: false,
      status: 429,
      notFound: false,
    })
    installFetchStub({ jsonBody: { kind: "conversation", conversationTitle: "no messages" } })
    expect(await apiClient.share.resolve("tok", { baseUrl: "" })).toEqual({
      ok: false,
      status: 200,
      notFound: false,
    })
  })

  test("network error → transient failure", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch")
    }) as unknown as typeof fetch
    expect(await apiClient.share.resolve("tok", { baseUrl: "" })).toEqual({
      ok: false,
      status: 0,
      notFound: false,
    })
  })

  // Module-load env: only meaningful when NEXT_PUBLIC_AGENT_PY_URL is unset
  // (bun auto-loads a local .env that might set it).
  test.skipIf(Boolean(process.env.NEXT_PUBLIC_AGENT_PY_URL?.trim()))(
    "no backend configured (and no override) → not attempted",
    async () => {
      const log = installFetchStub({ jsonBody: conversation })
      expect(await apiClient.share.resolve("tok")).toEqual({
        ok: false,
        status: 0,
        notFound: false,
      })
      expect(log).toHaveLength(0)
    },
  )
})

describe("apiClient.mcp.upsertCloudServer — dispatch", () => {
  function validBody() {
    return {
      id: "11111111-1111-1111-1111-111111111111",
      workspaceId: "11111111-1111-1111-1111-111111111122",
      name: "Cloud MCP",
      url: "https://mcp.cloud/sse",
      credentials: { type: "header", headers: { "X-API-Key": "secret" } },
      enabled: true,
    }
  }

  test("remote dispatch posts to {baseUrl}/v1/mcp/server with bearer JWT", async () => {
    const log = installFetchStub({ jsonBody: { ok: true } })
    const r = await apiClient.mcp.upsertCloudServer(validBody(), {
      target: REMOTE,
    })
    expect(r.ok).toBe(true)
    expect(log[0].url).toBe("https://agent-py.example/v1/mcp/server")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
    // Same wire shape across both backends — body passes through unchanged.
    expect((log[0].body as { id: string }).id).toBe(validBody().id)
  })

  test("remote dispatch surfaces error envelope on non-OK responses", async () => {
    installFetchStub({
      status: 500,
      jsonBody: { code: "encryption_key_unset", message: "key missing" },
    })
    const r = await apiClient.mcp.upsertCloudServer(validBody(), {
      target: REMOTE,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(500)
      expect(r.error.code).toBe("encryption_key_unset")
      expect(r.error.message).toBe("key missing")
    }
  })
})

describe("dispatchedFetch — error envelopes", () => {
  // Next's routes nest the error (`{ ok: false, error: { code, message } }`);
  // read as a flat message, an object reached the toast and crashed React (#31).

  test("agent-py's flat envelope and a bare string error still read as before", async () => {
    installFetchStub({ status: 429, jsonBody: { code: "rate_limit", message: "Slow down" } })
    const flat = await apiClient.url.fetch("https://e.x", { target: REMOTE })
    expect(!flat.ok && flat.error).toEqual({
      code: "rate_limit",
      message: "Slow down",
    })
    installFetchStub({ status: 500, jsonBody: { error: "boom" } })
    const bare = await apiClient.url.fetch("https://e.x", { target: REMOTE })
    expect(!bare.ok && bare.error).toEqual({
      code: undefined,
      message: "boom",
    })
  })
})

describe("dispatchedFetch — wire shape", () => {

  test("remote dispatch sets Authorization and routes to {baseUrl}/v1", async () => {
    const log = installFetchStub({ jsonBody: { ok: true } })
    await apiClient.summarize.file(
      { mode: "file", name: "n", text: "t" },
      { target: REMOTE },
    )
    expect(log[0].url).toBe("https://agent-py.example/v1/summarize")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
  })

  test("X-MCP-Credentials header survives through extraHeaders", async () => {
    // Re-stub a richer fetch that captures all headers, not just
    // Authorization + Content-Type. The existing installFetchStub is
    // intentionally narrow; this one is wider for the assertion.
    const originalFetch = globalThis.fetch
    const log: Record<string, string>[] = []
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      log.push({ ...headers })
      return new Response(JSON.stringify({ capabilities: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch
    try {
      await apiClient.mcp.proxy(
        "call",
        {
          server: { id: "srv-1", name: "x", url: "https://mcp.test", transport: "http" },
          tool: "echo",
          input: { msg: "hi" },
        },
        {
          target: REMOTE,
          credentialHeader: "base64-creds-stub",
        },
      )
      const headers = log[0]
      expect(headers["Authorization"]).toBe("Bearer jwt-test-token")
      expect(headers["X-MCP-Credentials"]).toBe("base64-creds-stub")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("apiClient — REQUIRE_AUTH_FOR_AI (401 auth_required)", () => {
  const authRequired = {
    status: 401,
    jsonBody: { code: "auth_required", message: "Sign in to use AI features." },
  }

  test("summarize.* resolves AUTH_REQUIRED_RESULT, not null", async () => {
    installFetchStub(authRequired)
    const res = await apiClient.summarize.conversation(
      { mode: "conversation", messages: [{ role: "user", content: "hi" }] },
      { target: REMOTE },
    )
    expect(isAuthRequiredResult(res)).toBe(true)
  })

  test("artifacts.extractTable resolves AUTH_REQUIRED_RESULT", async () => {
    installFetchStub(authRequired)
    const res = await apiClient.artifacts.extractTable(
      { reportText: "r", sources: [{ title: "t", url: "https://x.test", snippet: "s" }] },
      { target: REMOTE },
    )
    expect(isAuthRequiredResult(res)).toBe(true)
  })

  test("other failures (incl. the no-key `auth` 401) stay null", async () => {
    installFetchStub({ status: 401, jsonBody: { code: "auth", message: "no key" } })
    const res = await apiClient.summarize.file(
      { mode: "file", name: "n", text: "t" },
      { target: REMOTE },
    )
    expect(res).toBeNull()
  })
})

describe("apiClient.tasks.schedules — agent-py-only dispatch", () => {
  const schedule = {
    id: "s/1",
    workspaceId: "w1",
    name: "Morning",
    prompt: "p",
    cron: "0 8 * * *",
    timezone: "UTC",
    enabled: true,
    model: null,
    systemPrompt: null,
    maxSteps: null,
    lastRunAt: null,
    lastRunTaskId: null,
    nextRunAt: "2026-11-22T08:00:00+00:00",
    createdAt: "2026-11-21T08:00:00+00:00",
    updatedAt: "2026-11-21T08:00:00+00:00",
  }
  const create = { workspaceId: "w1", name: "Morning", prompt: "p", cron: "0 8 * * *" }
  const python = { target: REMOTE }

  test("python: list → GET agent-py /v1/tasks/schedules with bearer", async () => {
    const log = installFetchStub({ jsonBody: { schedules: [schedule] } })
    const list = await apiClient.tasks.schedules.list(python)
    expect(list).toEqual([schedule])
    expect(log).toHaveLength(1)
    expect(log[0].url).toBe("https://agent-py.example/v1/tasks/schedules")
    expect(log[0].method).toBe("GET")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
  })

  test("python: create → POST agent-py, same body", async () => {
    const log = installFetchStub({ status: 201, jsonBody: schedule })
    const res = await apiClient.tasks.schedules.create(create, python)
    expect(res).toEqual({ ok: true, status: 201, schedule })
    expect(log[0].url).toBe("https://agent-py.example/v1/tasks/schedules")
    expect(log[0].method).toBe("POST")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
    expect(log[0].contentType).toBe("application/json")
    expect(log[0].body).toEqual(create)
  })

  test("python: update / delete → agent-py /v1/tasks/schedules/{id} (id encoded)", async () => {
    let log = installFetchStub({ jsonBody: schedule })
    const res = await apiClient.tasks.schedules.update("s/1", { enabled: false }, python)
    expect(res.ok).toBe(true)
    expect(log[0].url).toBe("https://agent-py.example/v1/tasks/schedules/s%2F1")
    expect(log[0].method).toBe("PATCH")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
    expect(log[0].body).toEqual({ enabled: false })

    log = installFetchStub({ jsonBody: { ok: true } })
    expect(await apiClient.tasks.schedules.delete("s/1", python)).toEqual({ ok: true, status: 200 })
    expect(log[0].url).toBe("https://agent-py.example/v1/tasks/schedules/s%2F1")
    expect(log[0].method).toBe("DELETE")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
  })

  test("python: error envelope surfaces code + message", async () => {
    installFetchStub({ status: 409, jsonBody: { code: "limit_reached", message: "cap" } })
    const res = await apiClient.tasks.schedules.create(create, python)
    expect(res).toEqual({ ok: false, status: 409, error: { code: "limit_reached", message: "cap" } })
  })
})

// --- signed-out calls: tokenless to agent-py ---------------------------------

/** A signed-out browser's target: tokenless (Q123/Q134/Q142). */
const ANONYMOUS: AgentPyTarget = {
  baseUrl: "https://agent-py.example",
  authToken: null,
}

describe("anonymous remote dispatch (no session) sends no Authorization", () => {
  const bookmark = {
    ok: true,
    bookmark: { url: "https://e.test", title: "x", content: "", contentTruncated: false, contentHash: "0" },
  }
  const cases: [string, () => Promise<unknown>, unknown, string][] = [
    ["url.fetch", () => apiClient.url.fetch("https://e.test", { target: ANONYMOUS }), bookmark, "/v1/url/fetch"],
    [
      "summarize.file",
      () => apiClient.summarize.file({ mode: "file", text: "t" }, { target: ANONYMOUS }),
      { summary: "s" },
      "/v1/summarize",
    ],
    [
      "mcp.proxy",
      () =>
        apiClient.mcp.proxy("discover", { server: { id: "s1" } }, { target: ANONYMOUS }),
      { capabilities: {} },
      "/v1/mcp/s1/discover",
    ],
    [
      "artifacts.extractTable",
      () =>
        apiClient.artifacts.extractTable(
          { reportText: "r", sources: [{ title: "t", url: "https://x.test", snippet: "s" }] },
          { target: ANONYMOUS },
        ),
      { columns: [], rows: [], sources: [] },
      "/v1/extract-table",
    ],
    [
      "embed.file",
      () => apiClient.embed.file({ fileId: "f", text: "t" }, { target: ANONYMOUS }),
      { status: "skipped", sections: 0, reason: "not_signed_in" },
      "/v1/embed",
    ],
  ]
  for (const [name, run, jsonBody, path] of cases) {
    test(`${name} → agent-py ${path}, no bearer`, async () => {
      const log = installFetchStub({ jsonBody })
      await run()
      expect(log).toHaveLength(1)
      expect(log[0].url).toBe(`https://agent-py.example${path}`)
      expect(log[0].authorization).toBeUndefined()
    })
  }

  test("embed.file reads the anonymous skip (not_signed_in) as a result, not a failure", async () => {
    installFetchStub({ jsonBody: { status: "skipped", sections: 0, reason: "not_signed_in" } })
    const res = await apiClient.embed.file({ fileId: "f", text: "t" }, { target: ANONYMOUS })
    expect(res).toEqual({ status: "skipped", sections: 0, reason: "not_signed_in" })
  })
})

describe("apiClient.extract — agent-py dispatch (wave 12)", () => {
  interface FormCall {
    url: string
    authorization?: string
    file?: File
    signal?: AbortSignal | null
  }
  function installFormStub(jsonBody: unknown, status = 200): FormCall[] {
    const log: FormCall[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const form = init?.body instanceof FormData ? init.body : null
      log.push({
        url: input.toString(),
        authorization: headers["Authorization"],
        file: (form?.get("file") as File | null) ?? undefined,
        signal: init?.signal,
      })
      return new Response(JSON.stringify(jsonBody), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch
    return log
  }
  const file = new File(["hello"], "notes.txt", { type: "text/plain" })
  const result = { kind: "text" as const, text: "hello", truncated: false, fullText: "hello and more" }

  test("python → agent-py /v1/extract with the bearer, the file as multipart", async () => {
    const log = installFormStub(result)
    const res = await apiClient.extract(file, { target: REMOTE })
    expect(res).toEqual(result)
    expect(log).toHaveLength(1)
    expect(log[0].url).toBe("https://agent-py.example/v1/extract")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
    expect(log[0].file?.name).toBe("notes.txt")
  })

  test("signed out → agent-py /v1/extract, no bearer", async () => {
    const log = installFormStub(result)
    expect(await apiClient.extract(file, { target: ANONYMOUS })).toEqual(result)
    expect(log[0].url).toBe("https://agent-py.example/v1/extract")
    expect(log[0].authorization).toBeUndefined()
  })

  test("the abort signal is passed on", async () => {
    const log = installFormStub(result)
    const controller = new AbortController()
    await apiClient.extract(file, { target: REMOTE, signal: controller.signal })
    expect(log[0].signal).toBe(controller.signal)
  })

  test("a failure or an off-schema answer resolves null", async () => {
    installFormStub({ code: "rate_limit", message: "slow" }, 429)
    expect(await apiClient.extract(file, { target: REMOTE })).toBeNull()
    installFormStub({ kind: "nope" })
    expect(await apiClient.extract(file, { target: REMOTE })).toBeNull()
  })
})

describe("an account-bound call without a session goes tokenless; agent-py's 401 is 'Sign in required' (Q142)", () => {
  beforeEach(() => resetAuthRequiredNotice())

  /** Whether the "Sign in required" toast was just raised: a background
   *  re-raise is then suppressed by the cooldown. */
  const toastRaised = () => !notifyAuthRequired({ background: true })

  const create = { workspaceId: "w1", name: "Morning", prompt: "p", cron: "0 8 * * *" }
  const share = { kind: "conversation" as const, conversationId: "11111111-1111-4111-8111-111111111111" }

  test("share.create: sent to agent-py without a bearer, its 401 reads as auth_required + the toast", async () => {
    const log = installFetchStub({ status: 401, jsonBody: { code: "auth", message: "Missing bearer token." } })
    const res = await apiClient.share.create(share as never, { target: ANONYMOUS })
    expect(log).toHaveLength(1)
    expect(log[0].url).toBe("https://agent-py.example/v1/share")
    expect(log[0].authorization).toBeUndefined()
    expect(res).toMatchObject({ ok: false, status: 401 })
    expect(toastRaised()).toBe(true)
  })

  test("schedules.create: the 401 surfaces as auth_required, whatever code agent-py sent", async () => {
    for (const code of ["auth", "auth_required"]) {
      resetAuthRequiredNotice()
      const log = installFetchStub({ status: 401, jsonBody: { code, message: "Sign in." } })
      const res = await apiClient.tasks.schedules.create(create, { target: ANONYMOUS })
      expect(log[0].url).toBe("https://agent-py.example/v1/tasks/schedules")
      expect(log[0].authorization).toBeUndefined()
      expect(res).toEqual({ ok: false, status: 401, error: { code: "auth_required", message: "Sign in." } })
      expect(toastRaised()).toBe(true)
    }
  })

  test("memory.extract / mcp.upsertCloudServer: sent tokenless, refused, never short-circuited", async () => {
    let log = installFetchStub({ status: 401, jsonBody: { code: "auth" } })
    expect(await apiClient.memory.extract({ turnText: "t", conversationId: "c" }, { target: ANONYMOUS })).toBe(false)
    expect(log).toHaveLength(1)
    expect(log[0].url).toBe("https://agent-py.example/v1/memory/extract")
    log = installFetchStub({ status: 401, jsonBody: { code: "auth" } })
    const res = await apiClient.mcp.upsertCloudServer(
      { id: "s", workspaceId: "w", name: "n", url: "https://mcp.test", credentials: {} },
      { target: ANONYMOUS },
    )
    expect(log[0].url).toBe("https://agent-py.example/v1/mcp/server")
    expect(res).toEqual({ ok: false, status: 401, error: { code: "auth_required", message: undefined } })
  })

  test("with a session, a 401 `auth` (a rejected token) is not rewritten", async () => {
    installFetchStub({ status: 401, jsonBody: { code: "auth", message: "Invalid token." } })
    const res = await apiClient.tasks.schedules.create(create, { target: REMOTE })
    expect(res).toEqual({ ok: false, status: 401, error: { code: "auth", message: "Invalid token." } })
    expect(toastRaised()).toBe(false)
  })
})

/**
 * Tests for the non-chat endpoint dispatch behaviour added in the
 * "frontend selector for non-chat endpoints" PR. Each test drives
 * one of the four api-client methods with an explicit `dispatch:
 * 'remote'` context + a stubbed fetch and asserts that the URL,
 * Authorization header, and body wire shape match the remote service.
 *
 * The store-driven default (`dispatch: 'auto'`) is covered by the
 * resolver tests in `api/backend-resolver.test.ts` — its happy path
 * requires env vars captured at module load, which would make this
 * file fragile if asserted here. Test the deterministic explicit-
 * dispatch paths instead; the resolver tests cover the rest.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { apiClient, type RemoteDispatch } from "./api-client"

const REMOTE: RemoteDispatch = {
  backend: "python",
  baseUrl: "https://agent-py.example",
  authToken: "jwt-test-token",
}

interface FetchCall {
  url: string
  method: string
  authorization?: string
  contentType?: string
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
  test("in-Next route by default (dispatch: 'in-next')", async () => {
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
      dispatch: "in-next",
    })
    expect(result.ok).toBe(true)
    expect(log).toHaveLength(1)
    expect(log[0].url).toBe("/api/url/fetch")
    expect(log[0].authorization).toBeUndefined()
    expect(log[0].body).toEqual({ url: "https://example.com" })
  })

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
      dispatch: "remote",
      remote: REMOTE,
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
      { dispatch: "remote", remote: REMOTE },
    )
    await apiClient.summarize.conversation(
      {
        mode: "conversation",
        messages: [{ role: "user", content: "hi" }],
      },
      { dispatch: "remote", remote: REMOTE },
    )
    await apiClient.summarize.compress(
      {
        mode: "compress",
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
        ],
      },
      { dispatch: "remote", remote: REMOTE },
    )
    await apiClient.summarize.projectBreakdown(
      { mode: "project-breakdown", goal: "ship it" },
      { dispatch: "remote", remote: REMOTE },
    )
    expect(log).toHaveLength(4)
    for (const call of log) {
      expect(call.url).toBe("https://agent-py.example/v1/summarize")
      expect(call.authorization).toBe("Bearer jwt-test-token")
    }
    // Wire shape passes through unchanged — the remote services
    // accept the camelCase TS shape directly (`existingTitles` is
    // accepted via `populate_by_name` on agent-py; Zod parses it as-is
    // on agent-ts).
    expect((log[0].body as { mode: string }).mode).toBe("file")
    expect((log[3].body as { mode: string }).mode).toBe("project-breakdown")
  })

  test("in-Next route posts to /api/summarize without auth", async () => {
    const log = installFetchStub({ jsonBody: { summary: "ok" } })
    await apiClient.summarize.file(
      { mode: "file", name: "n", text: "t" },
      { dispatch: "in-next" },
    )
    expect(log[0].url).toBe("/api/summarize")
    expect(log[0].authorization).toBeUndefined()
  })
})

describe("apiClient.embed.file — dispatch", () => {
  // embedFile is pinned to in-next: there is no remote `/v1/embed`
  // handler, so it must never route remote even for remote-backend
  // users. This asserts the local-only contract (URL + no auth). The
  // resolver's auto→remote path is not exercised here — it needs
  // env vars captured at module load + a Supabase session, which the
  // file's header deliberately keeps out of this suite.
  test("always posts to /api/embed without auth", async () => {
    const log = installFetchStub({
      jsonBody: { status: "indexed", sections: 0 },
    })
    await apiClient.embed.file({ fileId: "f-1", text: "hello" })
    expect(log[0].url).toBe("/api/embed")
    expect(log[0].authorization).toBeUndefined()
    expect(log[0].contentType).toBe("application/json")
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
      { dispatch: "remote", remote: REMOTE },
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
      { dispatch: "remote", remote: REMOTE },
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
      dispatch: "remote",
      remote: REMOTE,
    })
    expect(url).toBe("https://cdn.example/signed")
    expect(log[0].url).toBe("https://agent-py.example/v1/images/refresh-url")
    expect(log[0].authorization).toBe("Bearer jwt-test-token")
    expect(log[0].body).toEqual({ storage_path: "u-1/generated/img.png" })
  })

  test("in-Next dispatch keeps the camelCase storagePath", async () => {
    const log = installFetchStub({
      jsonBody: { url: "https://cdn.example/signed" },
    })
    await apiClient.images.refreshUrl("u-1/generated/img.png", {
      dispatch: "in-next",
    })
    expect(log[0].url).toBe("/api/images/refresh-url")
    expect(log[0].body).toEqual({ storagePath: "u-1/generated/img.png" })
  })
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

  test("in-Next route posts to /api/mcp/server without auth", async () => {
    const log = installFetchStub({ jsonBody: { ok: true } })
    const r = await apiClient.mcp.upsertCloudServer(validBody(), {
      dispatch: "in-next",
    })
    expect(r.ok).toBe(true)
    expect(log[0].url).toBe("/api/mcp/server")
    expect(log[0].authorization).toBeUndefined()
  })

  test("remote dispatch posts to {baseUrl}/v1/mcp/server with bearer JWT", async () => {
    const log = installFetchStub({ jsonBody: { ok: true } })
    const r = await apiClient.mcp.upsertCloudServer(validBody(), {
      dispatch: "remote",
      remote: REMOTE,
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
      dispatch: "remote",
      remote: REMOTE,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(500)
      expect(r.error.code).toBe("encryption_key_unset")
      expect(r.error.message).toBe("key missing")
    }
  })
})

describe("dispatchedFetch — wire shape", () => {
  test("in-next dispatch sets Content-Type and no Authorization", async () => {
    const log = installFetchStub({ jsonBody: { ok: true } })
    const result = await apiClient.url.fetch("https://example.com", {
      dispatch: "in-next",
    })
    expect(result.ok).toBe(true)
    expect(log[0].contentType).toBe("application/json")
    expect(log[0].authorization).toBeUndefined()
    expect(log[0].url).toBe("/api/url/fetch")
  })

  test("remote dispatch sets Authorization and routes to {baseUrl}/v1", async () => {
    const log = installFetchStub({ jsonBody: { ok: true } })
    await apiClient.summarize.file(
      { mode: "file", name: "n", text: "t" },
      { dispatch: "remote", remote: REMOTE },
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
          dispatch: "remote",
          remote: REMOTE,
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

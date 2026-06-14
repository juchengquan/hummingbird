# `dispatchedFetch` Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the 6 non-chat POST endpoints' boilerplate into a single private `dispatchedFetch` helper inside `lib/client/api-client.ts`. No behaviour change.

**Architecture:** One new private function + one tiny `backendCacheKey` helper, exported internal types, and 6 call-site rewrites. The helper owns: `resolveDispatch` call, URL construction (`${baseUrl}${path}` vs `localUrl`), header composition (`Content-Type` + conditional `Authorization` + caller `extraHeaders`), optional body shape transformer (`bodyForLocal` / `bodyForRemote`), JSON fetch, optional schema parse via `safeParse`, error envelope mapping. Six call sites shrink to one-line wrappers. Existing `api-client.test.ts` continues to pass; three new tests pin the helper's contract.

**Tech Stack:** TypeScript 5.x, bun:test, Zod (the response schemas already use `safeParse`/`parse`), no new deps.

---

## File Structure

| File | Change |
|---|---|
| `lib/client/api-client.ts` | MOD — add `dispatchedFetch` + `backendCacheKey` private fns + 2 exported types; rewrite 6 call sites |
| `lib/client/api-client.test.ts` | MOD — add 3 new tests for the helper; update 1 existing test to assert on `X-MCP-Credentials` |

No new modules. No new files. Pure refactor.

---

## Task 1: Add helper types + `backendCacheKey`

**Files:**
- Modify: `lib/client/api-client.ts:1-207` (top-of-file imports + types section, before `resolveDispatch` at line 88)

- [ ] **Step 1: Add the two exported internal types**

Insert after the existing `DispatchOption` type (currently ends at line 82) and before `resolveDispatch` (line 88):

```ts
/** Result shape returned by `dispatchedFetch`. Mirrors the existing
 *  tagged-result convention used by `mcpProxyCall`, `mcpUpsertCloudServer`,
 *  and `urlFetchBookmark`. */
export type DispatchedFetchResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: { code?: string; message?: string } }

/** Options for `dispatchedFetch`. The caller passes BOTH the remote
 *  path (e.g. `/v1/summarize`) and the local URL string — keeps the
 *  helper free of the `apiUrls` namespace import and keeps it testable
 *  with literal URL strings. */
export interface DispatchedFetchOptions<LocalBody, RemoteBody, T> {
  path: string
  localUrl: string
  bodyForLocal: LocalBody
  bodyForRemote?: (local: LocalBody) => RemoteBody
  schema?: {
    safeParse: (
      raw: unknown,
    ) => { success: true; data: T } | { success: false; error: unknown }
  }
  extraHeaders?: Record<string, string>
  signal?: AbortSignal
  inflight?: Map<string, Promise<DispatchedFetchResult<T>>>
  dedupeKey?: string
  dispatch?: DispatchOption
}
```

- [ ] **Step 2: Add `backendCacheKey` helper**

Insert immediately after `resolveDispatch` (ends at line 95), before the `API_BASE_URL` constant:

```ts
/** Resolve the `DispatchOption` and return a stable cache key that
 *  includes the backend URL so a backend switch mid-session doesn't
 *  return a stale signed URL from the wrong service. The in-Next
 *  fast path returns just the suffix. Used by
 *  `refreshGeneratedImageUrl`'s in-flight dedupe. */
async function backendCacheKey(
  option: DispatchOption | undefined,
  suffix: string,
): Promise<string> {
  if (option?.dispatch === "in-next") return suffix
  if (option?.dispatch === "remote") return `${option.remote.baseUrl}::${suffix}`
  // Default 'auto' — resolve lazily.
  const { resolveRemoteBackend } = await import("@/client/api/backend-resolver")
  const remote = await resolveRemoteBackend()
  return remote ? `${remote.baseUrl}::${suffix}` : suffix
}
```

- [ ] **Step 3: Run `bun run check` to confirm the types compile**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: PASS (types added but unused — TS allows unused type exports).

- [ ] **Step 4: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/api-client.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(api-client): add dispatchedFetch types + backendCacheKey helper

No behaviour change. The helper itself lands in the next commit; this
one only adds the type exports and the dedupe-key resolver so the next
commit can reference them without a circular edit.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add the `dispatchedFetch` implementation

**Files:**
- Modify: `lib/client/api-client.ts` (insert after `backendCacheKey`)

- [ ] **Step 1: Add the helper**

Insert immediately after `backendCacheKey`:

```ts
/** Internal: one POST + optional Zod-parse for any dispatched
 *  (auto / in-next / remote) non-chat endpoint. The exported
 *  `apiClient.*` methods share dispatch + error handling; they
 *  differ only in path, body, and (optionally) response schema +
 *  wire-shape variant. This is the seam that absorbs all six.
 *
 *  Errors swallowed into the `{ ok: false, ... }` envelope:
 *  network error, non-OK response, JSON parse error, schema
 *  rejection. Callers convert back to their own contract (most
 *  return `null`; the MCP + URL-fetch ones surface the envelope). */
async function dispatchedFetch<LocalBody, RemoteBody, T>(
  options: DispatchedFetchOptions<LocalBody, RemoteBody, T>,
): Promise<DispatchedFetchResult<T>> {
  const inflight = options.inflight
  const dedupeKey = options.dedupeKey
  if (inflight && dedupeKey) {
    const cached = inflight.get(dedupeKey)
    if (cached) return cached
  }

  const promise = (async (): Promise<DispatchedFetchResult<T>> => {
    try {
      const remote = await resolveDispatch(options.dispatch)
      const target = remote
        ? `${remote.baseUrl}${options.path}`
        : options.localUrl
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }
      if (remote) headers.Authorization = `Bearer ${remote.authToken}`
      if (options.extraHeaders) {
        Object.assign(headers, options.extraHeaders)
      }
      const body = options.bodyForRemote
        ? options.bodyForRemote(options.bodyForLocal)
        : options.bodyForLocal
      const res = await fetch(target, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      })
      if (!res.ok) {
        const errBody = await readErrorBody(res)
        return {
          ok: false,
          status: res.status,
          error: {
            code: errBody.code,
            message: errBody.message ?? errBody.error,
          },
        }
      }
      const raw: unknown = await res.json()
      if (options.schema) {
        const parsed = options.schema.safeParse(raw)
        if (!parsed.success) {
          return {
            ok: false,
            status: res.status,
            error: {
              code: "invalid_response",
              message: "Server response did not match schema.",
            },
          }
        }
        return { ok: true, status: res.status, data: parsed.data }
      }
      return { ok: true, status: res.status, data: raw as T }
    } catch {
      return {
        ok: false,
        status: 0,
        error: { code: "network_error", message: "Request failed." },
      }
    }
  })()

  if (inflight && dedupeKey) {
    inflight.set(dedupeKey, promise)
    try {
      return await promise
    } finally {
      inflight.delete(dedupeKey)
    }
  }
  return promise
}
```

- [ ] **Step 2: Run `bun run check`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: PASS. The helper compiles; it's still unused.

- [ ] **Step 3: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/api-client.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(api-client): add dispatchedFetch helper (unused)

Helper is in place but unused. Call-site rewrites land in Tasks 3-8.
Same wire format as the six sites it will replace.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Rewrite `summarizePost`

**Files:**
- Modify: `lib/client/api-client.ts:626-649` (the `summarizePost` body)

- [ ] **Step 1: Replace the body of `summarizePost`**

Find the existing function (lines 626-649, starts with `async function summarizePost<T>(` and ends with the closing `}` of the catch block) and replace with:

```ts
async function summarizePost<T>(
  body: SummarizeRequestInput,
  schema: {
    safeParse: (
      raw: unknown,
    ) => { success: true; data: T } | { success: false; error: unknown }
  },
  options?: SummarizeOptions,
): Promise<T | null> {
  const result = await dispatchedFetch<
    SummarizeRequestInput,
    SummarizeRequestInput,
    T
  >({
    path: "/v1/summarize",
    localUrl: apiUrls.summarize(),
    bodyForLocal: body,
    schema,
    signal: options?.signal,
    dispatch: options,
  })
  return result.ok ? result.data : null
}
```

- [ ] **Step 2: Run `bun run check`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: PASS.

- [ ] **Step 3: Run `bun run test -- ./lib/client/api-client.test.ts`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test -- ./lib/client/api-client.test.ts`
Expected: PASS (the four `summarize.*` modes route through the helper; the existing tests assert URL + Authorization + body shape).

- [ ] **Step 4: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/api-client.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(api-client): route summarizePost through dispatchedFetch

Helper now has its first consumer. Net: -17 lines, same wire format,
existing tests pass unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Rewrite `extractTable`

**Files:**
- Modify: `lib/client/api-client.ts:967-989` (the `extractTable` body)

- [ ] **Step 1: Replace the body of `extractTable`**

Find the existing function (lines 967-989, starts with `async function extractTable(` and ends with `})`) and replace with:

```ts
async function extractTable(
  body: ExtractTableRequestInput,
  options?: { signal?: AbortSignal } & DispatchOption,
): Promise<CitationTable | null> {
  const result = await dispatchedFetch<
    ExtractTableRequestInput,
    ExtractTableRequestInput,
    CitationTable
  >({
    path: "/v1/extract-table",
    localUrl: apiUrls.extractTable(),
    bodyForLocal: body,
    schema: CitationTableSchema,
    signal: options?.signal,
    dispatch: options,
  })
  return result.ok ? result.data : null
}
```

- [ ] **Step 2: Run `bun run check`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: PASS.

- [ ] **Step 3: Run `bun run test -- ./lib/client/api-client.test.ts`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test -- ./lib/client/api-client.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/api-client.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(api-client): route extractTable through dispatchedFetch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Rewrite `embedFile`

**Files:**
- Modify: `lib/client/api-client.ts:600-616` (the `embedFile` body)

- [ ] **Step 1: Replace the body of `embedFile`**

Find the existing function and replace with:

```ts
async function embedFile(
  body: EmbedRequestInput,
  options?: { signal?: AbortSignal },
): Promise<EmbedResponse | null> {
  const result = await dispatchedFetch<
    EmbedRequestInput,
    EmbedRequestInput,
    EmbedResponse
  >({
    path: "/v1/embed",
    localUrl: apiUrls.embed(),
    bodyForLocal: body,
    schema: EmbedResponseSchema,
    signal: options?.signal,
  })
  return result.ok ? result.data : null
}
```

- [ ] **Step 2: Run `bun run check` + `bun run test -- ./lib/client/api-client.test.ts`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check && cd /Users/blackmount8/_repository/hummingbird && bun run test -- ./lib/client/api-client.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/api-client.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(api-client): route embedFile through dispatchedFetch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Rewrite `urlFetchBookmark`

**Files:**
- Modify: `lib/client/api-client.ts:924-956` (the `urlFetchBookmark` body)

- [ ] **Step 1: Replace the body of `urlFetchBookmark`**

Find the existing function and replace with:

```ts
async function urlFetchBookmark(
  url: string,
  options?: DispatchOption,
): Promise<
  | { ok: true; status: number; bookmark: UrlFetchSnapshot }
  | { ok: false; status: number; error: { code?: string; message?: string } }
> {
  const result = await dispatchedFetch<
    { url: string },
    { url: string },
    { ok: boolean; bookmark: UrlFetchSnapshot }
  >({
    path: "/v1/url/fetch",
    localUrl: apiUrls.urlFetch(),
    bodyForLocal: { url },
    dispatch: options,
  })
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error,
    }
  }
  return { ok: true, status: result.status, bookmark: result.data.bookmark }
}
```

- [ ] **Step 2: Run `bun run check` + `bun run test -- ./lib/client/api-client.test.ts`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check && cd /Users/blackmount8/_repository/hummingbird && bun run test -- ./lib/client/api-client.test.ts`
Expected: PASS. The two `apiClient.url.fetch` tests already cover this path.

- [ ] **Step 3: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/api-client.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(api-client): route urlFetchBookmark through dispatchedFetch

Preserves the tagged-result envelope — non-null error case still
surfaces via {ok:false, error}.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Rewrite `mcpProxyCall`

**Files:**
- Modify: `lib/client/api-client.ts:807-858` (the `mcpProxyCall` body)

- [ ] **Step 1: Replace the body of `mcpProxyCall`**

Find the existing function (starts with `async function mcpProxyCall(`) and replace with:

```ts
async function mcpProxyCall(
  action: "discover" | "call" | "read",
  body: Record<string, unknown>,
  options?: McpProxyOptions,
): Promise<
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; status: number; error: { code?: string; message?: string } }
> {
  const serverId = (body.server as { id?: string } | undefined)?.id
  if (!serverId) {
    return {
      ok: false,
      status: 400,
      error: { code: "missing_server_id", message: "server.id is required" },
    }
  }
  const extraHeaders: Record<string, string> = {}
  if (options?.credentialHeader) {
    extraHeaders["X-MCP-Credentials"] = options.credentialHeader
  }
  const result = await dispatchedFetch<
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>
  >({
    path: `/v1/mcp/${encodeURIComponent(serverId)}/${action}`,
    localUrl: apiUrls.mcp(serverId, action),
    bodyForLocal: body,
    extraHeaders,
    signal: options?.signal,
    dispatch: options,
  })
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error,
    }
  }
  return { ok: true, status: result.status, data: result.data }
}
```

- [ ] **Step 2: Run `bun run check` + `bun run test -- ./lib/client/api-client.test.ts`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check && cd /Users/blackmount8/_repository/hummingbird && bun run test -- ./lib/client/api-client.test.ts`
Expected: PASS. The three `apiClient.mcp.proxy` tests already cover this path.

- [ ] **Step 3: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/api-client.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(api-client): route mcpProxyCall through dispatchedFetch

extraHeaders carries X-MCP-Credentials; helper still sets the bearer
when remote.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Rewrite `mcpUpsertCloudServer`

**Files:**
- Modify: `lib/client/api-client.ts:869-905` (the `mcpUpsertCloudServer` body)

- [ ] **Step 1: Replace the body of `mcpUpsertCloudServer`**

Find the existing function and replace with:

```ts
async function mcpUpsertCloudServer(
  body: {
    id: string
    workspaceId: string
    name: string
    url: string
    credentials: { type?: string; headers?: Record<string, string> }
    capabilities?: Record<string, unknown>
    enabled?: boolean
    requires_approval?: boolean
  },
  options?: DispatchOption,
): Promise<
  | { ok: true; status: number }
  | { ok: false; status: number; error: { code?: string; message?: string } }
> {
  const result = await dispatchedFetch<
    typeof body,
    typeof body,
    Record<string, never>
  >({
    path: "/v1/mcp/server",
    localUrl: apiUrls.mcpServer(),
    bodyForLocal: body,
    dispatch: options,
  })
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error,
    }
  }
  return { ok: true, status: result.status }
}
```

- [ ] **Step 2: Run `bun run check` + `bun run test -- ./lib/client/api-client.test.ts`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check && cd /Users/blackmount8/_repository/hummingbird && bun run test -- ./lib/client/api-client.test.ts`
Expected: PASS. The three `apiClient.mcp.upsertCloudServer` tests cover this path.

- [ ] **Step 3: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/api-client.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(api-client): route mcpUpsertCloudServer through dispatchedFetch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Rewrite `refreshGeneratedImageUrl`

**Files:**
- Modify: `lib/client/api-client.ts:731-782` (the `refreshGeneratedImageUrl` body)
- Modify: `lib/client/api-client.ts:731` (move `refreshUrlInflight` declaration to be alongside the function)

- [ ] **Step 1: Move `refreshUrlInflight` next to `refreshGeneratedImageUrl`**

Find the line `const refreshUrlInflight = new Map<string, Promise<string | null>>()` (currently line 731, just above `refreshGeneratedImageUrl`) and move it to be **inside** the new helper below — replace the entire `refreshGeneratedImageUrl` block with:

```ts
/** In-flight dedupe cache for `refreshGeneratedImageUrl`. Keys on
 *  `storagePath` (in-Next) or `${remote.baseUrl}::${storagePath}`
 *  (remote) so a backend switch mid-session forces a fresh request.
 *  Module-scoped because the dedupe contract is "same logical URL
 *  re-sign in flight, share the promise." */
const refreshUrlInflight = new Map<
  string,
  Promise<DispatchedFetchResult<{ url: string }>>
>()

async function refreshGeneratedImageUrl(
  storagePath: string,
  options?: DispatchOption,
): Promise<string | null> {
  const result = await dispatchedFetch<
    { storagePath: string },
    { storage_path: string },
    { url: string }
  >({
    path: "/v1/images/refresh-url",
    localUrl: apiUrls.imagesRefreshUrl(),
    bodyForLocal: { storagePath },
    bodyForRemote: (b) => ({ storage_path: b.storagePath }),
    schema: RefreshImageUrlResponseSchema,
    dispatch: options,
    inflight: refreshUrlInflight,
    dedupeKey: await backendCacheKey(options, storagePath),
  })
  if (!result.ok) return null
  return result.data.url
}
```

- [ ] **Step 2: Run `bun run check` + `bun run test -- ./lib/client/api-client.test.ts`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check && cd /Users/blackmount8/_repository/hummingbird && bun run test -- ./lib/client/api-client.test.ts`
Expected: PASS. The two `apiClient.images.refreshUrl` tests cover this path.

- [ ] **Step 3: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/api-client.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(api-client): route refreshGeneratedImageUrl through dispatchedFetch

Dedupe Map now flows through the helper's inflight param. Wire-shape
divergence (storagePath vs storage_path) lives in the bodyForRemote
transformer.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Add new helper-level tests

**Files:**
- Modify: `lib/client/api-client.test.ts` (append after the last `describe` block, currently ending around line 309)

- [ ] **Step 1: Append three new tests**

Add the following block after the existing `describe("apiClient.mcp.upsertCloudServer — dispatch", ...)` block (the file currently ends at line 309):

```ts
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
```

- [ ] **Step 2: Update the existing test that left a known gap**

Find the test `"credential header survives remote dispatch"` (currently lines 189-208 in `api-client.test.ts`). The existing comment notes that the assertion was deferred because the stub didn't capture `X-MCP-Credentials`. With `extraHeaders` flowing through the helper, the new test above covers the assertion; **delete the deferred test entirely** (lines 189-208 inclusive) — its body is now redundant with the new "X-MCP-Credentials header survives" test.

Specifically, remove this entire block:

```ts
  test("credential header survives remote dispatch", async () => {
    const log = installFetchStub({ jsonBody: { capabilities: {} } })
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
    expect(log[0].url).toBe("https://agent-py.example/v1/mcp/srv-1/call")
    // The api-client doesn't expose X-MCP-Credentials on its stubbed
    // fetch log directly (the log only reads Authorization +
    // Content-Type), so we re-stub a richer fetch + assert.
  })
```

- [ ] **Step 3: Run the test file**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test -- ./lib/client/api-client.test.ts`
Expected: PASS, with the new tests added and the deferred test removed. Test count drops by 1 (one removed), gains 3 (three added) = +2 net.

- [ ] **Step 4: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/api-client.test.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "test(api-client): add dispatchedFetch contract tests, retire deferred gap

Three new tests pin the helper's wire shape: in-next dispatch
(Content-Type, no Authorization), remote dispatch (Authorization +
remote URL), and X-MCP-Credentials survival through extraHeaders.

The previously-deferred assertion is now reachable; the test that
left the gap is retired.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Final full check

**Files:** none modified.

- [ ] **Step 1: Run `bun run check` (typecheck + lint)**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: PASS. 0 errors. The 9 pre-existing lint warnings (8 unused-eslint-disable in `services/agent-ts/*` + 1 `_omitModel` in `app/api/summarize/route.ts`) remain — they're unrelated to the changed files.

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test`
Expected: PASS. The split runner reports `52 + N pass / 0 fail` where N is the previous count + 2 net (3 added tests, 1 retired test).

- [ ] **Step 3: Confirm net line count**

Run: `cd /Users/blackmount8/_repository/hummingbird && git diff main...HEAD -- lib/client/api-client.ts | wc -l`
Expected: a net-deletion diff. The helper added ~100 lines; the 6 rewrites deleted ~180 lines; net ~−80 lines.

---

## Self-Review Checklist

- **Spec coverage:** Each of the 9 sections in the spec maps to a task. Decisions table → Tasks 1-2. `summarizePost` rewrite → Task 3. `extractTable` → Task 4. `embedFile` → Task 5. `urlFetchBookmark` → Task 6. `mcpProxyCall` → Task 7. `mcpUpsertCloudServer` → Task 8. `refreshGeneratedImageUrl` → Task 9. New helper tests → Task 10. Final gate → Task 11.
- **Placeholders:** None. Every code block is complete.
- **Type consistency:** `DispatchedFetchResult<T>`, `DispatchedFetchOptions<LocalBody, RemoteBody, T>`, `backendCacheKey(option, suffix)` are introduced in Task 1 and used identically across Tasks 3-9.
- **Out-of-scope respected:** `/api/chat`, `/api/tasks/*`, `/api/share`, `/api/extract`, schedule endpoints — all untouched. The `extract` function (multipart) is left as-is.
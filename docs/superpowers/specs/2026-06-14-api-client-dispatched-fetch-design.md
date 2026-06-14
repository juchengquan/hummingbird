# Non-chat dispatch helper — `dispatchedFetch` in `api-client.ts`

**Status:** Draft — refactor only, no behaviour change. Identified during the 2026-06-14 architecture review as the top-pick shallow-module candidate.

**Goal:** Collapse the repeated `resolveDispatch → conditional URL/headers → fetch → error envelope → Zod parse` boilerplate from six non-chat endpoints into one `dispatchedFetch` helper inside `lib/client/api-client.ts`. Every call site shrinks to a one-liner that names the URL path, the body, and the response schema.

---

## Decisions locked during brainstorming

| # | Decision | Choice |
|---|---|---|
| Q1 | Scope | **Non-chat POSTs only.** `/api/chat` (SSE) and `/api/tasks/*` (enqueue + resume stream) keep their bespoke shapes — they handle streaming wire formats that don't collapse into the same helper. |
| Q2 | Result shape | **Tagged result.** Returns `{ ok: true; status; data }` or `{ ok: false; status; error }`. Matches the existing convention used by `mcpProxyCall`, `mcpUpsertCloudServer`, `urlFetchBookmark`. |
| Q3 | Schema integration | **Schema is optional.** When passed, the helper `.safeParse`s; on parse failure returns `{ ok: false, status: 200, error: { code: "invalid_response" } }`. Callers that already validated inline (e.g. `refreshGeneratedImageUrl`) keep their custom safeParse. |
| Q4 | Header composition | **Helper sets `Content-Type` + (when remote) `Authorization`; caller-supplied extra headers merged in.** Lets `mcpProxyCall` keep its `X-MCP-Credentials` injection without a special-case. |
| Q5 | Body wire-shape variants | **Caller-supplied transformer.** The helper takes `bodyForLocal` and an optional `bodyForRemote(bodyForLocal)`. Handles the `refreshGeneratedImageUrl` `storagePath` vs `storage_path` divergence without leaking shape logic into the helper. |
| Q6 | In-flight dedup | **Move into the helper as an opt-in.** `dedupeKey?: (input) => string` param. The `refreshGeneratedImageUrl` Map moves to the call site; helper just dedupes if asked. (`refreshUrlInflight` is endpoint-specific — it caches per `storagePath`, not per call.) |
| Q7 | File location | **Same file** — `lib/client/api-client.ts` (private). No new module; `dispatchedFetch` is internal infrastructure of the api-client module, not a separable concept. |
| Q8 | Test strategy | **Existing `api-client.test.ts` covers the dispatch contract via stubbed fetch.** No new test file. The helper is exercised transitively through every existing test that already drives a non-chat endpoint. |

---

## Architecture

One new private function in the same file, plus six call-site rewrites. No new modules, no new exports, no API surface change. Pure refactor: same wire format, same error envelope, same caller-visible behaviour.

```
lib/client/api-client.ts            (MOD — add dispatchedFetch; rewrite 6 call sites)
lib/client/api-client.test.ts       (MOD — adjust 0 test bodies; the helper is already
                                              covered transitively. Update only the one
                                              assertion in "credential header survives remote
                                              dispatch" that was an explicit known gap.)
```

---

## Section 1 — The helper

### Signature

```ts
type DispatchedFetchOptions<LocalBody, RemoteBody, T> = {
  /** Path appended to the in-Next base or the remote `/v1` base. */
  path: string
  /** Body shape for the in-Next route. */
  bodyForLocal: LocalBody
  /** Optional transformer when the remote service expects a different shape
   *  (e.g. `storagePath` → `storage_path`). Defaults to pass-through. */
  bodyForRemote?: (local: LocalBody) => RemoteBody
  /** Optional Zod (or compatible) schema. Parses the response body when set. */
  schema?: { safeParse: (raw: unknown) => { success: true; data: T } | { success: false; error: unknown } }
  /** Optional caller-supplied extra headers (merged after Content-Type/Authorization). */
  extraHeaders?: Record<string, string>
  /** Optional abort signal. */
  signal?: AbortSignal
  /** Optional dedupe key — see Section 3. */
  dedupeKey?: string
  /** Optional in-flight cache — see Section 3. */
  inflight?: Map<string, Promise<DispatchedFetchResult<T>>>
  /** Per-call dispatch option. */
  dispatch?: DispatchOption
}

type DispatchedFetchResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: { code?: string; message?: string } }
```

### Behaviour

1. Resolve `remote` via the existing `resolveDispatch(options.dispatch)`. Lazy import unchanged.
2. If `inflight` + `dedupeKey` supplied: check the Map; return cached if present; otherwise create the promise, register, run, delete on settle (try/finally).
3. Build `target = remote ? \`${remote.baseUrl}${path}\` : localUrl`. The caller passes both: `path` is the remote shape (`/v1/...`), `localUrl` is the in-Next URL string (computed via `apiUrls.xxx()` at the call site). This avoids the helper importing `apiUrls` and keeps it pure of the api-client's URL constants — the call site already has `apiUrls` in scope.
4. Build `headers = { "Content-Type": "application/json" }`; if `remote`, add `Authorization = \`Bearer ${remote.authToken}\``; merge `extraHeaders`.
5. JSON.stringify the appropriate body (local or remote-transformed).
6. `await fetch(target, { method: "POST", headers, body, signal })`.
7. On non-OK: call existing `readErrorBody(res)`; return `{ ok: false, status, error: { code, message } }`.
8. On OK: `await res.json()`.
   - If `schema` present: `schema.safeParse(raw)` — failure → `{ ok: false, status: 200, error: { code: "invalid_response", message: "..." } }`.
   - Else: return `{ ok: true; status; data: raw as T }` (caller typed their own T).
9. Wrap the whole thing in try/catch that returns `{ ok: false, status: 0, error: { code: "network_error" } }` — same defensive swallow as the existing call sites that return `null` on failure. (Callers that return `null` are converted to return the tagged result; `extractTable`, `refreshGeneratedImageUrl`, `summarizePost`, `embedFile`, `extract` already convert `null` to whatever their own downstream contract wants.)

### Why this shape

- **Tagged result, not `T | null`**: keeps the error envelope visible to callers without forcing every caller to handle `null`. The five existing sites that return `null` get a thin `.then(...)` that maps to their previous contract — same wire shape out, same caller behaviour.
- **`safeParse` not `parse`**: matches the existing `refreshGeneratedImageUrl` pattern (line 770) and avoids throwing from inside the helper.
- **Body transformer as function**: gives `refreshGeneratedImageUrl` its `storagePath`/`storage_path` switch without a special case. Other callers omit it and get pass-through.

---

## Section 2 — Call-site rewrites

Each rewrite keeps the function's **public** signature unchanged (so `apiClient.*` consumers don't change), only the body. Counts in `lib/client/api-client.ts`:

| Function | Before (lines) | After (lines) | Net |
|---|---|---|---|
| `summarizePost` | 25 | 8 | −17 |
| `refreshGeneratedImageUrl` | 51 | 22 | −29 |
| `mcpProxyCall` | 52 | 14 | −38 |
| `mcpUpsertCloudServer` | 37 | 9 | −28 |
| `urlFetchBookmark` | 33 | 11 | −22 |
| `extractTable` | 23 | 8 | −15 |
| **New helper** | — | 70 | +70 |
| **Total** | **221** | **142** | **−79** |

(The `summarizePost` rewrite includes moving its four exported wrappers — `summarizeFile`, `summarizeConversation`, `summarizeCompress`, `summarizeProjectBreakdown` — unchanged; only the inner helper shrinks.)

The `refreshUrlInflight` Map stays at the call site (Section 3) — it's endpoint-specific (keys on `storagePath`, not on the full call shape).

### `summarizePost` before / after sketch

Before (current `lib/client/api-client.ts:626-649`):
```ts
async function summarizePost<T>(
  body: SummarizeRequestInput,
  schema: { parse: (raw: unknown) => T },
  options?: SummarizeOptions
): Promise<T | null> {
  try {
    const remote = await resolveDispatch(options)
    const url = remote ? `${remote.baseUrl}/v1/summarize` : apiUrls.summarize()
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (remote) headers.Authorization = `Bearer ${remote.authToken}`
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: options?.signal })
    if (!res.ok) return null
    return schema.parse(await res.json())
  } catch {
    return null
  }
}
```

After:
```ts
async function summarizePost<T>(
  body: SummarizeRequestInput,
  schema: { safeParse: (raw: unknown) => { success: true; data: T } | { success: false } },
  options?: SummarizeOptions
): Promise<T | null> {
  const result = await dispatchedFetch<typeof body, typeof body, T>({
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

### `refreshGeneratedImageUrl` before / after sketch

Before (`lib/client/api-client.ts:731-782`): 51 lines. After: dedupe-Key carries the backend-aware cache key; body transformer handles `storagePath`/`storage_path`; helper does the rest.

```ts
async function refreshGeneratedImageUrl(
  storagePath: string,
  options?: DispatchOption
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
  return result.ok ? result.data.url : null
}
```

The `backendCacheKey` helper is a 5-line companion that produces the existing `${remote.baseUrl}::${storagePath}` shape from a `DispatchOption`.

---

## Section 3 — The `inflight` Map contract

The helper exposes `inflight?` and `dedupeKey?` as paired parameters. When both are supplied:

1. The helper computes the key (the caller's responsibility — they know what "the same logical request" means for their endpoint).
2. Looks up in the Map. If present, awaits and returns the cached promise.
3. Otherwise, creates the promise, sets it, awaits, and `delete`s on settle (try/finally) so a settled promise never blocks re-entry.

The `refreshUrlInflight` Map (currently module-private at `api-client.ts:731`) becomes the same Map passed into the helper. The 4-up image-grid scenario from the docstring (current line 729-730) is unchanged: the dedupe happens on `(storagePath, remote?.baseUrl)` so backend switches mid-session still hit the network.

For the other five call sites, no dedupe is added — none of them are called concurrently per logical key today. The Map is opt-in to keep the helper from deciding an invariant the call sites don't need.

---

## Section 4 — Error semantics

The helper swallows `fetch` failures (network error, JSON parse error, schema rejection) into the `{ ok: false, ... }` envelope. Callers that previously returned `null` continue to do so via the post-`.then` map. Callers that previously surfaced the envelope (`mcpProxyCall`, `mcpUpsertCloudServer`, `urlFetchBookmark`) pass it through unchanged.

The four existing return-`null` sites:
- `extract` (File upload — multipart, **not** refactored; multipart bodies don't fit the JSON helper shape. Stays as-is. **Decision: out of scope.**)
- `embedFile` — refactor to dispatchedFetch.
- `summarizePost` — refactor to dispatchedFetch.
- `extractTable` — refactor to dispatchedFetch.
- `refreshGeneratedImageUrl` — refactor to dispatchedFetch.

(`extract` is the only non-JSON site; it stays untouched. The 4 + 1 = 5 refactored + 1 untouched = the six "non-chat POSTs" from the architecture review minus the streaming ones. `mcpProxyCall` + `mcpUpsertCloudServer` + `urlFetchBookmark` make it six; the review's count is right.)

---

## Section 5 — Tests

### No new test file

The existing `lib/client/api-client.test.ts` (309 lines, ~12 test bodies across 5 describe blocks) covers every call site that gets rewritten. Each test stubs `globalThis.fetch`, asserts on `url` + `authorization` + `body`, and gets the same result whether the body is inline in `summarizePost` or centralised in `dispatchedFetch`. The test bodies do not change.

The one **deliberate** test change: the comment on line 206-207 of `api-client.test.ts` notes "The api-client doesn't expose X-MCP-Credentials on its stubbed fetch log directly". With `dispatchedFetch` accepting `extraHeaders`, the `X-MCP-Credentials` header flows through the same stub path as `Authorization`, so the test can assert on it directly. Update the test to assert `headers["X-MCP-Credentials"] === "base64-creds-stub"`.

### New unit tests for the helper

Add a small `describe("dispatchedFetch — wire shape")` block to `api-client.test.ts` (the same file) with three tests:

1. **In-next dispatch** — sets `Content-Type`, no `Authorization`, posts to `localUrl`, parses via schema.
2. **Remote dispatch** — sets `Content-Type` + `Authorization: Bearer <token>`, posts to `${baseUrl}${path}`, transforms body via `bodyForRemote`.
3. **In-flight dedup** — two concurrent calls with the same `dedupeKey` hit `fetch` exactly once; both return the same result.

These are the only "new" tests. The 12 existing tests continue to pass unchanged.

---

## Section 6 — Out of scope (explicit)

- **`/api/chat` SSE**: stays as `chatStream` + `chatStreamTs` + `chatStreamRemote`. Streaming frames + abort handling + per-backend routing are bespoke and don't collapse into the same helper.
- **`/api/tasks/*`**: `tasksStart` (enqueue + JSON parse), `tasksResume` (SSE), `tasksCancel` (no body), `tasksRespond` (JSON), `tasksSweep` (no body, no parse). The first three return tagged results without a Zod schema; the last two are trivial. None benefit from the helper.
- **`/api/share`, `/api/share/:token`, `/api/extract`**: share routes are authed differently (no `DispatchOption`); extract is multipart. All stay as-is.
- **`schedulesList/Create/Update/Delete`**: not currently dispatched to remote. Refactor is a future-PR opportunity if the remote services add `/v1/task-schedules`.
- **The chat-only lazy imports**: `chatStreamRemote`'s `narrowToRemoteBody` is a chat-only narrowing. Stays.

---

## Section 7 — Risks + mitigations

| Risk | Mitigation |
|---|---|
| Hidden behaviour difference in any of the 6 refactored call sites | Existing `api-client.test.ts` covers every call site with stubbed fetch. `bun run check` + `bun run test` must remain green. |
| TypeScript generic inference failure on `dispatchedFetch<LocalBody, RemoteBody, T>` with the transformer | Start with explicit type args at every call site (matches the existing `summarizePost<T>` precedent). Inference can be tightened later. |
| `inflight` Map lifecycle (memory leak on long-lived sessions) | Same as today: `try { ... } finally { map.delete(key) }`. The helper does the same. |
| Pulling `apiUrls` access into the helper makes it harder to test in isolation | Helper takes the `localUrl: string` as a parameter, not the `apiUrls.*` name. Test code can pass `"/api/test"`. |

---

## Section 8 — Rollout

Single PR. All six call sites land in one commit so a regression bisects to one change.

1. Add `dispatchedFetch` (private) + `backendCacheKey` (private) + `DispatchedFetchOptions`/`DispatchedFetchResult` types (exported internal).
2. Rewrite the 6 call sites one at a time, leaving the public signatures unchanged. Run `bun run check` after each.
3. Add the 3 new helper tests.
4. Update the one existing test that asserts on `X-MCP-Credentials` (now possible).
5. Final `bun run check` + `bun run test`.

Branch: `refactor/api-client-dispatched-fetch`. Target: `dev`.

---

## Section 9 — Wins

- **Locality**: the dispatch + headers + URL + fetch + parse contract lives in one place. Any future endpoint that needs to honour the remote selector calls `dispatchedFetch` and gets the contract for free.
- **Leverage**: 6 call sites collapse from ~221 lines to ~72 lines of per-endpoint bodies, against one ~70-line helper. Net ~−79 lines, with the helper absorbing the "what does dispatching mean?" responsibility.
- **Test surface**: helper-level tests assert the contract; per-endpoint tests assert the wire shape. Each side tests what it owns.
- **Future endpoints**: when the remote services add `/v1/foo`, the new endpoint writes 5 lines of `apiClient.foo = (...) => dispatchedFetch({...})` and inherits the bearer, dispatch, and error-envelope story.
- **No behaviour change**: every existing test passes unchanged (one assertion becomes possible that wasn't before).
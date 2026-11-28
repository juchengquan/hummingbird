# API contract

This document is the map of the contract between the Hummingbird
frontend and its backend. Since wave 13 of
[`PLAN-frontend-backend-split.md`](./PLAN-frontend-backend-split.md)
there is **one backend, agent-py** (`services/agent-py/`), and it is
required: the Next app has no API routes (`app/api/**` was deleted with
the `lib/server` code behind it, Q121/Q122) and reads no server secret.
The browser reaches agent-py at `NEXT_PUBLIC_AGENT_PY_URL` (`/` behind
the same-origin proxy); a deploy without it shows a full-page "This
deploy has no backend configured" screen (Q137).

The contract is spec-first and lives in `packages/contract/`:

- `openapi.yaml` — every endpoint, request and response (→ the TS types
  in `apps/web/lib/shared/contract/openapi.generated.ts` and agent-py's Pydantic
  models, `bun run contract:gen`; `bun run contract:check` fails on
  drift).
- `RUN_EVENTS.md` — the runs API's event stream (AG-UI over SSE): how a
  run's internal events map to the wire, cursors, interrupts and
  resumes, tasks and sub-agents.
- `conformance/` — the language-neutral suite any backend must pass
  (`CONTRACT_BASE_URL=… bun run contract:conformance`).

Single client entry point: `apps/web/lib/client/api-client.ts` (and the runs
client under `apps/web/lib/client/runs/`). Frontend code never `fetch`es a
backend path directly — everything goes through `apiClient.*` or
`apiUrls.*` (the latter for Plate, which takes a URL string and handles
the fetch itself). Response validation: the client parses JSON responses
with the Zod schemas in `apps/web/lib/shared/api-schemas.ts`, so a mismatched
backend fails loudly at the boundary instead of corrupting the UI.

### Auth — bearer, `auth_required`

The browser sends the Supabase access token as `Authorization: Bearer
<jwt>`; agent-py verifies it (HS256 with `SUPABASE_JWT_SECRET`, or
ES256 / RS256 against the project's JWKS). A bad bearer is `401 auth`.
An account-bound call (share, schedules, memory extract, the stored-file
links, cloud MCP) made without a session goes **tokenless** and gets
`401 auth_required` (Q142).

When agent-py runs with `REQUIRE_AUTH_FOR_AI=true` (or `1`), anonymous
runs and anonymous calls to the signed-out endpoints are refused before
any model work:

```jsonc
// 401
{ "code": "auth_required", "message": "Sign in to use AI features on this server." }
```

`POST /v1/extract` is the exception: it serves an anonymous caller
without the vision pass. Strict values (`true` / `false` / `1` / `0`);
anything else fails closed.

`auth_required` is distinct from `auth` (a rejected token, or no
provider key for the model): the client shows a "Sign in required"
prompt with a Sign in action (`apps/web/lib/client/auth/auth-required.ts`).

### Error envelope

JSON error responses use `{ code, message }` — a stable machine `code`
the client keys typed UI off, plus a display `message` (extra fields
allowed, e.g. `issues` on a validation error, `status` on a URL fetch).
The contract (`ApiError`) allows no other error body; request validation
answers `422 { code: "invalid_request", message, issues }`. See
`services/agent-py/README.md` → *Error responses*. In-stream errors on a
run are `RUN_ERROR` events (`RUN_EVENTS.md`).

### Request body caps — `413 payload_too_large`

agent-py caps every request body before routing or auth
(`body_limit.py`): a `Content-Length` over the cap, or a chunked body
whose streamed count passes it, is `413 { code: "payload_too_large",
message }` (a malformed `Content-Length` is `400 invalid_request`).

| Endpoint | Cap |
|---|---|
| `/v1/runs`, `/v1/summarize` | `CHAT_BODY_MAX_BYTES` (16 MiB) — a whole conversation |
| `/v1/extract` (multipart) | `EXTRACT_MAX_BYTES` (5 MB) + 64 KiB of multipart headroom |
| `/v1/ai/command` | 32 MiB |
| `/v1/embed` | 4 MiB |
| `/v1/extract-table` | 2 MiB |
| `/v1/tasks/schedules[/{id}]`, `/v1/memory/extract`, `/v1/ai/complete` | 256 KiB |
| `/v1/share`, `/v1/csp-report` | 16 KiB |
| everything else | `REQUEST_BODY_MAX_BYTES` (1 MiB) |

---

## Endpoints

Each is an operation in `packages/contract/openapi.yaml`; its
description there is normative.

| Endpoint | What |
|---|---|
| `POST /v1/runs`, `GET /v1/runs`, `GET /v1/runs/{id}`, `GET /v1/runs/{id}/events`, `POST /v1/runs/{id}/cancel`, `POST /v1/runs/{id}/answers`, `POST /v1/runs/{id}/delivered` | Chat (interactive runs, streamed) and tasks (background runs, `202`): start, list, read, rejoin from a cursor, cancel, answer a sub-agent run in place, mark a task delivered. Answers to a paused run are a resume: a new run with `forwardedProps.previousRunId` and `resume[]`. |
| `GET /v1/models` | The catalog models agent-py has a provider for (below). |
| `POST /v1/ai/command`, `POST /v1/ai/complete` | The Plate editor's AI menu and ghost text (below). |
| `POST /v1/extract` | Text (and, for some PDFs, a vision pass) from an uploaded file. |
| `POST /v1/summarize` | Conversation summary / compression. |
| `POST /v1/extract-table` | A research report's citation table. |
| `POST /v1/url/fetch` | A bookmark's snapshot (SSRF-guarded fetch). |
| `POST /v1/embed` | Chunk + embed a stored file into `file_sections`. |
| `POST /v1/memory/extract` | Facts to remember from a turn. |
| `POST /v1/mcp/server`, `POST /v1/mcp/{serverId}/{action}` | Save a cloud MCP server; the MCP proxy (`discover` / `call` / `read`). |
| `POST /v1/share`, `DELETE /v1/share/{token}`, `GET /v1/share/{token}` | Share links; the public read the share pages render (no auth, Q127). |
| `GET/POST /v1/tasks/schedules`, `PATCH/DELETE /v1/tasks/schedules/{id}` | Recurring tasks; agent-py's scheduler fires them. |
| `POST /v1/images/refresh-url`, `POST /v1/files/refresh-url` | Fresh signed URLs for stored images / files. |
| `POST /v1/csp-report` | CSP violation reports (the page's `report-uri`, Q140). |

---

## Streams

**Runs** (`POST /v1/runs` interactive, `GET /v1/runs/{id}/events`):
AG-UI events over SSE, each with a `<seq>` / `<seq>.<k>` cursor id for
rejoining — `packages/contract/RUN_EVENTS.md` is the protocol. Chat
consumes it through the runs client (`apps/web/lib/client/runs/`); a task's
panel reads the same events. The AI SDK frame stream that `/api/chat`
and agent-py's `/v1/chat` sent is gone (wave 13).

**Editor AI** (`POST /v1/ai/command`, `POST /v1/ai/complete`; contract
operations `editorAiCommand` / `editorAiComplete`): consumed by Plate
(`@platejs/ai`) in the Vercel AI SDK's formats — the UI message stream
(v1, `x-vercel-ai-ui-message-stream: v1`) for commands, a text stream
for completion. Plate's `useChat` / `useCompletion` hooks parse them;
the frontend doesn't touch the bytes. The browser renders the document
first — the command body is `{ messages, document: EditorAiDocument,
toolName?, model? }`, built by `apps/web/components/editor/ai/agent-py-body.ts`;
agent-py never sees the Plate value. The editor's own-gateway-key
setting was removed in wave 12 (Q124): agent-py never takes a user's
key. The prompts live in agent-py (`editor_ai/`), pinned by its frozen
golden files (Q141).

---

## Models — `GET /v1/models`

Public (no token), contract 0.7.0, operation `listModels` (wave 10,
Q119). The `config/models.json` ids agent-py has a provider for, in
catalog order:

```ts
{
  models: { id: string; tasks: boolean }[]  // tasks: background tasks run on it (it calls tools)
  defaultModel: string                       // AGENT_DEFAULT_MODEL
  auto: boolean                              // `auto` runs on /v1/runs (both models of the routing pair served)
}
```

Every catalog id is still valid on agent-py's other endpoints; one
missing here answers 503 instead of running. The browser reads it once
per page (`apps/web/lib/client/api/served-models.ts` → `apps/web/lib/shared/served-models.ts`)
and the model picker, the task models and the editor's list follow it;
until it arrives, or when it can't be read, they keep the built-in
`anthropic/*` list. An answer that lists **nothing** is a deploy with no
model provider (Q131): the picker and the chat say "No model provider
is configured on this deploy" with a pointer to the setup docs, and
sending is refused (no run, no 503 bubble, no mock answer).

---

## Signed-out calls (wave 12, contract 0.8.0)

A signed-out browser sends `extract`, `summarize`, `url/fetch`,
`extract-table`, the MCP proxy and `embed` to agent-py with no
`Authorization` header, and chats on anonymous runs (Q123/Q134). The
account-bound calls (share, schedules, memory extract, the stored-file
links, `/v1/mcp/server`) are signed-in only (a tokenless call gets `401
auth_required`).

agent-py's rules for an anonymous caller: a bad bearer is still `401
auth`; under `REQUIRE_AUTH_FOR_AI` it is refused `401 auth_required` —
except `/v1/extract`, which serves it without the vision pass; and it
gets per-IP limits (`429 rate_limit` + `Retry-After`): URL fetch 30 /
min, MCP proxy 120 / min (local credentials only, never a cloud-mode
lookup, and only on a deploy without accounts), text extraction 60 /
min, the vision pass 10 / min (every caller), embed 30 / min; anonymous
runs `RUNS_ANONYMOUS_*`. Summarize and extract-table have no per-IP
limit. Signed out, `embed` answers `200 { status: "skipped", sections:
0, reason: "not_signed_in" }`. The client IP is taken behind
`TRUSTED_PROXY_HOPS` reverse proxies (`docs/SECURITY.md`).

---

## Direct Supabase calls (not part of this contract)

The frontend talks directly to Supabase for:

- Auth (password sign-in, session refresh; the session lives in
  `@supabase/ssr`'s cookie storage in the browser, Q144)
- Sync queue + reconciliation (`apps/web/lib/client/sync/`)
- Storage uploads (`apps/web/lib/client/files/`)

These bypass the backend entirely. Share pages read through agent-py's
`GET /v1/share/{token}` (Q127), never with a service-role key.

---

## When you add a new endpoint

1. Add the operation (path, request, responses, errors as `ApiError`)
   to `packages/contract/openapi.yaml`, then `bun run contract:gen`.
2. Implement it in agent-py (`services/agent-py/src/agent_py/routers/`,
   mounted in `main.py`), using the generated models
   (`agent_py/contract/models.py`); add its body cap to `body_limit.py`
   if the default (1 MiB) doesn't fit, and its tests.
3. Regenerate `apps/web/lib/shared/agent-py-types.generated.ts`
   (`bun run codegen:agent-types`).
4. Add request and response Zod schemas to `apps/web/lib/shared/api-schemas.ts`
   where the client parses the response.
5. Add a typed method to `apiClient.*` (`apps/web/lib/client/api-client.ts`) that
   calls agent-py, parses the response with the schema, and returns the
   parsed value or a typed error result (or a URL builder to `apiUrls`
   for a library that takes a URL).
6. Add a conformance case under `packages/contract/conformance/` when
   the behaviour is part of the contract, and list the endpoint in the
   table above.

Next gets no route: anything that needs a secret or a model belongs in
agent-py.

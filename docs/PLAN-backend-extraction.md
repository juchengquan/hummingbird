# Plan: Frontend / backend extraction (Python-ready)

Status: **Phase 1 ✅ shipped.** Phase 2 (stand up the Python backend)
is now under way as [`PLAN-agent-api.md`](PLAN-agent-api.md) —
that plan's Phase 0 scaffolded the FastAPI service (#119) and Phases
1–5 will move the agent loop + tools + MCP onto it. The contract-first
work shipped here (apiClient + Zod schemas + `docs/API.md`) is the
surface the Python service binds to, so Phase 2 here is satisfied
incrementally by `PLAN-agent-api`. Phase 3 (deeper folder restructure
into `frontend/` + `backend/` directories) remains optional.

## Why

We're considering rewriting model inference and tool-calling in
Python. The goal of this plan is to make that swap **mechanical**:
the frontend doesn't change when the backend's language changes, and
nobody has to chase implicit contracts across a polyglot boundary.

The key insight: the question isn't "where do files live" — it's
"what's the wire contract between frontend and backend." Once that
contract is first-class, a Python rewrite is a deployment change, not
a refactor.

## Current architecture

Three layers, currently colocated in one Next.js app:

| Layer | Where | What it does |
|---|---|---|
| **Frontend** | `app/dashboard/`, `components/`, `lib/hooks/`, `lib/files/`, `lib/skills/` *(client portions)*, `lib/branches/` | React UI, Zustand store, IndexedDB cache, browser-side Supabase SDK calls |
| **Server pages** | `app/share/conversation/[token]/page.tsx`, `app/share/document/[token]/page.tsx`, `app/auth/callback/route.ts` | SSR for public read-only views + magic-link code-exchange |
| **Backend (would move to Python)** | `app/api/chat/`, `app/api/ai/command/`, `app/api/ai/copilot/`, `app/api/extract/`, `app/api/summarize/`, `app/api/share/`, `app/api/share/[token]/` | Model inference, tool calls (web search), file text extraction, server-side summarisation, share-link minting/revoking |
| **Shared contract** | `lib/api-schemas.ts`, `lib/api-errors.ts`, `lib/types.ts` *(partial)*, `lib/models.ts` | Zod schemas + error codes the frontend already uses to type fetches |

### What the frontend depends on from the backend

The full inventory of the wire contract that has to survive a Python
rewrite:

| Endpoint | Method | Request | Response |
|---|---|---|---|
| `/api/chat` | POST | `{ messages, model?, files?, workspaceSystemPrompt?, skills? }` | SSE stream of `text` / `reasoning` / `tool_call` / `tool_result` / `suggestions` / `error` / `done` frames |
| `/api/ai/command` | POST | Plate-driven payload (editor) | streamed UI message stream |
| `/api/ai/copilot` | POST | `{ prompt, model?, system?, apiKey? }` | streaming text |
| `/api/extract` | POST | `multipart/form-data` with `file` | `{ kind, text, truncated, language? }` |
| `/api/embed` | POST | `{ fileId, text, force? }` | `{ status, sections, reason? }` (needs the authed Supabase session + a server-side embedder; in-Next-only today) |
| `/api/summarize` | POST | `{ mode, name, text }` | `{ summary, keyTopics }` |
| `/api/share` | POST | `{ kind, conversationId }` | `{ token, kind }` |
| `/api/share/[token]` | DELETE | (path param) | `{ ok }` or `{ error }` |

The **browser → Supabase** path stays in TypeScript regardless: the
sync layer (`lib/sync/`), Storage uploads (`hooks/use-upload-file.ts`,
`lib/files/persist.ts`), and Supabase Auth all use `supabase-js` in
the browser and never go through Next.js API routes. **No Python
migration needed** for that surface.

## Approach — contract-first, three phases

### Phase 1 — In this repo, no behavior change

Make the wire contract first-class so the eventual swap is mechanical.

**New files**

- `lib/api-client.ts` — single typed client owning every
  `fetch('/api/...')` call in the codebase. The frontend imports
  `apiClient.chat.stream(req)`, `apiClient.extract(file)`,
  `apiClient.share.create(req)`, etc. Today it just builds URLs from
  `process.env.NEXT_PUBLIC_API_BASE_URL ?? ''` (empty = same origin =
  current behavior). The day you flip to Python, change one env var.

- `docs/API.md` — pin down the SSE frame protocol verbatim. Frame
  types, payload shapes, ordering rules, error semantics, abort
  semantics. Single page Python implementers can read and match.
  Includes:
    - Streaming SSE protocol for `/api/chat`
    - The `tool_call` / `tool_result` frame shapes (with current
      example payloads)
    - Error frame format and which `code`s map to which UI states
    - `Suggestions` and `done` semantics
    - JSON request/response shapes for non-streaming routes
    - Auth header convention (Supabase JWT in `Authorization: Bearer`
      vs cookie-based — pick one going forward)

**Modified files**

- `lib/api-schemas.ts` — extend Zod schemas to cover **response**
  shapes for the non-streaming routes (`extract`, `summarize`,
  `share`, `share/[token]`). Today only requests are typed. Response
  schemas give us runtime validation when the Python service returns
  something unexpected, and TS types for the client.

- Every file that currently does `fetch('/api/...')` directly:
    - `components/panels/chat.tsx` — `callChatAPI`'s body
    - `lib/extract.ts` — `extractFile`, `summariseFileInBackground`
    - `components/share-dialog.tsx` — `POST /api/share`
    - `app/share/.../page.tsx` (where they fetch) — leave server-side
      ones alone for now; they're SSR boundary code
    - Any other call sites surfaced by `grep -rn 'fetch.*api/'`

  All redirected through `apiClient.*`. No new behavior, no protocol
  changes — purely indirection so the URL prefix becomes a single
  configurable thing.

**Audits**

- Verify no frontend file imports `app/api/...` internals. Frontend
  may import from `lib/` (types, schemas); the inverse — `app/api/`
  importing from `lib/` — is fine. Likely already clean.
- Verify no shared module uses Node-only APIs in client paths
  (e.g. `pdf-parse`, `mammoth` should only ever load server-side via
  dynamic import inside the API route).

**What stays untouched**

- `app/share/conversation/[token]/page.tsx` and
  `app/share/document/[token]/page.tsx` — these are SSR pages with
  admin Supabase access. Once Python exists, they become a Next.js
  page that fetches from Python and renders. Defer until Phase 2.
- `app/auth/callback/route.ts` — Supabase magic-link code exchange.
  Stays in Next.js indefinitely; doesn't need Python.
- The whole `lib/sync/` + `lib/supabase/` surface — browser talks to
  Supabase directly.

**Effort:** ~1–2 days. Zero behavior change. Locks in the contract.

### Phase 2 — When Python is ready

Stand up a Python service that serves the same routes at the same
paths.

**Stack suggestion**

- **FastAPI** with `sse-starlette` for the streaming routes
- Pydantic models mirroring `lib/api-schemas.ts` (or generated from a
  shared OpenAPI doc)
- Anthropic / OpenAI / DeepSeek SDKs directly *(or LiteLLM for a
  single interface across providers)*
- `pypdf` / `python-docx` / `openpyxl` / `lxml` for extraction —
  one-to-one with current `pdf-parse` / `mammoth` / `xlsx` /
  `node-html-parser`
- `supabase` (Python SDK) for share-link writes and the admin client
  used by the share pages
- Tavily Python client for the Web Search skill

**Deployment shape (two options)**

1. **Same-origin reverse proxy** *(recommended)* — Vercel rewrites
   `/api/*` to the Python service. No CORS, no cookie domain
   headaches, browser sees one origin. Cleanest UX.
2. **Separate subdomain** (e.g. `api.example.com`) — needs CORS
   config + cookie domain `.example.com` if you want session sharing.
   Slightly more infra.

**Frontend changes when you flip**

Literally **set `NEXT_PUBLIC_API_BASE_URL`** (or just the rewrite).
All other code stays. Decommission `app/api/*` routes once parity is
proven.

**Share pages** become thin Next.js pages that fetch from Python
(`apiClient.share.resolve(token)`) instead of using the admin Supabase
client directly. Or move them to Python too if you want one less
language in the SSR layer.

### Phase 3 — Optional repo split

If the Python service grows its own team / release cadence, split it
into its own repo. Until then, keep it in `services/api/` of this
repo so types and schemas stay in sync via shared OpenAPI doc.

This is purely organizational — no code change beyond moving files.

## What stays in TypeScript regardless

- All React components and Zustand store
- IndexedDB cache (`lib/files/local-store.ts`)
- Sync queue + reconcile (`lib/sync/`) — talks directly to Supabase JS,
  not to your backend
- Supabase auth UI + magic-link callback
  (`components/auth/`, `app/auth/callback/route.ts`)
- The two `/share/...` pages *(can become thin proxies that fetch
  from Python)*
- `lib/api-schemas.ts` Zod schemas — these become the **shared
  source of truth** even after Python lands; Pydantic models mirror
  them

## Decisions to make before Phase 2

1. **Deployment shape** — same-origin (rewrite) vs subdomain. Affects
   auth cookies and CORS.
2. **Streaming format** — keep the custom SSE frame protocol, or
   switch to the Vercel AI SDK's UI message stream format (compatible
   with `@ai-sdk/react`). Right now there's a custom protocol; Python
   rewriting it is straightforward, but if you ever want `useChat()`
   from `@ai-sdk/react` on the frontend, the official format is more
   portable.
3. **Editor AI routes** (`/api/ai/command`, `/api/ai/copilot`) —
   these are very Plate-flavored. Worth checking how invasive porting
   their payload shape would be in Python. If awkward, you could keep
   just these two in Next.js and migrate everything else.
4. **Sync layer ownership** — keep browser → Supabase direct
   *(simplest, fewer moving parts)*, or proxy via Python *(uniform
   error handling, server-side validation)*. Default: keep direct
   unless you need server-side validation hooks.
5. **Local dev workflow** — running Next.js + Python in tandem.
   Probably `concurrently` script or a Docker Compose file. Decide
   later in Phase 2.

## Risks and tradeoffs

- **Polyglot type sync** — once Python owns the contract, TS types
  and Pydantic models can drift. Mitigations: shared OpenAPI doc
  with codegen on both sides, or rigorous CI that round-trips a
  set of fixtures through both implementations.
- **Streaming proxies** — Vercel rewrites work for streaming
  responses but check the upstream provider's timeouts. Some Edge
  runtimes cap response duration at 30s; reasoning models stream
  longer.
- **Auth header pattern** — Supabase JS sets cookies; if you switch
  to JWT-in-header for the Python service, the auth surface changes.
  Pick one early.
- **Local-dev complexity** — currently `bun dev` runs the whole app.
  After split, contributors need to run two services. Document it
  clearly in `CLAUDE.md`.
- **The contract-first refactor is invisible** — you can't screenshot
  it. Verifying it really did nothing functional means running every
  client API call by hand. Or write a small fixture test that hits
  every endpoint via the new client.

## Recommendation

**Do Phase 1 now.** It costs little, surfaces the real contract,
makes the code more testable today (one place for retry/error
handling), and means the day Python ships, the frontend doesn't need
to know.

**Hold Phase 2.** Wait until you have an actual Python implementation
to point at — speculatively building infra for a hypothetical service
is the kind of work that ages badly. Phase 1 makes Phase 2 easy
whenever you start it.

## Verification (Phase 1)

After the refactor, end-to-end checks that shouldn't regress:

1. Chat works (streaming, tool calls, error bubble, retry, model
   switch).
2. File upload + extraction completes and the chat system prompt
   includes the extracted text.
3. Auto-summary runs after upload.
4. Web search executes when toggled on (with `TAVILY_API_KEY`).
5. Share-link creation + revocation works; public share page renders.
6. Editor AI commands (`/api/ai/command`, `/api/ai/copilot`) still
   work — they go through the same client even though they're more
   tightly coupled to Plate.
7. `grep -rn "fetch.*'/api" components/ lib/` returns zero hits
   outside `lib/api-client.ts` — the new client is the only entry
   point.

## Files at a glance (Phase 1)

**New**

- `lib/api-client.ts` — the typed client
- `docs/API.md` — wire-protocol spec

**Modified**

- `lib/api-schemas.ts` — extend with response schemas
- `components/panels/chat.tsx` — route `/api/chat` call through client
- `lib/extract.ts` — route `/api/extract` and `/api/summarize` through
  client
- `components/share-dialog.tsx` — route `/api/share` POST through
  client
- `components/editor/use-chat.ts` and related — route `/api/ai/*`
  through client *(may need helper exports for the streaming variants)*
- `.env.example` — document `NEXT_PUBLIC_API_BASE_URL` *(default
  empty = same origin)*
- `CLAUDE.md` — note that all frontend → backend traffic goes through
  `lib/api-client.ts`; new endpoints must register there

**Untouched**

- `app/api/*` route handlers themselves — they still implement the
  contract; Phase 1 is purely a frontend-side cleanup
- `lib/sync/`, `lib/supabase/`, `lib/files/` — browser-direct surfaces
- `app/share/`, `app/auth/` — SSR boundary code, deferred

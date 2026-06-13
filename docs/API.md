# API contract

This document is the contract between the Hummingbird frontend and
whatever backend implements it. Today the backend is the Next.js route
handlers under `app/api/*`; the plan in
[`PLAN-backend-extraction.md`](./PLAN-backend-extraction.md) describes
swapping in a Python service. Both implementations must satisfy what's
written here.

Single client entry point: `lib/api-client.ts`. Frontend code never
calls `fetch('/api/...')` directly — everything goes through
`apiClient.*` or `apiUrls.*` (the latter for Plate's `useChat`
plugins, which take a URL string and handle the fetch themselves).

Response validation: JSON routes have Zod response schemas in
`lib/api-schemas.ts`. The client parses with them so a mismatched
backend fails loudly at the boundary instead of corrupting the UI.

Base URL: `NEXT_PUBLIC_API_BASE_URL` (default empty = same origin).
Setting it points every call at another host without code changes.

---

## JSON routes

### `POST /api/extract`

Extract text from an uploaded file.

**Request**: `multipart/form-data` with one field `file`.

**Response 200**: `ExtractionResponse`

```ts
{
  kind: "pdf" | "docx" | "markdown" | "csv" | "json" | "text"
      | "image" | "html" | "code" | "spreadsheet" | "unsupported",
  text: string,          // may be truncated; see `truncated`
  truncated: boolean,    // true when text was cut to fit the per-file budget
  language?: string,     // present for `kind: "code"` only
}
```

**Errors**: `400` malformed FormData, `413` file too large, `500` for
extractor failures. Body shape: `{ error: string }`.

---

### `POST /api/embed`

Chunk + embed a file's extracted text into the `file_sections` vector
table (`docs/PLAN-local-rag.md` PR 2). The body carries the text
directly so indexing doesn't depend on `files.full_text` having synced;
the only cloud precondition is the `files` row existing (the
`file_sections.file_id` FK). Requires an authenticated Supabase session.

**Request**: `EmbedRequest`

```ts
{
  fileId: string,    // ≤ 64 chars; the owning files-row id
  text: string,      // ≤ 1.2 MB; the extracted full text
  force?: boolean,   // re-index even if sections already exist
}
```

**Response 200**: `EmbedResponse`

```ts
{
  status: "indexed" | "skipped",
  sections: number,  // chunks written, or already-present count on skip
  reason?: "not_configured" | "empty" | "already_indexed" | "file_not_found",
}
```

Idempotent: a file already chunked returns `skipped/already_indexed`
(no embed) unless `force`. `not_configured` (no server-side embedder)
and `file_not_found` (the FK row hasn't synced yet — the client
retries with backoff) are **200, not errors** — indexing is
best-effort background decoration.

**Errors**: `400` invalid body, `401` not signed in, `500` embed/insert
failure. Body shape: `{ code?: string, error: string }`.

---

### `POST /api/summarize`

Generate a short summary. Two modes via discriminated union on
`mode`.

**Request — file mode**:

```ts
{ mode: "file", name?: string, text: string, model?: string }
```

Response: `{ summary: string, keyTopics?: string[] }`

**Request — conversation mode**:

```ts
{
  mode: "conversation",
  messages: { role: "user" | "assistant", content: string }[],
  model?: string,
}
```

Response: `{ summary: string, keyPoints?: string[], decisions?: string[] }`

**Errors**: `400` invalid body, `401` missing AI key, `500` model
failure.

---

### `POST /api/share`

Mint a public share token for a conversation or its editor document.
Requires an authenticated Supabase session (cookie-based today).

**Request**:

```ts
{
  kind: "conversation" | "document",
  conversationId: string,  // uuid of a conversation the caller owns
}
```

**Response 200**: `{ token: string, kind: "conversation" | "document" }`

**Errors**: `400` invalid body, `401` unauthorised, `404` conversation
not found, `500` insert failure, `503` Supabase not configured.

### `DELETE /api/share/[token]`

Revoke an existing share token. Requires auth; users can only revoke
their own tokens (enforced by RLS).

**Response 200**: `{ ok: true }`

**Errors**: `401` unauthorised, `404` token not found, `500` update
failure, `503` Supabase not configured.

---

## Streaming route — `POST /api/chat`

Sends a chat request and streams the assistant response.

**Request**: `ChatRequestSchema` from `lib/api-schemas.ts`:

```ts
{
  messages: ModelMessage[],         // see schema; supports multimodal parts
  model?: string,                   // default = DEFAULT_CHAT_MODEL
  files?: FileSummary[],            // extracted-text bundles up to 20 files
  workspaceSystemPrompt?: string,   // prepended to base instructions
  skills?: { id: SkillId }[],       // e.g. [{ id: "webSearch" }]
}
```

**Response 200**: `Content-Type: text/event-stream` carrying SSE
frames. Each frame is `data: <json>\n\n`. `<json>` is one of the
shapes below, discriminated by `type`.

**Errors**: `401` missing AI gateway key (frontend falls back to a
mock response), `400` invalid body, other 4xx/5xx with
`{ code, message }` envelope.

### Frame protocol

The frontend's parser lives in `components/panels/chat.tsx`; the
shapes below are normative.

```jsonc
// Text delta — incremental answer content.
{ "type": "text", "value": "string fragment" }

// Reasoning delta — for models that emit reasoning tokens (DeepSeek R1,
// Claude thinking variants). Rendered in a collapsible block above the
// text.
{ "type": "reasoning", "value": "string fragment" }

// Tool invocation start — fired when the model calls a tool. The
// client shows a live "Searching for X…" pill above the message.
{
  "type": "tool_call",
  "id": "string",        // unique within this stream
  "name": "string",      // e.g. "webSearch"
  "args": { ... }        // tool-specific (e.g. { "query": "..." })
}

// Tool result — collapses the live pill to a "Searched · N results" pill.
{
  "type": "tool_result",
  "id": "string",        // matches the `tool_call` frame
  "name": "string",
  "summary": "string",   // one-line user-facing summary
  // Optional — populated by `webSearch` (and any future tools that want
  // a Sources strip + clickable [N] citation markers in the message).
  // Order matters: the assistant cites these as [1], [2], etc.
  "results": [
    { "title": "string", "url": "string", "snippet": "string" }
  ]
}

// Suggestion chips — follow-up question prompts. Sent at most once,
// after the main answer streams in.
{ "type": "suggestions", "values": ["...", "..."] }

// Terminal error — stops the stream. `code` matches MessageErrorCode.
// Categorisation is best-effort (string-match on provider message +
// typed-error introspection where available); when no branch claims
// the error it falls through to "unknown" (Next.js inline route) or
// "upstream" (agent-py / agent-ts services). The consumer maps both
// catch-alls to the same generic ErrorBubble surface.
{ "type": "error", "code": "auth" | "rate_limit" | "context_window"
                          | "invalid_model" | "provider" | "network"
                          | "unknown",
  "message": "string" }

// Stream end — last frame of a successful stream.
{ "type": "done" }
```

### Ordering rules

- Any number of `text` and `reasoning` frames may interleave.
- `tool_call` and matching `tool_result` frames may interleave with
  text. A `tool_result.id` MUST match an earlier `tool_call.id`.
- `suggestions` is sent at most once, after all text has streamed.
- A stream MUST terminate with exactly one of `done` or `error`.
- The client treats end-of-stream without `done`/`error` as
  `code: "provider", message: "empty response"`.

### Abort semantics

- The client may abort via `AbortSignal`. The route handler MUST stop
  the upstream model call when its `req.signal` aborts.
- An aborted stream produces no `done` frame. The client treats
  abort-with-empty-placeholder as a quiet cancel (the placeholder is
  deleted, no error shown).

---

## Streaming route — `POST /api/ai/command` and `POST /api/ai/copilot`

These two are consumed by Plate (`@platejs/ai`). The wire format is
the Vercel AI SDK's UI message stream / completion stream (not the
custom protocol used by `/api/chat`). Plate's `useChat` / `useCompletion`
hooks parse them — the frontend doesn't touch the bytes directly.

**Implication for a Python rewrite**: porting these two routes
requires emitting the AI SDK's stream format, which is a separate
spec from the chat-route SSE above. See
[`ai-sdk` docs](https://ai-sdk.dev/docs) for the wire format. If the
porting cost is high, these two routes can stay in Next.js while the
others move (the plan calls this out as a deferred decision).

---

## Direct Supabase calls (not part of this contract)

The frontend talks directly to Supabase for:

- Auth (magic-link, session refresh)
- Sync queue + reconciliation (`lib/sync/`)
- Storage uploads (`hooks/use-upload-file.ts`,
  `lib/files/persist.ts`)
- Share-page reads via the service-role admin client server-side
  (`lib/supabase/admin.ts`, used by `app/share/.../page.tsx`)

These bypass the backend entirely and are unaffected by a Python
rewrite.

---

## When you add a new endpoint

1. Add request and response Zod schemas to `lib/api-schemas.ts`.
2. Add the URL builder to `apiUrls` in `lib/api-client.ts`.
3. Add a typed method to `apiClient.*` that wraps `fetch`, parses the
   response via the Zod schema, and returns either the parsed value or
   a typed error result.
4. Document the route in this file under the right section.
5. Implement the route handler under `app/api/...`. The server-side
   `route.ts` should `ChatRequestSchema.safeParse(body)` (or whichever
   schema) to fail fast on malformed requests.
6. Update `docs/PLAN-backend-extraction.md`'s endpoint inventory if
   the new route should also be implemented by the Python service.

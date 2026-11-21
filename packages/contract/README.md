# packages/contract

The **spec-first, language-neutral source of truth** for the HTTP
contract between the Hummingbird frontend and its backend
([`docs/PLAN-frontend-backend-split.md`](../../docs/PLAN-frontend-backend-split.md),
decisions Q11, Q13, Q19, Q22). Both sides generate their code from the
files here; nothing here is generated from code.

| Path | What |
|---|---|
| `openapi.yaml` | Hand-written **OpenAPI 3.1**: paths, request/response schemas, the shared `ApiError`, the bearer security scheme |
| `agui/1.0/schema.json` | The **AG-UI 1.0** JSON Schema, vendored byte-for-byte. Never edit — see [`agui/SOURCE.md`](agui/SOURCE.md) for the source URL, commit and SHA-256 |
| [`RUN_EVENTS.md`](RUN_EVENTS.md) | Normative: how the backend's internal run events map onto AG-UI events, run statuses, interrupts, streams (cursor, replay, gap) and log compaction |
| `redocly.yaml`, `.redocly.lint-ignore.yaml` | Lint config for `openapi.yaml` (Redocly `recommended`; exceptions need a reason) |
| `scripts/gen.sh` | The single codegen entry point (`--check` for CI) |
| `scripts/lint.ts` | Redocly lint/validation of `openapi.yaml` |
| `conformance/` | The conformance suite: HTTP cases run against any backend URL, checked against `openapi.yaml` |
| `tests/` | Offline tests: the spec compiles, fixtures are valid, the vendored AG-UI schema is unchanged |

There is no `package.json`: the repo root does not use workspaces, and
the tooling (`openapi-typescript`, `@redocly/openapi-core`, `ajv`) is
in the root `devDependencies`. A package manifest arrives with the
Phase 5 move to `apps/web` + workspaces, if it is needed then.

## Generated code

Each consumer holds its own generated code; this package holds only the
spec and the tooling. When the frontend moves to `apps/web`, its output
path moves with it.

| Output | Generator | Import as |
|---|---|---|
| `lib/shared/contract/openapi.generated.ts` | [`openapi-typescript`](https://openapi-ts.dev) 7 (`--root-types`) | `import type { CitationTable, paths } from "@/shared/contract/openapi.generated"` — types only, isomorphic, so it is legal from `lib/client`, `lib/server` and `lib/shared` alike |
| `services/agent-py/src/agent_py/contract/models.py` | [`datamodel-code-generator`](https://koxudaxi.github.io/datamodel-code-generator/) (Pydantic v2), normalised with agent-py's ruff config | `from agent_py.contract import models` |

Both files start with a `DO NOT EDIT — generated from
packages/contract/openapi.yaml` header. Both generators are pinned by
the lockfiles (`bun.lock`, `services/agent-py/uv.lock`), so output is
byte-identical everywhere.

## Commands

```bash
bun run contract:gen          # regenerate both outputs from openapi.yaml
bun run contract:check        # lint openapi.yaml + fail if generated code is stale (CI)
bun run contract:lint         # lint only
bun test ./packages/contract  # offline tests (also part of `bun run test`)
```

`contract:gen` / `contract:check` need `uv` (for the Python generator)
and `cd services/agent-py && uv sync` once.

CI: the `contract` job in `.github/workflows/ci.yml` runs the lint, the
drift check and the offline tests. The suite's own typecheck and lint
ride on the root `tsc` / `eslint` in the `ci` job.

## Changing the contract

1. Edit `openapi.yaml`. Within `/v1` changes are **additive only** — a
   new optional field, a new operation, a new error `code`. Objects are
   left open (no `additionalProperties: false`) so a receiver ignores
   fields it does not know. A breaking change is a new `/v2` path
   alongside `/v1` (Q22). Bump `info.version`.
2. `bun run contract:gen` and commit the spec together with both
   generated files.
3. `bun run contract:check`, `bun run check`, `bun run check:agent-py`.
4. Give every new operation with a request body a fixture in
   `conformance/fixtures.ts` (a test fails until you do), and add
   conformance cases for anything the generic ones don't cover.
5. Implement it in the backend and run the conformance suite against it.

### Conventions

- `operationId` is camelCase and unique; it names the generated
  operation types and the conformance cases.
- Every `/v1` operation is bearer-secured (a Supabase user JWT); only
  the probes and the operations listed in `PUBLIC_V1_OPERATIONS`
  (`tests/spec.test.ts`, each with its reason — `getShare`, the
  anonymous share-link read, and `reportCspViolation`, which browsers
  post without credentials) are public (`security: []`). A test
  enforces this. Two narrower exceptions, also listed there with
  reasons: `startRun` also admits **no** credential (`security:
  [{bearerAuth: []}, {}]` — anonymous interactive runs), and the three
  operations on one run (`getRun`, `streamRunEvents`, `cancelRun`) also
  accept that run's `runToken` (`X-Run-Token` header) instead of a
  bearer token. A present but invalid credential is always 401, never
  read as anonymous.
- Error responses reference `components/schemas/ErrorResponse` through
  the shared `components/responses/*`.
- Field casing follows the wire as it already exists: the refresh-url
  bodies use `storage_path` (agent-py's convention; the in-Next routes
  take `storagePath`), extract-table uses camelCase (the client sends
  the same body to both backends).

### Errors

`ApiError` (`{ code, message }`, open set of codes — see
`lib/shared/api-errors.ts`) is the envelope the frontend reads, and the
only error body the contract allows: `ErrorResponse` is `ApiError`, and
validation failures (`components/responses/ValidationError`) answer
`ValidationErrorResponse` — an `ApiError` (`code: invalid_request`) with
the problems in an optional `issues: ValidationIssue[]`. Objects are
open, so a route may add fields beside `code` / `message` (e.g. `reason`,
`status`). The conformance suite checks every 4xx/5xx body against both
the documented schema and `ApiError` — there is no opt-out.

agent-py produces this envelope for every non-streaming error via the
exception handlers in `services/agent-py/src/agent_py/error_envelope.py`
(which also holds the status → `code` table for errors raised without an
explicit code). Status codes are unchanged; agent-py's request
validation still answers 422.

**agent-ts** (`services/agent-ts`, frozen) still answers some errors in
its older shapes and is **not claimed conformant** — only agent-py is
run against the suite.

### AG-UI and the runs operations (Phase 2)

The runs operations (tag `runs`: `startRun`, `listRuns`, `getRun`,
`streamRunEvents`, `cancelRun`) reference the vendored schema by JSON
pointer, relative to `openapi.yaml` — `RunAgentInput`, `Interrupt`, and
`Event` for the `text/event-stream` responses. How the backend's
internal events become AG-UI events, what each status means, the
stream cursor, `gap` + `MESSAGES_SNAPSHOT` and compaction are specified
in [`RUN_EVENTS.md`](RUN_EVENTS.md); the operation descriptions in
`openapi.yaml` carry the HTTP-level rules (idempotent `runId`,
`runToken`, errors).

Things worth knowing when changing them:

- **`RunAgentInput` is closed** (`unevaluatedProperties: false`), so
  nothing can be added at its top level — not even under `allOf`.
  `StartRunRequest` narrows it (UUID `threadId` / `runId`, a typed
  `forwardedProps`) and Hummingbird's run options, `mode` included, live
  in `forwardedProps` (`RunForwardedProps`, open). The narrowing uses a
  UUID `pattern`, not `format: uuid`, so the generated Pydantic subclass
  keeps AG-UI's `str` fields (mypy rejects a `UUID` override).
- **Anchors.** Every AG-UI definition carries a `$anchor`; Redocly's
  dereference inlines a definition everywhere it is used, so one schema
  can hold the same anchor twice, which Ajv rejects. `loadSpec()`
  strips `$anchor` after bundling (the refs are all resolved by then).
- **Generated code.** `openapi-typescript` inlines the referenced
  AG-UI types (the full `Event` union included); `datamodel-code-generator`
  emits the referenced AG-UI models (`RunAgentInput`, `Message` and its
  members, `Interrupt`, `ResumeEntry`, …) but not the SSE `Event` union
  — the backend's AG-UI encoder builds events as plain JSON objects.
- **Strictness.** The generated `RunAgentInput` model forbids extra
  keys, like the schema. That is right for conformance (validating a
  backend's output), but AG-UI's guidance is that receivers tolerate
  unknown fields: the frontend must never validate a stream with it,
  and the backend should decide deliberately whether a newer client's
  extra input field is a 422.
- The custom-event payload schemas (`RunGapEventValue`,
  `RunRewindEventValue`) are not referenced by any operation — they
  travel inside SSE frames — so `.redocly.lint-ignore.yaml` exempts
  them from `no-unused-components`.

### Planned operations (`x-planned`)

An operation can be specified before any backend implements it: it
carries `x-planned: <wave>` (the runs operations: `wave-3b`). The
conformance suite skips planned operations (`Operation.planned` in
`conformance/harness.ts`), so a backend is held to everything else with
`CONTRACT_SKIP_OPERATIONS` unset — "strict" conformance. Planned
operations still get the offline checks (schemas compile, fixtures
validate, security shape). `tests/spec.test.ts` keeps the planned set
in `PLANNED_OPERATIONS`, so implementing one is deliberate: delete the
marker **and** the entry, add its conformance cases, and run the suite.

### The Zod schemas

`lib/shared/api-schemas.ts` (Zod) still validates responses in
`lib/client/api-client.ts` and requests in the Next routes. Per Q19
they are retired as endpoints move to the backend: as each Next route
is removed (Phase 5) its Zod schemas go too, and the client parses with
validators derived from this spec (e.g. Zod generated from
`openapi.yaml`, or Ajv over the generated JSON Schema) instead of
hand-written ones. Until then, a change to a `/v1` operation that
already has a Zod twin must update both — the conformance suite is what
catches a backend that drifted from the spec.

The old code-first pipeline (`bun run codegen:agent-types` → FastAPI's
`/openapi.json` → `lib/shared/agent-py-types.generated.ts`) keeps
running unchanged until a later wave retires it in favour of this one.

## Conformance suite

`conformance/` drives HTTP against `CONTRACT_BASE_URL` and validates
every response — status and JSON body — against the operation in
`openapi.yaml`. It knows nothing about the implementation, so agent-py
and a future TypeScript backend (Q11) run exactly the same cases.

**Runner: `bun test` + Ajv (JSON Schema 2020-12).** OpenAPI 3.1 schemas
*are* 2020-12, so Ajv validates them directly (after Redocly inlines
the `$ref`s) with no translation layer. Bun is already the repo's test
runner and CI toolchain, the suite is typechecked and linted with the
rest of the repo, and it shares no code with any backend — which keeps
the "language-neutral" promise honest: the backend under test is just a
URL. (Schemathesis-style fuzzing can be layered on later;
it would not replace hand-written cases for auth and lifecycle.)

| Variable | Meaning |
|---|---|
| `CONTRACT_BASE_URL` | Backend origin, e.g. `http://localhost:8765`. Unset → every case is skipped (so `bun run test` stays offline) |
| `CONTRACT_AUTH_TOKEN` | Optional Supabase user JWT for cases that need a signed-in caller (`errors.test.ts`; skipped without it) |
| `CONTRACT_SKIP_OPERATIONS` | Comma-separated `operationId`s the backend does not implement yet |

Cases today:

- `meta.test.ts` — `/healthz` and `/readyz` answer 200 with their
  documented bodies, without and with a bogus `Authorization` header.
- `auth.test.ts` — derived from the spec: every bearer-secured
  operation, called with a schema-valid body (`fixtures.ts`), refuses no
  token, a malformed token and a non-Bearer scheme with 401 and a
  documented error body. Needs no Supabase — only the backend's JWT
  secret configured (without it agent-py answers 503 and the case fails
  with a hint).
- `errors.test.ts` — with `CONTRACT_AUTH_TOKEN`: every secured operation
  with a request body, sent `{}`, answers 400/422 with an `ApiError`
  whose `code` is `invalid_request`. Any token the backend accepts works
  (agent-py: an HS256 JWT signed with its `SUPABASE_JWT_SECRET`, `role`
  `authenticated`, a UUID `sub`, `aud` `authenticated`, future `exp`).
- `share.test.ts` — the public `getShare`: an unknown token answers 404
  `not_found` with no token, and a bogus `Authorization` header is
  ignored rather than refused. Path parameters (`{token}`) are filled
  from `pathParams` in `fixtures.ts`.
- `security.test.ts` — the public CSP report intake: a well-formed
  report (`application/csp-report`, `application/reports+json`) → 204
  with an empty body; malformed JSON → 400 `invalid_request`, an
  unsupported media type → 415 `unsupported_content_type`, both with the
  standard `ApiError` body.

### Running it against agent-py

```bash
# terminal 1 — any non-empty secret makes agent-py verify (and reject) tokens
cd services/agent-py
SUPABASE_JWT_SECRET=conformance-local-secret uv run uvicorn agent_py.main:app --port 8765

# terminal 2
CONTRACT_BASE_URL=http://localhost:8765 bun run contract:conformance
```

An operation the backend has not implemented yet answers 404 and fails
with a hint; mark it `x-planned` in the spec (preferred — see above) or
skip it locally, e.g. `CONTRACT_SKIP_OPERATIONS=refreshFileUrl,extractTable`.
Strict conformance is the suite passing with `CONTRACT_SKIP_OPERATIONS`
unset (and `CONTRACT_AUTH_TOKEN` set, so `errors.test.ts` runs too).

### What the runs conformance cases must cover (wave 3b)

Removing `x-planned` from the runs operations brings them under the
generic cases (`auth.test.ts`: 401 without / with a bad credential —
`startRun`'s fixture is a **background** run so an anonymous call is a
401 too; `errors.test.ts`: `{}` → `invalid_request`). Wave 3b adds a
`runs.test.ts` (and an SSE reader in the harness — `assertConforms`
only checks JSON bodies) covering at least:

- **start, interactive**: 200 `text/event-stream`; every `data:` is a
  valid AG-UI `Event`; the stream opens with `RUN_STARTED` (matching
  `threadId` / `runId`), ends with `RUN_FINISHED` or `RUN_ERROR`, and
  every other event (bar a `gap`) has a strictly increasing `id:` in
  `RunCursor` form. Needs a model-free path in the backend under test
  (e.g. its stub harness) so the case costs nothing.
- **start, background**: 202 `RunAccepted`; `getRun` then answers
  `queued`/`running`; without a token → 401 `auth_required`; a
  `threadId` the caller does not own → 404.
- **idempotency**: the same body twice → one run (202 twice / the second
  interactive call replays from `0`); same `runId`, other `threadId` or
  `mode` → 409 `run_id_conflict`; a second user reusing the `runId` →
  the identical 409 body.
- **validation**: non-UUID `runId` / `threadId` → 422; `resume[]`
  without `forwardedProps.previousRunId` → 400; `resume[]` not covering
  the previous run's open interrupts → 409 `invalid_state`.
- **anonymous**: no `Authorization` → 200 + an `X-Run-Token` matching
  `RunToken`; `getRun` / `streamRunEvents` / `cancelRun` with that
  token → 200, with another token or none → 404 / 401; `listRuns`
  without a bearer → 401.
- **rejoin**: `after=<cursor>` returns exactly the events after it (no
  repeat, no skip) — compare with a full replay; `Last-Event-ID` is
  equivalent; a malformed or out-of-range cursor → 400; a compacted run
  replayed from `0` → `RUN_STARTED`, `CUSTOM hummingbird.gap` (value
  valid against `RunGapEventValue`), `MESSAGES_SNAPSHOT`, then the
  closing event.
- **status / cancel**: `getRun` body valid against `Run`, with the
  `status` ↔ `result` / `error` / `openInterrupts` rule; cancel is
  idempotent (twice → 200 `cancelled` both times; a finished run is
  returned unchanged) and closes a live stream with `RUN_FINISHED {
  outcome: { type: "cancelled" } }`.
- **list**: filters (`threadId`, repeated `status`, `parentRunId`,
  `mode`), newest-first order, `pageSize` bounds, `nextPageToken` walk
  with no duplicates or gaps, garbage `pageToken` → 400, another user's
  runs never listed.
- **not found**: an unknown or foreign `runId` → the same 404 body for
  `getRun`, `streamRunEvents` and `cancelRun`.

The suite is not in CI yet (CI starts no backend); that comes with the
reverse-proxy / compose setup.

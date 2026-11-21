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
  the probes and `reportCspViolation` (browsers post CSP reports without
  credentials) are public (`security: []`). A test enforces this
  (`PUBLIC_V1_OPERATIONS` in `tests/spec.test.ts`).
- Error responses reference `components/schemas/ErrorResponse` through
  the shared `components/responses/*`.
- Field casing follows the wire as it already exists: the refresh-url
  bodies use `storage_path` (agent-py's convention; the in-Next routes
  take `storagePath`), extract-table uses camelCase (the client sends
  the same body to both backends).

### Errors

`ApiError` (`{ code, message }`, open set of codes — see
`lib/shared/api-errors.ts`) is the envelope the frontend reads. agent-py
today still answers with FastAPI's `{ detail: … }` envelope, so
`ErrorResponse` is `ApiError | LegacyFastApiError` for now. Once agent-py
installs an exception handler that flattens `detail`, drop
`LegacyFastApiError` from `ErrorResponse`; until then
`CONTRACT_STRICT_ERRORS=1` shows what would fail.

### AG-UI (Phase 2)

No run endpoints exist yet. When they land, reference the vendored
schema by JSON pointer, relative to `openapi.yaml`:

```yaml
requestBody:
  content:
    application/json:
      schema:
        $ref: "./agui/1.0/schema.json#/$defs/RunAgentInput"
# SSE events: "./agui/1.0/schema.json#/$defs/Event"  (type-discriminated union)
```

Verified while setting this package up: Redocly bundles such a `$ref`,
`openapi-typescript` inlines it into the generated types, and
`datamodel-code-generator` emits importable Pydantic models for it
(~90 classes). They are deliberately not referenced yet, so the
generated code carries only what is in use. `tests/agui-schema.test.ts`
already compiles the schema with the conformance suite's validator and
checks `RunAgentInput` and the events the run contract uses. The
schema is strict (closed objects): use it to validate a backend's
output in conformance, never in the frontend's receive path (AG-UI's
own guidance).

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
| `CONTRACT_AUTH_TOKEN` | Optional Supabase user JWT for cases that need a signed-in caller (none yet) |
| `CONTRACT_SKIP_OPERATIONS` | Comma-separated `operationId`s the backend does not implement yet |
| `CONTRACT_STRICT_ERRORS=1` | Validate error bodies against `ApiError` only (rejects the legacy FastAPI envelope) |

Cases today:

- `meta.test.ts` — `/healthz` and `/readyz` answer 200 with their
  documented bodies, without and with a bogus `Authorization` header.
- `auth.test.ts` — derived from the spec: every bearer-secured
  operation, called with a schema-valid body (`fixtures.ts`), refuses no
  token, a malformed token and a non-Bearer scheme with 401 and a
  documented error body. Needs no Supabase — only the backend's JWT
  secret configured (without it agent-py answers 503 and the case fails
  with a hint).
- `security.test.ts` — the public CSP report intake: a well-formed
  report (`application/csp-report`, `application/reports+json`) → 204,
  malformed JSON → 400, an unsupported media type → 415, all with an
  empty body.

### Running it against agent-py

```bash
# terminal 1 — any non-empty secret makes agent-py verify (and reject) tokens
cd services/agent-py
SUPABASE_JWT_SECRET=conformance-local-secret uv run uvicorn agent_py.main:app --port 8765

# terminal 2
CONTRACT_BASE_URL=http://localhost:8765 bun run contract:conformance
```

An operation the backend has not implemented yet answers 404 and fails
with a hint; skip it until it lands, e.g.
`CONTRACT_SKIP_OPERATIONS=refreshFileUrl,extractTable`.

The suite is not in CI yet (CI starts no backend); that comes with the
reverse-proxy / compose setup.

/**
 * Offline checks on openapi.yaml — no backend needed; runs in `bun run test`.
 * (Redocly's lint runs separately: `bun run contract:lint`.)
 */
import { beforeAll, describe, expect, test } from "bun:test"

import { validRequestBodies } from "../conformance/fixtures"
import { Contract, createAjv, loadSpec, operations } from "../conformance/harness"

/** `/v1` operations that are deliberately public (`security: []`). Each
 *  needs a reason; adding one here is a security decision, not a fix for
 *  a failing test.
 *  - getShare: the share token is the capability — anonymous viewers open
 *    a share link without an account.
 *  - reportCspViolation: browsers POST CSP violation reports without
 *    credentials.
 *  - listModels: the model picker reads it signed out too (anonymous runs
 *    and editor calls pick a model); it names catalog ids only (Q119). */
const PUBLIC_V1_OPERATIONS = new Set(["getShare", "reportCspViolation", "listModels"])

/** `/v1` operations that take a bearer token OR no credential at all
 *  (`security: [{ bearerAuth: [] }, {}]`). Same bar as above.
 *  - startRun: anonymous callers may start interactive runs (Q2/Q16/Q20);
 *    the run's `X-Run-Token` is their credential afterwards.
 *  - editorAiCommand / editorAiComplete: the editor's AI, as on Next
 *    (Q105; `REQUIRE_AUTH_FOR_AI` refuses anonymous callers).
 *  - extractFile, summarize, extractTable, fetchUrl, mcpProxy, embedFile:
 *    the non-chat calls a signed-out browser makes (0.8.0, Q123/Q134),
 *    served under per-IP limits; `REQUIRE_AUTH_FOR_AI` refuses anonymous
 *    callers (extractFile: serves them without its vision pass). mcpProxy
 *    only on the local-credentials path; embedFile indexes nothing for
 *    them. The account-bound operations (share, schedules, memory, the
 *    storage links, upsertMcpServer) stay bearer-only. */
const ANONYMOUS_ALLOWED_V1_OPERATIONS = new Set([
  "startRun",
  "editorAiCommand",
  "editorAiComplete",
  "extractFile",
  "summarize",
  "extractTable",
  "fetchUrl",
  "mcpProxy",
  "embedFile",
])

/** The operations an anonymous run's `runToken` authorises — only the
 *  ones addressing that one run. */
const RUN_TOKEN_OPERATIONS = new Set(["getRun", "streamRunEvents", "cancelRun"])

/** Specified but not implemented yet (`x-planned`), so the conformance
 *  suite skips them. Implementing one means deleting its marker in
 *  openapi.yaml AND its entry here — this list makes that deliberate. */
const PLANNED_OPERATIONS: Record<string, string> = {}

describe("contract: openapi.yaml", () => {
  let contract: Contract
  beforeAll(async () => {
    contract = new Contract(await loadSpec())
  })

  test("operationIds are unique and every /v1 operation is bearer-secured (bar the listed public ones)", () => {
    const ops = operations(contract.spec)
    expect(new Set(ops.map((o) => o.operationId)).size).toBe(ops.length)
    for (const op of ops) {
      if (op.path.startsWith("/v1/")) {
        const expected = !PUBLIC_V1_OPERATIONS.has(op.operationId)
        expect([op.operationId, op.secured]).toEqual([op.operationId, expected])
      } else expect(op.path).toMatch(/^\/(healthz|readyz)$/)
    }
  })

  test("anonymous alternatives and run tokens appear only where listed", () => {
    for (const op of contract.all()) {
      const security = op.raw.security ?? contract.spec.security ?? []
      const anonymousAlt = op.secured && security.some((req) => Object.keys(req).length === 0)
      expect([op.operationId, anonymousAlt]).toEqual([
        op.operationId,
        ANONYMOUS_ALLOWED_V1_OPERATIONS.has(op.operationId),
      ])
      const runToken = security.some((req) => "runToken" in req)
      expect([op.operationId, runToken]).toEqual([op.operationId, RUN_TOKEN_OPERATIONS.has(op.operationId)])
      // A run token is an alternative to the bearer token, never a replacement.
      if (runToken) expect(security.some((req) => "bearerAuth" in req)).toBe(true)
    }
  })

  test("x-planned marks exactly the operations listed as planned", () => {
    const planned = Object.fromEntries(
      contract
        .all()
        .filter((op) => op.planned !== null)
        .map((op) => [op.operationId, op.planned]),
    )
    expect(planned).toEqual(PLANNED_OPERATIONS)
  })

  test("startRun's body is an AG-UI RunAgentInput narrowed to UUID ids", () => {
    const validate = createAjv().compile(contract.operation("startRun").raw.requestBody!.content!["application/json"]!.schema!)
    const base = validRequestBodies.startRun as Record<string, unknown>
    expect(validate(base)).toBe(true)
    // Plain AG-UI input (no forwardedProps) is a valid interactive run.
    expect(validate({ threadId: base.threadId, runId: base.runId, messages: base.messages })).toBe(true)
    expect(validate({ ...base, runId: "r1" })).toBe(false)
    expect(validate({ ...base, threadId: "t1" })).toBe(false)
    // Closed like RunAgentInput: no top-level extras (mode lives in forwardedProps).
    expect(validate({ ...base, mode: "background" })).toBe(false)
    expect(validate({ ...base, forwardedProps: { mode: "sometimes" } })).toBe(false)
    // forwardedProps stays open for keys a later wave adds.
    expect(validate({ ...base, forwardedProps: { mode: "interactive", futureKey: 1 } })).toBe(true)
  })

  test("every response and request schema compiles as JSON Schema 2020-12", () => {
    const ajv = createAjv()
    for (const op of contract.all()) {
      const media = [
        op.raw.requestBody?.content?.["application/json"],
        ...Object.values(op.raw.responses).map((r) => r.content?.["application/json"]),
      ]
      for (const m of media) if (m?.schema) ajv.compile(m.schema)
    }
  })

  test("every operation with a request body has a valid conformance fixture", () => {
    const ajv = createAjv()
    const withBody = contract.all().filter((op) => op.raw.requestBody)
    expect(Object.keys(validRequestBodies).sort()).toEqual(withBody.map((o) => o.operationId).sort())
    for (const op of withBody) {
      const content = op.raw.requestBody?.content
      // JSON bodies, and multipart ones (extractFile: the fixture is its
      // form fields).
      const schema = (content?.["application/json"] ?? content?.["multipart/form-data"])?.schema
      expect(schema).toBeDefined()
      const validate = ajv.compile(schema!)
      const ok = validate(validRequestBodies[op.operationId])
      expect([op.operationId, ok, ajv.errorsText(validate.errors)]).toEqual([op.operationId, true, "No errors"])
    }
  })

  test("ErrorResponse is the flat ApiError envelope only", () => {
    const validate = createAjv().compile(contract.schema("ErrorResponse"))
    expect(validate({ code: "auth", message: "Unauthorized." })).toBe(true)
    // Open object: a route may add fields beside code/message.
    expect(validate({ code: "mcp_url_blocked", message: "Not allowed.", reason: "private_address" })).toBe(true)
    // The legacy FastAPI envelope is rejected in every form.
    expect(validate({ detail: "Invalid token." })).toBe(false)
    expect(validate({ detail: { code: "forbidden", message: "Nope." } })).toBe(false)
    expect(validate({ detail: [{ loc: ["body", "storage_path"], msg: "Field required", type: "missing" }] })).toBe(false)
    expect(validate({ error: "Unauthorized." })).toBe(false)
    expect(validate({ code: "auth" })).toBe(false)
  })

  test("ValidationErrorResponse is an ApiError with optional issues", () => {
    const validate = createAjv().compile(contract.schema("ValidationErrorResponse"))
    const issue = { loc: ["body", "storagePath"], msg: "Field required", type: "missing" }
    expect(validate({ code: "invalid_request", message: "body.storagePath: Field required", issues: [issue] })).toBe(true)
    expect(validate({ code: "invalid_request", message: "Invalid request body." })).toBe(true)
    expect(validate({ code: "invalid_request", message: "x", issues: [{ msg: "no loc" }] })).toBe(false)
    expect(validate({ detail: [issue] })).toBe(false)
  })

  test("every documented 4xx/5xx body is (or extends) ApiError", () => {
    for (const op of contract.all()) {
      for (const [status, res] of Object.entries(op.raw.responses)) {
        if (!/^[45]/.test(status)) continue
        const schema = res.content?.["application/json"]?.schema
        expect([op.operationId, status, schema !== undefined]).toEqual([op.operationId, status, true])
        const validate = createAjv().compile(schema!)
        // The legacy envelope fails every documented error schema; a bare
        // ApiError passes every one.
        expect([op.operationId, status, validate({ detail: "x" })]).toEqual([op.operationId, status, false])
        expect([op.operationId, status, validate({ code: "x", message: "y" })]).toEqual([op.operationId, status, true])
      }
    }
  })
})

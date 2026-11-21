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
 *    a share link without an account. */
const PUBLIC_V1_OPERATIONS = new Set(["getShare"])

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
      const schema = op.raw.requestBody?.content?.["application/json"]?.schema
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

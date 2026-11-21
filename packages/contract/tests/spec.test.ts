/**
 * Offline checks on openapi.yaml — no backend needed; runs in `bun run test`.
 * (Redocly's lint runs separately: `bun run contract:lint`.)
 */
import { beforeAll, describe, expect, test } from "bun:test"

import { validRequestBodies } from "../conformance/fixtures"
import { Contract, createAjv, loadSpec, operations } from "../conformance/harness"

describe("contract: openapi.yaml", () => {
  let contract: Contract
  beforeAll(async () => {
    contract = new Contract(await loadSpec())
  })

  test("operationIds are unique and every /v1 operation is bearer-secured", () => {
    const ops = operations(contract.spec)
    expect(new Set(ops.map((o) => o.operationId)).size).toBe(ops.length)
    for (const op of ops) {
      if (op.path.startsWith("/v1/")) expect([op.operationId, op.secured]).toEqual([op.operationId, true])
      else expect(op.path).toMatch(/^\/(healthz|readyz)$/)
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

  test("ErrorResponse accepts ApiError and the transitional FastAPI envelope only", () => {
    const validate = createAjv().compile(contract.schema("ErrorResponse"))
    expect(validate({ code: "auth", message: "Unauthorized." })).toBe(true)
    expect(validate({ detail: "Invalid token." })).toBe(true)
    expect(validate({ detail: { code: "forbidden", message: "Nope." } })).toBe(true)
    expect(validate({ detail: [{ loc: ["body", "storage_path"], msg: "Field required", type: "missing" }] })).toBe(true)
    expect(validate({ error: "Unauthorized." })).toBe(false)
    expect(validate({ code: "auth" })).toBe(false)
  })
})

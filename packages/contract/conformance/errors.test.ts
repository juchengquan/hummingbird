/**
 * Error envelope beyond auth: a signed-in caller sending a body that
 * fails the operation's request schema gets a documented 400/422 whose
 * body is an `ApiError` (`{ code, message }`, `code` `invalid_request`) —
 * not a framework default such as FastAPI's `{ detail: [...] }`.
 *
 * Needs `CONTRACT_AUTH_TOKEN` (a JWT the backend accepts); skipped
 * without it. The token's user needs no data: the body is rejected before
 * any lookup.
 */
import { beforeAll, describe, expect, test } from "bun:test"

import { call, Contract, createAjv, env, loadSpec, operations } from "./harness"

const withBody = env.baseUrl
  ? operations(await loadSpec()).filter((op) => op.secured && op.raw.requestBody)
  : []

describe.skipIf(!env.baseUrl || !env.authToken)(`conformance: error envelope @ ${env.baseUrl}`, () => {
  let contract: Contract
  beforeAll(async () => {
    contract = await Contract.load()
  })

  for (const op of withBody) {
    test.skipIf(env.skipOperations.has(op.operationId) || op.planned !== null)(
      `${op.operationId}: schema-invalid body → 400/422 invalid_request`,
      async () => {
        const schema = op.raw.requestBody?.content?.["application/json"]?.schema
        // Only meaningful when `{}` really is invalid for this operation.
        if (!schema || createAjv().compile(schema)({})) return
        const ex = await call(op, { body: {}, token: env.authToken })
        expect([400, 422]).toContain(ex.status)
        contract.assertConforms(op.operationId, ex)
        expect((ex.body as { code?: unknown }).code).toBe("invalid_request")
      },
    )
  }
})

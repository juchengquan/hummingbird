/**
 * Every operation the spec marks as bearer-secured must refuse a caller
 * without a valid token: 401 with a documented error body. Cases are
 * derived from the spec, so a new secured operation is covered the moment
 * it is added (and `tests/spec.test.ts` forces it a request fixture).
 *
 * These cases need no live Supabase — only the backend's JWT secret to be
 * configured. A backend with no secret answers 503 (documented, but it
 * means the suite cannot check auth), which fails with a hint.
 */
import { beforeAll, describe, expect, test } from "bun:test"

import { validRequestBodies } from "./fixtures"
import { call, Contract, env, loadSpec, operations, type Exchange } from "./harness"

// Discovered up front so each operation gets its own named test.
const secured = env.baseUrl ? operations(await loadSpec()).filter((op) => op.secured) : []

function expect401(ex: Exchange, operationId: string) {
  if (ex.status === 404) {
    throw new Error(
      `backend answered 404: ${operationId} looks unimplemented ` +
        "(list it in CONTRACT_SKIP_OPERATIONS to skip it until it is)",
    )
  }
  if (ex.status === 503) {
    throw new Error(
      "backend answered 503: its auth is not configured (agent-py: set SUPABASE_JWT_SECRET), " +
        "so the 401 cases cannot run",
    )
  }
  expect(ex.status).toBe(401)
}

describe.skipIf(!env.baseUrl)(`conformance: bearer auth @ ${env.baseUrl}`, () => {
  let contract: Contract
  beforeAll(async () => {
    contract = await Contract.load()
  })

  for (const op of secured) {
    // A planned operation (`x-planned`) is not implemented yet: skipped.
    const skip = env.skipOperations.has(op.operationId) || op.planned !== null
    const body = validRequestBodies[op.operationId]

    test.skipIf(skip)(`${op.operationId}: no token → 401 + error body`, async () => {
      const ex = await call(op, { body })
      expect401(ex, op.operationId)
      contract.assertConforms(op.operationId, ex)
    })

    test.skipIf(skip)(`${op.operationId}: malformed token → 401 + error body`, async () => {
      const ex = await call(op, { body, token: "not-a-jwt" })
      expect401(ex, op.operationId)
      contract.assertConforms(op.operationId, ex)
    })

    test.skipIf(skip)(`${op.operationId}: non-Bearer scheme → 401 + error body`, async () => {
      const ex = await call(op, { body, headers: { authorization: "Basic Zm9vOmJhcg==" } })
      expect401(ex, op.operationId)
      contract.assertConforms(op.operationId, ex)
    })
  }
})

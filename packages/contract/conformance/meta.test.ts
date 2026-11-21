/**
 * Probes: `/healthz` and `/readyz` are public and always answer 200 with
 * their documented bodies.
 */
import { beforeAll, describe, expect, test } from "bun:test"

import { call, Contract, env } from "./harness"

describe.skipIf(!env.baseUrl)(`conformance: meta probes @ ${env.baseUrl}`, () => {
  let contract: Contract
  beforeAll(async () => {
    contract = await Contract.load()
  })

  for (const operationId of ["getHealthz", "getReadyz"]) {
    test.skipIf(env.skipOperations.has(operationId))(`${operationId} → 200 + schema`, async () => {
      const op = contract.operation(operationId)
      const ex = await call(op)
      expect(ex.status).toBe(200)
      contract.assertConforms(operationId, ex)
    })
  }

  test("probes need no Authorization header, and ignore a bad one", async () => {
    const ex = await call(contract.operation("getHealthz"), { token: "not-a-jwt" })
    expect(ex.status).toBe(200)
    contract.assertConforms("getHealthz", ex)
  })
})

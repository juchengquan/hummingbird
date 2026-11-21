/**
 * Sharing cases the generic auth cases don't cover. `createShare` and
 * `revokeShare` are bearer-secured, so `auth.test.ts` already checks that
 * an unauthenticated create / revoke is a 401 with a documented body.
 * `getShare` is the one public `/v1` operation: it must answer without a
 * token, and an unknown token must be a plain 404 — no hint of whether
 * the token ever existed.
 *
 * Needs no Supabase: a backend without a database must also answer 404
 * for every token (it can resolve none).
 */
import { beforeAll, describe, expect, test } from "bun:test"

import { call, Contract, env } from "./harness"

/** The `code` of an error body, flat (`ApiError`) or in the transitional
 *  FastAPI `{ detail: ApiError }` envelope. */
function errorCode(body: unknown): unknown {
  if (!body || typeof body !== "object") return undefined
  const b = body as { code?: unknown; detail?: unknown }
  if (b.code !== undefined) return b.code
  if (b.detail && typeof b.detail === "object") return (b.detail as { code?: unknown }).code
  return undefined
}

describe.skipIf(!env.baseUrl)(`conformance: sharing @ ${env.baseUrl}`, () => {
  let contract: Contract
  beforeAll(async () => {
    contract = await Contract.load()
  })

  const skip = env.skipOperations.has("getShare")

  test.skipIf(skip)("getShare: unknown token, no auth → 404 not_found", async () => {
    const op = contract.operation("getShare")
    const ex = await call(op, { pathParams: { token: "no-such-share-token-0000" } })
    expect(ex.status).toBe(404)
    contract.assertConforms("getShare", ex)
    expect(errorCode(ex.body)).toBe("not_found")
  })

  test.skipIf(skip)("getShare: a bogus Authorization header is ignored, not a 401", async () => {
    const op = contract.operation("getShare")
    const ex = await call(op, {
      token: "not-a-jwt",
      pathParams: { token: "no-such-share-token-0001" },
    })
    expect(ex.status).toBe(404)
    contract.assertConforms("getShare", ex)
  })
})

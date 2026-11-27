/**
 * Signed-out non-chat calls (0.8.0, Q123/Q134): the operations a browser
 * without a session uses take no token at all — they are served, not 401
 * — while a bad token is still a 401 (`auth.test.ts`). Each case is chosen
 * to spend nothing: no model call (an unknown model is refused first), no
 * outbound fetch (an unparseable URL), no
 * index write (embedding indexes nothing for an anonymous caller).
 *
 * With `CONTRACT_REQUIRE_AUTH_FOR_AI=1` (the backend runs with
 * `REQUIRE_AUTH_FOR_AI` on) every case but `extractFile` expects
 * `401 auth_required` instead; `extractFile` is still served, without its
 * vision pass. The per-IP limits are not exercised — tripping one would
 * make the other cases in a shared run flaky.
 */
import { beforeAll, describe, expect, test } from "bun:test"

import { validRequestBodies } from "./fixtures"
import { call, Contract, env, type Exchange } from "./harness"

function code(ex: Exchange): unknown {
  return (ex.body as { code?: unknown } | undefined)?.code
}

describe.skipIf(!env.baseUrl)(`conformance: signed-out calls @ ${env.baseUrl}`, () => {
  let contract: Contract
  beforeAll(async () => {
    contract = await Contract.load()
  })

  /** One anonymous exchange, checked against the contract; under the
   *  sign-in gate a gated operation must refuse it `401 auth_required`.
   *  Returns null in that case (nothing else to check). */
  async function anonymous(
    operationId: string,
    opts: Parameters<typeof call>[1],
    gated = true,
  ): Promise<Exchange | null> {
    const ex = await call(contract.operation(operationId), opts)
    contract.assertConforms(operationId, ex)
    if (gated && env.requireAuthForAi) {
      expect([ex.status, code(ex)]).toEqual([401, "auth_required"])
      return null
    }
    expect(ex.status).not.toBe(401)
    return ex
  }

  const skip = (operationId: string) => env.skipOperations.has(operationId)

  test.skipIf(skip("extractFile"))("extractFile: a text file, no token → 200 text", async () => {
    const ex = await anonymous("extractFile", { body: validRequestBodies.extractFile }, false)
    expect(ex!.status).toBe(200)
    const body = ex!.body as { kind: string; text: string; truncated: boolean }
    expect(body.kind).toBe("text")
    expect(body.text).toContain("Conformance probe")
    expect(body.truncated).toBe(false)
  })

  test.skipIf(skip("summarize"))("summarize: no token, unknown model → 400 unknown_model", async () => {
    const ex = await anonymous("summarize", {
      body: { ...(validRequestBodies.summarize as object), model: "conformance/no-such-model" },
    })
    if (!ex) return
    expect([ex.status, code(ex)]).toEqual([400, "unknown_model"])
  })

  test.skipIf(skip("extractTable"))("extractTable: no token, unknown model → 400 unknown_model", async () => {
    const ex = await anonymous("extractTable", {
      body: { ...(validRequestBodies.extractTable as object), model: "conformance/no-such-model" },
    })
    if (!ex) return
    expect([ex.status, code(ex)]).toEqual([400, "unknown_model"])
  })

  test.skipIf(skip("fetchUrl"))("fetchUrl: no token, unparseable URL → 400 invalid_url", async () => {
    const ex = await anonymous("fetchUrl", { body: { url: "   " } })
    if (!ex) return
    expect([ex.status, code(ex)]).toEqual([400, "invalid_url"])
  })

  // The proxy is never an anonymous open relay: where accounts exist (every
  // backend this suite runs against verifies tokens) it wants a session, as
  // Next's route does; only a deploy without accounts serves it anonymously.
  test.skipIf(skip("mcpProxy"))("mcpProxy: no token where accounts exist → 401 auth_required", async () => {
    const ex = await call(contract.operation("mcpProxy"), { body: validRequestBodies.mcpProxy })
    contract.assertConforms("mcpProxy", ex)
    expect([ex.status, code(ex)]).toEqual([401, "auth_required"])
  })

  test.skipIf(skip("mcpProxy"))("mcpProxy: an unknown action → 404", async () => {
    const ex = await call(contract.operation("mcpProxy"), {
      body: validRequestBodies.mcpProxy,
      pathParams: { action: "conformance-bogus" },
    })
    contract.assertConforms("mcpProxy", ex)
    expect(ex.status).toBe(env.requireAuthForAi ? 401 : 404)
  })

  test.skipIf(skip("embedFile"))("embedFile: no token → 200 skipped, nothing indexed", async () => {
    const ex = await anonymous("embedFile", { body: validRequestBodies.embedFile })
    if (!ex) return
    expect(ex.status).toBe(200)
    const body = ex.body as { status: string; sections: number; reason?: string }
    expect(body.status).toBe("skipped")
    expect(body.sections).toBe(0)
    expect(["not_configured", "not_signed_in"]).toContain(String(body.reason))
  })
})

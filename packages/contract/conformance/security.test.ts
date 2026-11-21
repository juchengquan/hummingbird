/**
 * `POST /v1/csp-report` (reportCspViolation): public CSP violation-report
 * intake. A well-formed report in any accepted media type → 204 with an
 * empty body; a body that is not JSON → 400; an unsupported media type →
 * 415. Errors carry the standard `ApiError` body and never echo input.
 * (The per-IP rate limit is not exercised here — tripping it would make
 * the other cases in a shared run flaky.)
 */
import { beforeAll, describe, expect, test } from "bun:test"

import { validRequestBodies } from "./fixtures"
import { Contract, env, type Exchange } from "./harness"

const OPERATION = "reportCspViolation"

/** Raw POST: these cases need non-JSON media types and invalid bodies,
 *  which the harness's JSON-only `call` cannot send. */
async function post(contentType: string, body: string): Promise<Exchange> {
  const res = await fetch(`${env.baseUrl}/v1/csp-report`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
    signal: AbortSignal.timeout(10_000),
  })
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  return { status: res.status, contentType: res.headers.get("content-type"), body: parsed, text, headers: res.headers }
}

const skip = env.skipOperations.has(OPERATION)

describe.skipIf(!env.baseUrl)(`conformance: CSP report intake @ ${env.baseUrl}`, () => {
  let contract: Contract
  beforeAll(async () => {
    contract = await Contract.load()
  })

  test.skipIf(skip)("legacy report-uri body (application/csp-report) → 204, empty body", async () => {
    const ex = await post("application/csp-report", JSON.stringify(validRequestBodies[OPERATION]))
    expect(ex.status).toBe(204)
    expect(ex.text).toBe("")
    contract.assertConforms(OPERATION, ex)
  })

  test.skipIf(skip)("Reporting-API batch (application/reports+json) → 204, empty body", async () => {
    const batch = [
      {
        type: "csp-violation",
        age: 10,
        url: "https://app.example.com/",
        body: {
          documentURL: "https://app.example.com/",
          effectiveDirective: "img-src",
          blockedURL: "https://tracker.example.com/p.gif?id=secret",
          disposition: "report",
        },
      },
      { type: "deprecation", body: { id: "x" } },
    ]
    const ex = await post("application/reports+json", JSON.stringify(batch))
    expect(ex.status).toBe(204)
    expect(ex.text).toBe("")
    contract.assertConforms(OPERATION, ex)
  })

  test.skipIf(skip)("malformed JSON → 400 invalid_request", async () => {
    const ex = await post("application/csp-report", "{not json")
    expect(ex.status).toBe(400)
    expect((ex.body as { code?: string }).code).toBe("invalid_request")
    contract.assertConforms(OPERATION, ex)
  })

  test.skipIf(skip)("unsupported media type → 415 unsupported_content_type", async () => {
    const ex = await post("text/plain", JSON.stringify(validRequestBodies[OPERATION]))
    expect(ex.status).toBe(415)
    expect((ex.body as { code?: string }).code).toBe("unsupported_content_type")
    contract.assertConforms(OPERATION, ex)
  })
})

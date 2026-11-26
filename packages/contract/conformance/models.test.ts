/**
 * `GET /v1/models` (listModels, 0.7.0, Q119): public — no token needed — and
 * every id it lists is a `config/models.json` id, in catalog order, with the
 * default model among the catalog's.
 */
import { beforeAll, describe, expect, test } from "bun:test"

import catalog from "../../../config/models.json"
import { Contract, env } from "./harness"

const OPERATION = "listModels"
const skip = env.skipOperations.has(OPERATION)

describe.skipIf(!env.baseUrl)(`conformance: models @ ${env.baseUrl}`, () => {
  let contract: Contract
  beforeAll(async () => {
    contract = await Contract.load()
  })

  test.skipIf(skip)("listModels: no auth → 200, catalog ids in catalog order", async () => {
    const res = await fetch(`${env.baseUrl}/v1/models`, { signal: AbortSignal.timeout(10_000) })
    const text = await res.text()
    const body = JSON.parse(text) as { models: { id: string; tasks: boolean }[]; defaultModel: string; auto: boolean }
    contract.assertConforms(OPERATION, {
      status: res.status,
      contentType: res.headers.get("content-type"),
      body,
      text,
      headers: res.headers,
    })
    expect(res.status).toBe(200)
    const ids = catalog.models.map((m) => m.id)
    const listed = body.models.map((m) => m.id)
    expect(listed.every((id) => ids.includes(id))).toBe(true)
    expect(listed).toEqual([...listed].sort((a, b) => ids.indexOf(a) - ids.indexOf(b)))
    expect(ids).toContain(body.defaultModel)
  })
})

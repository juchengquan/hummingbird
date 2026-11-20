import { afterEach, describe, expect, test } from "bun:test"
import { NextRequest } from "next/server"

import { setAiAuthScenario } from "@/server/auth/_test/ai-auth-scenario"

import { memoryExtractDeps, POST } from "./route"

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/memory/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

describe("POST /api/memory/extract — tainted turns", () => {
  const real = memoryExtractDeps.extractFacts
  let calls: unknown[] = []
  let restore: (() => void) | null = null
  afterEach(() => {
    memoryExtractDeps.extractFacts = real
    calls = []
    restore?.()
    restore = null
  })

  function stubExtractor() {
    restore = setAiAuthScenario("flag-off")
    memoryExtractDeps.extractFacts = async (input) => {
      calls.push(input)
    }
  }

  test("an untainted turn is extracted", async () => {
    stubExtractor()
    const res = await post({ turnText: "User: I use Rust", conversationId: "c1" })
    expect(res.status).toBe(200)
    expect(calls).toEqual([{ turnText: "User: I use Rust", conversationId: "c1" }])
  })

  test("a tainted turn is refused (200, nothing extracted)", async () => {
    stubExtractor()
    const res = await post({ turnText: "User: summarise the attached page", tainted: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls).toEqual([])
  })
})

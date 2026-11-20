import { afterEach, describe, expect, test } from "bun:test"
import { NextRequest } from "next/server"

import { setAiAuthScenario } from "@/server/auth/_test/ai-auth-scenario"

import { POST } from "./route"

function post(body: string) {
  return new NextRequest("http://localhost/api/ai/command", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
  })
}

describe("POST /api/ai/command validation", () => {
  test("non-JSON body → 400 invalid_request", async () => {
    const res = await POST(post("{not json"))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("invalid_request")
  })

  test("missing ctx (previously an uncaught TypeError → 500) → 400", async () => {
    const res = await POST(
      post(
        JSON.stringify({
          messages: [{ id: "m", role: "user", parts: [{ type: "text", text: "hi" }] }],
        })
      )
    )
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("invalid_request")
  })

  test("malformed ctx.children / messages → 400", async () => {
    for (const body of [
      { ctx: { children: 5 }, messages: [{ role: "user", parts: [] }] },
      { ctx: { children: [] }, messages: "hi" },
      { ctx: { children: [], toolName: "rm" }, messages: [{ role: "user", parts: [] }] },
    ]) {
      const res = await POST(post(JSON.stringify(body)))
      expect(res.status).toBe(400)
    }
  })
})

describe("POST /api/ai/command — REQUIRE_AUTH_FOR_AI", () => {
  let restore: (() => void) | null = null
  afterEach(() => {
    restore?.()
    restore = null
  })

  test("flag on + anonymous → 401 auth_required before body parsing", async () => {
    restore = setAiAuthScenario("anonymous")
    const res = await POST(post("{not json"))
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe("auth_required")
  })

  test("flag on + signed in → gate passes (validation 400)", async () => {
    restore = setAiAuthScenario("signed-in")
    const res = await POST(post("{not json"))
    expect(res.status).toBe(400)
  })

  test("flag off → unchanged (validation 400)", async () => {
    restore = setAiAuthScenario("flag-off")
    const res = await POST(post("{not json"))
    expect(res.status).toBe(400)
  })
})

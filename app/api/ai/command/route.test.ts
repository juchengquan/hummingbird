import { describe, expect, test } from "bun:test"
import { NextRequest } from "next/server"

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

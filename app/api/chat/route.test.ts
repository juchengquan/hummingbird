import { afterEach, describe, expect, test } from "bun:test"
import { NextRequest } from "next/server"

import {
  setAiAuthScenario,
  type AiAuthScenario,
} from "@/server/auth/_test/ai-auth-scenario"

import { CHAT_BODY_MAX } from "@/shared/api-schemas"

import { POST } from "./route"

/**
 * REQUIRE_AUTH_FOR_AI gate on `/api/chat`. A malformed body is used on
 * purpose: when the gate lets the request through, the route's own
 * validation answers `400 invalid_request` before any model work — so
 * "400" proves the gate passed and "401 auth_required" proves it
 * blocked *before* the body was even parsed.
 */

function post(body: string) {
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
  })
}

let restore: (() => void) | null = null
function scenario(s: AiAuthScenario) {
  restore = setAiAuthScenario(s)
}
afterEach(() => {
  restore?.()
  restore = null
})

describe("POST /api/chat — REQUIRE_AUTH_FOR_AI", () => {
  test("flag on + anonymous → 401 auth_required, before body parsing", async () => {
    scenario("anonymous")
    const res = await POST(post("{not json"))
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe("auth_required")
  })

  test("flag on + signed in → passes the gate (body validation runs)", async () => {
    scenario("signed-in")
    const res = await POST(post("{not json"))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("invalid_request")
  })

  test("flag off → anonymous unchanged", async () => {
    scenario("flag-off")
    const res = await POST(post("{not json"))
    expect(res.status).toBe(400)
  })

  test("flag on but Supabase unconfigured → anonymous unchanged", async () => {
    scenario("supabase-unconfigured")
    const res = await POST(post("{not json"))
    expect(res.status).toBe(400)
  })
})

describe("POST /api/chat — body cap", () => {
  test("Content-Length over CHAT_BODY_MAX → 413 payload_too_large, body never read", async () => {
    scenario("flag-off")
    let pulled = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true
        },
      },
      { highWaterMark: 0 }
    )
    const req = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(CHAT_BODY_MAX + 1),
      },
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1])
    const res = await POST(req)
    expect(res.status).toBe(413)
    expect((await res.json()).code).toBe("payload_too_large")
    expect(pulled).toBe(false)
  })
})

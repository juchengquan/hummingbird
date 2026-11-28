import { describe, expect, test } from "bun:test"

import { resolveBackendBaseUrl } from "./backend-base-url"

describe("resolveBackendBaseUrl", () => {
  test("unset / blank → not configured", () => {
    for (const raw of [undefined, null, "", "   "]) {
      expect(resolveBackendBaseUrl(raw)).toEqual({
        configured: false,
        baseUrl: "",
        sameOrigin: false,
      })
    }
  })

  test("absolute URL → that URL, trailing slashes stripped", () => {
    expect(resolveBackendBaseUrl("http://localhost:8000")).toEqual({
      configured: true,
      baseUrl: "http://localhost:8000",
      sameOrigin: false,
    })
    expect(resolveBackendBaseUrl(" https://api.example.com/// ").baseUrl).toBe(
      "https://api.example.com",
    )
  })

  test("`/` → same origin with an empty prefix, still configured", () => {
    const r = resolveBackendBaseUrl("/")
    expect(r).toEqual({ configured: true, baseUrl: "", sameOrigin: true })
    // What callers build from it: a relative URL on the page's origin.
    expect(`${r.baseUrl}/v1/chat`).toBe("/v1/chat")
  })

  test("a same-origin path prefix keeps the prefix", () => {
    expect(resolveBackendBaseUrl("/backend/")).toEqual({
      configured: true,
      baseUrl: "/backend",
      sameOrigin: true,
    })
  })

  test("protocol-relative `//host` is another origin, not same-origin", () => {
    expect(resolveBackendBaseUrl("//api.example.com").sameOrigin).toBe(false)
  })
})

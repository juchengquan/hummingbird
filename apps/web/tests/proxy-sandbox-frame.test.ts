import { afterEach, describe, expect, test } from "bun:test"
import { NextRequest } from "next/server"

import { config, proxy } from "../proxy"

/**
 * The sandbox frame shell (`/sandbox/frame`) sends its own CSP; the app
 * policy from `proxy.ts` must never land on it — neither via the
 * matcher nor via the in-function guard.
 */

const source = config.matcher[0].source
// Next anchors matcher sources the same way (path-to-regexp, full match).
const matches = (path: string) => new RegExp(`^${source}$`).test(path)

describe("proxy matcher", () => {
  test("excludes the sandbox frame shell", () => {
    expect(matches("/sandbox/frame")).toBe(false)
  })

  test("still covers app pages, including look-alike paths", () => {
    for (const p of ["/", "/editor", "/dashboard", "/share/abc", "/sandbox", "/sandbox/frames", "/sandbox/frame/x"]) {
      expect(matches(p)).toBe(true)
    }
  })
})

describe("proxy()", () => {
  const prev = process.env.CSP_MODE
  afterEach(() => {
    if (prev === undefined) delete process.env.CSP_MODE
    else process.env.CSP_MODE = prev
  })

  test("never stamps the app CSP on the sandbox frame shell", () => {
    process.env.CSP_MODE = "enforce"
    const res = proxy(new NextRequest("http://localhost/sandbox/frame"))
    expect(res.headers.get("content-security-policy")).toBeNull()
    expect(res.headers.get("content-security-policy-report-only")).toBeNull()
  })

  test("still stamps it on app pages", () => {
    process.env.CSP_MODE = "enforce"
    const res = proxy(new NextRequest("http://localhost/editor"))
    expect(res.headers.get("content-security-policy")).toContain("frame-src 'self'")
  })
})

describe("proxy() report endpoints", () => {
  const prev = { mode: process.env.CSP_MODE, agentPy: process.env.NEXT_PUBLIC_AGENT_PY_URL }
  afterEach(() => {
    for (const [key, value] of [
      ["CSP_MODE", prev.mode],
      ["NEXT_PUBLIC_AGENT_PY_URL", prev.agentPy],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test("no agent-py → no Reporting-Endpoints and no report-uri (Q140)", () => {
    process.env.CSP_MODE = "enforce"
    delete process.env.NEXT_PUBLIC_AGENT_PY_URL
    const res = proxy(new NextRequest("http://localhost/editor"))
    expect(res.headers.get("reporting-endpoints")).toBeNull()
    expect(res.headers.get("content-security-policy")).not.toContain("report-uri")
  })

  test("agent-py configured → reports go to its /v1/csp-report", () => {
    process.env.CSP_MODE = "enforce"
    process.env.NEXT_PUBLIC_AGENT_PY_URL = "https://api.example.com"
    const res = proxy(new NextRequest("http://localhost/editor"))
    expect(res.headers.get("reporting-endpoints")).toBe(
      'csp-endpoint="https://api.example.com/v1/csp-report"',
    )
    expect(res.headers.get("content-security-policy")).toContain(
      "report-uri https://api.example.com/v1/csp-report",
    )
  })
})

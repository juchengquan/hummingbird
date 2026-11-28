import { describe, expect, test } from "bun:test"

import {
  BACKEND_CSP_REPORT_PATH,
  buildCsp,
  buildCspDirectives,
  CSP_REPORT_GROUP,
  cspHeaderName,
  cspOptionsFromEnv,
  cspReportUri,
  EMBED_FRAME_ORIGINS,
  generateNonce,
  originOf,
  parseCspMode,
  reportingEndpointsHeader,
  websocketOriginOf,
} from "./csp"

function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) out.set(name, sources)
  }
  return out
}

const NONCE = "bm9uY2UtdGVzdC0xMjM0NQ=="

describe("parseCspMode", () => {
  test("defaults to report-only when unset, empty or unrecognised", () => {
    expect(parseCspMode(undefined)).toBe("report-only")
    expect(parseCspMode("")).toBe("report-only")
    expect(parseCspMode("  ")).toBe("report-only")
    expect(parseCspMode("enforced")).toBe("report-only")
    expect(parseCspMode("true")).toBe("report-only")
  })

  test("accepts the three modes, case- and whitespace-insensitively", () => {
    expect(parseCspMode("report-only")).toBe("report-only")
    expect(parseCspMode(" Enforce ")).toBe("enforce")
    expect(parseCspMode("OFF")).toBe("off")
  })
})

describe("cspHeaderName", () => {
  test("maps each mode to its header (none when off)", () => {
    expect(cspHeaderName("enforce")).toBe("Content-Security-Policy")
    expect(cspHeaderName("report-only")).toBe("Content-Security-Policy-Report-Only")
    expect(cspHeaderName("off")).toBeNull()
  })
})

describe("generateNonce", () => {
  test("is base64 of 128 bits and matches Next's nonce pattern", () => {
    const n = generateNonce()
    expect(n).toMatch(/^[A-Za-z0-9+/_-]+={0,2}$/)
    expect(atob(n).length).toBe(16)
  })

  test("is fresh on every call", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateNonce()))
    expect(seen.size).toBe(50)
  })
})

describe("originOf / websocketOriginOf", () => {
  test("reduces http(s) URLs to their origin", () => {
    expect(originOf("https://abc.supabase.co/rest/v1?x=1")).toBe("https://abc.supabase.co")
    expect(originOf(" http://localhost:8000/ ")).toBe("http://localhost:8000")
  })

  test("drops empty, malformed and non-http values", () => {
    expect(originOf(undefined)).toBeNull()
    expect(originOf("")).toBeNull()
    expect(originOf("not a url")).toBeNull()
    expect(originOf("javascript:alert(1)")).toBeNull()
    expect(originOf("ftp://example.com")).toBeNull()
    // A value trying to smuggle extra directives can't survive URL parsing as an origin.
    expect(originOf("https://a.com; script-src *")).toBeNull()
    // …and a path/query carrying one is cut off at the origin.
    expect(originOf("https://a.com/x;script-src%20*")).toBe("https://a.com")
  })

  test("maps https→wss and http→ws", () => {
    expect(websocketOriginOf("https://abc.supabase.co")).toBe("wss://abc.supabase.co")
    expect(websocketOriginOf("http://127.0.0.1:54321")).toBe("ws://127.0.0.1:54321")
  })
})

describe("buildCsp", () => {
  test("production policy: nonce + strict-dynamic, no eval, strict defaults", () => {
    const d = directives(buildCsp({ nonce: NONCE, isDev: false }))
    expect(d.get("default-src")).toEqual(["'self'"])
    expect(d.get("script-src")).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"])
    expect(d.get("style-src")).toEqual(["'self'", "'unsafe-inline'"])
    expect(d.get("img-src")).toEqual(["'self'", "data:", "blob:", "https:"])
    expect(d.get("font-src")).toEqual(["'self'", "data:"])
    expect(d.get("worker-src")).toEqual(["'self'", "blob:"])
    expect(d.get("object-src")).toEqual(["'none'"])
    expect(d.get("base-uri")).toEqual(["'self'"])
    expect(d.get("form-action")).toEqual(["'self'"])
    expect(d.get("frame-ancestors")).toEqual(["'none'"])
    expect(d.get("frame-src")).toEqual(["'self'", ...EMBED_FRAME_ORIGINS])
    // No agent-py → nowhere to report (Q140): neither directive.
    expect(d.has("report-uri")).toBe(false)
    expect(d.has("report-to")).toBe(false)
  })

  test("a report URI adds report-uri + report-to", () => {
    const d = directives(
      buildCsp({ nonce: NONCE, isDev: false, reportUri: "https://api.example.com/v1/csp-report" }),
    )
    expect(d.get("report-uri")).toEqual(["https://api.example.com/v1/csp-report"])
    expect(d.get("report-to")).toEqual([CSP_REPORT_GROUP])
  })

  test("never allows inline/eval scripts or wasm in production", () => {
    const script = directives(buildCsp({ nonce: NONCE, isDev: false })).get("script-src")!
    expect(script).not.toContain("'unsafe-inline'")
    expect(script).not.toContain("'unsafe-eval'")
    expect(script).not.toContain("'wasm-unsafe-eval'")
  })

  test("style-src carries no nonce (a nonce would void 'unsafe-inline')", () => {
    const style = directives(buildCsp({ nonce: NONCE, isDev: false })).get("style-src")!
    expect(style.some((s) => s.startsWith("'nonce-"))).toBe(false)
  })

  test("dev adds 'unsafe-eval' for React's dev tooling", () => {
    const script = directives(buildCsp({ nonce: NONCE, isDev: true })).get("script-src")!
    expect(script).toContain("'unsafe-eval'")
  })

  test("connect-src adds Supabase over https + wss and each remote backend origin", () => {
    const d = directives(
      buildCsp({
        nonce: NONCE,
        isDev: false,
        supabaseUrl: "https://abc.supabase.co",
        backendUrls: ["https://api.example.com/v1", undefined, "http://localhost:8000", "garbage"],
      }),
    )
    const connect = d.get("connect-src")!
    expect(connect[0]).toBe("'self'")
    expect(connect).toContain("https://abc.supabase.co")
    expect(connect).toContain("wss://abc.supabase.co")
    expect(connect).toContain("https://api.example.com")
    expect(connect).toContain("http://localhost:8000")
    expect(connect).not.toContain("garbage")
    expect(connect).toContain("https://react-tweet.vercel.app")
  })

  test("connect-src without Supabase/backends is just self + fixed origins", () => {
    const connect = directives(buildCsp({ nonce: NONCE, isDev: false })).get("connect-src")!
    expect(connect).toEqual(["'self'", "https://react-tweet.vercel.app", "data:", "blob:"])
  })

  test("a same-origin backend (`/`, `/backend`) adds no source — 'self' covers it", () => {
    const sameOrigin = directives(
      buildCsp({
        nonce: NONCE,
        isDev: false,
        backendUrls: ["/", " / ", "/backend/", "//"],
      }),
    ).get("connect-src")!
    const baseline = directives(buildCsp({ nonce: NONCE, isDev: false })).get("connect-src")!
    expect(sameOrigin).toEqual(baseline)
    // Never a bare path or empty token, which would be an invalid source.
    expect(sameOrigin.every((s) => s.length > 0 && !s.startsWith("/"))).toBe(true)
  })

  test("same-origin env value flows through cspOptionsFromEnv without an extra origin", () => {
    const policy = buildCsp(
      cspOptionsFromEnv(NONCE, { NODE_ENV: "production", NEXT_PUBLIC_AGENT_PY_URL: "/" }),
    )
    expect(directives(policy).get("connect-src")).toEqual([
      "'self'",
      "https://react-tweet.vercel.app",
      "data:",
      "blob:",
    ])
  })

  test("deduplicates repeated origins", () => {
    const connect = directives(
      buildCsp({
        nonce: NONCE,
        isDev: false,
        backendUrls: ["https://api.example.com", "https://api.example.com/other"],
      }),
    ).get("connect-src")!
    expect(connect.filter((s) => s === "https://api.example.com")).toHaveLength(1)
  })

  test("serialises as `name sources; name sources` with no newlines", () => {
    const policy = buildCsp({ nonce: NONCE, isDev: false })
    expect(policy).not.toMatch(/\n/)
    expect(policy.startsWith("default-src 'self'; script-src ")).toBe(true)
    expect(buildCspDirectives({ nonce: NONCE, isDev: false }).length).toBe(directives(policy).size)
  })

  test("the nonce Next extracts from script-src is ours", () => {
    // Mirrors next/dist/server/app-render/get-script-nonce-from-header.js
    const policy = buildCsp({ nonce: NONCE, isDev: false })
    const scriptSrc = policy.split(";").map((s) => s.trim()).find((s) => s.startsWith("script-src"))!
    const match = scriptSrc
      .split(/\s+/)
      .slice(1)
      .map((s) => s.match(/^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/))
      .find(Boolean)
    expect(match?.[1]).toBe(NONCE)
  })
})

describe("cspOptionsFromEnv", () => {
  test("reads the public origins and dev flag from the env bag", () => {
    const opts = cspOptionsFromEnv(NONCE, {
      NODE_ENV: "production",
      NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
      NEXT_PUBLIC_API_BASE_URL: "https://api.example.com",
      NEXT_PUBLIC_AGENT_PY_URL: "http://localhost:8000",
    })
    expect(opts).toEqual({
      nonce: NONCE,
      isDev: false,
      supabaseUrl: "https://abc.supabase.co",
      backendUrls: ["https://api.example.com", "http://localhost:8000"],
      reportUri: "http://localhost:8000/v1/csp-report",
    })
    expect(cspOptionsFromEnv(NONCE, { NODE_ENV: "development" }).isDev).toBe(true)
  })

  test("no agent-py configured → no report target, and the policy names none", () => {
    for (const env of [{}, { NEXT_PUBLIC_AGENT_PY_URL: "  " }]) {
      const opts = cspOptionsFromEnv(NONCE, env)
      expect(opts.reportUri).toBeNull()
      const policy = buildCsp(opts)
      expect(policy).not.toContain("report-uri")
      expect(policy).not.toContain("report-to")
      expect(policy).not.toContain("/api/csp-report")
    }
  })
})

describe("cspReportUri", () => {
  test("unset / blank → none (there is no in-Next route)", () => {
    expect(cspReportUri(undefined)).toBeNull()
    expect(cspReportUri(null)).toBeNull()
    expect(cspReportUri("")).toBeNull()
    expect(cspReportUri("   ")).toBeNull()
  })

  test("same origin (`/` or a path prefix) → /v1/csp-report on the page's origin", () => {
    expect(cspReportUri("/")).toBe(BACKEND_CSP_REPORT_PATH)
    expect(cspReportUri("/")).toBe("/v1/csp-report")
    expect(cspReportUri("/backend/")).toBe("/backend/v1/csp-report")
  })

  test("absolute → <base>/v1/csp-report", () => {
    expect(cspReportUri("https://api.example.com")).toBe("https://api.example.com/v1/csp-report")
    expect(cspReportUri("https://api.example.com/")).toBe("https://api.example.com/v1/csp-report")
    expect(cspReportUri("http://localhost:8000")).toBe("http://localhost:8000/v1/csp-report")
  })

  test("a value that could break out of the policy → none", () => {
    expect(cspReportUri("https://a.com; script-src *")).toBeNull()
    expect(cspReportUri('/x"; script-src *')).toBeNull()
    expect(cspReportUri("/a,b")).toBeNull()
    expect(cspReportUri("javascript:alert(1)")).toBeNull()
    expect(cspReportUri("not a url")).toBeNull()
  })

  test("buildCsp + reportingEndpointsHeader carry the chosen URI", () => {
    for (const [env, expected] of [
      ["/", "/v1/csp-report"],
      ["https://api.example.com", "https://api.example.com/v1/csp-report"],
    ] as const) {
      const opts = cspOptionsFromEnv(NONCE, { NEXT_PUBLIC_AGENT_PY_URL: env })
      expect(opts.reportUri).toBe(expected)
      expect(directives(buildCsp(opts)).get("report-uri")).toEqual([expected])
      expect(directives(buildCsp(opts)).get("report-to")).toEqual([CSP_REPORT_GROUP])
      expect(reportingEndpointsHeader(expected)).toBe(`${CSP_REPORT_GROUP}="${expected}"`)
    }
  })
})

describe("reportingEndpointsHeader", () => {
  test("names the report-to group and points it at the report route", () => {
    expect(reportingEndpointsHeader("/v1/csp-report")).toBe(`${CSP_REPORT_GROUP}="/v1/csp-report"`)
  })
})

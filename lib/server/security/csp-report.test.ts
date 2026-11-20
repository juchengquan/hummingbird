import { beforeEach, describe, expect, test } from "bun:test"

import { createSlidingWindow } from "@/server/rate-limit"

import {
  CSP_REPORT_MAX_BYTES,
  CSP_REPORT_MAX_ENTRIES,
  createCspReportHandler,
  parseCspReports,
  sanitizeReportedUrl,
} from "./csp-report"

const LEGACY = {
  "csp-report": {
    "document-uri": "https://app.example.com/dashboard?token=secret",
    referrer: "",
    "violated-directive": "script-src-elem",
    "effective-directive": "script-src-elem",
    "original-policy": "default-src 'self'; …",
    disposition: "report",
    "blocked-uri": "https://evil.example.net/x.js?k=v",
    "line-number": 12,
    "column-number": 34,
    "source-file": "https://app.example.com/_next/static/chunks/a.js",
    "status-code": 200,
    "script-sample": "alert(document.cookie)",
  },
}

const REPORTING_API = [
  {
    type: "csp-violation",
    age: 3,
    url: "https://app.example.com/share/conversation/AbCdEf123456",
    user_agent: "Mozilla/5.0",
    body: {
      documentURL: "https://app.example.com/share/conversation/AbCdEf123456",
      effectiveDirective: "style-src-attr",
      blockedURL: "inline",
      disposition: "enforce",
      lineNumber: 1,
      sample: "color:red",
    },
  },
  { type: "deprecation", body: { id: "x" } },
  {
    type: "csp-violation",
    body: { documentURL: "about:srcdoc", effectiveDirective: "script-src-elem", blockedURL: "https://unpkg.com/react@19/umd/react.development.js" },
  },
]

function post(body: string, contentType: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/csp-report", {
    method: "POST",
    headers: { "content-type": contentType, ...headers },
    body,
  })
}

describe("sanitizeReportedUrl", () => {
  test("keeps origin + path, drops query and fragment", () => {
    expect(sanitizeReportedUrl("https://a.com/p/q.js?token=1#h")).toBe("https://a.com/p/q.js")
  })

  test("passes CSP keywords through", () => {
    expect(sanitizeReportedUrl("inline")).toBe("inline")
    expect(sanitizeReportedUrl("eval")).toBe("eval")
    expect(sanitizeReportedUrl("wasm-eval")).toBe("wasm-eval")
  })

  test("collapses non-network schemes to the scheme, except about:srcdoc", () => {
    expect(sanitizeReportedUrl("data:text/html,<script>alert(1)</script>")).toBe("data:")
    expect(sanitizeReportedUrl("blob:https://a.com/uuid")).toBe("blob:")
    expect(sanitizeReportedUrl("chrome-extension://abcdef/content.js")).toBe("chrome-extension:")
    expect(sanitizeReportedUrl("about:srcdoc")).toBe("about:srcdoc")
  })

  test("redacts share tokens", () => {
    expect(sanitizeReportedUrl("https://a.com/share/document/tok123/x")).toBe("https://a.com/share/document/:token/x")
  })

  test("handles empty / malformed / oversized input", () => {
    expect(sanitizeReportedUrl(undefined)).toBe("")
    expect(sanitizeReportedUrl("http://[bad")).toBe("invalid")
    const long = sanitizeReportedUrl(`https://a.com/${"x".repeat(1000)}`)
    expect(long.length).toBeLessThanOrEqual(201)
  })
})

describe("parseCspReports", () => {
  test("normalises a legacy report-uri body", () => {
    expect(parseCspReports(LEGACY)).toEqual([
      {
        evt: "csp_violation",
        via: "report-uri",
        directive: "script-src-elem",
        blocked: "https://evil.example.net/x.js",
        document: "https://app.example.com/dashboard",
        source: "https://app.example.com/_next/static/chunks/a.js",
        line: 12,
        column: 34,
        disposition: "report",
      },
    ])
  })

  test("normalises a Reporting-API batch, skipping non-CSP entries", () => {
    const out = parseCspReports(REPORTING_API)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      evt: "csp_violation",
      via: "reporting-api",
      directive: "style-src-attr",
      blocked: "inline",
      document: "https://app.example.com/share/conversation/:token",
      line: 1,
      disposition: "enforce",
    })
    expect(out[1]).toMatchObject({ document: "about:srcdoc", srcdoc: true, blocked: "https://unpkg.com/react@19/umd/react.development.js" })
  })

  test("never carries the script sample or the original policy", () => {
    const text = JSON.stringify([...parseCspReports(LEGACY), ...parseCspReports(REPORTING_API)])
    expect(text).not.toContain("alert(document.cookie)")
    expect(text).not.toContain("color:red")
    expect(text).not.toContain("default-src")
    expect(text).not.toContain("secret")
    expect(text).not.toContain("AbCdEf123456")
  })

  test("caps the number of entries taken from one batch", () => {
    const batch = Array.from({ length: CSP_REPORT_MAX_ENTRIES + 10 }, () => REPORTING_API[0])
    expect(parseCspReports(batch)).toHaveLength(CSP_REPORT_MAX_ENTRIES)
  })

  test("ignores unknown shapes", () => {
    expect(parseCspReports(null)).toEqual([])
    expect(parseCspReports("x")).toEqual([])
    expect(parseCspReports({ foo: 1 })).toEqual([])
    expect(parseCspReports([1, "a", { type: "csp-violation" }])).toEqual([])
  })

  test("falls back to violated-directive and an unknown marker", () => {
    expect(parseCspReports({ "csp-report": { "violated-directive": "img-src https:" } })[0].directive).toBe("img-src")
    expect(parseCspReports({ "csp-report": {} })[0].directive).toBe("unknown")
  })

  test("drops non-standard dispositions and non-numeric positions", () => {
    const [log] = parseCspReports({ "csp-report": { disposition: "<b>", "line-number": "12" } })
    expect(log.disposition).toBeUndefined()
    expect(log.line).toBeUndefined()
  })
})

describe("createCspReportHandler", () => {
  let lines: string[]
  let handle: (req: Request) => Promise<Response>

  beforeEach(() => {
    lines = []
    handle = createCspReportHandler({
      limiter: createSlidingWindow({ windowMs: 60_000, max: 3 }),
      log: (l) => lines.push(l),
    })
  })

  test("accepts application/csp-report and logs one JSON line, empty 204", async () => {
    const res = await handle(post(JSON.stringify(LEGACY), "application/csp-report"))
    expect(res.status).toBe(204)
    expect(await res.text()).toBe("")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ evt: "csp_violation", directive: "script-src-elem" })
  })

  test("accepts application/reports+json (with charset) batches", async () => {
    const res = await handle(post(JSON.stringify(REPORTING_API), "application/reports+json; charset=utf-8"))
    expect(res.status).toBe(204)
    expect(lines).toHaveLength(2)
  })

  test("accepts application/json", async () => {
    const res = await handle(post(JSON.stringify(LEGACY), "application/json"))
    expect(res.status).toBe(204)
  })

  test("rejects other content types with 415 and logs nothing", async () => {
    const res = await handle(post(JSON.stringify(LEGACY), "text/plain"))
    expect(res.status).toBe(415)
    expect(await res.text()).toBe("")
    expect(lines).toHaveLength(0)
  })

  test("rejects oversized bodies with 413 (declared or streamed)", async () => {
    const big = JSON.stringify({ "csp-report": { pad: "x".repeat(CSP_REPORT_MAX_BYTES) } })
    const res = await handle(post(big, "application/csp-report"))
    expect(res.status).toBe(413)
    expect(lines).toHaveLength(0)
  })

  test("rejects malformed JSON with an empty 400", async () => {
    const res = await handle(post("{not json <script>", "application/csp-report"))
    expect(res.status).toBe(400)
    expect(await res.text()).toBe("")
  })

  test("valid JSON that isn't a report → 204, nothing logged", async () => {
    const res = await handle(post(JSON.stringify({ hello: "world" }), "application/json"))
    expect(res.status).toBe(204)
    expect(lines).toHaveLength(0)
  })

  test("rate-limits per client IP with 429 + Retry-After", async () => {
    const body = JSON.stringify(LEGACY)
    const ip = { "x-forwarded-for": "203.0.113.7" }
    for (let i = 0; i < 3; i++) {
      expect((await handle(post(body, "application/csp-report", ip))).status).toBe(204)
    }
    const limited = await handle(post(body, "application/csp-report", ip))
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(lines).toHaveLength(3)
    // A different client is unaffected.
    const other = await handle(post(body, "application/csp-report", { "x-forwarded-for": "198.51.100.9" }))
    expect(other.status).toBe(204)
  })
})

import { describe, expect, test } from "bun:test"

import {
  httpOriginOf,
  isExternalHttpUrl,
  isSafeImageUrl,
  isSafeLinkUrl,
  markdownImagePolicy,
  normalizeUrlForSchemeCheck,
  planImageOpen,
} from "./safe-url"

// Payloads that must never survive as a link or image URL.
const SCRIPT_URLS = [
  "javascript:alert(1)",
  "JAVASCRIPT:alert(1)",
  "JaVaScRiPt:alert(1)",
  " javascript:alert(1)",
  "\tjavascript:alert(1)",
  "\njavascript:alert(1)",
  "\u0000javascript:alert(1)",
  "\u0001\u001fjavascript:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  "java\rscript:alert(1)",
  "java\u00adscript:alert(1)",
  "java\u200bscript:alert(1)",
  "\ufeffjavascript:alert(1)",
  "javascript :alert(1)",
  // HTML character references (browsers decode these in attributes)
  "java&#x09;script:alert(1)",
  "java&#x9script:alert(1)",
  "java&#9;script:alert(1)",
  "java&#0000009;script:alert(1)",
  "&#106;avascript:alert(1)",
  "&#x6A;avascript:alert(1)",
  "&#x6a&#x61&#x76&#x61script:alert(1)",
  "javascript&colon;alert(1)",
  "javascript&COLON;alert(1)",
  "java&Tab;script:alert(1)",
  "java&NewLine;script:alert(1)",
  "javascript&#58;alert(1)",
  "javascript&#x3a;alert(1)",
  // Percent-encoding
  "%6Aavascript:alert(1)",
  "%6a%61%76%61%73%63%72%69%70%74%3aalert(1)",
  "javascript%3Aalert(1)",
  "java%09script:alert(1)",
  // Double encoding
  "&amp;#106;avascript:alert(1)",
  "%256Aavascript:alert(1)",
  "&#37;6Aavascript:alert(1)",
  // Other dangerous / non-allowlisted schemes
  "vbscript:msgbox(1)",
  "VBScript:msgbox(1)",
  "livescript:alert(1)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "data:text/html,<script>alert(1)</script>",
  "file:///etc/passwd",
  "blob:https://example.com/uuid",
  "filesystem:https://example.com/x",
  "ftp://example.com/",
  "chrome://settings",
  "about:blank",
  "x-unknown:foo",
  // Odd prefixes fail closed
  "1javascript:alert(1)",
  "&unknown;javascript:alert(1)",
]

describe("isSafeLinkUrl", () => {
  test.each([
    "http://example.com",
    "https://example.com/path?q=1#frag",
    "HTTPS://EXAMPLE.COM",
    "  https://example.com",
    "mailto:someone@example.com",
    "MAILTO:someone@example.com",
    "/relative/path",
    "relative/path",
    "./sibling",
    "../parent",
    "#fragment",
    "?query=1",
    "//example.com/protocol-relative",
    "/path/with:colon",
    "/search?q=a:b",
    "#a:b",
    "",
  ])("allows %p", (url) => {
    expect(isSafeLinkUrl(url)).toBe(true)
  })

  test.each(SCRIPT_URLS)("rejects %p", (url) => {
    expect(isSafeLinkUrl(url)).toBe(false)
  })

  test("rejects data: for links, even images", () => {
    expect(isSafeLinkUrl("data:image/png;base64,AAAA")).toBe(false)
  })

  test("rejects non-strings", () => {
    expect(isSafeLinkUrl(null)).toBe(false)
    expect(isSafeLinkUrl(undefined)).toBe(false)
  })

  test("survives pathological input without throwing", () => {
    expect(isSafeLinkUrl("&#99999999999;x")).toBe(true)
    expect(isSafeLinkUrl("%E0%A4%A")).toBe(true)
    expect(isSafeLinkUrl("&".repeat(10_000) + "javascript:")).toBe(false)
  })
})

describe("isSafeImageUrl", () => {
  test.each([
    "https://example.com/a.png",
    "http://example.com/a.png",
    "/api/files/abc/raw",
    "images/a.png",
    "//cdn.example.com/a.png",
    "data:image/png;base64,iVBORw0KGgo=",
    "data:image/jpeg;base64,AAAA",
    "DATA:IMAGE/GIF;base64,AAAA",
    "data:image/webp;base64,AAAA",
    "data:image/png,rawbytes",
  ])("allows %p", (url) => {
    expect(isSafeImageUrl(url)).toBe(true)
  })

  test.each([
    ...SCRIPT_URLS,
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "data:image/svg%2Bxml,<svg onload=alert(1)>",
    "data:image/pngx;base64,AAAA",
    "data:image/png",
    "data:,hello",
    "mailto:a@example.com",
  ])("rejects %p", (url) => {
    expect(isSafeImageUrl(url)).toBe(false)
  })
})

describe("isExternalHttpUrl", () => {
  test("absolute http(s) and protocol-relative are external", () => {
    expect(isExternalHttpUrl("https://example.com")).toBe(true)
    expect(isExternalHttpUrl("http://example.com")).toBe(true)
    expect(isExternalHttpUrl("//example.com")).toBe(true)
  })

  test("relative, fragment and mailto are not", () => {
    expect(isExternalHttpUrl("/path")).toBe(false)
    expect(isExternalHttpUrl("#x")).toBe(false)
    expect(isExternalHttpUrl("mailto:a@example.com")).toBe(false)
  })
})

describe("normalizeUrlForSchemeCheck", () => {
  test("decodes entities and percent-encoding, strips controls, lowercases", () => {
    expect(normalizeUrlForSchemeCheck(" Java&#x09;Script%3A x")).toBe("javascript:x")
  })
})

describe("planImageOpen", () => {
  test("http(s) and relative URLs open directly", () => {
    expect(planImageOpen("https://cdn.example.com/a.png")).toEqual({
      kind: "direct",
      url: "https://cdn.example.com/a.png",
    })
    expect(planImageOpen("/api/files/x.png")).toEqual({
      kind: "direct",
      url: "/api/files/x.png",
    })
  })

  test("raster data: URLs open via a blob", () => {
    expect(planImageOpen("data:image/png;base64,iVBORw0KGgo=")).toEqual({
      kind: "blob",
      mime: "image/png",
      base64: true,
      payload: "iVBORw0KGgo=",
    })
    expect(planImageOpen("data:image/webp,abc")).toEqual({
      kind: "blob",
      mime: "image/webp",
      base64: false,
      payload: "abc",
    })
  })

  test("script, SVG and unknown-scheme URLs are blocked", () => {
    for (const url of SCRIPT_URLS) {
      expect(planImageOpen(url)).toEqual({ kind: "blocked" })
    }
    expect(planImageOpen("data:image/svg+xml;base64,PHN2Zz4=")).toEqual({
      kind: "blocked",
    })
    expect(planImageOpen("data:text/html,<script>alert(1)</script>")).toEqual({
      kind: "blocked",
    })
    expect(planImageOpen("file:///etc/passwd")).toEqual({ kind: "blocked" })
    expect(planImageOpen(undefined)).toEqual({ kind: "blocked" })
  })
})

describe("markdownImagePolicy", () => {
  const trusted = ["https://proj.supabase.co"]

  test.each([
    "https://proj.supabase.co/storage/v1/object/public/x.png",
    "data:image/png;base64,AAAA",
    "blob:https://app.example.com/uuid",
    "/relative.png",
    "relative.png",
  ])("auto-loads %p", (url) => {
    expect(markdownImagePolicy(url, trusted)).toEqual({ kind: "auto" })
  })

  test.each([
    ["https://evil.example.com/a.png", "evil.example.com"],
    ["http://evil.example.com:8080/a.png", "evil.example.com:8080"],
    ["//evil.example.com/a.png", "evil.example.com"],
    ["/\\evil.example.com/a.png", "evil.example.com"],
    ["https://proj.supabase.co.evil.com/a.png", "proj.supabase.co.evil.com"],
    ["http://proj.supabase.co/a.png", "proj.supabase.co"],
  ])("click-to-load %p (host %p)", (url, host) => {
    expect(markdownImagePolicy(url, trusted)).toEqual({ kind: "click", host })
  })

  test("nothing is trusted by default", () => {
    expect(markdownImagePolicy("https://proj.supabase.co/x.png").kind).toBe("click")
  })

  test.each([...SCRIPT_URLS.filter((u) => !u.startsWith("blob:")), "data:image/svg+xml,<svg/>", "blob:javascript:alert(1)"])(
    "blocks %p",
    (url) => {
      expect(markdownImagePolicy(url, trusted)).toEqual({ kind: "blocked" })
    }
  )

  test("httpOriginOf", () => {
    expect(httpOriginOf("https://proj.supabase.co/rest/v1")).toBe("https://proj.supabase.co")
    expect(httpOriginOf("javascript:alert(1)")).toBeNull()
    expect(httpOriginOf(undefined)).toBeNull()
    expect(httpOriginOf("")).toBeNull()
  })
})

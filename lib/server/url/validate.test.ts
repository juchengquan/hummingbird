import { describe, expect, test } from "bun:test"
import { normalizeUrl } from "./validate"

describe("normalizeUrl — schemeless input", () => {
  test("bare domain → https://", () => {
    expect(normalizeUrl("google.com")).toBe("https://google.com/")
  })
  test("domain + path → https://", () => {
    expect(normalizeUrl("google.com/foo")).toBe("https://google.com/foo")
  })
  test("domain:port → https:// (not mistaken for scheme)", () => {
    expect(normalizeUrl("example.com:8080")).toBe("https://example.com:8080/")
  })
  test("trims whitespace before prepending", () => {
    expect(normalizeUrl("  google.com  ")).toBe("https://google.com/")
  })
  test("raw IPv4 → https://", () => {
    expect(normalizeUrl("1.2.3.4")).toBe("https://1.2.3.4/")
  })
  test("IPv4:port → https://", () => {
    expect(normalizeUrl("1.2.3.4:8080")).toBe("https://1.2.3.4:8080/")
  })
})

describe("normalizeUrl — explicit scheme preserved", () => {
  test("https:// stays https://", () => {
    expect(normalizeUrl("https://google.com")).toBe("https://google.com/")
  })
  test("http:// preserved (validateOutboundUrl handles policy)", () => {
    expect(normalizeUrl("http://insecure.example")).toBe("http://insecure.example/")
  })
  test("scheme + host casing normalized", () => {
    expect(normalizeUrl("HTTPS://Foo.COM")).toBe("https://foo.com/")
  })
})

describe("normalizeUrl — non-URL schemes preserved (so bad_scheme can fire)", () => {
  test("ftp:// preserved", () => {
    expect(normalizeUrl("ftp://example.com")?.startsWith("ftp://")).toBe(true)
  })
  test("mailto: preserved", () => {
    expect(normalizeUrl("mailto:foo@bar.com")).toBe("mailto:foo@bar.com")
  })
  test("javascript: preserved", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBe("javascript:alert(1)")
  })
})

describe("normalizeUrl — invalid input", () => {
  test("scheme alone → null", () => {
    expect(normalizeUrl("https://")).toBeNull()
  })
  test("spaces in input → null", () => {
    expect(normalizeUrl("not a url with spaces")).toBeNull()
  })
  test("empty → null", () => {
    expect(normalizeUrl("")).toBeNull()
  })
})

describe("normalizeUrl — existing canonicalization preserved", () => {
  test("hash stripped, trailing slash trimmed", () => {
    expect(normalizeUrl("https://x.com/path/#anchor")).toBe("https://x.com/path")
  })
  test("root / preserved", () => {
    expect(normalizeUrl("https://x.com/")).toBe("https://x.com/")
  })
})

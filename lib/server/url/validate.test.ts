import { describe, expect, test } from "bun:test"
import { isAddressAllowed, normalizeUrl, validateOutboundUrl } from "./validate"

async function codeOf(url: string, policy?: { allowPrivateHosts?: boolean }) {
  const r = await validateOutboundUrl(url, policy)
  return r.ok ? "ok" : r.error.code
}

describe("validateOutboundUrl — private destinations rejected (default policy)", () => {
  for (const url of [
    "http://127.0.0.1/",
    "http://127.1.2.3:8080/x",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[::7f00:1]/",
    "http://[64:ff9b::7f00:1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
  ]) {
    test(url, async () => {
      expect(await codeOf(url)).toBe("private_address")
    })
  }

  for (const url of [
    "http://localhost:3000/",
    "http://localhost./",
    "http://foo.localhost/",
    "http://printer.local/",
    "http://metadata.google.internal/",
    "http://metadata.google.internal./",
    "http://svc.internal/",
  ]) {
    test(url, async () => {
      expect(await codeOf(url)).toBe("blocked_host")
    })
  }

  test("non-http scheme rejected", async () => {
    expect(await codeOf("file:///etc/passwd")).toBe("bad_scheme")
  })

  test("public IP literal allowed", async () => {
    expect(await codeOf("https://93.184.216.34/")).toBe("ok")
  })
})

describe("validateOutboundUrl — allowPrivateHosts opt-in", () => {
  const policy = { allowPrivateHosts: true }
  for (const url of [
    "http://127.0.0.1:8080/mcp",
    "http://[::1]:8080/mcp",
    "http://192.168.1.10/mcp",
    "http://localhost:8080/mcp",
  ]) {
    test(`allows ${url}`, async () => {
      expect(await codeOf(url, policy)).toBe("ok")
    })
  }

  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "http://[::ffff:169.254.169.254]/",
    "http://[fe80::1]/",
    "http://[fd00:ec2::254]/",
  ]) {
    test(`still blocks link-local / metadata ${url}`, async () => {
      expect(await codeOf(url, policy)).toBe("private_address")
    })
  }

  test("still blocks named metadata hosts", async () => {
    expect(await codeOf("http://metadata.google.internal/", policy)).toBe("blocked_host")
  })
})

describe("isAddressAllowed", () => {
  test("default policy", () => {
    expect(isAddressAllowed("8.8.8.8")).toBe(true)
    expect(isAddressAllowed("2606:4700::1111")).toBe(true)
    expect(isAddressAllowed("127.0.0.1")).toBe(false)
    expect(isAddressAllowed("not-an-ip")).toBe(false)
  })
  test("allowPrivateHosts keeps link-local denied", () => {
    const p = { allowPrivateHosts: true }
    expect(isAddressAllowed("127.0.0.1", p)).toBe(true)
    expect(isAddressAllowed("10.1.2.3", p)).toBe(true)
    expect(isAddressAllowed("169.254.169.254", p)).toBe(false)
    expect(isAddressAllowed("not-an-ip", p)).toBe(false)
  })
})

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

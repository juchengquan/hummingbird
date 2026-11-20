import { describe, expect, test } from "bun:test"

import { sanitizeRenderedLinks } from "./sanitize-links"

class FakeAnchor {
  attrs: Map<string, string>
  constructor(attrs: Record<string, string>) {
    this.attrs = new Map(Object.entries(attrs))
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value)
  }
  removeAttribute(name: string) {
    this.attrs.delete(name)
  }
}

function rootOf(anchors: FakeAnchor[]) {
  return {
    querySelectorAll(selector: string) {
      expect(selector).toBe("a[href]")
      return anchors
    },
  }
}

describe("sanitizeRenderedLinks", () => {
  test("removes unsafe hrefs (and target) but keeps the anchor", () => {
    const bad = [
      new FakeAnchor({ href: "javascript:alert(1)", target: "_blank" }),
      new FakeAnchor({ href: " JavaScript:alert(1)" }),
      new FakeAnchor({ href: "java\tscript:alert(1)" }),
      new FakeAnchor({ href: "vbscript:msgbox(1)" }),
      new FakeAnchor({ href: "data:text/html,<script>alert(1)</script>" }),
      new FakeAnchor({ href: "file:///etc/passwd" }),
    ]
    expect(sanitizeRenderedLinks(rootOf(bad))).toBe(bad.length)
    for (const a of bad) {
      expect(a.getAttribute("href")).toBeNull()
      expect(a.getAttribute("target")).toBeNull()
    }
  })

  test("keeps safe hrefs; external ones gain rel=noopener noreferrer", () => {
    const ext = new FakeAnchor({ href: "https://example.com" })
    const mail = new FakeAnchor({ href: "mailto:a@example.com" })
    const anchor = new FakeAnchor({ href: "#_Toc123" })
    expect(sanitizeRenderedLinks(rootOf([ext, mail, anchor]))).toBe(0)
    expect(ext.getAttribute("href")).toBe("https://example.com")
    expect(ext.getAttribute("rel")).toBe("noopener noreferrer")
    expect(mail.getAttribute("href")).toBe("mailto:a@example.com")
    expect(mail.getAttribute("rel")).toBeNull()
    expect(anchor.getAttribute("href")).toBe("#_Toc123")
  })
})

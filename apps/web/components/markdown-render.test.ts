import { describe, expect, test } from "bun:test"

import { renderMarkdownToHtml } from "./markdown-render"

function expectNoScriptUrl(html: string) {
  expect(html.toLowerCase()).not.toContain("javascript:")
  expect(html).not.toMatch(/href=/i)
}

describe("renderMarkdownToHtml -- link sanitization", () => {
  test("inline javascript: link renders as plain text", () => {
    const html = renderMarkdownToHtml("[open](javascript:alert(1))")
    expectNoScriptUrl(html)
    expect(html).toContain("open")
  })

  test("reference-style javascript: link renders as plain text", () => {
    const html = renderMarkdownToHtml("[x][r]\n\n[r]: javascript:alert(document.cookie)")
    expectNoScriptUrl(html)
    expect(html).toContain("x")
  })

  test.each([
    "[a](JaVaScRiPt:alert(1))",
    "[a](java&#x09;script:alert(1))",
    "[a](javascript&colon;alert(1))",
    "[a](%6Aavascript:alert(1))",
    "[a](vbscript:msgbox(1))",
    "[a](data:text/html;base64,PHNjcmlwdD4=)",
    "<javascript:alert(1)>",
    "[a][b]\n\n[b]: <javascript:alert(1)> \"title\"",
  ])("neutralizes %p", (src) => {
    const html = renderMarkdownToHtml(src)
    expect(html).not.toMatch(/<a\b/i)
    expect(html).not.toMatch(/href=/i)
  })

  test("keeps link text formatting when the href is dropped", () => {
    const html = renderMarkdownToHtml("[**bold**](javascript:alert(1))")
    expect(html).toContain("<strong>bold</strong>")
    expect(html).not.toMatch(/<a\b/i)
  })

  test("external http(s) links keep href and gain rel=noopener noreferrer", () => {
    const html = renderMarkdownToHtml('[site](https://example.com/a?b=1 "T")')
    expect(html).toContain('<a rel="noopener noreferrer" href="https://example.com/a?b=1" title="T">site</a>')
  })

  test("GFM bare-URL autolinks are kept", () => {
    const html = renderMarkdownToHtml("see https://example.com now")
    expect(html).toContain('href="https://example.com"')
  })

  test("relative, fragment and mailto links are kept without rel", () => {
    expect(renderMarkdownToHtml("[r](/docs/a)")).toContain('<a href="/docs/a">r</a>')
    expect(renderMarkdownToHtml("[f](#sec)")).toContain('<a href="#sec">f</a>')
    expect(renderMarkdownToHtml("[m](mailto:a@example.com)")).toContain(
      '<a href="mailto:a@example.com">m</a>'
    )
  })
})

describe("renderMarkdownToHtml -- image sanitization", () => {
  test("safe images render unchanged once loaded", () => {
    expect(
      renderMarkdownToHtml("![alt](https://example.com/a.png)", {
        loadedRemoteImages: new Set(["https://example.com/a.png"]),
      })
    ).toContain('<img referrerpolicy="no-referrer" src="https://example.com/a.png" alt="alt">')
    expect(renderMarkdownToHtml("![alt](data:image/png;base64,AAAA)")).toContain(
      '<img src="data:image/png;base64,AAAA" alt="alt">'
    )
  })

  test.each([
    "![alt](javascript:alert(1))",
    "![alt](data:image/svg+xml;base64,PHN2Zz4=)",
    "![alt](data:text/html,hi)",
    "![alt][i]\n\n[i]: javascript:alert(1)",
  ])("drops the <img> for %p but keeps alt text", (src) => {
    const html = renderMarkdownToHtml(src)
    expect(html).not.toMatch(/<img\b/i)
    expect(html.toLowerCase()).not.toContain("javascript:")
    expect(html).toContain("alt")
  })

  test("alt text of a dropped image is escaped", () => {
    const html = renderMarkdownToHtml("![<b>x</b>](javascript:alert(1))")
    expect(html).not.toContain("<b>")
  })
})

describe("renderMarkdownToHtml -- click-to-load remote images", () => {
  const SUPABASE = "https://proj.supabase.co"
  const opts = { trustedImageOrigins: [SUPABASE] }

  test("a remote https image renders as a placeholder naming the host", () => {
    const html = renderMarkdownToHtml("![a chart](https://tracker.example.com/p.png?u=1&v=2)", opts)
    expect(html).not.toMatch(/<img\b/i)
    expect(html).toContain('<button type="button" class="md-remote-image"')
    expect(html).toContain('data-remote-image-src="https://tracker.example.com/p.png?u=1&amp;v=2"')
    expect(html).toContain('<span class="md-remote-image-host">tracker.example.com</span>')
    expect(html).toContain("Load image")
    expect(html).toContain('<span class="md-remote-image-alt">a chart</span>')
    // No inline handlers (CSP; the component uses event delegation).
    expect(html).not.toMatch(/\son\w+=/i)
  })

  test("protocol-relative and http images are click-to-load too", () => {
    for (const src of ["//cdn.example.com/x.png", "http://cdn.example.com/x.png", "/\\cdn.example.com/x.png"]) {
      const html = renderMarkdownToHtml(`![x](${src})`, opts)
      expect(html).not.toMatch(/<img\b/i)
      expect(html).toContain("cdn.example.com")
    }
  })

  test("only the clicked URL loads", () => {
    const md = "![a](https://a.example.com/1.png) ![b](https://b.example.com/2.png)"
    const html = renderMarkdownToHtml(md, {
      ...opts,
      loadedRemoteImages: new Set(["https://a.example.com/1.png"]),
    })
    expect(html).toContain('<img referrerpolicy="no-referrer" src="https://a.example.com/1.png"')
    expect(html).not.toMatch(/<img [^>]*src="https:\/\/b\.example/)
    expect(html).toContain('data-remote-image-src="https://b.example.com/2.png"')
  })

  test("the app's Supabase storage, data:, blob: and relative images load immediately", () => {
    for (const src of [
      `${SUPABASE}/storage/v1/object/sign/x.png?token=t`,
      "data:image/webp;base64,AAAA",
      "blob:https://app.example.com/0b7c-uuid",
      "/api/files/x.png",
    ]) {
      const html = renderMarkdownToHtml(`![x](${src})`, opts)
      expect(html).toMatch(/<img src="/)
      expect(html).not.toContain("md-remote-image")
    }
  })

  test("a look-alike of the trusted origin is still click-to-load", () => {
    const html = renderMarkdownToHtml("![x](https://proj.supabase.co.evil.com/x.png)", opts)
    expect(html).not.toMatch(/<img\b/i)
    expect(html).toContain("proj.supabase.co.evil.com")
  })

  test("hostile alt / URL text stays inert in the placeholder", () => {
    const html = renderMarkdownToHtml('![<img src=x onerror=alert(1)>](https://e.com/a.png "t")', opts)
    expect(html).not.toMatch(/<img\b/i)
    const quoted = renderMarkdownToHtml('![x](<https://e.com/a.png?"onmouseover="alert(1)>)', opts)
    expect(quoted).not.toMatch(/"\s*onmouseover=/i)
  })
})

describe("renderMarkdownToHtml -- raw HTML", () => {
  test("raw HTML is escaped, not passed through", () => {
    const html = renderMarkdownToHtml('<a href="javascript:alert(1)">x</a><script>alert(1)</script>')
    expect(html).not.toMatch(/<a\b/i)
    expect(html).not.toMatch(/<script\b/i)
  })
})

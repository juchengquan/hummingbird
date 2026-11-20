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
  test("safe images render unchanged", () => {
    expect(renderMarkdownToHtml("![alt](https://example.com/a.png)")).toContain(
      '<img src="https://example.com/a.png" alt="alt">'
    )
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

describe("renderMarkdownToHtml -- raw HTML", () => {
  test("raw HTML is escaped, not passed through", () => {
    const html = renderMarkdownToHtml('<a href="javascript:alert(1)">x</a><script>alert(1)</script>')
    expect(html).not.toMatch(/<a\b/i)
    expect(html).not.toMatch(/<script\b/i)
  })
})

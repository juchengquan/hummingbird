import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { neutralizeDocxSymbols } from "./sanitize-symbols"

const PAYLOAD = '41;<img src=x onerror="window.__pwned=1">'

/** A parsed-document shape like docx-preview's `WordDocument`: symbols
 *  in the body, in a header part (reached via `parts`) and in a
 *  footnote, plus the back-references the walk must not choke on. */
function craftedDocument() {
  const bodySym = { type: "symbol", font: "Wingdings", char: PAYLOAD }
  const okSym = { type: "symbol", font: "Symbol", char: "F0B7" }
  const paragraph: Record<string, unknown> = { type: "paragraph", children: [bodySym, okSym] }
  Object.assign(bodySym, { parent: paragraph })
  const headerSym = { type: "symbol", font: "x", char: "<svg onload=alert(1)>" }
  const header = { _package: { huge: new Uint8Array(8) }, rootElement: { type: "header", children: [{ type: "paragraph", children: [headerSym] }] } }
  const footSym: { type: string; font: string; char?: string } = { type: "symbol", font: "x", char: undefined }
  const doc: Record<string, unknown> = {
    _package: {},
    documentPart: { body: { type: "document", children: [paragraph] } },
    footnotesPart: { notes: [{ type: "footnote", children: [footSym] }] },
    parts: [header],
  }
  doc.partsMap = { "word/header1.xml": header }
  return { doc, bodySym, okSym, headerSym, footSym }
}

describe("neutralizeDocxSymbols", () => {
  test("replaces non-hex symbol chars everywhere; keeps valid ones", () => {
    const { doc, bodySym, okSym, headerSym, footSym } = craftedDocument()
    expect(neutralizeDocxSymbols(doc)).toBe(3)
    expect(bodySym.char).toBe("FFFD")
    expect(headerSym.char).toBe("FFFD")
    expect(footSym.char).toBe("FFFD")
    expect(okSym.char).toBe("F0B7")
    // Idempotent.
    expect(neutralizeDocxSymbols(doc)).toBe(0)
  })

  for (const bad of ["", "1234567", "zz", "41 ", "&#x41", "41;<b>"]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      const sym = { type: "symbol", char: bad }
      neutralizeDocxSymbols({ children: [sym] })
      expect(sym.char).toBe("FFFD")
    })
  }
})

// ---------------------------------------------------------------------------
// Pin the docx-preview internals the neutralizer relies on. If an upgrade
// changes any of these, re-review the symbol sink (and this file).
// ---------------------------------------------------------------------------

const DIST = readFileSync(
  join(process.cwd(), "node_modules/docx-preview/dist/docx-preview.mjs"),
  "utf8"
)

describe("docx-preview internals (pinned)", () => {
  test("symbols are parsed as { type: 'symbol', char: w:char }", () => {
    expect(DIST).toContain('DomType["Symbol"] = "symbol";')
    expect(DIST).toMatch(/type: DomType\.Symbol,\s*font: [^\n]+,\s*char: globalXmlParser\.attr\(c, "char"\)/)
  })

  test("the real renderSymbol emits no markup for a neutralized crafted symbol", () => {
    const m = DIST.match(/\n {4}renderSymbol\(elem\) \{\n([\s\S]*?)\n {4}\}\n/)
    expect(m).not.toBeNull()
    // The sink this module exists for. If it's gone, the upstream fix
    // landed — this guard (not the neutralizer) is what needs updating.
    expect(m![1]).toContain("span.innerHTML = `&#x${elem.char};`")
    const renderSymbol = new Function("elem", m![1]) as (this: unknown, elem: unknown) => {
      innerHTML: string
    }
    const fakeRenderer = {
      createElement: () => ({ style: {}, innerHTML: "" }),
    }

    const { doc, bodySym } = craftedDocument()
    // Unpatched, the payload reaches innerHTML as live markup…
    expect(renderSymbol.call(fakeRenderer, { ...bodySym }).innerHTML).toContain("<img")
    // …after neutralizing it is a single character reference.
    neutralizeDocxSymbols(doc)
    const html = renderSymbol.call(fakeRenderer, bodySym).innerHTML
    expect(html).toBe("&#xFFFD;")
    expect(html).not.toContain("<")
  })
})

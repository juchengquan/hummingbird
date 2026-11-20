import { describe, expect, test } from "bun:test"
import * as XLSX from "xlsx"

import { extractFile } from "./extraction"

// A VALID minimal 1-page PDF (renders/parses fine) so the real pdf-parse
// text pass succeeds deterministically and the *vision branch* is what's
// under test. We force `vision: true` to bypass the heuristic and drive
// the vision pass through injected deps (no native renderer / model call).
const FIXTURE_PDF_B64 =
  "JVBERi0xLjMKJf////8KNyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9NZWRpYUJveCBbMCAwIDIwMCAyMDBdCi9Db250ZW50cyA1IDAgUgovUmVzb3VyY2VzIDYgMCBSCi9Vc2VyVW5pdCAxCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Qcm9jU2V0IFsvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJXQovRm9udCA8PAovRjEgOCAwIFIKPj4KL0NvbG9yU3BhY2UgPDwKPj4KPj4KZW5kb2JqCjUgMCBvYmoKPDwKL0xlbmd0aCA3NgovRmlsdGVyIC9GbGF0ZURlY29kZQo+PgpzdHJlYW0KeJwzVDAAQl1DIGFkYKCQnMtVyGWIIeYUAhU0BIooGJpZ6lmaWCiE5HLpuxkqGJoohKRxRduYWJhZ2ikYxCqEeHG5hnAFcgEAJq8SBgplbmRzdHJlYW0KZW5kb2JqCjEwIDAgb2JqCihQREZLaXQpCmVuZG9iagoxMSAwIG9iagooUERGS2l0KQplbmRvYmoKMTIgMCBvYmoKKEQ6MjAyNjA2MjAwNDMzMTlaKQplbmRvYmoKOSAwIG9iago8PAovUHJvZHVjZXIgMTAgMCBSCi9DcmVhdG9yIDExIDAgUgovQ3JlYXRpb25EYXRlIDEyIDAgUgo+PgplbmRvYmoKOCAwIG9iago8PAovVHlwZSAvRm9udAovQmFzZUZvbnQgL0hlbHZldGljYQovU3VidHlwZSAvVHlwZTEKL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKPj4KZW5kb2JqCjQgMCBvYmoKPDwKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCi9OYW1lcyAyIDAgUgo+PgplbmRvYmoKMSAwIG9iago8PAovVHlwZSAvUGFnZXMKL0NvdW50IDEKL0tpZHMgWzcgMCBSXQo+PgplbmRvYmoKMiAwIG9iago8PAovRGVzdHMgPDwKICAvTmFtZXMgWwpdCj4+Cj4+CmVuZG9iagp4cmVmCjAgMTMKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwNzI2IDAwMDAwIG4gCjAwMDAwMDA3ODMgMDAwMDAgbiAKMDAwMDAwMDY2NCAwMDAwMCBuIAowMDAwMDAwNjQzIDAwMDAwIG4gCjAwMDAwMDAyMzggMDAwMDAgbiAKMDAwMDAwMDEzMSAwMDAwMCBuIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDA1NDYgMDAwMDAgbiAKMDAwMDAwMDQ3MSAwMDAwMCBuIAowMDAwMDAwMzg1IDAwMDAwIG4gCjAwMDAwMDA0MTAgMDAwMDAgbiAKMDAwMDAwMDQzNSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDEzCi9Sb290IDMgMCBSCi9JbmZvIDkgMCBSCi9JRCBbPDUwOGIxMjkyZDkzNmZlMjNiZjdkYjM4ZDZjYWFiYjZiPiA8NTA4YjEyOTJkOTM2ZmUyM2JmN2RiMzhkNmNhYWJiNmI+XQo+PgpzdGFydHhyZWYKODMwCiUlRU9GCg=="
const FAKE_PDF = Buffer.from(FIXTURE_PDF_B64, "base64")

describe("extractFile — vision gating", () => {
  test("no vision model configured → vision pass not invoked (text-only)", async () => {
    let visionCalled = false
    const result = await extractFile(
      { name: "doc.pdf", mimeType: "application/pdf", data: FAKE_PDF },
      {
        vision: true,
        resolveVisionModel: () => null,
        extractWithVision: async () => {
          visionCalled = true
          return { text: "VISION", pageCount: 1 }
        },
      }
    )
    expect(visionCalled).toBe(false)
    expect(result.kind).toBe("pdf")
    expect(result.text).not.toBe("VISION")
  })

  test("forced vision + model present → merges vision markdown", async () => {
    const result = await extractFile(
      { name: "doc.pdf", mimeType: "application/pdf", data: FAKE_PDF },
      {
        vision: true,
        resolveVisionModel: () => "vis/a",
        extractWithVision: async () => ({ text: "| A | B |\n|---|---|\n| 1 | 2 |", pageCount: 1 }),
      }
    )
    expect(result.text).toContain("| A | B |")
  })

  test("vision pass throws → falls back to text-only (never throws)", async () => {
    const result = await extractFile(
      { name: "doc.pdf", mimeType: "application/pdf", data: FAKE_PDF },
      {
        vision: true,
        resolveVisionModel: () => "vis/a",
        extractWithVision: async () => {
          throw new Error("render boom")
        },
      }
    )
    expect(result.kind).toBe("pdf")
    expect(result.text).not.toContain("VISION")
  })

  test("budget denied → vision pass not invoked", async () => {
    let visionCalled = false
    await extractFile(
      { name: "doc.pdf", mimeType: "application/pdf", data: FAKE_PDF },
      {
        vision: true,
        resolveVisionModel: () => "vis/a",
        consumeVisionBudget: () => ({ allowed: false, retryAfterSec: 30 }),
        extractWithVision: async () => {
          visionCalled = true
          return { text: "x", pageCount: 1 }
        },
      }
    )
    expect(visionCalled).toBe(false)
  })

  test("onVisionOutcome reports what happened to the vision pass", async () => {
    const run = async (opts: Parameters<typeof extractFile>[1]) => {
      const seen: string[] = []
      await extractFile(
        { name: "doc.pdf", mimeType: "application/pdf", data: FAKE_PDF },
        { ...opts, onVisionOutcome: (o) => seen.push(o) }
      )
      return seen
    }
    const ok = async () => ({ text: "v", pageCount: 1 })
    expect(await run({ vision: true, resolveVisionModel: () => null })).toEqual(["skipped"])
    expect(await run({ vision: false, resolveVisionModel: () => "m" })).toEqual(["skipped"])
    expect(
      await run({
        vision: true,
        resolveVisionModel: () => "m",
        consumeVisionBudget: () => ({ allowed: false, retryAfterSec: 1 }),
        extractWithVision: ok,
      })
    ).toEqual(["budget_denied"])
    expect(
      await run({ vision: true, resolveVisionModel: () => "m", extractWithVision: ok })
    ).toEqual(["applied"])
    expect(
      await run({
        vision: true,
        resolveVisionModel: () => "m",
        extractWithVision: async () => {
          throw new Error("x")
        },
      })
    ).toEqual(["failed"])
  })
})

describe("extractFile — spreadsheet bounds", () => {
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

  /** A real 2x2 xlsx whose sheet XML is then rewritten by `patch`.
   *  (Setting a huge `!ref` and letting SheetJS write it would walk the
   *  whole declared range at write time, so the XML is patched instead.) */
  function craftXlsx(patch: (sheetXml: string) => string): Buffer {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["a", "b"],
        ["1", "2"],
      ]),
      "S"
    )
    const zip = XLSX.CFB.read(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), {
      type: "buffer",
    })
    const entry = XLSX.CFB.find(zip, "/xl/worksheets/sheet1.xml")
    if (!entry) throw new Error("fixture: sheet1.xml missing")
    const xml = Buffer.from(entry.content as Uint8Array).toString("utf8")
    entry.content = Buffer.from(patch(xml))
    return XLSX.CFB.write(zip, { fileType: "zip", type: "buffer" }) as Buffer
  }

  test("tiny file declaring a huge range extracts only its real cells, fast", async () => {
    // 100 cols x 1M rows declared, 4 real cells.
    const data = craftXlsx((xml) => xml.replace('ref="A1:B2"', 'ref="A1:CV1000000"'))
    expect(data.length).toBeLessThan(64 * 1024)
    // Sanity: the declared range survives a plain read (this is the bomb).
    expect(XLSX.read(data, { type: "buffer" }).Sheets.S?.["!ref"]).toBe("A1:CV1000000")

    const start = performance.now()
    const result = await extractFile({ name: "bomb.xlsx", mimeType: XLSX_MIME, data })
    const elapsed = performance.now() - start

    expect(result.kind).toBe("spreadsheet")
    expect(result.text).toBe("# Sheet: S\na,b\n1,2")
    expect(result.truncated).toBe(false)
    expect(elapsed).toBeLessThan(2_000)
  })

  test("real cells spanning a huge sheet stop at the text budget", async () => {
    // A far-corner cell makes the *real* bounds 16,384 cols x 4,000 rows
    // (inside `sheetRows`): ~65M mostly-empty cells if rendered in full.
    const data = craftXlsx((xml) =>
      xml
        .replace('ref="A1:B2"', 'ref="A1:XFD4000"')
        .replace(
          "</sheetData>",
          '<row r="4000"><c r="XFD4000" t="str"><v>far</v></c></row></sheetData>'
        )
    )
    expect(data.length).toBeLessThan(64 * 1024)

    const start = performance.now()
    const result = await extractFile({ name: "wide.xlsx", mimeType: XLSX_MIME, data })
    const elapsed = performance.now() - start

    expect(result.kind).toBe("spreadsheet")
    expect(result.text.startsWith("# Sheet: S\na,b")).toBe(true)
    expect(result.truncated).toBe(true)
    expect((result.fullText ?? "").length).toBeLessThanOrEqual(1024 * 1024)
    expect(elapsed).toBeLessThan(3_000)
  })
})

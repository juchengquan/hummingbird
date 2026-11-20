import { deflateRawSync } from "node:zlib"

import { describe, expect, test } from "bun:test"
import * as XLSX from "xlsx"

import { extractFile } from "../extraction"
import { assertZipWithinLimits, looksLikeZip, ZipLimitError } from "./zip-guard"

interface FakeEntry {
  name: string
  data: Buffer
  /** Override the size written into the headers (to simulate a lying
   *  archive). Defaults to the real uncompressed length. */
  declaredSize?: number
  stored?: boolean
}

/** Minimal zip writer (CRC left 0 — neither the guard nor these tests
 *  check it). Enough to hand-craft bombs and lying headers. */
function buildZip(entries: FakeEntry[], prefix = Buffer.alloc(0)): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = prefix.length
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const body = e.stored ? e.data : deflateRawSync(e.data)
    const usize = e.declaredSize ?? e.data.length
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(e.stored ? 0 : 8, 8)
    lfh.writeUInt32LE(body.length, 18)
    lfh.writeUInt32LE(usize, 22)
    lfh.writeUInt16LE(name.length, 26)
    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(20, 4)
    cdh.writeUInt16LE(20, 6)
    cdh.writeUInt16LE(e.stored ? 0 : 8, 10)
    cdh.writeUInt32LE(body.length, 20)
    cdh.writeUInt32LE(usize, 24)
    cdh.writeUInt16LE(name.length, 28)
    cdh.writeUInt32LE(offset - prefix.length, 42)
    locals.push(lfh, name, body)
    centrals.push(cdh, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset - prefix.length, 16)
  return Buffer.concat([prefix, ...locals, cd, eocd])
}

function realXlsx(): Buffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["name", "qty"],
      ["apple", 3],
    ]),
    "Fruit"
  )
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer
}

describe("assertZipWithinLimits", () => {
  test("accepts a real xlsx produced by SheetJS", () => {
    const buf = realXlsx()
    expect(looksLikeZip(buf)).toBe(true)
    expect(() => assertZipWithinLimits(buf)).not.toThrow()
  })

  test("accepts stored + deflated entries within limits", () => {
    const buf = buildZip([
      { name: "a.xml", data: Buffer.from("<a/>") },
      { name: "b.bin", data: Buffer.from("raw"), stored: true },
    ])
    expect(() => assertZipWithinLimits(buf, { maxTotalUncompressed: 100 })).not.toThrow()
  })

  test("rejects too many entries", () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({
      name: `f${i}`,
      data: Buffer.from("x"),
    }))
    expect(() => assertZipWithinLimits(buildZip(entries), { maxEntries: 5 })).toThrow(
      ZipLimitError
    )
  })

  test("rejects a bomb by its declared size", () => {
    const buf = buildZip([{ name: "big", data: Buffer.alloc(2_000) }])
    expect(() => assertZipWithinLimits(buf, { maxTotalUncompressed: 1_000 })).toThrow(
      /extraction limit/
    )
  })

  test("rejects a bomb whose headers LIE about the size (real inflate is capped)", () => {
    // 4 MB of zeros deflates to a few KB; headers claim 10 bytes.
    const buf = buildZip([{ name: "liar", data: Buffer.alloc(4_000_000), declaredSize: 10 }])
    expect(() =>
      assertZipWithinLimits(buf, { maxTotalUncompressed: 1_000_000 })
    ).toThrow(/extraction limit/)
  })

  test("the cap is on the total across entries", () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({
      name: `p${i}`,
      data: Buffer.alloc(400),
    }))
    expect(() =>
      assertZipWithinLimits(buildZip(entries), { maxTotalUncompressed: 1_000 })
    ).toThrow(ZipLimitError)
    expect(() =>
      assertZipWithinLimits(buildZip(entries), { maxTotalUncompressed: 1_200 })
    ).not.toThrow()
  })

  test("tolerates prepended bytes (like JSZip) and still enforces the cap", () => {
    const buf = buildZip([{ name: "big", data: Buffer.alloc(5_000), declaredSize: 1 }], Buffer.from("JUNK"))
    expect(looksLikeZip(buf)).toBe(true)
    expect(() => assertZipWithinLimits(buf, { maxTotalUncompressed: 1_000 })).toThrow(
      ZipLimitError
    )
  })

  test("rejects non-zip input and unsupported methods", () => {
    expect(() => assertZipWithinLimits(Buffer.from("hello world, not a zip at all"))).toThrow(
      ZipLimitError
    )
    const buf = buildZip([{ name: "x", data: Buffer.from("x") }])
    // Patch the central-directory method to 12 (bzip2).
    const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    buf.writeUInt16LE(12, cd + 10)
    expect(() => assertZipWithinLimits(buf)).toThrow(/compression method/)
  })
})

describe("extractFile zip-bomb guard", () => {
  test("a docx whose entries declare > 100 MB is refused before mammoth runs", async () => {
    const bomb = buildZip([
      { name: "word/document.xml", data: Buffer.from("<x/>"), declaredSize: 200 * 1024 * 1024 },
    ])
    await expect(
      extractFile({ name: "bomb.docx", mimeType: "", data: bomb })
    ).rejects.toBeInstanceOf(ZipLimitError)
  })

  test("an xlsx bomb is refused; a real xlsx still extracts", async () => {
    const bomb = buildZip([
      { name: "xl/workbook.xml", data: Buffer.from("<x/>"), declaredSize: 200 * 1024 * 1024 },
    ])
    await expect(
      extractFile({ name: "bomb.xlsx", mimeType: "", data: bomb })
    ).rejects.toBeInstanceOf(ZipLimitError)

    const ok = await extractFile({ name: "fruit.xlsx", mimeType: "", data: realXlsx() })
    expect(ok.kind).toBe("spreadsheet")
    expect(ok.text).toContain("apple")
  })
})

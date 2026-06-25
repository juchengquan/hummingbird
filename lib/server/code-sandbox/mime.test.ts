import { describe, expect, it } from "bun:test"

import { mimeForName } from "./mime"

describe("mimeForName", () => {
  it("maps common deliverable extensions", () => {
    expect(mimeForName("report.csv")).toBe("text/csv")
    expect(mimeForName("data.json")).toBe("application/json")
    expect(mimeForName("out.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    expect(mimeForName("doc.pdf")).toBe("application/pdf")
    expect(mimeForName("archive.zip")).toBe("application/zip")
    expect(mimeForName("notes.txt")).toBe("text/plain")
  })

  it("is case-insensitive on the extension", () => {
    expect(mimeForName("REPORT.CSV")).toBe("text/csv")
  })

  it("falls back to octet-stream for unknown / missing extensions", () => {
    expect(mimeForName("mystery.bin")).toBe("application/octet-stream")
    expect(mimeForName("noext")).toBe("application/octet-stream")
  })
})

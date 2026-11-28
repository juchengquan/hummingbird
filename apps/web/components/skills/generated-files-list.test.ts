import { describe, expect, test } from "bun:test"
import { humanSize, shouldRefreshFile } from "./generated-files-list"

describe("humanSize", () => {
  test("bytes under 1KB", () => {
    expect(humanSize(512)).toBe("512 B")
  })

  test("kilobytes with decimal", () => {
    expect(humanSize(2048)).toBe("2.0 KB")
  })

  test("kilobytes without decimal when >= 10", () => {
    expect(humanSize(20 * 1024)).toBe("20 KB")
  })

  test("megabytes with decimal", () => {
    expect(humanSize(5 * 1024 * 1024)).toBe("5.0 MB")
  })

  test("megabytes without decimal when >= 10", () => {
    expect(humanSize(50 * 1024 * 1024)).toBe("50 MB")
  })
})

const f = (storagePath: string | null) => ({
  id: "x", name: "x", sizeBytes: 1, mimeType: "text/plain",
  url: "u", storagePath,
})

describe("shouldRefreshFile", () => {
  test("true for a cloud file with a messageId", () => {
    expect(shouldRefreshFile(f("u/generated/x"), "m1")).toBe(true)
  })
  test("false without a storagePath (data-URL / local file)", () => {
    expect(shouldRefreshFile(f(null), "m1")).toBe(false)
  })
  test("false without a messageId", () => {
    expect(shouldRefreshFile(f("u/generated/x"), undefined)).toBe(false)
  })
})

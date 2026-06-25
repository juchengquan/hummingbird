import { describe, expect, test } from "bun:test"
import { humanSize } from "./generated-files-list"

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

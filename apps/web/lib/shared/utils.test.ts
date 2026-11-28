import { describe, expect, test } from "bun:test"
import { formatBytes, toISO } from "./utils"

describe("formatBytes", () => {
  test("zero → 0 B", () => {
    expect(formatBytes(0)).toBe("0 B")
  })
  test("sub-1 KB stays as B", () => {
    expect(formatBytes(512)).toBe("512 B")
  })
  test("KB range", () => {
    expect(formatBytes(1024)).toBe("1 KB")
    expect(formatBytes(1536)).toBe("1.5 KB")
  })
  test("MB range", () => {
    expect(formatBytes(1024 * 1024)).toBe("1 MB")
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB")
  })
  test("GB / TB range", () => {
    expect(formatBytes(1024 ** 3)).toBe("1 GB")
    expect(formatBytes(1024 ** 4)).toBe("1 TB")
  })
  test("trailing zeros dropped", () => {
    expect(formatBytes(5120)).toBe("5 KB") // not "5.0 KB"
  })
})

describe("toISO", () => {
  test("Date → ISO string", () => {
    const d = new Date("2026-05-21T12:34:56.789Z")
    expect(toISO(d)).toBe("2026-05-21T12:34:56.789Z")
  })
  test("ISO string → same ISO string (pass-through)", () => {
    expect(toISO("2026-05-21T12:34:56.789Z")).toBe("2026-05-21T12:34:56.789Z")
  })
  test("non-ISO string → returned unchanged (caller's responsibility to validate)", () => {
    expect(toISO("not-a-date")).toBe("not-a-date")
  })
})

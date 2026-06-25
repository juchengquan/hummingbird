import { describe, expect, test } from "bun:test"

import { normalizeTable, toCodeRunResult, type RawRun } from "./marshal"

const base: RawRun = { stdout: "", stderr: "", exitCode: 0, images: [], timedOut: false }

describe("toCodeRunResult", () => {
  test("exit 0 → ok, stdout as a text result", () => {
    const r = toCodeRunResult({ ...base, stdout: "4\n" })
    expect(r.ok).toBe(true)
    expect(r.stdout).toBe("4\n")
    expect(r.results).toContainEqual({ type: "text", value: "4\n" })
  })
  test("non-zero exit → not ok + runtime error, stderr carried", () => {
    const r = toCodeRunResult({ ...base, stderr: "Traceback...", exitCode: 1 })
    expect(r.ok).toBe(false)
    expect(r.stderr).toBe("Traceback...")
    expect(r.error?.code).toBe("runtime")
  })
  test("timedOut → timeout error regardless of exit", () => {
    const r = toCodeRunResult({ ...base, exitCode: 137, timedOut: true })
    expect(r.error?.code).toBe("timeout")
    expect(r.ok).toBe(false)
  })
  test("upstreamError → upstream error regardless of exit/timeout", () => {
    const r = toCodeRunResult({ ...base, exitCode: 137, timedOut: true, upstreamError: "boot failed" })
    expect(r.error?.code).toBe("upstream")
    expect(r.error?.message).toBe("boot failed")
    expect(r.ok).toBe(false)
  })
  test("images become base64 image results", () => {
    const r = toCodeRunResult({ ...base, images: [{ format: "png", data: "AAAA" }] })
    expect(r.results).toContainEqual({ type: "image", format: "png", data: "AAAA" })
  })
  test("empty stdout produces no text result", () => {
    const r = toCodeRunResult({ ...base, images: [{ format: "png", data: "AAAA" }] })
    expect(r.results.some((x) => x.type === "text")).toBe(false)
  })
  test("stdout truncated at STDOUT_CAP with a marker", () => {
    const big = "x".repeat(300_000)
    const r = toCodeRunResult({ ...base, stdout: big })
    expect(r.stdout.length).toBeLessThanOrEqual(256_000 + 32)
    expect(r.stdout).toContain("truncated")
  })
  test("images beyond RESULT_CAP are dropped (not partial)", () => {
    const huge = "a".repeat(6_000_000) // ~6MB each; 2 exceed 10MB cap
    const r = toCodeRunResult({
      ...base,
      images: [
        { format: "png", data: huge },
        { format: "png", data: huge },
      ],
    })
    expect(r.results.filter((x) => x.type === "image").length).toBe(1)
  })
})

describe("normalizeTable", () => {
  test("{columns, rows} shape → stringified table", () => {
    expect(normalizeTable({ columns: ["a", "b"], rows: [[1, 2], [3, 4]] })).toEqual({
      columns: ["a", "b"],
      rows: [["1", "2"], ["3", "4"]],
    })
  })
  test("pandas orient=split {columns, data, index} → uses data, ignores index", () => {
    expect(
      normalizeTable({ columns: ["x"], data: [[true], [null]], index: [0, 1] }),
    ).toEqual({ columns: ["x"], rows: [["true"], [""]] })
  })
  test("non-scalar cells are JSON-encoded (no [object Object])", () => {
    expect(normalizeTable({ columns: ["c"], rows: [[{ k: 1 }]] })).toEqual({
      columns: ["c"],
      rows: [['{"k":1}']],
    })
  })
  test("garbage → null", () => {
    expect(normalizeTable(null)).toBeNull()
    expect(normalizeTable({ columns: "nope" })).toBeNull()
    expect(normalizeTable({ rows: [[1]] })).toBeNull() // no columns
  })
})

describe("toCodeRunResult — tables", () => {
  test("tables become table CodeResult cells", () => {
    const r = toCodeRunResult({ ...base, tables: [{ columns: ["a"], rows: [["1"]] }] })
    expect(r.results).toContainEqual({ type: "table", columns: ["a"], rows: [["1"]] })
  })
  test("ignores unparseable table entries", () => {
    const r = toCodeRunResult({ ...base, tables: [42, { columns: ["a"], rows: [["1"]] }] })
    expect(r.results.filter((x) => x.type === "table")).toHaveLength(1)
  })
  test("caps columns/rows and notes the truncation", () => {
    const cols = Array.from({ length: 60 }, (_, i) => `c${i}`)
    const rows = Array.from({ length: 1100 }, () => cols.map(() => "x"))
    const r = toCodeRunResult({ ...base, tables: [{ columns: cols, rows }] })
    const t = r.results.find((x) => x.type === "table") as { columns: string[]; rows: string[][] }
    expect(t.columns.length).toBe(50)
    expect(t.rows.length).toBe(1000)
    expect(t.rows[0].length).toBe(50)
    expect(r.results.some((x) => x.type === "text" && x.value.toLowerCase().includes("truncated"))).toBe(true)
  })
  test("caps long cell values", () => {
    const r = toCodeRunResult({ ...base, tables: [{ columns: ["a"], rows: [["y".repeat(600)]] }] })
    const t = r.results.find((x) => x.type === "table") as { rows: string[][] }
    expect(t.rows[0][0].length).toBeLessThanOrEqual(500 + 1) // +1 for the … marker
  })
})

describe("toCodeRunResult — RESULT_CAP spans text/images/tables", () => {
  test("a small table within budget is still emitted", () => {
    const r = toCodeRunResult({ ...base, stdout: "hi\n", tables: [{ columns: ["a"], rows: [["1"]] }] })
    expect(r.results.filter((x) => x.type === "table")).toHaveLength(1)
  })

  test("an image consuming most of the budget drops a table that no longer fits", () => {
    const img = "a".repeat(9_500_000) // ~9.5MB image
    const cols = ["x", "y"]
    const rows = Array.from({ length: 1000 }, () => ["z".repeat(500), "z".repeat(500)]) // ~1MB
    const r = toCodeRunResult({
      ...base,
      images: [{ format: "png", data: img }],
      tables: [{ columns: cols, rows }],
    })
    expect(r.results.filter((x) => x.type === "image")).toHaveLength(1) // image fit
    expect(r.results.filter((x) => x.type === "table")).toHaveLength(0) // table dropped
    expect(
      r.results.some((x) => x.type === "text" && x.value.toLowerCase().includes("dropped")),
    ).toBe(true)
  })
})

describe("toCodeRunResult — files", () => {
  test("passes output files through with computed sizeBytes", () => {
    const data = Buffer.from("col1,col2\n1,2\n").toString("base64")
    const out = toCodeRunResult({
      stdout: "",
      stderr: "",
      exitCode: 0,
      images: [],
      timedOut: false,
      files: [{ name: "report.csv", mime: "text/csv", data }],
    })
    expect(out.files).toEqual([
      {
        name: "report.csv",
        mimeType: "text/csv",
        sizeBytes: Buffer.from(data, "base64").length,
        data,
      },
    ])
  })

  test("defaults files to an empty array when none were written", () => {
    const out = toCodeRunResult({
      stdout: "hi",
      stderr: "",
      exitCode: 0,
      images: [],
      timedOut: false,
    })
    expect(out.files).toEqual([])
  })
})

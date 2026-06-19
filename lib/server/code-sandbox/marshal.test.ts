import { describe, expect, test } from "bun:test"

import { toCodeRunResult, type RawRun } from "./marshal"

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

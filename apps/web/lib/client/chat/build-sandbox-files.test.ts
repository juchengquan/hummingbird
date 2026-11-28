import { describe, expect, test } from "bun:test"

import { buildSandboxFiles, type SandboxFileSource } from "./build-sandbox-files"

const local: SandboxFileSource = { fileId: "f1", name: "a.csv", storagePath: null, readBytes: async () => new Uint8Array([97]) }
const cloud: SandboxFileSource = { fileId: "f2", name: "b.parquet", storagePath: "u/f2", readBytes: async () => new Uint8Array([1]) }

describe("buildSandboxFiles", () => {
  test("local files carry base64 bytes; cloud files carry no bytes", async () => {
    const out = await buildSandboxFiles([local, cloud])
    const a = out.find((e) => e.name === "a.csv")!
    const b = out.find((e) => e.name === "b.parquet")!
    expect(a.dataBase64).toBeDefined()
    expect(b.dataBase64).toBeUndefined()
    expect(b.fileId).toBe("f2")
  })
  test("local files over the per-file cap are omitted", async () => {
    const huge: SandboxFileSource = { fileId: "f3", name: "big", storagePath: null, readBytes: async () => new Uint8Array(11_000_000) }
    const out = await buildSandboxFiles([huge])
    expect(out.find((e) => e.name === "big")).toBeUndefined()
  })
  test("empty input → empty manifest", async () => {
    expect(await buildSandboxFiles([])).toEqual([])
  })
  test("stops at the count cap (10 files)", async () => {
    const sources: SandboxFileSource[] = Array.from({ length: 12 }, (_, i) => ({
      fileId: `c${i}`,
      name: `n${i}`,
      storagePath: `u/c${i}`,
      readBytes: async () => new Uint8Array([0]),
    }))
    const out = await buildSandboxFiles(sources)
    expect(out.length).toBe(10)
  })
  test("round-trips local bytes through base64 correctly", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 65, 66])
    const src: SandboxFileSource = { fileId: "r1", name: "r.bin", storagePath: null, readBytes: async () => bytes }
    const out = await buildSandboxFiles([src])
    const decoded = Uint8Array.from(atob(out[0].dataBase64!), (c) => c.charCodeAt(0))
    expect(Array.from(decoded)).toEqual(Array.from(bytes))
  })
})

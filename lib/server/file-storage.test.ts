import { describe, expect, it } from "bun:test"

// No Supabase configured → data-URL fallback path (getSupabaseServerClient
// returns null in the test environment). No mock.module needed — the module
// naturally returns null when NEXT_PUBLIC_SUPABASE_URL / ANON_KEY are absent,
// so resolveCloudContext() yields null and we exercise the data-URL branch.

import { persistGeneratedFiles } from "./file-storage"

describe("persistGeneratedFiles — data-URL fallback", () => {
  it("returns a data: URL with the file's mime when Supabase is absent", async () => {
    const bytes = Buffer.from("col1,col2\n1,2\n")
    const res = await persistGeneratedFiles([
      {
        id: "call-0",
        name: "report.csv",
        mimeType: "text/csv",
        sizeBytes: bytes.length,
        bytes,
      },
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.files).toHaveLength(1)
    const f = res.files[0]
    expect(f.url).toBe(`data:text/csv;base64,${bytes.toString("base64")}`)
    expect(f.storagePath).toBeNull()
    expect(f.name).toBe("report.csv")
    expect(f.sizeBytes).toBe(bytes.length)
  })

  it("returns ok with an empty list for no inputs", async () => {
    const res = await persistGeneratedFiles([])
    expect(res).toEqual({ ok: true, files: [] })
  })

  it("forces the data-URL path when localFilesOnly is set", async () => {
    const bytes = Buffer.from("x")
    const res = await persistGeneratedFiles(
      [{ id: "a", name: "a.bin", mimeType: "application/octet-stream", sizeBytes: 1, bytes }],
      { localFilesOnly: true },
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.files[0].storagePath).toBeNull()
    expect(res.files[0].url).toMatch(/^data:/)
  })
})

import { describe, expect, test } from "bun:test"
import type { UploadedFile } from "@/shared/types"
import { diffFiles } from "./handlers"

function make(id: string, overrides: Partial<UploadedFile> = {}): UploadedFile {
  return {
    id,
    name: `file-${id}.txt`,
    size: 100,
    type: "text/plain",
    uploadedAt: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

describe("diffFiles", () => {
  test("no ops when identical", () => {
    expect(diffFiles([make("a")], [make("a")])).toEqual([])
  })

  test("upsert for a new file", () => {
    const ops = diffFiles([], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("upsert")
    expect(ops[0].target).toBe("files")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.id).toBe("a")
      expect(ops[0].row.name).toBe("file-a.txt")
      expect(ops[0].row.size).toBe(100)
      expect(ops[0].row.type).toBe("text/plain")
    }
  })

  test("soft-delete tombstone (deletedAt flips on) emits upsert, not delete", () => {
    const ops = diffFiles(
      [make("a")],
      [make("a", { deletedAt: new Date("2026-05-23T02:00:00Z") })]
    )
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("upsert")
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.deleted_at).toBeTypeOf("string")
    }
  })

  test("hard delete when a file vanishes from the next array", () => {
    const ops = diffFiles([make("a"), make("b")], [make("a")])
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe("delete")
    if (ops[0].kind === "delete") {
      expect(ops[0].where).toEqual({ column: "id", value: "b" })
    }
  })

  test("extraction-complete (status + text) triggers an upsert", () => {
    const a = [make("a", { extractionStatus: "pending" })]
    const b = [
      make("a", {
        extractionStatus: "done",
        extractedText: "hello world",
        extractedKind: "text",
      }),
    ]
    const ops = diffFiles(a, b)
    expect(ops).toHaveLength(1)
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.extraction_status).toBe("done")
      expect(ops[0].row.extracted_text).toBe("hello world")
    }
  })

  test("storagePath set on upload sends through", () => {
    const ops = diffFiles(
      [make("a")],
      [make("a", { storagePath: "user/abc/file-a.txt" })]
    )
    expect(ops).toHaveLength(1)
    if (ops[0].kind === "upsert") {
      expect(ops[0].row.storage_path).toBe("user/abc/file-a.txt")
    }
  })
})

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { IDBFactory } from "fake-indexeddb"

import type { UploadedFile } from "@/shared/types"

import {
  __resetFileBlobFieldsForTests,
  clearAllFileBlobFields,
  clearFileBlobFields,
  deleteFileBlobFields,
  getFileBlobFields,
  getFileImageDataUrls,
  isFileBlobDurable,
  loadFileBlobFieldsMap,
  offloadFileBlobs,
  peekFileBlobFields,
  stripDurableBlobFields,
  stripDurableBlobFieldsAll,
} from "./blob-fields"
import { __setIndexedDBFactoryForTests } from "./idb"

const IMG = "data:image/png;base64," + "A".repeat(1000)
const FULL = "full text ".repeat(500)

function file(over: Partial<UploadedFile> = {}): UploadedFile {
  return {
    id: "f1",
    name: "a.png",
    size: 10,
    type: "image/png",
    uploadedAt: new Date(0),
    ...over,
  }
}

beforeEach(() => {
  __resetFileBlobFieldsForTests()
  __setIndexedDBFactoryForTests(new IDBFactory())
})

afterEach(() => {
  __setIndexedDBFactoryForTests(undefined)
  __resetFileBlobFieldsForTests()
})

/** Fresh session (as after a reload) over the same IndexedDB. */
function simulateReload(): void {
  __resetFileBlobFieldsForTests()
}

describe("offload + durable stripping", () => {
  test("a field is stripped from the persisted row only after IndexedDB commits it", async () => {
    const f = file({ imageDataUrl: IMG })
    // Before the write: the row persists unchanged (no data loss window).
    expect(stripDurableBlobFields(f)).toBe(f)
    expect(isFileBlobDurable(f)).toBe(false)

    expect(await offloadFileBlobs([f])).toBe(true)

    expect(isFileBlobDurable(f)).toBe(true)
    const stripped = stripDurableBlobFields(f)
    expect(stripped.imageDataUrl).toBeUndefined()
    expect(stripped.id).toBe("f1")
    // Memoised per row object.
    expect(stripDurableBlobFields(f)).toBe(stripped)
  })

  test("a second offload of the same values is a no-op", async () => {
    const f = file({ extractedFullText: FULL })
    expect(await offloadFileBlobs([f])).toBe(true)
    expect(await offloadFileBlobs([f])).toBe(false)
  })

  test("a changed value is not stripped until the new value is durable", async () => {
    const f = file({ extractedFullText: FULL })
    await offloadFileBlobs([f])
    const g = { ...f, extractedFullText: FULL + " v2" }
    expect(stripDurableBlobFields(g)).toBe(g)
    await offloadFileBlobs([g])
    expect(stripDurableBlobFields(g).extractedFullText).toBeUndefined()
  })

  test("IndexedDB unavailable (private mode): rows keep their fields in localStorage", async () => {
    __setIndexedDBFactoryForTests(null)
    const f = file({ imageDataUrl: IMG })
    expect(await offloadFileBlobs([f])).toBe(false)
    expect(stripDurableBlobFields(f)).toBe(f)
    // Still readable in-session through the accessor.
    expect((await getFileBlobFields({ id: "f1" })).imageDataUrl).toBe(IMG)
  })

  test("stripDurableBlobFieldsAll returns the same array when nothing to strip, memoises, and re-strips after the ledger changes", async () => {
    const plain = file({ id: "p" })
    const withImg = file({ id: "i", imageDataUrl: IMG })
    const files = [plain, withImg]
    expect(stripDurableBlobFieldsAll(files)).toBe(files)
    await offloadFileBlobs(files)
    const out = stripDurableBlobFieldsAll(files)
    expect(out).not.toBe(files)
    expect(out[0]).toBe(plain)
    expect(out[1].imageDataUrl).toBeUndefined()
    expect(stripDurableBlobFieldsAll(files)).toBe(out)
  })

  test("tombstoned rows are never offloaded", async () => {
    const f = file({ imageDataUrl: IMG, deletedAt: new Date() })
    expect(await offloadFileBlobs([f])).toBe(false)
  })
})

describe("async accessors", () => {
  test("after a reload, values come back from IndexedDB for the stripped row", async () => {
    await offloadFileBlobs([
      file({ id: "img", imageDataUrl: IMG }),
      file({ id: "doc", extractedFullText: FULL }),
    ])
    simulateReload()

    expect(peekFileBlobFields({ id: "img" })).toBeUndefined()
    expect(await getFileBlobFields({ id: "img" })).toEqual({ imageDataUrl: IMG })
    expect(peekFileBlobFields({ id: "img" })).toEqual({ imageDataUrl: IMG })
    expect(await getFileBlobFields({ id: "doc" })).toEqual({ extractedFullText: FULL })
    expect(await getFileBlobFields({ id: "none" })).toEqual({})

    const urls = await getFileImageDataUrls([{ id: "doc" }, { id: "img" }, { id: "none" }])
    expect(urls).toEqual([IMG])

    const map = await loadFileBlobFieldsMap([{ id: "doc" }, { id: "img" }])
    expect(map.get("doc")?.extractedFullText).toBe(FULL)
    expect(map.get("img")?.imageDataUrl).toBe(IMG)
  })

  test("values read back from IndexedDB count as durable (no rewrite needed)", async () => {
    await offloadFileBlobs([file({ imageDataUrl: IMG })])
    simulateReload()
    const row = file({ imageDataUrl: IMG }) // e.g. merged in from another tab
    await getFileBlobFields(row)
    expect(isFileBlobDurable(row)).toBe(true)
  })

  test("the row's own in-memory value wins over the stored one", async () => {
    await offloadFileBlobs([file({ imageDataUrl: IMG })])
    simulateReload()
    const fresh = "data:image/png;base64,NEW"
    expect((await getFileBlobFields({ id: "f1", imageDataUrl: fresh })).imageDataUrl).toBe(fresh)
  })

  test("both fields are merged in one record", async () => {
    await offloadFileBlobs([file({ imageDataUrl: IMG })])
    await offloadFileBlobs([file({ extractedFullText: FULL })])
    simulateReload()
    expect(await getFileBlobFields({ id: "f1" })).toEqual({
      imageDataUrl: IMG,
      extractedFullText: FULL,
    })
  })
})

describe("clearing + cascade deletes", () => {
  test("clearFileBlobFields drops just that field, in memory and in IndexedDB", async () => {
    await offloadFileBlobs([file({ imageDataUrl: IMG, extractedFullText: FULL })])
    await clearFileBlobFields("f1", ["extractedFullText"])
    expect(peekFileBlobFields({ id: "f1" })).toEqual({ imageDataUrl: IMG })
    simulateReload()
    expect(await getFileBlobFields({ id: "f1" })).toEqual({ imageDataUrl: IMG })
  })

  test("deleteFileBlobFields removes the record, and a late offload can't resurrect it", async () => {
    const f = file({ imageDataUrl: IMG })
    const pending = offloadFileBlobs([f]) // queued before the delete
    await deleteFileBlobFields("f1")
    await pending
    expect(await offloadFileBlobs([f])).toBe(false)
    expect(await getFileBlobFields({ id: "f1" })).toEqual({})
    simulateReload()
    expect(await getFileBlobFields({ id: "f1" })).toEqual({})
  })

  test("clearAllFileBlobFields wipes every record", async () => {
    await offloadFileBlobs([
      file({ id: "a", imageDataUrl: IMG }),
      file({ id: "b", extractedFullText: FULL }),
    ])
    await clearAllFileBlobFields()
    simulateReload()
    expect(await getFileBlobFields({ id: "a" })).toEqual({})
    expect(await getFileBlobFields({ id: "b" })).toEqual({})
  })
})

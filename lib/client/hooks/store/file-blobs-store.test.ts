/**
 * Store-level coverage for the v32 move of `imageDataUrl` /
 * `extractedFullText` out of localStorage (`client/files/blob-fields.ts`):
 * the migration step + post-hydration offload, and the cascade deletes
 * from file / conversation / workspace removal.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { IDBFactory } from "fake-indexeddb"

import {
  __resetFileBlobFieldsForTests,
  getFileBlobFields,
  offloadFileBlobs,
} from "@/client/files/blob-fields"
import { __setIndexedDBFactoryForTests } from "@/client/files/idb"
import { useStore, type AppState, type UploadedFile } from "@/client/hooks/use-store"

import { runMigrations, STORE_VERSION } from "./migrate"
import { partializeState } from "./persist"

const IMG = "data:image/jpeg;base64," + "B".repeat(4096)
const FULL = "lorem ipsum ".repeat(1000)

/** Let fire-and-forget IndexedDB work (fake-indexeddb schedules on
 *  timers) settle. */
const settle = () => new Promise((r) => setTimeout(r, 30))

/** What a fresh page load sees: the module's session state is gone,
 *  IndexedDB is not. */
const reload = () => __resetFileBlobFieldsForTests()

function legacyRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "f",
    name: "x",
    size: 1,
    type: "image/jpeg",
    uploadedAt: new Date(0).toISOString(),
    ...over,
  }
}

beforeEach(() => {
  __resetFileBlobFieldsForTests()
  __setIndexedDBFactoryForTests(new IDBFactory())
})

afterEach(async () => {
  await settle()
  __setIndexedDBFactoryForTests(undefined)
  __resetFileBlobFieldsForTests()
})

describe("v32 migration — blobs to IndexedDB", () => {
  test("STORE_VERSION is 32", () => {
    expect(STORE_VERSION).toBe(32)
  })

  test("the step keeps legacy blob values on the rows (they are the pending stash) and drops junk", () => {
    const out = runMigrations(
      {
        files: [
          legacyRow({ id: "img", imageDataUrl: IMG }),
          legacyRow({ id: "doc", extractedFullText: FULL }),
          legacyRow({ id: "junk", imageDataUrl: "", extractedFullText: 42 }),
          null,
        ],
      },
      31
    ) as { files: Array<Record<string, unknown> | null> }
    expect(out.files[0]?.imageDataUrl).toBe(IMG)
    expect(out.files[1]?.extractedFullText).toBe(FULL)
    expect("imageDataUrl" in (out.files[2] ?? {})).toBe(false)
    expect("extractedFullText" in (out.files[2] ?? {})).toBe(false)
    expect(out.files[3]).toBeNull()
  })

  test("end to end: migrate → offload → persisted shape drops blobs; they reload from IndexedDB", async () => {
    const migrated = runMigrations(
      {
        files: [
          legacyRow({ id: "img", imageDataUrl: IMG }),
          legacyRow({ id: "doc", extractedFullText: FULL }),
        ],
      },
      31
    ) as { files: UploadedFile[] }
    const state = { ...useStore.getState(), files: migrated.files } as AppState

    // Before the async offload commits, nothing is stripped.
    const before = partializeState(state).files
    expect(before[0].imageDataUrl).toBe(IMG)
    expect(before[1].extractedFullText).toBe(FULL)

    expect(await offloadFileBlobs(state.files)).toBe(true)

    const after = partializeState(state).files
    expect(after[0].imageDataUrl).toBeUndefined()
    expect(after[1].extractedFullText).toBeUndefined()
    expect(JSON.stringify(after).length).toBeLessThan(1000)

    reload()
    expect((await getFileBlobFields({ id: "img" })).imageDataUrl).toBe(IMG)
    expect((await getFileBlobFields({ id: "doc" })).extractedFullText).toBe(FULL)
  })

  test("IndexedDB unavailable: the blobs stay in the persisted state (no data loss)", async () => {
    __setIndexedDBFactoryForTests(null)
    const migrated = runMigrations(
      { files: [legacyRow({ id: "img", imageDataUrl: IMG })] },
      31
    ) as { files: UploadedFile[] }
    const state = { ...useStore.getState(), files: migrated.files } as AppState
    expect(await offloadFileBlobs(state.files)).toBe(false)
    expect(partializeState(state).files[0].imageDataUrl).toBe(IMG)
  })
})

describe("store wiring", () => {
  test("setting a blob field on a file offloads it and the persisted row drops it", async () => {
    const s = useStore.getState()
    s.addFile({ id: "up1", name: "p.png", size: 1, type: "image/png", uploadedAt: new Date() })
    s.setFileExtraction("up1", { extractionStatus: "done", extractedKind: "image", imageDataUrl: IMG })
    await settle()
    const row = partializeState(useStore.getState()).files.find((f) => f.id === "up1")
    expect(row?.extractedKind).toBe("image")
    expect(row?.imageDataUrl).toBeUndefined()
    reload()
    expect((await getFileBlobFields({ id: "up1" })).imageDataUrl).toBe(IMG)
  })

  test("a patch that clears extractedFullText clears the IndexedDB copy", async () => {
    const s = useStore.getState()
    s.addFile({ id: "re1", name: "a.pdf", size: 1, type: "application/pdf", uploadedAt: new Date() })
    s.setFileExtraction("re1", { extractedText: "short", extractedFullText: FULL })
    await settle()
    s.setFileExtraction("re1", { extractedText: "short", extractedFullText: undefined })
    await settle()
    reload()
    expect(await getFileBlobFields({ id: "re1" })).toEqual({})
  })
})

describe("cascade deletes", () => {
  async function seedFile(id: string): Promise<void> {
    useStore.getState().addFile({
      id,
      name: `${id}.png`,
      size: 1,
      type: "image/png",
      uploadedAt: new Date(),
      extractedKind: "image",
      imageDataUrl: IMG,
    })
    await settle()
    reload()
    expect((await getFileBlobFields({ id })).imageDataUrl).toBe(IMG)
  }

  async function expectGone(id: string): Promise<void> {
    await settle()
    reload()
    expect(await getFileBlobFields({ id })).toEqual({})
  }

  test("removeFile deletes the file's IndexedDB blobs", async () => {
    await seedFile("rm1")
    useStore.getState().removeFile("rm1")
    await expectGone("rm1")
  })

  test("deleteConversation deletes blobs of files only it referenced", async () => {
    await seedFile("cv1")
    const conv = useStore.getState().createConversation()
    useStore.getState().addConversationFile(conv.id, "cv1")
    useStore.getState().deleteConversation(conv.id)
    expect(useStore.getState().files.find((f) => f.id === "cv1")?.deletedAt).toBeDefined()
    await expectGone("cv1")
  })

  test("deleteWorkspace deletes blobs of its library files", async () => {
    const ws = useStore.getState().createWorkspace("doomed-blobs")
    await seedFile("ws1")
    useStore.getState().addResource(ws.id, "ws1")
    useStore.getState().deleteWorkspace(ws.id)
    expect(useStore.getState().files.find((f) => f.id === "ws1")?.deletedAt).toBeDefined()
    await expectGone("ws1")
  })

  test("clearFiles wipes every file's blobs", async () => {
    await seedFile("cl1")
    await seedFile("cl2")
    useStore.getState().clearFiles()
    await expectGone("cl1")
    await expectGone("cl2")
  })
})

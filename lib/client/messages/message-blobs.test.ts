import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { IDBFactory } from "fake-indexeddb"

import type { Conversation, GeneratedFile, GeneratedImage, Message } from "@/shared/types"
import {
  canonicalBlobItems,
  isMessageBlobRef,
  messageBlobKey,
  messageBlobRef,
} from "@/shared/message-blob-ref"

import { __setIndexedDBFactoryForTests } from "../files/idb"
import {
  __flushMessageBlobOpsForTests,
  __resetMessageBlobsForTests,
  collectMessageBlobKeys,
  deleteMessageBlobs,
  isMessageBlobDurable,
  isMessageBlobMissing,
  offloadMessageBlobs,
  peekMessageBlobUrl,
  prepareMessageRowForUpload,
  primeMessageBlobCache,
  removedMessageBlobKeys,
  resolveMessageBlobUrl,
  stripDurableMessageBlobs,
} from "./message-blobs"

const IMG = "data:image/png;base64," + "A".repeat(2048)
const IMG2 = "data:image/png;base64," + "C".repeat(2048)
const CSV = "data:text/csv;base64," + "B".repeat(512)
const SIGNED = "https://example.supabase.co/storage/v1/object/sign/x.png?token=t"

function image(id: string, url: string, over: Partial<GeneratedImage> = {}): GeneratedImage {
  return { id, url, width: 1, height: 1, format: "png", prompt: "p", mode: "t2i", ...over }
}

function genFile(id: string, url: string): GeneratedFile {
  return { id, name: `${id}.csv`, sizeBytes: 3, mimeType: "text/csv", url, storagePath: null }
}

function msg(id: string, over: Partial<Message> = {}): Message {
  return { id, role: "assistant", content: id, timestamp: new Date(0), ...over }
}

function conv(id: string, messages: Message[]): Conversation {
  return {
    id,
    workspaceId: "ws",
    title: id,
    messages,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    pinned: false,
    systemPrompt: "",
    selectedFileIds: [],
  } as Conversation
}

/** A fresh page load: module session state gone, IndexedDB kept. */
const reload = () => __resetMessageBlobsForTests()

beforeEach(() => {
  __resetMessageBlobsForTests()
  __setIndexedDBFactoryForTests(new IDBFactory())
})

afterEach(async () => {
  await __flushMessageBlobOpsForTests()
  __setIndexedDBFactoryForTests(undefined)
  __resetMessageBlobsForTests()
})

describe("shared refs", () => {
  test("canonical form maps inline data: URLs to their key's reference, leaves others", () => {
    const items = [image("i1", IMG), image("i2", SIGNED), image("i3", messageBlobRef("src/i3"))]
    const out = canonicalBlobItems("m1", items)
    expect(out[0].url).toBe(messageBlobRef("m1/i1"))
    expect(out[1].url).toBe(SIGNED)
    expect(out[2].url).toBe(messageBlobRef("src/i3"))
    // No inline payload → same array back.
    expect(canonicalBlobItems("m1", [items[1]])).toEqual([items[1]])
  })
})

describe("offload + strip-after-confirm", () => {
  test("nothing is stripped before IndexedDB confirms; afterwards data: URLs become refs", async () => {
    const convs = [
      conv("c1", [
        msg("m1", {
          generatedImages: [image("i1", IMG), image("i2", SIGNED)],
          generatedFiles: [genFile("f1", CSV)],
        }),
      ]),
    ]
    // Before the offload: the persisted copy keeps the payloads verbatim.
    expect(stripDurableMessageBlobs(convs)).toBe(convs)

    const pending = offloadMessageBlobs(convs)
    // Still not durable mid-write.
    expect(stripDurableMessageBlobs(convs)).toBe(convs)
    expect(await pending).toBe(true)

    const stripped = stripDurableMessageBlobs(convs)
    const m = stripped[0].messages[0]
    expect(m.generatedImages?.[0].url).toBe(messageBlobRef("m1/i1"))
    // Signed URLs are left alone.
    expect(m.generatedImages?.[1].url).toBe(SIGNED)
    expect(m.generatedFiles?.[0].url).toBe(messageBlobRef("m1/f1"))
    // The in-memory rows are never mutated.
    expect(convs[0].messages[0].generatedImages?.[0].url).toBe(IMG)
    // Memoised: same output for the same input.
    expect(stripDurableMessageBlobs(convs)).toBe(stripped)
  })

  test("IndexedDB unavailable → nothing becomes durable, payloads stay in the persisted copy", async () => {
    __setIndexedDBFactoryForTests(null)
    const convs = [conv("c1", [msg("m1", { generatedImages: [image("i1", IMG)] })])]
    expect(await offloadMessageBlobs(convs)).toBe(false)
    expect(isMessageBlobDurable("m1/i1", IMG)).toBe(false)
    expect(stripDurableMessageBlobs(convs)).toBe(convs)
    // Still readable from the session cache.
    expect(await resolveMessageBlobUrl(messageBlobRef("m1/i1"))).toBe(IMG)
  })

  test("a changed value is not stripped until the new value is durable", async () => {
    const a = [conv("c1", [msg("m1", { generatedImages: [image("i1", IMG)] })])]
    await offloadMessageBlobs(a)
    const b = [conv("c1", [msg("m1", { generatedImages: [image("i1", IMG2)] })])]
    expect(stripDurableMessageBlobs(b)[0].messages[0].generatedImages?.[0].url).toBe(IMG2)
    await offloadMessageBlobs(b)
    expect(stripDurableMessageBlobs(b)[0].messages[0].generatedImages?.[0].url).toBe(
      messageBlobRef("m1/i1")
    )
  })
})

describe("read side", () => {
  test("after a reload a reference resolves from IndexedDB through the session cache", async () => {
    await offloadMessageBlobs([conv("c1", [msg("m1", { generatedImages: [image("i1", IMG)] })])])
    reload()
    const ref = messageBlobRef("m1/i1")
    expect(peekMessageBlobUrl(ref)).toBeUndefined()
    expect(await resolveMessageBlobUrl(ref)).toBe(IMG)
    expect(peekMessageBlobUrl(ref)).toBe(IMG)
    // Plain URLs pass through untouched.
    expect(await resolveMessageBlobUrl(SIGNED)).toBe(SIGNED)
  })

  test("an unknown reference resolves to undefined and is flagged missing", async () => {
    const ref = messageBlobRef("nope/x")
    expect(await resolveMessageBlobUrl(ref)).toBeUndefined()
    expect(isMessageBlobMissing("nope/x")).toBe(true)
    // "No record" is final: not un-marked for a retry.
    await new Promise((r) => setTimeout(r, 1_100))
    expect(isMessageBlobMissing("nope/x")).toBe(true)
  })

  test("a key missing because IndexedDB was unusable is retried once it recovers", async () => {
    const factory = new IDBFactory()
    __setIndexedDBFactoryForTests(factory)
    await offloadMessageBlobs([conv("c1", [msg("m1", { generatedImages: [image("i1", IMG)] })])])
    await __flushMessageBlobOpsForTests()
    reload()
    const ref = messageBlobRef("m1/i1")
    // Connection unusable (e.g. Safari dropped it) → reads as missing…
    __setIndexedDBFactoryForTests(null)
    expect(await resolveMessageBlobUrl(ref)).toBeUndefined()
    expect(isMessageBlobMissing("m1/i1")).toBe(true)
    // …IndexedDB comes back; after the backoff the key is un-marked so
    // readers ask again, and the read succeeds.
    __setIndexedDBFactoryForTests(factory)
    await new Promise((r) => setTimeout(r, 1_100))
    expect(isMessageBlobMissing("m1/i1")).toBe(false)
    expect(await resolveMessageBlobUrl(ref)).toBe(IMG)
  })

  test("primeMessageBlobCache makes inline values resolvable without IndexedDB", async () => {
    __setIndexedDBFactoryForTests(null)
    primeMessageBlobCache([conv("c1", [msg("m1", { generatedFiles: [genFile("f1", CSV)] })])])
    expect(await resolveMessageBlobUrl(messageBlobRef("m1/f1"))).toBe(CSV)
  })
})

describe("prepareMessageRowForUpload — never sends a placeholder", () => {
  const row = (images: unknown, files: unknown = null) => ({
    id: "m1",
    conversation_id: "c1",
    content: "x",
    generated_images: images,
    generated_files: files,
  })

  test("references are resolved back to the real data: URLs", async () => {
    await offloadMessageBlobs([
      conv("c1", [msg("m1", { generatedImages: [image("i1", IMG)], generatedFiles: [genFile("f1", CSV)] })]),
    ])
    reload() // force the IndexedDB path
    const out = await prepareMessageRowForUpload(
      row(
        [image("i1", messageBlobRef("m1/i1")), image("i2", SIGNED)],
        [genFile("f1", messageBlobRef("m1/f1"))]
      )
    )
    expect((out.generated_images as GeneratedImage[]).map((i) => i.url)).toEqual([IMG, SIGNED])
    expect((out.generated_files as GeneratedFile[])[0].url).toBe(CSV)
    expect(JSON.stringify(out)).not.toContain("hb-blob:")
  })

  test("an unresolvable reference drops ONLY that column (no null, no partial list)", async () => {
    await offloadMessageBlobs([conv("c1", [msg("m1", { generatedFiles: [genFile("f1", CSV)] })])])
    reload()
    const out = await prepareMessageRowForUpload(
      row(
        [image("gone", messageBlobRef("m1/gone")), image("i2", SIGNED)],
        [genFile("f1", messageBlobRef("m1/f1"))]
      )
    )
    expect("generated_images" in out).toBe(false)
    expect((out.generated_files as GeneratedFile[])[0].url).toBe(CSV)
    expect(out.content).toBe("x")
    expect(JSON.stringify(out)).not.toContain("hb-blob:")
  })

  test("rows without references come back untouched (same object)", async () => {
    const r = row([image("i2", SIGNED)])
    expect(await prepareMessageRowForUpload(r)).toBe(r)
    const empty = row(null)
    expect(await prepareMessageRowForUpload(empty)).toBe(empty)
  })
})

describe("cascade deletes", () => {
  test("removedMessageBlobKeys: deleted message's keys, but not keys a fork still references", () => {
    const src = conv("c1", [
      msg("m1", { generatedImages: [image("i1", IMG)] }),
      msg("m2", { generatedFiles: [genFile("f1", messageBlobRef("m2/f1"))] }),
    ])
    // A fork copied m1 with a reference to the source key.
    const fork = conv("c2", [msg("m1-copy", { generatedImages: [image("i1", messageBlobRef("m1/i1"))] })])
    expect([...collectMessageBlobKeys(src)].sort()).toEqual(["m1/i1", "m2/f1"])

    const prev = [src, fork]
    // Delete the source conversation: m2/f1 orphaned, m1/i1 still referenced.
    expect(removedMessageBlobKeys(prev, [fork])).toEqual(["m2/f1"])
    // Delete the fork too: m1/i1 goes.
    expect(removedMessageBlobKeys([fork], [])).toEqual(["m1/i1"])
    // An unrelated change orphans nothing.
    expect(removedMessageBlobKeys(prev, [{ ...src, title: "t" }, fork])).toEqual([])
  })

  test("deleteMessageBlobs removes the record; a write queued earlier can't resurrect it", async () => {
    const convs = [conv("c1", [msg("m1", { generatedImages: [image("i1", IMG)] })])]
    const write = offloadMessageBlobs(convs)
    const del = deleteMessageBlobs([messageBlobKey("m1", "i1")])
    await Promise.all([write, del])
    expect(isMessageBlobDurable("m1/i1", IMG)).toBe(false)
    // The persisted copy keeps the inline value (never stripped).
    expect(stripDurableMessageBlobs(convs)).toBe(convs)
    reload()
    expect(await resolveMessageBlobUrl(messageBlobRef("m1/i1"))).toBeUndefined()
  })

  test("a key seen live again after a delete is re-stored", async () => {
    await deleteMessageBlobs(["m1/i1"])
    const convs = [conv("c1", [msg("m1", { generatedImages: [image("i1", IMG)] })])]
    expect(await offloadMessageBlobs(convs)).toBe(true)
    reload()
    expect(await resolveMessageBlobUrl(messageBlobRef("m1/i1"))).toBe(IMG)
  })
})

test("isMessageBlobRef only matches the placeholder scheme", () => {
  expect(isMessageBlobRef(messageBlobRef("a/b"))).toBe(true)
  expect(isMessageBlobRef(IMG)).toBe(false)
  expect(isMessageBlobRef(SIGNED)).toBe(false)
})

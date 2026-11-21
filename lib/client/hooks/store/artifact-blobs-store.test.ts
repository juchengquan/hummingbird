/**
 * Store v34: image / file artifacts created from generated items reference
 * the item's bytes in the message-blob IndexedDB store instead of copying
 * the `data:` URL into `storagePath` (`client/messages/message-blobs.ts`,
 * artifact section). Covers the migration + offload (with dedupe), the
 * persisted shape, reference counting across message + artifact, the sync
 * side (diff, queue flush, bulk upload, pull merge) and the readers'
 * resolver.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { IDBFactory } from "fake-indexeddb"

import {
  artifactMarkdownForEditor,
  resolveArtifactAssetUrl,
} from "@/client/artifacts/artifact-asset"
import { __setIndexedDBFactoryForTests } from "@/client/files/idb"
import {
  __flushMessageBlobOpsForTests,
  __resetMessageBlobsForTests,
  artifactStoragePathFor,
  offloadArtifactBlobs,
  offloadMessageBlobs,
  primeMessageBlobCache,
  removedBlobKeys,
  resolveMessageBlobUrl,
  type ArtifactRefRewrite,
} from "@/client/messages/message-blobs"
import type { AppSupabaseClient } from "@/client/supabase/client"
import type { SyncSnapshot } from "@/client/sync/compute-sync-ops"
import { diffArtifacts } from "@/client/sync/handlers"
import { bulkUploadLocalState, type CloudSnapshot } from "@/client/sync/reconcile"
import { mergeCloudSnapshot } from "@/client/sync/snapshot-merge"
import {
  configureSync,
  enqueue,
  resetSyncQueue,
  takeRecentlyDroppedOps,
  whenDrained,
} from "@/client/sync/sync-queue"
import { useStore, type AppState } from "@/client/hooks/use-store"
import { artifactBlobKey, messageBlobRef } from "@/shared/message-blob-ref"
import type { Artifact, Conversation, GeneratedImage, Message } from "@/shared/types"

import { runMigrations, STORE_VERSION } from "./migrate"
import { partializeState } from "./persist"

const IMG = "data:image/png;base64," + "Q".repeat(8192)
const OTHER = "data:image/png;base64," + "R".repeat(4096)
const SIGNED = "https://example.supabase.co/storage/v1/object/sign/a.png?token=t"

const settle = async () => {
  await new Promise((r) => setTimeout(r, 30))
  await __flushMessageBlobOpsForTests()
}
/** A fresh page load: module session state gone, IndexedDB kept. */
const reload = () => __resetMessageBlobsForTests()

function image(id: string, url: string): GeneratedImage {
  return { id, url, width: 1, height: 1, format: "png", prompt: "cat", mode: "t2i" }
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
function art(id: string, over: Partial<Artifact> = {}): Artifact {
  return {
    id,
    workspaceId: "ws",
    conversationId: "c",
    messageId: "m",
    kind: "image",
    language: null,
    title: "cat",
    content: "cat",
    storagePath: null,
    pinned: false,
    createdAt: new Date(0),
    ...over,
  }
}

/** A rewrite callback over a plain array (stands in for the store). */
function arrayRewrite(list: Artifact[]): ArtifactRefRewrite {
  return (id, value, ref) => {
    const i = list.findIndex((a) => a.id === id && a.storagePath === value)
    if (i === -1) return false
    list[i] = { ...list[i], storagePath: ref }
    return true
  }
}

beforeEach(() => {
  __resetMessageBlobsForTests()
  __setIndexedDBFactoryForTests(new IDBFactory())
})

afterEach(async () => {
  await settle()
  __setIndexedDBFactoryForTests(undefined)
  __resetMessageBlobsForTests()
})

// ---------------------------------------------------------------------------
// Migration + offload
// ---------------------------------------------------------------------------

describe("v34 migration — artifact blobs", () => {
  test("STORE_VERSION includes the v34 step", () => {
    expect(STORE_VERSION).toBeGreaterThanOrEqual(34)
  })

  test("an exact duplicate of an inline source item is pointed at the item's key; the rest is left for the offload", () => {
    const out = runMigrations(
      {
        conversations: [
          conv("c", [msg("m", { generatedImages: [image("i1", IMG), image("i2", SIGNED)] })]),
        ],
        artifacts: [
          art("dup", { storagePath: IMG }),
          art("unmatched", { storagePath: OTHER }),
          art("signed", { storagePath: SIGNED }),
          art("orphan", { messageId: null, storagePath: IMG }),
          art("junk", { storagePath: 42 as unknown as string }),
          art("code", { kind: "code", storagePath: null }),
        ],
      },
      33
    ) as { artifacts: Artifact[] }
    const byId = new Map(out.artifacts.map((a) => [a.id, a.storagePath]))
    expect(byId.get("dup")).toBe(messageBlobRef("m/i1"))
    expect(byId.get("unmatched")).toBe(OTHER)
    expect(byId.get("signed")).toBe(SIGNED)
    expect(byId.get("orphan")).toBe(IMG)
    expect(byId.get("junk")).toBeNull()
    expect(byId.get("code")).toBeNull()
  })

  test("end to end: migrate → persisted copy stays inline until IndexedDB confirms → then one shared record", async () => {
    const migrated = runMigrations(
      {
        conversations: [conv("c", [msg("m-e2e", { generatedImages: [image("i1", IMG)] })])],
        artifacts: [art("a-e2e", { messageId: "m-e2e", storagePath: IMG })],
      },
      33
    ) as { conversations: Conversation[]; artifacts: Artifact[] }
    expect(migrated.artifacts[0].storagePath).toBe(messageBlobRef("m-e2e/i1"))
    const state = {
      ...useStore.getState(),
      conversations: migrated.conversations,
      artifacts: migrated.artifacts,
    } as AppState
    primeMessageBlobCache(state.conversations) // what hydration does

    // Before IndexedDB confirms, the artifact persists its bytes inline:
    // a failed write can never leave only a dangling reference.
    expect(partializeState(state).artifacts[0].storagePath).toBe(IMG)

    expect(await offloadMessageBlobs(state.conversations)).toBe(true)
    const persisted = partializeState(state)
    expect(persisted.artifacts[0].storagePath).toBe(messageBlobRef("m-e2e/i1"))
    expect(persisted.conversations[0].messages[0].generatedImages?.[0].url).toBe(
      messageBlobRef("m-e2e/i1")
    )
    expect(JSON.stringify(persisted.artifacts).length).toBeLessThan(1000)

    reload()
    expect(await resolveMessageBlobUrl(persisted.artifacts[0].storagePath!)).toBe(IMG)
  })

  test("dedupe: a legacy inline artifact whose source item is already a stored ref shares that record", async () => {
    await offloadMessageBlobs([conv("c", [msg("m", { generatedImages: [image("i1", IMG)] })])])
    reload() // source item now carries a ref; bytes only in IndexedDB
    const conversations = [
      conv("c", [msg("m", { generatedImages: [image("i1", messageBlobRef("m/i1"))] })]),
    ]
    const artifacts = [art("legacy", { storagePath: IMG })]
    expect(await offloadArtifactBlobs(artifacts, conversations, arrayRewrite(artifacts))).toBe(1)
    expect(artifacts[0].storagePath).toBe(messageBlobRef("m/i1"))
    // No second copy was written.
    reload()
    expect(await resolveMessageBlobUrl(messageBlobRef(artifactBlobKey("legacy")))).toBeUndefined()
    expect(await resolveMessageBlobUrl(artifacts[0].storagePath!)).toBe(IMG)
  })

  test("no matching item: the bytes get the artifact's own record", async () => {
    const artifacts = [art("solo", { messageId: null, storagePath: OTHER })]
    expect(await offloadArtifactBlobs(artifacts, [], arrayRewrite(artifacts))).toBe(1)
    expect(artifacts[0].storagePath).toBe(messageBlobRef(artifactBlobKey("solo")))
    reload()
    expect(await resolveMessageBlobUrl(artifacts[0].storagePath!)).toBe(OTHER)
  })

  test("IndexedDB unavailable: the artifact stays inline, in memory and persisted", async () => {
    __setIndexedDBFactoryForTests(null)
    const artifacts = [art("noidb", { messageId: null, storagePath: OTHER })]
    expect(await offloadArtifactBlobs(artifacts, [], arrayRewrite(artifacts))).toBe(0)
    expect(artifacts[0].storagePath).toBe(OTHER)
    const state = { ...useStore.getState(), artifacts } as AppState
    expect(partializeState(state).artifacts[0].storagePath).toBe(OTHER)
  })

  test("IndexedDB unavailable: a reference created from an item is persisted inflated", async () => {
    __setIndexedDBFactoryForTests(null)
    const conversations = [conv("c", [msg("m", { generatedImages: [image("i1", IMG)] })])]
    await offloadMessageBlobs(conversations) // primes the cache, write fails
    const ref = artifactStoragePathFor("m", image("i1", IMG))
    expect(ref).toBe(messageBlobRef("m/i1"))
    const state = {
      ...useStore.getState(),
      conversations,
      artifacts: [art("a", { storagePath: ref })],
    } as AppState
    expect(partializeState(state).artifacts[0].storagePath).toBe(IMG)
  })

  test("artifactStoragePathFor only references bytes the session actually holds", () => {
    // Not on any message / not offloaded → keep the inline value.
    expect(artifactStoragePathFor("m", image("i1", IMG))).toBe(IMG)
    expect(artifactStoragePathFor("m", image("i2", SIGNED))).toBe(SIGNED)
  })
})

// ---------------------------------------------------------------------------
// Store wiring + reference counting
// ---------------------------------------------------------------------------

function seed(workspaceId?: string): { convId: string; messageId: string; artifactId: string } {
  const s = useStore.getState()
  const c = s.createConversation(workspaceId)
  const m = s.addMessage({ role: "assistant", content: "here" }, c.id)
  const img = image("img", IMG)
  s.appendMessageGeneratedImages(m.id, [img])
  const a = s.createArtifact({
    conversationId: c.id,
    messageId: m.id,
    kind: "image",
    title: "cat",
    content: "cat",
    storagePath: artifactStoragePathFor(m.id, img),
  })
  return { convId: c.id, messageId: m.id, artifactId: a.id }
}

async function bytesAt(key: string): Promise<string | undefined> {
  await settle()
  reload()
  return resolveMessageBlobUrl(messageBlobRef(key))
}

describe("store wiring", () => {
  test("a generated image's artifact references the item: one IndexedDB record, no copy in localStorage", async () => {
    const { messageId, artifactId } = seed()
    const live = useStore.getState().artifacts.find((a) => a.id === artifactId)!
    expect(live.storagePath).toBe(messageBlobRef(`${messageId}/img`))
    await settle()
    const persisted = partializeState(useStore.getState())
    const pa = persisted.artifacts.find((a) => a.id === artifactId)!
    expect(pa.storagePath).toBe(messageBlobRef(`${messageId}/img`))
    expect(JSON.stringify(persisted.artifacts)).not.toContain("base64")
    expect(await bytesAt(`${messageId}/img`)).toBe(IMG)
  })

  test("a legacy inline artifact in the store is rewritten to the shared ref after the write", async () => {
    const s = useStore.getState()
    const c = s.createConversation()
    const m = s.addMessage({ role: "assistant", content: "x" }, c.id)
    s.appendMessageGeneratedImages(m.id, [image("img", IMG)])
    const a = s.createArtifact({
      conversationId: c.id,
      messageId: m.id,
      kind: "image",
      content: "cat",
      storagePath: IMG, // pre-v34 shape
    })
    await settle()
    await settle()
    const live = useStore.getState().artifacts.find((x) => x.id === a.id)!
    expect(live.storagePath).toBe(messageBlobRef(`${m.id}/img`))
    expect(await bytesAt(artifactBlobKey(a.id))).toBeUndefined()
  })
})

describe("reference counting across message + artifact", () => {
  test("deleting the source message keeps bytes the artifact uses; deleting the artifact then frees them", async () => {
    const { messageId, artifactId } = seed()
    await settle()
    useStore.getState().deleteMessage(messageId)
    expect(await bytesAt(`${messageId}/img`)).toBe(IMG)
    // The artifact survives with its reference intact.
    const live = useStore.getState().artifacts.find((a) => a.id === artifactId)!
    expect(live.messageId).toBeNull()
    expect(live.storagePath).toBe(messageBlobRef(`${messageId}/img`))

    useStore.getState().deleteArtifact(artifactId)
    expect(await bytesAt(`${messageId}/img`)).toBeUndefined()
  })

  test("deleting the artifact keeps bytes the message uses; deleting the message then frees them", async () => {
    const { messageId, artifactId } = seed()
    await settle()
    useStore.getState().deleteArtifact(artifactId)
    expect(await bytesAt(`${messageId}/img`)).toBe(IMG)
    useStore.getState().deleteMessage(messageId)
    expect(await bytesAt(`${messageId}/img`)).toBeUndefined()
  })

  test("deleteWorkspace frees bytes shared by its messages and artifacts", async () => {
    const ws = useStore.getState().createWorkspace("doomed-artifact-blobs")
    const { messageId } = seed(ws.id)
    await settle()
    useStore.getState().deleteWorkspace(ws.id)
    expect(await bytesAt(`${messageId}/img`)).toBeUndefined()
  })

  test("removedBlobKeys: a key is orphaned only when neither side references it", () => {
    const withItem = [conv("c", [msg("m", { generatedImages: [image("i", messageBlobRef("m/i"))] })])]
    const noItem = [conv("c", [msg("m")])]
    const withArt = [art("a", { storagePath: messageBlobRef("m/i") })]
    expect(removedBlobKeys({ conversations: withItem, artifacts: withArt }, { conversations: noItem, artifacts: withArt })).toEqual([])
    expect(removedBlobKeys({ conversations: withItem, artifacts: withArt }, { conversations: withItem, artifacts: [] })).toEqual([])
    expect(removedBlobKeys({ conversations: noItem, artifacts: withArt }, { conversations: noItem, artifacts: [] })).toEqual(["m/i"])
    expect(removedBlobKeys({ conversations: withItem, artifacts: [] }, { conversations: noItem, artifacts: [] })).toEqual(["m/i"])
  })
})

// ---------------------------------------------------------------------------
// Sync safety
// ---------------------------------------------------------------------------

const EMPTY: SyncSnapshot = {
  workspaces: [],
  documents: [],
  conversations: [],
  files: [],
  resources: [],
  conversationFiles: [],
  notes: [],
  artifacts: [],
  prompts: [],
  projectTasks: [],
  mcpServers: [],
  mcpResources: [],
  mcpResourceBindings: [],
  conversationMcpResources: [],
  urlBookmarks: [],
  conversationUrlBookmarks: [],
}

describe("sync diff rows", () => {
  test("the offload's inline → ref rewrite is not an edit (the cache vouches for the bytes)", async () => {
    await offloadMessageBlobs([conv("c", [msg("m", { generatedImages: [image("i", IMG)] })])])
    const inline = art("a", { storagePath: IMG })
    const ref = art("a", { storagePath: messageBlobRef("m/i") })
    expect(diffArtifacts([inline], [ref])).toEqual([])
    expect(diffArtifacts([ref], [inline])).toEqual([])
  })

  test("a new artifact's row carries the small reference, not the payload", () => {
    const [op] = diffArtifacts([], [art("a", { storagePath: messageBlobRef("m/i") })])
    const row = (op as { row: Record<string, unknown> }).row
    expect(row.storage_path).toBe(messageBlobRef("m/i"))
    expect(JSON.stringify(row)).not.toContain("base64")
  })
})

interface Call {
  table: string
  row: Record<string, unknown>
}

function recordingClient(calls: Call[]): AppSupabaseClient {
  return {
    from(table: string) {
      return {
        upsert(row: Record<string, unknown> | Record<string, unknown>[]) {
          for (const r of Array.isArray(row) ? row : [row]) calls.push({ table, row: r })
          return Promise.resolve({ error: null })
        },
      }
    },
  } as unknown as AppSupabaseClient
}

describe("sync queue flush", () => {
  beforeEach(() => {
    configureSync({ client: null, userId: null })
    resetSyncQueue()
    takeRecentlyDroppedOps("")
  })
  afterEach(() => {
    configureSync({ client: null, userId: null })
    resetSyncQueue()
  })

  test("a reference is resolved to the real bytes before the upsert goes out", async () => {
    await offloadMessageBlobs([conv("c", [msg("m", { generatedImages: [image("i", IMG)] })])])
    reload() // only IndexedDB knows the bytes now
    const [op] = diffArtifacts([], [art("a", { storagePath: messageBlobRef("m/i") })])
    const calls: Call[] = []
    configureSync({ client: recordingClient(calls), userId: "u" })
    enqueue({ ...op, ownerUserId: "u" })
    await whenDrained(2000)
    expect(calls).toHaveLength(1)
    expect(calls[0].row.storage_path).toBe(IMG)
    expect(JSON.stringify(calls[0].row)).not.toContain("hb-blob:")
  })

  test("an unresolvable reference is never sent and never null-overwrites: the column is omitted", async () => {
    const [op] = diffArtifacts([], [art("a", { storagePath: messageBlobRef("gone/i") })])
    const calls: Call[] = []
    configureSync({ client: recordingClient(calls), userId: "u" })
    enqueue({ ...op, ownerUserId: "u" })
    await whenDrained(2000)
    expect(calls).toHaveLength(1)
    expect("storage_path" in calls[0].row).toBe(false)
    expect(calls[0].row.title).toBe("cat")
    expect(JSON.stringify(calls[0].row)).not.toContain("hb-blob:")
  })

  test("a Supabase Storage URL passes through untouched", async () => {
    const [op] = diffArtifacts([], [art("a", { storagePath: SIGNED })])
    const calls: Call[] = []
    configureSync({ client: recordingClient(calls), userId: "u" })
    enqueue({ ...op, ownerUserId: "u" })
    await whenDrained(2000)
    expect(calls[0].row.storage_path).toBe(SIGNED)
  })
})

describe("bulk upload", () => {
  test("artifact rows go up with real bytes; an unresolvable ref goes separately without the column", async () => {
    await offloadMessageBlobs([conv("c", [msg("m", { generatedImages: [image("i", IMG)] })])])
    reload()
    const calls: Call[] = []
    const snapshot = {
      ...EMPTY,
      artifacts: [
        art("ok", { storagePath: messageBlobRef("m/i") }),
        art("lost", { storagePath: messageBlobRef("lost/i") }),
        art("plain", { storagePath: SIGNED }),
      ],
    } as unknown as CloudSnapshot
    const r = await bulkUploadLocalState(recordingClient(calls), "u", snapshot)
    expect(r.ok).toBe(true)
    const rows = calls.filter((c) => c.table === "artifacts").map((c) => c.row)
    expect(JSON.stringify(rows)).not.toContain("hb-blob:")
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get("ok")!.storage_path).toBe(IMG)
    expect(byId.get("plain")!.storage_path).toBe(SIGNED)
    expect("storage_path" in byId.get("lost")!).toBe(false)
  })
})

describe("pull merge", () => {
  const snap = (artifacts: Artifact[]): CloudSnapshot =>
    ({ ...EMPTY, artifacts }) as unknown as CloudSnapshot
  const ref = messageBlobRef("m/i")

  test("the cloud's real bytes replace a local reference", () => {
    const merged = mergeCloudSnapshot(
      snap([art("a", { storagePath: ref })]),
      snap([art("a", { storagePath: IMG })])
    )
    expect(merged.artifacts[0].storagePath).toBe(IMG)
  })

  test("…unless the reference is known to hold exactly those bytes (no churn)", () => {
    const merged = mergeCloudSnapshot(
      snap([art("a", { storagePath: ref })]),
      snap([art("a", { storagePath: IMG, title: "renamed" })]),
      { isSameBlob: (r, v) => r === ref && v === IMG }
    )
    expect(merged.artifacts[0].storagePath).toBe(ref)
    expect(merged.artifacts[0].title).toBe("renamed")
  })

  test("a reference in the cloud never replaces real local bytes", () => {
    const merged = mergeCloudSnapshot(
      snap([art("a", { storagePath: IMG })]),
      snap([art("a", { storagePath: ref })])
    )
    expect(merged.artifacts[0].storagePath).toBe(IMG)
  })

  test("a cloud null (omitted column on insert) never wipes the local value", () => {
    const merged = mergeCloudSnapshot(
      snap([art("a", { storagePath: ref })]),
      snap([art("a", { storagePath: null, title: "renamed" })])
    )
    expect(merged.artifacts[0].storagePath).toBe(ref)
    expect(merged.artifacts[0].title).toBe("renamed")
  })

  test("a fresh signed URL from the cloud still wins (cloud-storage case)", () => {
    const merged = mergeCloudSnapshot(
      snap([art("a", { storagePath: SIGNED })]),
      snap([art("a", { storagePath: SIGNED + "2" })])
    )
    expect(merged.artifacts[0].storagePath).toBe(SIGNED + "2")
  })
})

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

describe("readers' resolver", () => {
  test("a reference resolves to its bytes; plain URLs pass through; missing bytes → undefined", async () => {
    await offloadMessageBlobs([conv("c", [msg("m", { generatedImages: [image("i", IMG)] })])])
    reload()
    expect(await resolveArtifactAssetUrl(art("a", { storagePath: messageBlobRef("m/i") }))).toBe(IMG)
    expect(await resolveArtifactAssetUrl(art("b", { storagePath: SIGNED }))).toBe(SIGNED)
    expect(await resolveArtifactAssetUrl(art("c", { storagePath: messageBlobRef("gone/i") }))).toBeUndefined()
  })

  test("Send to editor embeds the resolved URL, never a reference", async () => {
    await offloadMessageBlobs([conv("c", [msg("m", { generatedImages: [image("i", IMG)] })])])
    reload()
    const md = await artifactMarkdownForEditor(art("a", { storagePath: messageBlobRef("m/i") }))
    expect(md).toBe(`![cat](${IMG})`)
    expect(await artifactMarkdownForEditor(art("x", { storagePath: messageBlobRef("gone/i") }))).toBeNull()
    expect(await artifactMarkdownForEditor(art("t", { kind: "markdown", content: "# hi" }))).toBe("# hi")
  })
})

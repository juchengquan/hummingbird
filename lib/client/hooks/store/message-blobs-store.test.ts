/**
 * Store-level coverage for the v33 move of inline `data:` URLs on message
 * generated images / files out of localStorage
 * (`client/messages/message-blobs.ts`): the migration step + post-
 * hydration offload, the persisted shape, cascade deletes from message /
 * conversation / workspace removal (and fork safety), and the sync side —
 * diff rows, pause-baseline hashes, the queue flush, the bulk upload and
 * the pull merge.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { IDBFactory } from "fake-indexeddb"

import { __setIndexedDBFactoryForTests } from "@/client/files/idb"
import {
  __flushMessageBlobOpsForTests,
  __resetMessageBlobsForTests,
  offloadMessageBlobs,
  removedMessageBlobKeys,
  resolveMessageBlobUrl,
} from "@/client/messages/message-blobs"
import type { AppSupabaseClient } from "@/client/supabase/client"
import { diffConversationMessages } from "@/client/sync/handlers"
import { buildPauseBaseline, computeResumeOps } from "@/client/sync/pause-baseline"
import type { SyncSnapshot } from "@/client/sync/compute-sync-ops"
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
import { messageBlobRef } from "@/shared/message-blob-ref"
import type { Conversation, GeneratedFile, GeneratedImage, Message } from "@/shared/types"

import { mergeCrossTabState } from "./cross-tab-merge"
import { runMigrations, STORE_VERSION } from "./migrate"
import { partializeState } from "./persist"

const IMG = "data:image/png;base64," + "Q".repeat(8192)
const CSV = "data:text/csv;base64," + "Z".repeat(1024)
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
// Migration + persisted shape
// ---------------------------------------------------------------------------

describe("v33 migration — message blobs to IndexedDB", () => {
  test("STORE_VERSION is 33", () => {
    expect(STORE_VERSION).toBe(33)
  })

  test("the step keeps inline payloads (they are the pending stash) and drops only junk", () => {
    const out = runMigrations(
      {
        conversations: [
          {
            id: "c",
            messages: [
              { id: "m1", generatedImages: [image("i1", IMG)], generatedFiles: [genFile("f1", CSV)] },
              { id: "m2", generatedImages: "nope", generatedFiles: [null, { id: 3 }, genFile("f2", SIGNED)] },
              null,
            ],
          },
        ],
      },
      32
    ) as { conversations: Array<{ messages: Array<Record<string, unknown> | null> }> }
    const [m1, m2, m3] = out.conversations[0].messages
    expect((m1?.generatedImages as GeneratedImage[])[0].url).toBe(IMG)
    expect((m1?.generatedFiles as GeneratedFile[])[0].url).toBe(CSV)
    expect("generatedImages" in (m2 ?? {})).toBe(false)
    expect((m2?.generatedFiles as GeneratedFile[]).map((f) => f.id)).toEqual(["f2"])
    expect(m3).toBeNull()
  })

  test("end to end: migrate → offload → persisted copy carries refs; bytes reload from IndexedDB", async () => {
    const migrated = runMigrations(
      {
        conversations: [
          conv("c-e2e", [
            msg("m-e2e", {
              generatedImages: [image("i1", IMG), image("i2", SIGNED)],
              generatedFiles: [genFile("f1", CSV)],
            }),
          ]),
        ],
      },
      32
    ) as { conversations: Conversation[] }
    const state = { ...useStore.getState(), conversations: migrated.conversations } as AppState

    // Before the offload commits, nothing is stripped (no data loss window).
    const before = partializeState(state).conversations[0].messages[0]
    expect(before.generatedImages?.[0].url).toBe(IMG)

    expect(await offloadMessageBlobs(state.conversations)).toBe(true)

    const persisted = partializeState(state)
    const m = persisted.conversations[0].messages[0]
    expect(m.generatedImages?.[0].url).toBe(messageBlobRef("m-e2e/i1"))
    expect(m.generatedImages?.[1].url).toBe(SIGNED)
    expect(m.generatedFiles?.[0].url).toBe(messageBlobRef("m-e2e/f1"))
    expect(JSON.stringify(persisted.conversations).length).toBeLessThan(2000)

    reload()
    expect(await resolveMessageBlobUrl(m.generatedImages![0].url)).toBe(IMG)
    expect(await resolveMessageBlobUrl(m.generatedFiles![0].url)).toBe(CSV)
  })

  test("IndexedDB unavailable: payloads stay in the persisted state", async () => {
    __setIndexedDBFactoryForTests(null)
    const state = {
      ...useStore.getState(),
      conversations: [conv("c-noidb", [msg("m-noidb", { generatedImages: [image("i1", IMG)] })])],
    } as AppState
    expect(await offloadMessageBlobs(state.conversations)).toBe(false)
    expect(partializeState(state).conversations[0].messages[0].generatedImages?.[0].url).toBe(IMG)
  })
})

// ---------------------------------------------------------------------------
// Store wiring + cascades
// ---------------------------------------------------------------------------

function seedConversation(workspaceId?: string): { convId: string; messageId: string } {
  const s = useStore.getState()
  const c = s.createConversation(workspaceId)
  const m = s.addMessage({ role: "assistant", content: "here" }, c.id)
  s.appendMessageGeneratedImages(m.id, [image("img", IMG)])
  s.appendMessageGeneratedFiles(m.id, [genFile("file", CSV)])
  return { convId: c.id, messageId: m.id }
}

async function expectStored(messageId: string): Promise<void> {
  await settle()
  reload()
  expect(await resolveMessageBlobUrl(messageBlobRef(`${messageId}/img`))).toBe(IMG)
  expect(await resolveMessageBlobUrl(messageBlobRef(`${messageId}/file`))).toBe(CSV)
}

async function expectGone(messageId: string): Promise<void> {
  await settle()
  reload()
  expect(await resolveMessageBlobUrl(messageBlobRef(`${messageId}/img`))).toBeUndefined()
  expect(await resolveMessageBlobUrl(messageBlobRef(`${messageId}/file`))).toBeUndefined()
}

describe("store wiring", () => {
  test("a generated data: image is offloaded and the persisted message carries a ref", async () => {
    const { convId, messageId } = seedConversation()
    await settle()
    const persisted = partializeState(useStore.getState()).conversations.find((c) => c.id === convId)
    const m = persisted?.messages.find((x) => x.id === messageId)
    expect(m?.generatedImages?.[0].url).toBe(messageBlobRef(`${messageId}/img`))
    expect(m?.generatedFiles?.[0].url).toBe(messageBlobRef(`${messageId}/file`))
    // The live store keeps the real value for this session.
    const live = useStore.getState().conversations.find((c) => c.id === convId)
    expect(live?.messages.find((x) => x.id === messageId)?.generatedImages?.[0].url).toBe(IMG)
    await expectStored(messageId)
  })
})

describe("cascade deletes", () => {
  test("deleteMessage deletes its IndexedDB entries", async () => {
    const { messageId } = seedConversation()
    await expectStored(messageId)
    useStore.getState().deleteMessage(messageId)
    await expectGone(messageId)
  })

  test("deleteConversation deletes its messages' entries", async () => {
    const { convId, messageId } = seedConversation()
    await expectStored(messageId)
    useStore.getState().deleteConversation(convId)
    await expectGone(messageId)
  })

  test("deleteWorkspace deletes the entries of its conversations' messages", async () => {
    const ws = useStore.getState().createWorkspace("doomed-message-blobs")
    const { messageId } = seedConversation(ws.id)
    await expectStored(messageId)
    useStore.getState().deleteWorkspace(ws.id)
    await expectGone(messageId)
  })

  test("a fork that still references the source's bytes keeps them alive", async () => {
    const { convId, messageId } = seedConversation()
    await settle()
    // Simulate the post-reload state: the source message carries refs.
    const stripped = partializeState(useStore.getState()).conversations
    useStore.setState({ conversations: stripped })
    const fork = useStore.getState().forkConversation(convId, messageId)
    expect(fork).not.toBeNull()
    const copied = fork!.messages[fork!.messages.length - 1]
    expect(copied.generatedImages?.[0].url).toBe(messageBlobRef(`${messageId}/img`))

    useStore.getState().deleteConversation(convId)
    await expectStored(messageId)

    useStore.getState().deleteConversation(fork!.id)
    await expectGone(messageId)
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

const inline = () => msg("m-sync", { generatedImages: [image("i1", IMG)], generatedFiles: [genFile("f1", CSV)] })
const stripped = () =>
  msg("m-sync", {
    generatedImages: [image("i1", messageBlobRef("m-sync/i1"))],
    generatedFiles: [genFile("f1", messageBlobRef("m-sync/f1"))],
  })

describe("sync diff rows", () => {
  test("a strip (data: URL → its ref) is not an edit: no op", () => {
    expect(diffConversationMessages("c", [inline()], [stripped()])).toEqual([])
    expect(diffConversationMessages("c", [stripped()], [inline()])).toEqual([])
  })

  test("rows carry refs (small), never the inline payload", () => {
    const [op] = diffConversationMessages("c", [], [inline()])
    expect(op.kind).toBe("upsert")
    const row = (op as { row: Record<string, unknown> }).row
    expect(JSON.stringify(row)).not.toContain("base64")
    expect((row.generated_images as GeneratedImage[])[0].url).toBe(messageBlobRef("m-sync/i1"))
    // Same row whether the message is inline or stripped.
    const [op2] = diffConversationMessages("c", [], [stripped()])
    expect((op2 as { row: unknown }).row).toEqual(row)
  })

  test("pause-baseline hashes are stable across a strip: resume uploads nothing", () => {
    const before: SyncSnapshot = { ...EMPTY, conversations: [conv("c", [inline()])] }
    const after: SyncSnapshot = { ...EMPTY, conversations: [conv("c", [stripped()])] }
    const baseline = buildPauseBaseline({ userId: "u", snapshot: before })
    expect(computeResumeOps(baseline, after)).toEqual([])
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

  test("refs are resolved to the real bytes before the upsert goes out", async () => {
    await offloadMessageBlobs([conv("c", [inline()])])
    reload() // only IndexedDB knows the bytes now
    const [op] = diffConversationMessages("c", [], [stripped()])
    const calls: Call[] = []
    configureSync({ client: recordingClient(calls), userId: "u" })
    enqueue({ ...op, ownerUserId: "u" })
    await whenDrained(2000)
    expect(calls).toHaveLength(1)
    const sent = calls[0].row
    expect(JSON.stringify(sent)).not.toContain("hb-blob:")
    expect((sent.generated_images as GeneratedImage[])[0].url).toBe(IMG)
    expect((sent.generated_files as GeneratedFile[])[0].url).toBe(CSV)
  })

  test("an unresolvable ref never null-overwrites: the column is omitted", async () => {
    reload() // nothing stored anywhere
    const [op] = diffConversationMessages("c", [], [stripped()])
    const calls: Call[] = []
    configureSync({ client: recordingClient(calls), userId: "u" })
    enqueue({ ...op, ownerUserId: "u" })
    await whenDrained(2000)
    expect(calls).toHaveLength(1)
    const sent = calls[0].row
    expect("generated_images" in sent).toBe(false)
    expect("generated_files" in sent).toBe(false)
    expect(sent.content).toBe("m-sync")
    expect(JSON.stringify(sent)).not.toContain("hb-blob:")
  })
})

describe("bulk upload", () => {
  const snapshot = (messages: Message[]): CloudSnapshot =>
    ({
      ...EMPTY,
      workspaces: [],
      conversations: [conv("c-bulk", messages)],
    }) as unknown as CloudSnapshot

  test("rows go up with real bytes; rows with an unresolvable ref go separately without the column", async () => {
    await offloadMessageBlobs([conv("c-bulk", [msg("ok", { generatedImages: [image("i1", IMG)] })])])
    reload()
    const calls: Call[] = []
    const r = await bulkUploadLocalState(
      recordingClient(calls),
      "u",
      snapshot([
        msg("ok", { generatedImages: [image("i1", messageBlobRef("ok/i1"))] }),
        msg("lost", { generatedImages: [image("i9", messageBlobRef("lost/i9"))] }),
        msg("plain", { generatedImages: [image("i2", SIGNED)] }),
      ])
    )
    expect(r.ok).toBe(true)
    const rows = calls.filter((c) => c.table === "messages").map((c) => c.row)
    expect(JSON.stringify(rows)).not.toContain("hb-blob:")
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect((byId.get("ok")!.generated_images as GeneratedImage[])[0].url).toBe(IMG)
    expect((byId.get("plain")!.generated_images as GeneratedImage[])[0].url).toBe(SIGNED)
    expect("generated_images" in byId.get("lost")!).toBe(false)
  })
})

describe("pull merge", () => {
  const snap = (messages: Message[]): CloudSnapshot =>
    ({ ...EMPTY, conversations: [conv("c-pull", messages)] }) as unknown as CloudSnapshot

  test("the cloud's real bytes replace a local ref", () => {
    const merged = mergeCloudSnapshot(
      snap([stripped()]),
      snap([msg("m-sync", { generatedImages: [image("i1", IMG)] })])
    )
    expect(merged.conversations[0].messages[0].generatedImages?.[0].url).toBe(IMG)
  })

  test("a ref in the cloud never overwrites real local bytes", () => {
    const merged = mergeCloudSnapshot(
      snap([inline()]),
      snap([stripped()])
    )
    const m = merged.conversations[0].messages[0]
    expect(m.generatedImages?.[0].url).toBe(IMG)
    expect(m.generatedFiles?.[0].url).toBe(CSV)
  })

  test("multi-tab: another tab's stripped copy merges in without orphaning or losing bytes", async () => {
    // This tab: inline bytes, already durable in the shared IndexedDB.
    const oursConvs = [conv("c-tab", [inline()])]
    await offloadMessageBlobs(oursConvs)
    // The other tab wrote its stripped copy plus a new message.
    const theirs = JSON.parse(
      JSON.stringify({ conversations: [conv("c-tab", [stripped(), msg("m-new")])] })
    ) as Record<string, unknown>
    const { merged } = mergeCrossTabState({
      base: { conversations: oursConvs },
      ours: { conversations: oursConvs },
      theirs,
      heldConversationIds: new Set(),
    })
    const mergedConvs = merged.conversations as Conversation[]
    const m = mergedConvs[0].messages.find((x) => x.id === "m-sync")!
    // The ref names the same key → the cascade sees nothing orphaned …
    expect(removedMessageBlobKeys(oursConvs, mergedConvs)).toEqual([])
    // … and the bytes still resolve from IndexedDB.
    reload()
    expect(await resolveMessageBlobUrl(m.generatedImages![0].url)).toBe(IMG)
    expect(await resolveMessageBlobUrl(m.generatedFiles![0].url)).toBe(CSV)
  })

  test("items the cloud lacks (an omitted column) are kept, not dropped", () => {
    const merged = mergeCloudSnapshot(
      snap([stripped()]),
      snap([msg("m-sync", { content: "edited elsewhere" })])
    )
    const m = merged.conversations[0].messages[0]
    expect(m.content).toBe("edited elsewhere")
    expect(m.generatedImages?.[0].url).toBe(messageBlobRef("m-sync/i1"))
    expect(m.generatedFiles?.[0].url).toBe(messageBlobRef("m-sync/f1"))
  })
})

import { describe, expect, test } from "bun:test"
import type { AppSupabaseClient } from "@/client/supabase/client"
import type { Conversation, Message, Workspace } from "@/shared/types"
import { useStore } from "@/client/hooks/use-store"
import {
  applyCloudSnapshot,
  bulkUploadLocalState,
  fetchCloudSnapshot,
  type CloudSnapshot,
} from "./reconcile"
import {
  CONVERSATION_LOCAL_ONLY_KEYS,
  CONVERSATION_SYNCED_KEYS,
  MESSAGE_LOCAL_ONLY_KEYS,
  MESSAGE_SYNCED_KEYS,
  WORKSPACE_LOCAL_ONLY_KEYS,
  WORKSPACE_SYNCED_KEYS,
  mergeCloudSnapshot,
} from "./snapshot-merge"
import type { SyncOp } from "./sync-queue"

// ---------- fixtures ---------------------------------------------------------

const T0 = new Date("2026-05-23T00:00:00.000Z")
const T1 = new Date("2026-05-24T00:00:00.000Z")

/**
 * `Required<…>` forces every key of the type to be present, so adding a
 * field to Message / Conversation / Workspace breaks the typecheck here
 * until the fixture (and therefore the classification test) covers it.
 */
function fullMessage(id = "m1"): Required<Message> {
  return {
    id,
    role: "assistant",
    content: "hello",
    timestamp: T0,
    error: { kind: "unknown", message: "boom" } as unknown as Required<Message>["error"],
    reasoning: "because",
    reasoningDurationMs: 1200,
    toolCalls: [{ id: "t1", name: "webSearch", argsLabel: "q", summary: "s" }],
    attachedFileIds: ["f1"],
    suggestions: ["next?"],
    verification: { verdict: "ok" } as unknown as Required<Message>["verification"],
    generatedImages: [
      { id: "i1", url: "u", width: 1, height: 2, format: "png", prompt: "p", mode: "t2i" },
    ],
    generatedFiles: [
      { id: "g1", name: "a.csv", sizeBytes: 3, mimeType: "text/csv", url: "u", storagePath: null },
    ],
    codeResults: [{ id: "c1", stdout: "out", stderr: "", results: [] }],
    uiParts: [{ id: "ui1" }] as unknown as Required<Message>["uiParts"],
    routedModel: "openai/gpt-x",
    mcpApps: [{ id: "app1" }] as unknown as Required<Message>["mcpApps"],
    compressed: true,
    kind: "recap",
    recapMessageIds: ["m0"],
    turnPersona: { agentId: "a1", allowedMcpServerIds: ["s1"] },
    taskTurn: { mode: "research" },
  }
}

function fullConversation(id = "c1", messages: Message[] = [fullMessage()]): Required<Conversation> {
  return {
    id,
    workspaceId: "ws-1",
    title: "Chat",
    messages,
    createdAt: T0,
    updatedAt: T0,
    pinned: true,
    systemPrompt: "be brief",
    memoryOff: true,
    selectedFileIds: ["f1"],
    fileRetrievalModes: { f1: "rag" },
    selectedMcpResourceIds: ["r1"],
    selectedUrlBookmarkIds: ["b1"],
    selectedArtifactIds: ["a1"],
    skillPrefs: { webSearch: false },
    webSearchConfig: { maxResults: 3 } as unknown as Required<Conversation>["webSearchConfig"],
    webFetchConfig: { enabled: true } as unknown as Required<Conversation>["webFetchConfig"],
    imageGenConfig: { size: "1k" } as unknown as Required<Conversation>["imageGenConfig"],
    fileSearchConfig: { topK: 2 } as unknown as Required<Conversation>["fileSearchConfig"],
    parentId: "c0",
    // A message that is uploaded too: the fork point is only set when its
    // message exists (bulkUploadLocalState).
    forkedFromMessageId: "m1",
  }
}

function fullWorkspace(id = "ws-1"): Required<Workspace> {
  return {
    id,
    name: "WS",
    createdAt: T0,
    updatedAt: T0,
    systemPrompt: "sys",
    defaultModel: "openai/gpt-x",
    skillPrefs: { webSearch: true },
    webSearchConfig: { maxResults: 3 } as unknown as Required<Workspace>["webSearchConfig"],
    webFetchConfig: { enabled: true } as unknown as Required<Workspace>["webFetchConfig"],
    imageGenConfig: { size: "1k" } as unknown as Required<Workspace>["imageGenConfig"],
    fileSearchConfig: { topK: 2 } as unknown as Required<Workspace>["fileSearchConfig"],
    isProject: true,
    goal: "ship",
    milestones: [{ title: "m", dueDate: "2026-06-01" }],
    position: 0,
    canvasState: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } as unknown as Required<Workspace>["canvasState"],
  }
}

function emptySnapshot(over: Partial<CloudSnapshot> = {}): CloudSnapshot {
  return {
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
    ...over,
  }
}

function msg(id: string, over: Partial<Message> = {}): Message {
  return { id, role: "user", content: `m-${id}`, timestamp: T0, ...over }
}

function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    workspaceId: "ws-1",
    title: `Conv ${id}`,
    messages: [],
    createdAt: T0,
    updatedAt: T0,
    pinned: false,
    systemPrompt: "",
    selectedFileIds: [],
    ...over,
  }
}

const op = {
  del: (target: SyncOp["target"], id: string): SyncOp => ({
    kind: "delete",
    target,
    clientOpId: "",
    where: { column: "id", value: id },
  }),
  up: (target: SyncOp["target"], id: string): SyncOp => ({
    kind: "upsert",
    target,
    clientOpId: "",
    row: { id },
  }),
}

/**
 * In-memory Supabase stand-in: `upsert` stores rows per table, and
 * `select().eq().order()` reads them back (ordered by `position` for
 * messages). Enough for bulkUploadLocalState → fetchCloudSnapshot.
 */
function fakeDb(): AppSupabaseClient {
  const tables = new Map<string, Record<string, unknown>[]>()
  const client = {
    from(table: string) {
      return {
        upsert(rows: Record<string, unknown>[]) {
          // Upsert: replace by id, keep first-insert order.
          const byId = new Map((tables.get(table) ?? []).map((r) => [r.id, r]))
          for (const r of rows) byId.set(r.id, r)
          tables.set(table, [...byId.values()])
          return Promise.resolve({ error: null })
        },
        select() {
          let order: string | null = null
          const builder = {
            eq: () => builder,
            order: (col: string) => {
              order = col
              return builder
            },
            then(resolve: (v: { data: unknown[]; error: null }) => void) {
              const rows = [...(tables.get(table) ?? [])]
              if (order) rows.sort((a, b) => (a[order!] as number) - (b[order!] as number))
              resolve({ data: rows, error: null })
            },
          }
          return builder
        },
      }
    },
  }
  return client as unknown as AppSupabaseClient
}

// ---------- classification ---------------------------------------------------

describe("field classification", () => {
  const cases: Array<[string, object, readonly string[], readonly string[]]> = [
    ["Message", fullMessage(), MESSAGE_SYNCED_KEYS, MESSAGE_LOCAL_ONLY_KEYS],
    ["Conversation", fullConversation(), CONVERSATION_SYNCED_KEYS, CONVERSATION_LOCAL_ONLY_KEYS],
    ["Workspace", fullWorkspace(), WORKSPACE_SYNCED_KEYS, WORKSPACE_LOCAL_ONLY_KEYS],
  ]
  for (const [name, fixture, synced, localOnly] of cases) {
    test(`every ${name} key is either synced or local-only (not both)`, () => {
      const classified = new Set([...synced, ...localOnly])
      expect(classified.size).toBe(synced.length + localOnly.length)
      const unclassified = Object.keys(fixture).filter((k) => !classified.has(k))
      expect(unclassified).toEqual([])
    })
  }

  test("synced keys really round-trip through upload → fetch; local-only keys don't", async () => {
    const db = fakeDb()
    const local = emptySnapshot({
      workspaces: [fullWorkspace()],
      conversations: [fullConversation()],
    })
    const up = await bulkUploadLocalState(db, "user-a", local)
    expect(up.ok).toBe(true)
    const cloud = await fetchCloudSnapshot(db, "user-a")
    expect(cloud).not.toBeNull()

    const pick = (o: object, keys: readonly string[]) =>
      Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]))

    const [w] = cloud!.workspaces
    expect(pick(w, WORKSPACE_SYNCED_KEYS)).toEqual(pick(fullWorkspace(), WORKSPACE_SYNCED_KEYS))
    for (const k of WORKSPACE_LOCAL_ONLY_KEYS) expect(w[k]).toBeUndefined()

    const [c] = cloud!.conversations
    // Messages are compared separately below (the fixture's message
    // carries local-only fields the cloud copy can't have).
    const headerKeys = CONVERSATION_SYNCED_KEYS.filter((k) => k !== "messages")
    expect(pick(c, headerKeys)).toEqual(pick(fullConversation(), headerKeys))
    for (const k of CONVERSATION_LOCAL_ONLY_KEYS) expect(c[k]).toBeUndefined()

    const [m] = c.messages
    expect(pick(m, MESSAGE_SYNCED_KEYS)).toEqual(pick(fullMessage(), MESSAGE_SYNCED_KEYS))
    for (const k of MESSAGE_LOCAL_ONLY_KEYS) expect(m[k]).toBeUndefined()
  })
})

// ---------- local-only merge ---------------------------------------------------

describe("mergeCloudSnapshot: local-only fields", () => {
  test("local-only fields survive; cloud wins for synced fields", () => {
    const local = emptySnapshot({
      workspaces: [fullWorkspace()],
      conversations: [fullConversation("c1", [fullMessage("m1")])],
    })
    // Cloud copy as fetchCloudSnapshot would build it: no local-only
    // keys, and some synced fields changed on another device.
    const cloud = emptySnapshot({
      workspaces: [{ ...fullWorkspace(), name: "Renamed", webSearchConfig: undefined, webFetchConfig: undefined, imageGenConfig: undefined, fileSearchConfig: undefined }],
      conversations: [
        conv("c1", {
          title: "Cloud title",
          pinned: false,
          messages: [msg("m1", { role: "assistant", content: "edited elsewhere" })],
        }),
      ],
    })

    const merged = mergeCloudSnapshot(local, cloud)
    const [c] = merged.conversations
    expect(c.title).toBe("Cloud title")
    expect(c.pinned).toBe(false)
    expect(c.memoryOff).toBe(true)
    expect(c.selectedArtifactIds).toEqual(["a1"])
    expect(c.webSearchConfig).toEqual(fullConversation().webSearchConfig)

    const [m] = c.messages
    expect(m.content).toBe("edited elsewhere")
    expect(m.uiParts).toEqual(fullMessage().uiParts)
    expect(m.codeResults).toEqual(fullMessage().codeResults)
    expect(m.mcpApps).toEqual(fullMessage().mcpApps)
    expect(m.verification).toEqual(fullMessage().verification)
    expect(m.routedModel).toBe("openai/gpt-x")
    expect(m.taskTurn).toEqual({ mode: "research" })

    const [w] = merged.workspaces
    expect(w.name).toBe("Renamed")
    expect(w.webSearchConfig).toEqual(fullWorkspace().webSearchConfig)
  })

  test("keepLocalOnlyFields: false takes the cloud entity as-is", () => {
    const local = emptySnapshot({ conversations: [conv("c1", { memoryOff: true })] })
    const cloud = emptySnapshot({ conversations: [conv("c1")] })
    const [c] = mergeCloudSnapshot(local, cloud, { keepLocalOnlyFields: false }).conversations
    expect(c.memoryOff).toBeUndefined()
  })

  test("entities only in the cloud come through; local entities without pending ops are dropped", () => {
    const local = emptySnapshot({ conversations: [conv("stale")] })
    const cloud = emptySnapshot({ conversations: [conv("fresh")] })
    expect(mergeCloudSnapshot(local, cloud).conversations.map((c) => c.id)).toEqual(["fresh"])
  })
})

// ---------- pending ops --------------------------------------------------------

describe("mergeCloudSnapshot: pending ops", () => {
  test("a pending delete is not resurrected (conversation, message, other entities)", () => {
    const local = emptySnapshot({ conversations: [conv("keep", { messages: [msg("m1")] })] })
    const cloud = emptySnapshot({
      conversations: [
        conv("keep", { messages: [msg("m1"), msg("m2")] }),
        conv("deleted"),
      ],
      notes: [
        { id: "n1", workspaceId: "ws-1", conversationId: null, messageId: null, body: "x", createdAt: T0, updatedAt: T0 },
      ],
    })
    const merged = mergeCloudSnapshot(local, cloud, {
      pendingOps: [op.del("conversations", "deleted"), op.del("messages", "m2"), op.del("notes", "n1")],
    })
    expect(merged.conversations.map((c) => c.id)).toEqual(["keep"])
    expect(merged.conversations[0].messages.map((m) => m.id)).toEqual(["m1"])
    expect(merged.notes).toEqual([])
  })

  test("a pending upsert keeps the local version instead of the cloud one", () => {
    const local = emptySnapshot({
      conversations: [
        conv("c1", { title: "local edit", updatedAt: T1, messages: [msg("m1", { content: "local msg" })] }),
      ],
    })
    const cloud = emptySnapshot({
      conversations: [conv("c1", { title: "stale cloud", messages: [msg("m1", { content: "stale" })] })],
    })
    const merged = mergeCloudSnapshot(local, cloud, {
      pendingOps: [op.up("conversations", "c1"), op.up("messages", "m1")],
    })
    expect(merged.conversations[0].title).toBe("local edit")
    expect(merged.conversations[0].messages[0].content).toBe("local msg")
  })

  test("a cloud row without the turn's persona doesn't erase it (Q52)", () => {
    // A database before 0044, or a row an older client wrote.
    const turnPersona = { agentId: "a1", allowedMcpServerIds: [] }
    const local = emptySnapshot({ conversations: [conv("c1", { messages: [msg("m1", { turnPersona })] })] })
    const cloud = emptySnapshot({ conversations: [conv("c1", { messages: [msg("m1")] })] })
    const merged = mergeCloudSnapshot(local, cloud, { pendingOps: [] })
    expect(merged.conversations[0].messages[0].turnPersona).toEqual(turnPersona)
  })

  test("header and messages merge independently", () => {
    // Pending header upsert, but a new message arrived from another device.
    const local = emptySnapshot({
      conversations: [conv("c1", { title: "local", messages: [msg("m1")] })],
    })
    const cloud = emptySnapshot({
      conversations: [conv("c1", { title: "cloud", messages: [msg("m1"), msg("m2")] })],
    })
    const [c] = mergeCloudSnapshot(local, cloud, {
      pendingOps: [op.up("conversations", "c1")],
    }).conversations
    expect(c.title).toBe("local")
    expect(c.messages.map((m) => m.id)).toEqual(["m1", "m2"])
  })

  test("local-only entities with a pending upsert are kept, in local order", () => {
    const local = emptySnapshot({
      conversations: [
        conv("c1", { messages: [msg("m1"), msg("new-1"), msg("m2"), msg("new-2")] }),
        conv("brand-new", { messages: [msg("x")] }),
      ],
    })
    const cloud = emptySnapshot({
      conversations: [conv("c1", { messages: [msg("m1"), msg("m2")] })],
    })
    const merged = mergeCloudSnapshot(local, cloud, {
      pendingOps: [
        op.up("messages", "new-1"),
        op.up("messages", "new-2"),
        op.up("conversations", "brand-new"),
        op.up("messages", "x"),
      ],
    })
    expect(merged.conversations.map((c) => c.id)).toEqual(["c1", "brand-new"])
    expect(merged.conversations[0].messages.map((m) => m.id)).toEqual([
      "m1",
      "new-1",
      "m2",
      "new-2",
    ])
    expect(merged.conversations[1].messages.map((m) => m.id)).toEqual(["x"])
  })

  test("the last pending op for an id wins (upsert then delete → deleted)", () => {
    const local = emptySnapshot()
    const cloud = emptySnapshot({ conversations: [conv("c1")] })
    const merged = mergeCloudSnapshot(local, cloud, {
      pendingOps: [op.up("conversations", "c1"), op.del("conversations", "c1")],
    })
    expect(merged.conversations).toEqual([])
  })

  test("a streaming conversation keeps its local messages", () => {
    const local = emptySnapshot({
      conversations: [conv("c1", { messages: [msg("m1"), msg("partial", { content: "stream…" })] })],
    })
    const cloud = emptySnapshot({ conversations: [conv("c1", { messages: [msg("m1")] })] })
    const [c] = mergeCloudSnapshot(local, cloud, {
      streamingConversationIds: new Set(["c1"]),
    }).conversations
    expect(c.messages.map((m) => m.id)).toEqual(["m1", "partial"])
  })
})

// ---------- applyCloudSnapshot (store integration) ---------------------------------

describe("applyCloudSnapshot", () => {
  test("merges into the store instead of replacing it wholesale", () => {
    useStore.setState({
      workspaces: [fullWorkspace("ws-1")],
      conversations: [
        conv("c1", { memoryOff: true, messages: [msg("m1", { routedModel: "x/y" })] }),
        conv("deleted-locally"),
      ],
      typingConversationIds: [],
    })
    // The user deleted a conversation locally; its delete op is still
    // queued when the (stale) snapshot lands.
    useStore.setState({
      conversations: useStore.getState().conversations.filter((c) => c.id !== "deleted-locally"),
    })

    applyCloudSnapshot(
      emptySnapshot({
        workspaces: [{ ...fullWorkspace("ws-1"), webSearchConfig: undefined, webFetchConfig: undefined, imageGenConfig: undefined, fileSearchConfig: undefined }],
        conversations: [conv("c1", { title: "cloud", messages: [msg("m1")] }), conv("deleted-locally")],
      }),
      { pendingOps: [op.del("conversations", "deleted-locally")] }
    )

    const s = useStore.getState()
    expect(s.conversations.map((c) => c.id)).toEqual(["c1"])
    expect(s.conversations[0].title).toBe("cloud")
    expect(s.conversations[0].memoryOff).toBe(true)
    expect(s.conversations[0].messages[0].routedModel).toBe("x/y")
    expect(s.workspaces[0].webSearchConfig).toEqual(fullWorkspace().webSearchConfig)
  })
})

describe("bulkUploadLocalState — forked conversations", () => {
  /** Upserts rows like `fakeDb`, but enforces conversations'
   *  `forked_from_message_id` FK (not deferrable) against messages
   *  already stored, and records each conversations upsert. */
  function fkDb() {
    const tables = new Map<string, Record<string, unknown>[]>()
    const convUpserts: Record<string, unknown>[][] = []
    const client = {
      from(table: string) {
        return {
          upsert(rows: Record<string, unknown>[]) {
            if (table === "conversations") {
              convUpserts.push(rows)
              const messageIds = new Set((tables.get("messages") ?? []).map((m) => m.id))
              const bad = rows.find(
                (r) => r.forked_from_message_id != null && !messageIds.has(r.forked_from_message_id)
              )
              if (bad) {
                return Promise.resolve({ error: { code: "23503", message: "fk violation" } })
              }
            }
            const byId = new Map((tables.get(table) ?? []).map((r) => [r.id, r]))
            for (const r of rows) byId.set(r.id, r)
            tables.set(table, [...byId.values()])
            return Promise.resolve({ error: null })
          },
        }
      },
    }
    return { client: client as unknown as AppSupabaseClient, tables, convUpserts }
  }

  test("a fork's branch point is set after the messages exist", async () => {
    const db = fkDb()
    const parent = conv("p", { messages: [msg("m1"), msg("m2")] })
    const fork = conv("f", { parentId: "p", forkedFromMessageId: "m1", messages: [msg("m3")] })
    const orphan = conv("o", { parentId: "p", forkedFromMessageId: "gone", messages: [] })
    const up = await bulkUploadLocalState(
      db.client,
      "user-a",
      emptySnapshot({ workspaces: [fullWorkspace("ws-1")], conversations: [fork, parent, orphan] })
    )
    expect(up).toEqual({ ok: true })
    // First pass: every conversation, no branch points.
    expect(db.convUpserts[0].map((r) => r.forked_from_message_id)).toEqual([null, null, null])
    // Second pass, after messages: only forks whose branch point exists.
    expect(db.convUpserts[1].map((r) => [r.id, r.forked_from_message_id])).toEqual([["f", "m1"]])
    const stored = db.tables.get("conversations")!
    expect(stored.find((r) => r.id === "f")?.forked_from_message_id).toBe("m1")
    expect(stored.find((r) => r.id === "o")?.forked_from_message_id).toBeNull()
  })
})

describe("mid-stream pulls keep the in-flight turn", () => {
  test("a streaming conversation (typing flag already cleared) keeps its placeholder", () => {
    // The typing flag clears on the first chunk; only the streaming flag
    // remains for the rest of the stream. A pull must still treat the
    // conversation as held.
    useStore.setState({
      workspaces: [fullWorkspace("ws-1")],
      conversations: [
        conv("c1", { messages: [msg("u1"), msg("ph", { role: "assistant", content: "tok" })] }),
      ],
      typingConversationIds: [],
      streamingConversationIds: ["c1"],
      artifacts: [],
      notes: [],
    })
    applyCloudSnapshot(
      emptySnapshot({
        workspaces: [{ ...fullWorkspace("ws-1"), webSearchConfig: undefined, webFetchConfig: undefined, imageGenConfig: undefined, fileSearchConfig: undefined }],
        conversations: [conv("c1", { messages: [msg("u1")] })],
      })
    )
    const [c] = useStore.getState().conversations
    expect(c.messages.map((m) => m.id)).toEqual(["u1", "ph"])
    useStore.setState({ streamingConversationIds: [] })
  })

  test("artifacts / notes on a not-yet-uploaded streaming message survive the pull", () => {
    const artifact = {
      id: "a1",
      workspaceId: "ws-1",
      conversationId: "c1",
      messageId: "ph",
      kind: "image" as const,
      language: null,
      title: "img",
      content: "",
      storagePath: "hb-blob:ph/i1",
      pinned: false,
      createdAt: T0,
    }
    const note = {
      id: "n1",
      workspaceId: "ws-1",
      conversationId: "c1",
      messageId: "ph",
      body: "b",
      createdAt: T0,
      updatedAt: T0,
    }
    const otherArtifact = { ...artifact, id: "a2", messageId: "u1" }
    const local = emptySnapshot({
      conversations: [conv("c1", { messages: [msg("u1"), msg("ph")] })],
      artifacts: [artifact, otherArtifact],
      notes: [note],
    })
    const cloud = emptySnapshot({ conversations: [conv("c1", { messages: [msg("u1")] })] })
    const merged = mergeCloudSnapshot(local, cloud, {
      streamingConversationIds: new Set(["c1"]),
    })
    // a2 references an uploaded message and has no pending op → the
    // cloud (which lacks it) wins, as before.
    expect(merged.artifacts.map((a) => a.id)).toEqual(["a1"])
    expect(merged.notes.map((n) => n.id)).toEqual(["n1"])
    // A pending delete still wins.
    expect(
      mergeCloudSnapshot(local, cloud, {
        streamingConversationIds: new Set(["c1"]),
        pendingOps: [op.del("artifacts", "a1")],
      }).artifacts
    ).toEqual([])
    // Not streaming → the ordinary rule applies.
    expect(mergeCloudSnapshot(local, cloud).artifacts).toEqual([])
  })
})

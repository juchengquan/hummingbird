import { describe, expect, test } from "bun:test"
import type { Artifact, Conversation, Message, Note } from "@/shared/types"
import {
  computeSyncOps,
  type DeferredDependentOps,
  type SyncSnapshot,
} from "./compute-sync-ops"
import type { SyncOp } from "./sync-queue"

function msg(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    role: "user",
    content: `m-${id}`,
    timestamp: new Date("2026-05-23T00:00:00Z"),
    ...overrides,
  }
}

function conv(id: string, messages: Message[]): Conversation {
  return {
    id,
    workspaceId: "ws-1",
    title: `Conv ${id}`,
    messages,
    createdAt: new Date("2026-05-23T00:00:00Z"),
    updatedAt: new Date("2026-05-23T00:00:00Z"),
    pinned: false,
    systemPrompt: "",
    selectedFileIds: [],
  }
}

function snap(conversations: Conversation[]): SyncSnapshot {
  return {
    workspaces: [],
    documents: [],
    conversations,
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
}

const messageOps = (ops: SyncOp[]) => ops.filter((o) => o.target === "messages")

/**
 * Drives a sequence of store states through `computeSyncOps` the way
 * `useSync`'s subscriber does: the baseline advances to every state,
 * held ids come from the caller.
 */
function drive(
  initial: SyncSnapshot,
  steps: Array<{ next: SyncSnapshot; held: string[] }>
): SyncOp[][] {
  const baselines = new Map<string, Message[]>()
  let prev = initial
  return steps.map(({ next, held }) => {
    const ops = computeSyncOps(prev, next, new Set(held), baselines)
    prev = next
    return ops
  })
}

describe("computeSyncOps — streaming hold", () => {
  test("no message ops per token; one upsert of the final message when the stream ends", () => {
    const user = msg("u1")
    const other = conv("b", [msg("b1")])
    const s0 = snap([conv("a", [user]), other])
    // Stream starts (typing + streaming set, no entity change).
    const s1 = s0
    // Placeholder + tokens. The typing flag drops on the first chunk,
    // the streaming flag stays on — this is the case that used to
    // enqueue an upsert per token.
    const s2 = snap([conv("a", [user, msg("p", { role: "assistant", content: "Hel" })]), other])
    const s3 = snap([conv("a", [user, msg("p", { role: "assistant", content: "Hello" })]), other])
    const s4 = snap([
      conv("a", [user, msg("p", { role: "assistant", content: "Hello world" })]),
      other,
    ])
    // Stream settles: streaming flag cleared, no entity change in the
    // same notification — the baseline has already advanced to s4, so
    // a prev→next diff here would find nothing.
    const s5 = s4

    const out = drive(s0, [
      { next: s1, held: ["a"] },
      { next: s2, held: ["a"] },
      { next: s3, held: ["a"] },
      { next: s4, held: ["a"] },
      { next: s5, held: [] },
    ])

    for (const ops of out.slice(0, 4)) expect(messageOps(ops)).toHaveLength(0)
    const final = messageOps(out[4])
    expect(final).toHaveLength(1)
    expect(final[0].kind).toBe("upsert")
    if (final[0].kind === "upsert") {
      expect(final[0].row.id).toBe("p")
      expect(final[0].row.content).toBe("Hello world")
      expect(final[0].row.position).toBe(1)
    }
  })

  test("release in the same notification as a message change does not double-enqueue", () => {
    const s0 = snap([conv("a", [msg("u1")])])
    const s1 = snap([conv("a", [msg("u1"), msg("p", { content: "partial" })])])
    const s2 = snap([conv("a", [msg("u1"), msg("p", { content: "final" })])])
    const out = drive(s0, [
      { next: s1, held: ["a"] },
      { next: s2, held: [] },
    ])
    const final = messageOps(out[1])
    expect(final).toHaveLength(1)
    if (final[0].kind === "upsert") expect(final[0].row.content).toBe("final")
  })

  test("other conversations still sync while one is held", () => {
    const s0 = snap([conv("a", []), conv("b", [])])
    const s1 = snap([conv("a", [msg("p", { content: "tok" })]), conv("b", [msg("b1")])])
    const [ops] = drive(s0, [{ next: s1, held: ["a"] }])
    const m = messageOps(ops)
    expect(m).toHaveLength(1)
    if (m[0].kind === "upsert") expect(m[0].row.conversation_id).toBe("b")
  })

  test("conversation deleted mid-stream: release emits no message ops, header delete still goes out", () => {
    const s0 = snap([conv("a", [msg("u1")])])
    const s1 = snap([conv("a", [msg("u1"), msg("p")])])
    const s2 = snap([])
    const out = drive(s0, [
      { next: s1, held: ["a"] },
      { next: s2, held: [] },
    ])
    expect(messageOps(out[1])).toHaveLength(0)
    expect(
      out[1].filter((o) => o.target === "conversations" && o.kind === "delete")
    ).toHaveLength(1)
  })

  test("baselines map is cleaned up after release", () => {
    const baselines = new Map<string, Message[]>()
    const s0 = snap([conv("a", [])])
    const s1 = snap([conv("a", [msg("p")])])
    computeSyncOps(s0, s1, new Set(["a"]), baselines)
    expect(baselines.has("a")).toBe(true)
    computeSyncOps(s1, s1, new Set(), baselines)
    expect(baselines.size).toBe(0)
  })
})

function artifact(id: string, messageId: string | null, over: Partial<Artifact> = {}): Artifact {
  return {
    id,
    workspaceId: "ws-1",
    conversationId: "a",
    messageId,
    kind: "image",
    language: null,
    title: id,
    content: "",
    storagePath: `hb-blob:${messageId}/${id}`,
    pinned: false,
    createdAt: new Date("2026-05-23T00:00:00Z"),
    ...over,
  }
}

function note(id: string, messageId: string | null): Note {
  return {
    id,
    workspaceId: "ws-1",
    conversationId: "a",
    messageId,
    body: id,
    createdAt: new Date("2026-05-23T00:00:00Z"),
    updatedAt: new Date("2026-05-23T00:00:00Z"),
  }
}

/** `drive`, but with ONE deferred-ops map across the steps (as useSync). */
function driveWithDeferred(
  initial: SyncSnapshot,
  steps: Array<{ next: SyncSnapshot; held: string[] }>
): { out: SyncOp[][]; deferred: DeferredDependentOps } {
  const baselines = new Map<string, Message[]>()
  const deferred: DeferredDependentOps = new Map()
  let prev = initial
  const out = steps.map(({ next, held }) => {
    const ops = computeSyncOps(prev, next, new Set(held), baselines, deferred)
    prev = next
    return ops
  })
  return { out, deferred }
}

const label = (op: SyncOp) =>
  `${op.kind}:${op.target}:${op.kind === "upsert" ? op.row.id : op.kind === "delete" ? op.where.value : "*"}`

describe("computeSyncOps — rows referencing a held message", () => {
  const user = msg("u1")
  const s0 = snap([conv("a", [user])])
  const ph = (content: string) => msg("ph", { role: "assistant", content })

  test("a tool image artifact created mid-stream is uploaded AFTER its message", () => {
    const s1 = snap([conv("a", [user, ph("tok")])])
    // tool_image: the artifact is created with messageId = placeholder.
    const s2 = { ...snap([conv("a", [user, ph("tok")])]), artifacts: [artifact("art", "ph")] }
    // autoArchiveCodeBlocks runs before the streaming flag clears.
    const s3 = {
      ...snap([conv("a", [user, ph("done")])]),
      artifacts: [artifact("art", "ph"), artifact("code", "ph", { kind: "code", storagePath: null })],
      notes: [note("bm", "ph")],
    }
    const { out, deferred } = driveWithDeferred(s0, [
      { next: s1, held: ["a"] },
      { next: s2, held: ["a"] },
      { next: s3, held: ["a"] },
      { next: s3, held: [] }, // stream settles
    ])
    for (const ops of out.slice(0, 3)) expect(ops).toEqual([])
    expect(out[3].map(label)).toEqual([
      "upsert:messages:ph",
      "upsert:artifacts:art",
      "upsert:notes:bm",
      "upsert:artifacts:code",
    ])
    expect(deferred.size).toBe(0)
  })

  test("rows on already-uploaded messages are not held", () => {
    const s1 = { ...snap([conv("a", [user, ph("tok")])]), artifacts: [artifact("old", "u1")] }
    const [ops] = driveWithDeferred(s0, [{ next: s1, held: ["a"] }]).out
    expect(ops.map(label)).toEqual(["upsert:artifacts:old"])
  })

  test("a delete of a parked row stays behind its upsert (collapsed to the delete)", () => {
    const s1 = { ...snap([conv("a", [user, ph("tok")])]), artifacts: [artifact("art", "ph")] }
    const s2 = snap([conv("a", [user, ph("tok")])])
    const { out } = driveWithDeferred(s0, [
      { next: s1, held: ["a"] },
      { next: s2, held: ["a"] },
      { next: s2, held: [] },
    ])
    expect(out[0]).toEqual([])
    expect(out[1]).toEqual([])
    expect(out[2].map(label)).toEqual(["upsert:messages:ph", "delete:artifacts:art"])
  })

  test("a parked row whose message vanished mid-stream goes out with message_id null", () => {
    const s1 = { ...snap([conv("a", [user, ph("tok")])]), artifacts: [artifact("art", "ph")] }
    const s2 = { ...snap([conv("a", [user])]), artifacts: [artifact("art", "ph")] }
    const { out } = driveWithDeferred(s0, [
      { next: s1, held: ["a"] },
      { next: s2, held: [] },
    ])
    const up = out[1].find((o) => o.target === "artifacts")
    expect(up?.kind).toBe("upsert")
    if (up?.kind === "upsert") expect(up.row.message_id).toBeNull()
  })

  test("conversation deleted mid-stream: parked rows go out detached from it", () => {
    const s1 = { ...snap([conv("a", [user, ph("tok")])]), artifacts: [artifact("art", "ph")] }
    const s2 = { ...snap([]), artifacts: [artifact("art", "ph")] }
    const { out } = driveWithDeferred(s0, [
      { next: s1, held: ["a"] },
      { next: s2, held: [] },
    ])
    expect(out[1].map(label)).toEqual(["upsert:artifacts:art", "delete:conversations:a"])
    const up = out[1][0]
    if (up.kind === "upsert") {
      expect(up.row.message_id).toBeNull()
      expect(up.row.conversation_id).toBeNull()
    }
  })

  test("parked ops still go out when the held baseline was cleared (rebase)", () => {
    const baselines = new Map<string, Message[]>()
    const deferred: DeferredDependentOps = new Map()
    const s1 = { ...snap([conv("a", [user, ph("tok")])]), artifacts: [artifact("art", "ph")] }
    computeSyncOps(s0, snap([conv("a", [user, ph("tok")])]), new Set(["a"]), baselines, deferred)
    expect(computeSyncOps(snap([conv("a", [user, ph("tok")])]), s1, new Set(["a"]), baselines, deferred)).toEqual([])
    baselines.clear()
    const ops = computeSyncOps(s1, s1, new Set(), baselines, deferred)
    expect(ops.map(label)).toEqual(["upsert:artifacts:art"])
  })
})

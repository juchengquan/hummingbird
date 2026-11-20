import { describe, expect, test } from "bun:test"
import type { Conversation, Message } from "@/shared/types"
import { computeSyncOps, type SyncSnapshot } from "./compute-sync-ops"
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

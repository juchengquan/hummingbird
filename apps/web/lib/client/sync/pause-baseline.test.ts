import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import type {
  Conversation,
  ConversationFile,
  Document,
  Message,
  Workspace,
} from "@/shared/types"
import type { SyncSnapshot } from "./compute-sync-ops"
import {
  buildPauseBaseline,
  claimPauseBaseline,
  clearPauseBaseline,
  computeResumeOps,
  decideResume,
  hashRow,
  markPauseBaselineDirty,
  mergePauseBaselines,
  parsePauseBaseline,
  PAUSE_BASELINE_KEY,
  readPauseBaseline,
  savePauseBaseline,
  shouldCapturePauseBaseline,
  withDirtyOps,
  type OwnershipContext,
  type PauseBaseline,
} from "./pause-baseline"
import type { NewSyncOp, SyncOp } from "./sync-queue"

// ---------------------------------------------------------------------------
// localStorage shim (bun has none) — failable, to exercise the quota path.
// ---------------------------------------------------------------------------

const ls = new Map<string, string>()
let failWrites = false
const hadLocalStorage = "localStorage" in globalThis
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => ls.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (failWrites) throw new Error("QuotaExceededError")
    ls.set(k, v)
  },
  removeItem: (k: string) => void ls.delete(k),
}
afterAll(() => {
  if (!hadLocalStorage) delete (globalThis as { localStorage?: unknown }).localStorage
})
beforeEach(() => {
  failWrites = false
  ls.clear()
  // Also drops any in-memory fallback left by a previous test.
  clearPauseBaseline()
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = new Date("2026-05-23T00:00:00Z")
const T1 = new Date("2026-05-24T00:00:00Z")

function ws(id: string, over: Partial<Workspace> = {}): Workspace {
  return { id, name: `WS ${id}`, createdAt: T0, updatedAt: T0, ...over }
}
function doc(id: string, workspaceId: string, over: Partial<Document> = {}): Document {
  return { id, workspaceId, title: id, content: "", createdAt: T0, updatedAt: T0, ...over }
}
function msg(id: string, over: Partial<Message> = {}): Message {
  return { id, role: "user", content: `m-${id}`, timestamp: T0, ...over }
}
function conv(
  id: string,
  messages: Message[],
  over: Partial<Conversation> = {}
): Conversation {
  return {
    id,
    workspaceId: "ws-1",
    title: `Conv ${id}`,
    messages,
    createdAt: T0,
    updatedAt: T0,
    pinned: false,
    systemPrompt: "",
    selectedFileIds: [],
    ...over,
  }
}
function link(id: string, conversationId: string, fileId: string): ConversationFile {
  return { id, conversationId, fileId, addedAt: T0 }
}

function snap(over: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    workspaces: [ws("ws-1")],
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

const OWNED: OwnershipContext = { localOwner: "user-a", reconciled: true }

function baselineOf(s: SyncSnapshot, droppedOps: SyncOp[] = []): PauseBaseline {
  return buildPauseBaseline({ userId: "user-a", snapshot: s, droppedOps, now: 1 })
}

/** Compact "kind target id" strings, in op order. */
function summary(ops: NewSyncOp[]): string[] {
  return ops.map((op) => {
    if (op.kind === "upsert") return `upsert ${op.target} ${String(op.row.id)}`
    if (op.kind === "delete") return `delete ${op.target} ${op.where.value}`
    return `deleteMany ${op.target}`
  })
}

function opFor(
  kind: "upsert" | "delete",
  target: SyncOp["target"],
  id: string,
  owner = "user-a",
  row: Record<string, unknown> = {}
): SyncOp {
  return kind === "upsert"
    ? { kind, target, clientOpId: "x", row: { id, ...row }, ownerUserId: owner }
    : { kind, target, clientOpId: "x", where: { column: "id", value: id }, ownerUserId: owner }
}

// ---------------------------------------------------------------------------
// computeResumeOps
// ---------------------------------------------------------------------------

describe("computeResumeOps", () => {
  test("nothing changed while paused → no ops", () => {
    const s = snap({ conversations: [conv("c1", [msg("m1"), msg("m2")])] })
    expect(computeResumeOps(baselineOf(s), s)).toEqual([])
  })

  test("a conversation created while paused is uploaded with its messages", () => {
    const before = snap()
    const after = snap({ conversations: [conv("c1", [msg("m1"), msg("m2")])] })
    expect(summary(computeResumeOps(baselineOf(before), after))).toEqual([
      "upsert conversations c1",
      "upsert messages m1",
      "upsert messages m2",
    ])
  })

  test("a conversation deleted while paused is deleted — its messages go by cascade", () => {
    const before = snap({
      conversations: [conv("c1", [msg("m1"), msg("m2")]), conv("c2", [])],
    })
    const after = snap({ conversations: [conv("c2", [])] })
    expect(summary(computeResumeOps(baselineOf(before), after))).toEqual([
      "delete conversations c1",
    ])
  })

  test("a message deleted from a surviving conversation is deleted by id", () => {
    const before = snap({ conversations: [conv("c1", [msg("m1"), msg("m2")])] })
    const after = snap({ conversations: [conv("c1", [msg("m1")])] })
    expect(summary(computeResumeOps(baselineOf(before), after))).toEqual([
      "delete messages m2",
    ])
  })

  test("edited rows are re-sent with the CURRENT content; untouched rows are not", () => {
    const before = snap({
      documents: [doc("d1", "ws-1"), doc("d2", "ws-1")],
      conversations: [conv("c1", [msg("m1")])],
    })
    const after = snap({
      documents: [doc("d1", "ws-1", { content: "new", updatedAt: T1 }), doc("d2", "ws-1")],
      conversations: [conv("c1", [msg("m1", { content: "edited" })])],
    })
    const ops = computeResumeOps(baselineOf(before), after)
    expect(summary(ops)).toEqual(["upsert documents d1", "upsert messages m1"])
    const d1 = ops[0] as Extract<NewSyncOp, { kind: "upsert" }>
    expect(d1.row.content).toBe("new")
  })

  test("local-only fields (no DB column) changing is not an upload", () => {
    const before = snap({ conversations: [conv("c1", [])] })
    const after = snap({ conversations: [conv("c1", [], { memoryOff: true })] })
    expect(computeResumeOps(baselineOf(before), after)).toEqual([])
  })

  test("a date revived as a differently formatted ISO string is not a change", () => {
    const before = snap({ documents: [doc("d1", "ws-1")] })
    const after = snap({
      documents: [
        doc("d1", "ws-1", {
          createdAt: "2026-05-23T00:00:00Z" as unknown as Date,
          updatedAt: "2026-05-23T00:00:00.000+00:00" as unknown as Date,
        }),
      ],
    })
    expect(computeResumeOps(baselineOf(before), after)).toEqual([])
  })

  test("order: link deletes → upserts (parents first) → other deletes (children first)", () => {
    // While paused: the chat moved from ws-old to ws-new, ws-old was
    // deleted along with a doc in it, and a file link was replaced by a
    // new link row with the same (conversation, file) key.
    const before = snap({
      workspaces: [ws("ws-1"), ws("ws-old")],
      documents: [doc("d-old", "ws-old")],
      conversations: [conv("c1", [msg("m1")], { workspaceId: "ws-old" })],
      conversationFiles: [link("l-old", "c1", "f1")],
    })
    const after = snap({
      workspaces: [ws("ws-1"), ws("ws-new")],
      conversations: [conv("c1", [msg("m1")], { workspaceId: "ws-new", updatedAt: T1 })],
      conversationFiles: [link("l-new", "c1", "f1")],
    })
    expect(summary(computeResumeOps(baselineOf(before), after))).toEqual([
      // unique (conversation_id, file_id) freed before the new link lands
      "delete conversation_files l-old",
      "upsert workspaces ws-new",
      "upsert conversations c1",
      "upsert conversation_files l-new",
      // the chat is re-parented BEFORE ws-old's cascade could take it
      "delete documents d-old",
      "delete workspaces ws-old",
    ])
  })

  test("a streaming conversation's partial messages still upload (the hold re-diffs later)", () => {
    const before = snap({ conversations: [conv("c1", [msg("m1")])] })
    const after = snap({
      conversations: [conv("c1", [msg("m1"), msg("m2", { role: "assistant", content: "par" })])],
    })
    expect(summary(computeResumeOps(baselineOf(before), after))).toEqual([
      "upsert messages m2",
    ])
  })

  test("very large pause diffs stay linear", () => {
    const many = Array.from({ length: 5_000 }, (_, i) => msg(`m${i}`))
    const before = snap({ conversations: [conv("c-old", many)] })
    const after = snap({ conversations: [conv("c-new", many.map((m) => ({ ...m })))] })
    const t0 = performance.now()
    const ops = computeResumeOps(baselineOf(before), after)
    const elapsed = performance.now() - t0
    // c-old delete (messages cascade) + c-new + 5000 message upserts.
    expect(ops.length).toBe(5_002)
    expect(elapsed).toBeLessThan(2_000)
  })
})

// ---------------------------------------------------------------------------
// Ops pending / dropped at pause time
// ---------------------------------------------------------------------------

describe("unflushed ops at pause", () => {
  test("ops still QUEUED at pause are not re-sent (they flush first on resume)", () => {
    // The diff baseline already includes the queued edit to c1.
    const s = snap({ conversations: [conv("c1", [], { title: "queued edit" })] })
    expect(computeResumeOps(baselineOf(s), s)).toEqual([])
  })

  test("a dropped upsert (sign-out reset) is re-sent from the current state", () => {
    const s = snap({ conversations: [conv("c1", [msg("m1")])] })
    const b = baselineOf(s, [
      opFor("upsert", "conversations", "c1"),
      opFor("upsert", "messages", "m1", "user-a", { conversation_id: "c1" }),
    ])
    expect(summary(computeResumeOps(b, s))).toEqual([
      "upsert conversations c1",
      "upsert messages m1",
    ])
  })

  test("a dropped delete is re-sent (message deletes carry no conversation id)", () => {
    const s = snap({ conversations: [conv("c1", [msg("m1")])] })
    const b = baselineOf(s, [
      opFor("delete", "conversations", "c-gone"),
      opFor("delete", "messages", "m-gone"),
    ])
    expect(summary(computeResumeOps(b, s))).toEqual([
      "delete messages m-gone",
      "delete conversations c-gone",
    ])
  })

  test("another account's dropped ops are ignored", () => {
    const s = snap({ conversations: [conv("c1", [])] })
    const b = baselineOf(s, [opFor("upsert", "conversations", "c1", "user-b")])
    expect(computeResumeOps(b, s)).toEqual([])
  })

  test("withDirtyOps marks a recorded baseline without mutating it", () => {
    const s = snap({ conversations: [conv("c1", [])] })
    const b = baselineOf(s)
    const marked = withDirtyOps(b, [opFor("upsert", "conversations", "c1")])
    expect(summary(computeResumeOps(marked, s))).toEqual(["upsert conversations c1"])
    expect(computeResumeOps(b, s)).toEqual([])
    expect(withDirtyOps(b, [opFor("upsert", "conversations", "c1", "user-b")])).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// Multi-tab merge
// ---------------------------------------------------------------------------

describe("mergePauseBaselines", () => {
  test("union of ids; disagreeing hashes become dirty (re-sent)", () => {
    const a = baselineOf(
      snap({ conversations: [conv("c1", []), conv("c2", [], { title: "A's view" })] })
    )
    const b = baselineOf(
      snap({ conversations: [conv("c2", [], { title: "B's view" }), conv("c3", [])] })
    )
    const merged = mergePauseBaselines(a, { ...b, capturedAt: 0 })
    expect(merged.capturedAt).toBe(0)
    const current = snap({
      conversations: [conv("c1", []), conv("c2", [], { title: "B's view" })],
    })
    // c2: the tabs disagreed → re-sent; c3: in a baseline, gone now → deleted.
    expect(summary(computeResumeOps(merged, current))).toEqual([
      "upsert conversations c2",
      "delete conversations c3",
    ])
  })
})

// ---------------------------------------------------------------------------
// Ownership decisions
// ---------------------------------------------------------------------------

describe("decideResume / shouldCapturePauseBaseline", () => {
  const b = baselineOf(snap())

  test("no baseline → none", () => {
    expect(decideResume(null, "user-a", OWNED)).toBe("none")
  })

  test("same user, local data still theirs → upload", () => {
    expect(decideResume(b, "user-a", OWNED)).toBe("upload")
  })

  test("a DIFFERENT user signing in never uploads; the baseline is kept for its owner", () => {
    expect(decideResume(b, "user-b", { localOwner: "user-a", reconciled: false })).toBe("keep")
    expect(decideResume(b, "user-b", { localOwner: null, reconciled: true })).toBe("keep")
  })

  test("once another account reconciled over the local data, the baseline is dead", () => {
    expect(decideResume(b, "user-b", { localOwner: "user-b", reconciled: true })).toBe("discard")
    expect(decideResume(b, "user-a", { localOwner: "user-b", reconciled: true })).toBe("discard")
  })

  test("capture only for the reconciled owner of the local data", () => {
    expect(shouldCapturePauseBaseline("user-a", OWNED)).toBe(true)
    expect(shouldCapturePauseBaseline("user-a", { localOwner: "user-a", reconciled: false })).toBe(
      false
    )
    expect(shouldCapturePauseBaseline("user-a", { localOwner: "user-b", reconciled: true })).toBe(
      false
    )
    expect(shouldCapturePauseBaseline("user-a", { localOwner: null, reconciled: true })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe("pause baseline storage", () => {
  test("paused → reload → resume: the record survives in localStorage and uploads", () => {
    const before = snap({ conversations: [conv("c1", [msg("m1")])] })
    savePauseBaseline(baselineOf(before))
    // "Reload": nothing survives but localStorage.
    const raw = ls.get(PAUSE_BASELINE_KEY) ?? null
    expect(parsePauseBaseline(raw)?.userId).toBe("user-a")

    const after = snap({ conversations: [conv("c1", [msg("m1")]), conv("c2", [])] })
    const claimed = claimPauseBaseline("user-a", OWNED)
    expect(claimed).not.toBeNull()
    expect(summary(computeResumeOps(claimed!, after))).toEqual(["upsert conversations c2"])
  })

  test("the claim is one-shot: a second tab resuming finds nothing", () => {
    savePauseBaseline(baselineOf(snap()))
    expect(claimPauseBaseline("user-a", OWNED)).not.toBeNull()
    expect(ls.has(PAUSE_BASELINE_KEY)).toBe(false)
    expect(claimPauseBaseline("user-a", OWNED)).toBeNull()
  })

  test("a different user's sign-in leaves the record for its owner", () => {
    savePauseBaseline(baselineOf(snap()))
    expect(claimPauseBaseline("user-b", { localOwner: "user-a", reconciled: false })).toBeNull()
    expect(readPauseBaseline()?.userId).toBe("user-a")
    // …who can still resume later.
    expect(claimPauseBaseline("user-a", OWNED)).not.toBeNull()
  })

  test("a stale record is cleared when claimed", () => {
    savePauseBaseline(baselineOf(snap()))
    expect(claimPauseBaseline("user-a", { localOwner: "user-b", reconciled: true })).toBeNull()
    expect(readPauseBaseline()).toBeNull()
  })

  test("a second pause of the same user (another tab) merges into the record", () => {
    savePauseBaseline(baselineOf(snap({ conversations: [conv("c1", [])] })))
    savePauseBaseline(baselineOf(snap({ conversations: [conv("c2", [])] })))
    const rec = readPauseBaseline()!
    expect(Object.keys(rec.rows.conversations ?? {}).sort()).toEqual(["c1", "c2"])
  })

  test("a pause of another user replaces the record", () => {
    savePauseBaseline(baselineOf(snap({ conversations: [conv("c1", [])] })))
    savePauseBaseline(
      buildPauseBaseline({ userId: "user-b", snapshot: snap(), now: 2 })
    )
    expect(readPauseBaseline()?.userId).toBe("user-b")
  })

  test("markPauseBaselineDirty updates the recorded baseline (reset after capture)", () => {
    const s = snap({ conversations: [conv("c1", [])] })
    savePauseBaseline(baselineOf(s))
    markPauseBaselineDirty([opFor("upsert", "conversations", "c1")])
    const claimed = claimPauseBaseline("user-a", OWNED)!
    expect(summary(computeResumeOps(claimed, s))).toEqual(["upsert conversations c1"])
  })

  test("quota failure falls back to memory for this page session", () => {
    failWrites = true
    savePauseBaseline(baselineOf(snap()))
    expect(ls.has(PAUSE_BASELINE_KEY)).toBe(false)
    expect(readPauseBaseline()?.userId).toBe("user-a")
    expect(claimPauseBaseline("user-a", OWNED)).not.toBeNull()
    expect(readPauseBaseline()).toBeNull()
  })

  test("malformed records read as none", () => {
    expect(parsePauseBaseline("not json")).toBeNull()
    expect(parsePauseBaseline(JSON.stringify({ v: 2 }))).toBeNull()
    expect(
      parsePauseBaseline(
        JSON.stringify({ v: 1, userId: "u", capturedAt: 1, rows: { x: { a: 1 } }, messages: {} })
      )
    ).toBeNull()
  })

  test("the record is compact: ids and hashes, never row content", () => {
    const secret = "x".repeat(10_000)
    savePauseBaseline(baselineOf(snap({ documents: [doc("d1", "ws-1", { content: secret })] })))
    const raw = ls.get(PAUSE_BASELINE_KEY)!
    expect(raw).not.toContain(secret)
    expect(raw.length).toBeLessThan(500)
  })
})

describe("hashRow", () => {
  test("stable for equal rows, different for changed content", () => {
    expect(hashRow({ id: "a", v: 1 })).toBe(hashRow({ id: "a", v: 1 }))
    expect(hashRow({ id: "a", v: 1 })).not.toBe(hashRow({ id: "a", v: 2 }))
    expect(hashRow({ id: "a" })).not.toBe("")
  })
})

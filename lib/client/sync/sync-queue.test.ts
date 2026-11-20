import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AppSupabaseClient } from "@/client/supabase/client"
import {
  attributeLegacyOps,
  configureSync,
  enqueue,
  enqueueMany,
  pendingOpCount,
  pendingOpsFor,
  resetSyncQueue,
  syncQueueMark,
  takeRecentlyDroppedOps,
  whenDrained,
  type NewSyncOp,
  type SyncOp,
} from "./sync-queue"
import {
  buildPauseBaseline,
  claimPauseBaseline,
  computeResumeOps,
  savePauseBaseline,
} from "./pause-baseline"
import type { SyncSnapshot } from "./compute-sync-ops"

interface Call {
  table: string
  kind: "upsert" | "delete"
  row?: Record<string, unknown>
  id?: string
}

/** Minimal Supabase stand-in: records upserts / id-deletes, always ok. */
function fakeClient(calls: Call[]): AppSupabaseClient {
  const client = {
    from(table: string) {
      return {
        upsert(row: Record<string, unknown>) {
          calls.push({ table, kind: "upsert", row })
          return Promise.resolve({ error: null })
        },
        delete() {
          return {
            eq(_column: string, value: string) {
              calls.push({ table, kind: "delete", id: value })
              return Promise.resolve({ error: null })
            },
          }
        },
      }
    },
  }
  return client as unknown as AppSupabaseClient
}

function upsert(id: string, ownerUserId?: string): NewSyncOp {
  return {
    kind: "upsert",
    target: "conversations",
    row: { id, title: id },
    ...(ownerUserId ? { ownerUserId } : {}),
  }
}

beforeEach(() => {
  configureSync({ client: null, userId: null })
  resetSyncQueue()
  takeRecentlyDroppedOps("") // forget what the reset just recorded
})

afterEach(() => {
  configureSync({ client: null, userId: null })
  resetSyncQueue()
})

describe("attributeLegacyOps", () => {
  const legacy = { ...upsert("x"), clientOpId: "1" } as SyncOp
  const owned = { ...upsert("y", "user-b"), clientOpId: "2" } as SyncOp

  test("stamps unowned ops with the unambiguous device owner", () => {
    const [a, b] = attributeLegacyOps([legacy, owned], "user-a")
    expect(a.ownerUserId).toBe("user-a")
    // An op that already has an owner is never re-attributed.
    expect(b.ownerUserId).toBe("user-b")
  })

  test("leaves unowned ops unowned when the owner is unknown", () => {
    const [a] = attributeLegacyOps([legacy], null)
    expect(a.ownerUserId).toBeUndefined()
  })
})

describe("owner stamping + filtering", () => {
  test("enqueue stamps the configured user as owner", () => {
    // No client → the gate stays closed, op just sits in the queue.
    configureSync({ client: null, userId: "user-a" })
    enqueue(upsert("c1"))
    const [op] = pendingOpsFor("user-a")
    expect(op.ownerUserId).toBe("user-a")
    expect(pendingOpsFor("user-b")).toEqual([])
  })

  test("flush drops other accounts' ops and unowned legacy ops", async () => {
    const calls: Call[] = []
    // Signed out: ops from A plus an unowned (legacy) op accumulate.
    enqueue(upsert("from-a", "user-a"))
    enqueue(upsert("legacy")) // no configured user → unowned
    enqueue(upsert("from-b", "user-b"))
    expect(pendingOpCount()).toBe(3)

    configureSync({ client: fakeClient(calls), userId: "user-b" })
    await whenDrained(2_000)

    expect(pendingOpCount()).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].row?.id).toBe("from-b")
    expect(calls[0].row?.user_id).toBe("user-b")
  })

  test("the owner's ops replay when the owner signs back in", async () => {
    const calls: Call[] = []
    enqueue(upsert("mine", "user-a"))
    configureSync({ client: fakeClient(calls), userId: "user-a" })
    await whenDrained(2_000)
    expect(calls.map((c) => c.row?.id)).toEqual(["mine"])
    expect(calls[0].row?.user_id).toBe("user-a")
  })

  test("resetSyncQueue (sign-out) drops everything", () => {
    configureSync({ client: null, userId: "user-a" })
    enqueue(upsert("c1"))
    resetSyncQueue()
    expect(pendingOpCount()).toBe(0)
  })
})

describe("pendingOpsFor since-mark", () => {
  test("includes ops flushed after the mark, excludes earlier ones", async () => {
    const calls: Call[] = []
    const client = fakeClient(calls)

    enqueue(upsert("before", "user-a"))
    configureSync({ client, userId: "user-a" })
    await whenDrained(2_000)

    const mark = syncQueueMark()
    enqueue({
      kind: "delete",
      target: "conversations",
      where: { column: "id", value: "gone" },
    })
    await whenDrained(2_000)
    expect(pendingOpCount()).toBe(0)

    const ids = pendingOpsFor("user-a", { since: mark }).map((op) =>
      op.kind === "delete" ? op.where.value : op.kind === "upsert" ? op.row.id : null
    )
    expect(ids).toEqual(["gone"])
    // Without a mark only still-queued ops count.
    expect(pendingOpsFor("user-a")).toEqual([])
    // Never another account's.
    expect(pendingOpsFor("user-b", { since: mark })).toEqual([])
  })
})

const idOf = (op: SyncOp | NewSyncOp) =>
  op.kind === "upsert" ? op.row.id : op.kind === "delete" ? op.where.value : null

describe("enqueueMany (resume-from-pause upload)", () => {
  test("stamps owner + clientOpId on every op and keeps order", () => {
    configureSync({ client: null, userId: "user-a" })
    enqueueMany([{ ...upsert("c1"), clientOpId: "" }, upsert("c2"), upsert("c3", "user-a")])
    const ops = pendingOpsFor("user-a")
    expect(ops.map(idOf)).toEqual(["c1", "c2", "c3"])
    for (const op of ops) expect(op.clientOpId).not.toBe("")
  })

  test("offline / unconfigured at resume: ops stay queued, the drain wait times out", async () => {
    // No client → the gate is closed, exactly as when offline.
    configureSync({ client: null, userId: "user-a" })
    enqueueMany([upsert("c1"), upsert("c2")])
    await whenDrained(50)
    expect(pendingOpCount()).toBe(2)
  })

  test("ops queued before the pause flush before the resume upload", async () => {
    const calls: Call[] = []
    enqueue(upsert("pre-pause", "user-a"))
    enqueueMany([upsert("paused-edit", "user-a")])
    configureSync({ client: fakeClient(calls), userId: "user-a" })
    await whenDrained(2_000)
    expect(calls.map((c) => c.row?.id)).toEqual(["pre-pause", "paused-edit"])
  })
})

describe("ops dropped without flushing", () => {
  test("a reset (sign-out) records them for the pause baseline, per owner", () => {
    configureSync({ client: null, userId: "user-a" })
    enqueue(upsert("a1"))
    enqueue(upsert("b1", "user-b"))
    resetSyncQueue()
    expect(takeRecentlyDroppedOps("user-a").map(idOf)).toEqual(["a1"])
    expect(takeRecentlyDroppedOps("user-a")).toEqual([])
  })

  test("another account signing in prunes them and records them", () => {
    enqueue(upsert("a1", "user-a"))
    configureSync({ client: null, userId: "user-b" })
    expect(pendingOpCount()).toBe(0)
    expect(takeRecentlyDroppedOps("user-a").map(idOf)).toEqual(["a1"])
  })

  test("a reset AFTER the pause baseline was recorded marks it dirty", () => {
    const snapshot: SyncSnapshot = {
      workspaces: [],
      documents: [],
      conversations: [
        {
          id: "c1",
          workspaceId: "ws-1",
          title: "t",
          messages: [],
          createdAt: new Date(0),
          updatedAt: new Date(0),
          pinned: false,
          systemPrompt: "",
          selectedFileIds: [],
        },
      ],
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
    configureSync({ client: null, userId: "user-a" })
    enqueue(upsert("c1"))
    // Recorded while the edit was still queued, so it trusts the edit…
    savePauseBaseline(buildPauseBaseline({ userId: "user-a", snapshot }))
    // …then sign-out drops the op unflushed.
    resetSyncQueue()
    const claimed = claimPauseBaseline("user-a", { localOwner: "user-a", reconciled: true })
    expect(claimed).not.toBeNull()
    expect(computeResumeOps(claimed!, snapshot).map(idOf)).toEqual(["c1"])
  })
})

describe("upsert hitting a missing reference (23503 / 42501)", () => {
  /** Artifact upserts fail with `code` until their message_id exists. */
  function fkClient(calls: Call[], code: string): AppSupabaseClient {
    const messages = new Set<string>()
    const client = {
      from(table: string) {
        return {
          upsert(row: Record<string, unknown>) {
            if (table === "artifacts" && row.message_id && !messages.has(row.message_id as string)) {
              return Promise.resolve({ error: { code } })
            }
            if (table === "messages") messages.add(row.id as string)
            calls.push({ table, kind: "upsert", row })
            return Promise.resolve({ error: null })
          },
        }
      },
    }
    return client as unknown as AppSupabaseClient
  }
  const art = (id: string, messageId: string, title = id): NewSyncOp => ({
    kind: "upsert",
    target: "artifacts",
    row: { id, message_id: messageId, title },
  })
  const message = (id: string): NewSyncOp => ({
    kind: "upsert",
    target: "messages",
    row: { id },
  })

  for (const code of ["23503", "42501"]) {
    test(`${code}: retried behind the queued dependency instead of dropped`, async () => {
      const calls: Call[] = []
      configureSync({ client: null, userId: "user-a" })
      enqueueMany([art("a1", "m1"), message("m1")])
      configureSync({ client: fkClient(calls, code), userId: "user-a" })
      await whenDrained(2_000)
      expect(calls.map((c) => `${c.table}:${c.row?.id}`)).toEqual(["messages:m1", "artifacts:a1"])
    })
  }

  test("a stale copy never overtakes a newer op for the same row", async () => {
    const calls: Call[] = []
    configureSync({ client: null, userId: "user-a" })
    enqueueMany([art("a1", "m1", "old"), message("m1"), art("a1", "m1", "new")])
    configureSync({ client: fkClient(calls, "23503"), userId: "user-a" })
    await whenDrained(2_000)
    expect(calls.map((c) => `${c.table}:${c.row?.title ?? c.row?.id}`)).toEqual([
      "messages:m1",
      "artifacts:new",
    ])
  })

  test("a reference that never shows up is dropped after a bounded number of rounds", async () => {
    const calls: Call[] = []
    configureSync({ client: null, userId: "user-a" })
    enqueue(art("a1", "never"))
    configureSync({ client: fkClient(calls, "23503"), userId: "user-a" })
    await whenDrained(15_000)
    expect(pendingOpCount()).toBe(0)
    expect(calls).toEqual([])
  }, 20_000)
})

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AppSupabaseClient } from "@/client/supabase/client"
import {
  attributeLegacyOps,
  configureSync,
  enqueue,
  pendingOpCount,
  pendingOpsFor,
  resetSyncQueue,
  syncQueueMark,
  whenDrained,
  type NewSyncOp,
  type SyncOp,
} from "./sync-queue"

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

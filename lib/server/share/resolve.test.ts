import { describe, expect, test } from "bun:test"

import type { SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "@/shared/supabase/types"
import { resolveShare } from "./resolve"

/**
 * In-memory fake of the slice of the Supabase query builder `resolveShare`
 * uses: `.from(t).select().eq()…​.order().maybeSingle()` / awaited list.
 * `eq` really filters the seeded rows, so a missing owner filter in the
 * resolver shows up as another user's rows leaking into the result — the
 * service-role client has no RLS to hide them.
 */
type Row = Record<string, unknown>
type Tables = Record<string, Row[]>

function makeClient(tables: Tables): {
  client: SupabaseClient<Database>
  filtersByTable: Record<string, string[][]>
} {
  const filtersByTable: Record<string, string[][]> = {}

  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])]
    const filters: string[] = []
    ;(filtersByTable[table] ??= []).push(filters)
    const builder = {
      select() {
        return builder
      },
      eq(col: string, val: unknown) {
        filters.push(col)
        rows = rows.filter((r) => r[col] === val)
        return builder
      },
      order(col: string, opts?: { ascending?: boolean }) {
        const dir = opts?.ascending === false ? -1 : 1
        rows.sort((a, b) => ((a[col] as number) - (b[col] as number)) * dir)
        return builder
      },
      maybeSingle() {
        if (rows.length > 1) {
          return Promise.resolve({ data: null, error: { message: "multiple rows" } })
        }
        return Promise.resolve({ data: rows[0] ?? null, error: null })
      },
      then(resolve: (v: unknown) => void) {
        resolve({ data: rows, error: null })
      },
    }
    return builder
  }

  return { client: { from } as unknown as SupabaseClient<Database>, filtersByTable }
}

const ALICE = "00000000-0000-4000-8000-00000000a11c"
const MALLORY = "00000000-0000-4000-8000-0000000ba11e"
const ALICE_CONV = "10000000-0000-4000-8000-000000000001"
const MALLORY_CONV = "10000000-0000-4000-8000-000000000002"
const ALICE_DOC = "20000000-0000-4000-8000-000000000001"
const MALLORY_DOC = "20000000-0000-4000-8000-000000000002"

function share(over: Row): Row {
  return {
    token: "tok",
    user_id: ALICE,
    kind: "conversation",
    conversation_id: null,
    document_id: null,
    created_at: "2026-01-01T00:00:00Z",
    revoked_at: null,
    ...over,
  }
}

function msg(id: string, conversation_id: string, user_id: string, position: number): Row {
  return { id, conversation_id, user_id, role: "user", content: id, reasoning: null, position }
}

const BASE: Omit<Tables, "shares"> = {
  conversations: [
    { id: ALICE_CONV, user_id: ALICE, title: "Alice chat" },
    { id: MALLORY_CONV, user_id: MALLORY, title: "Mallory chat" },
  ],
  documents: [
    { id: ALICE_DOC, user_id: ALICE, title: "Alice doc", content: "secret" },
    { id: MALLORY_DOC, user_id: MALLORY, title: "", content: "mine" },
  ],
  messages: [
    msg("m2", ALICE_CONV, ALICE, 2),
    msg("m1", ALICE_CONV, ALICE, 1),
    // Injected into Alice's conversation by another user (pre-0031 RLS gap).
    msg("evil", ALICE_CONV, MALLORY, 3),
    msg("other", MALLORY_CONV, MALLORY, 1),
  ],
}

describe("resolveShare", () => {
  test("returns null when the service-role client is unavailable", async () => {
    expect(await resolveShare("tok", null)).toBeNull()
  })

  test("returns null for an unknown token", async () => {
    const { client } = makeClient({ ...BASE, shares: [] })
    expect(await resolveShare("tok", client)).toBeNull()
  })

  test("returns null for a revoked share", async () => {
    const { client } = makeClient({
      ...BASE,
      shares: [share({ conversation_id: ALICE_CONV, revoked_at: "2026-02-01T00:00:00Z" })],
    })
    expect(await resolveShare("tok", client)).toBeNull()
  })

  test("conversation share by its owner → owner's messages only, in order", async () => {
    const { client, filtersByTable } = makeClient({
      ...BASE,
      shares: [share({ conversation_id: ALICE_CONV })],
    })
    const res = await resolveShare("tok", client)
    expect(res).toEqual({
      kind: "conversation",
      conversationTitle: "Alice chat",
      messages: [
        { id: "m1", role: "user", content: "m1", reasoning: null, position: 1 },
        { id: "m2", role: "user", content: "m2", reasoning: null, position: 2 },
      ],
      createdAt: "2026-01-01T00:00:00Z",
    })
    expect(filtersByTable.conversations[0]).toContain("user_id")
    expect(filtersByTable.messages[0]).toEqual(["conversation_id", "user_id"])
  })

  test("conversation share pointing at another user's conversation → null", async () => {
    // Mallory inserted a share row directly via PostgREST targeting Alice's id.
    const { client, filtersByTable } = makeClient({
      ...BASE,
      shares: [share({ user_id: MALLORY, conversation_id: ALICE_CONV })],
    })
    expect(await resolveShare("tok", client)).toBeNull()
    // Never got as far as reading the victim's messages.
    expect(filtersByTable.messages).toBeUndefined()
  })

  test("document share by its owner → document content", async () => {
    const { client } = makeClient({
      ...BASE,
      shares: [share({ kind: "document", document_id: MALLORY_DOC, user_id: MALLORY })],
    })
    expect(await resolveShare("tok", client)).toEqual({
      kind: "document",
      documentTitle: "Untitled",
      documentContent: "mine",
      createdAt: "2026-01-01T00:00:00Z",
    })
  })

  test("document share pointing at another user's document → null", async () => {
    const { client } = makeClient({
      ...BASE,
      shares: [share({ kind: "document", document_id: ALICE_DOC, user_id: MALLORY })],
    })
    expect(await resolveShare("tok", client)).toBeNull()
  })
})

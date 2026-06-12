import { describe, expect, test } from "bun:test"

import type { SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "@/shared/supabase/types"
import { indexFileSections } from "./index-file"

/**
 * Minimal chainable fake of the bits of the Supabase client
 * `indexFileSections` touches: `.from().select().eq()` (HEAD count),
 * `.from().delete().eq()`, and `.from().insert()`. Each builder is
 * awaitable and resolves a result keyed off the last verb invoked.
 */
interface FakeOpts {
  existingCount?: number
  countError?: { message: string } | null
  insertError?: { code?: string; message: string } | null
}
interface Capture {
  insertedRows: unknown[] | null
  deleted: boolean
}

function makeClient(opts: FakeOpts = {}): {
  client: SupabaseClient<Database>
  capture: Capture
} {
  const capture: Capture = { insertedRows: null, deleted: false }
  let lastVerb: "select" | "insert" | "delete" | "" = ""

  const builder = {
    select() {
      lastVerb = "select"
      return builder
    },
    insert(rows: unknown[]) {
      lastVerb = "insert"
      capture.insertedRows = rows
      return builder
    },
    delete() {
      lastVerb = "delete"
      capture.deleted = true
      return builder
    },
    eq() {
      return builder
    },
    then(resolve: (v: unknown) => void) {
      if (lastVerb === "select") {
        resolve({ count: opts.existingCount ?? 0, error: opts.countError ?? null })
      } else if (lastVerb === "insert") {
        resolve({ error: opts.insertError ?? null })
      } else {
        resolve({ error: null })
      }
    },
  }

  const client = { from: () => builder } as unknown as SupabaseClient<Database>
  return { client, capture }
}

const fakeEmbed = (texts: string[]): Promise<number[][]> =>
  Promise.resolve(texts.map((_, i) => [i, i + 1, i + 2]))

// Long enough to chunk into several pieces with a tiny window.
const LONG_TEXT = "para one.\n\npara two.\n\npara three.\n\npara four.\n\npara five."
const SMALL_CHUNKS = { maxChars: 12, overlapChars: 0 }

describe("indexFileSections", () => {
  test("empty text → skipped/empty, no DB writes", async () => {
    const { client, capture } = makeClient()
    const result = await indexFileSections({
      client,
      userId: "u1",
      fileId: "f1",
      text: "   ",
      embed: fakeEmbed,
    })
    expect(result).toEqual({ status: "skipped", sections: 0, reason: "empty" })
    expect(capture.insertedRows).toBeNull()
  })

  test("already indexed → skipped/already_indexed, no embed/insert", async () => {
    let embedCalls = 0
    const { client, capture } = makeClient({ existingCount: 4 })
    const result = await indexFileSections({
      client,
      userId: "u1",
      fileId: "f1",
      text: LONG_TEXT,
      chunkOptions: SMALL_CHUNKS,
      embed: (t) => {
        embedCalls++
        return fakeEmbed(t)
      },
    })
    expect(result).toEqual({ status: "skipped", sections: 4, reason: "already_indexed" })
    expect(embedCalls).toBe(0)
    expect(capture.insertedRows).toBeNull()
  })

  test("fresh file → indexed; rows carry user_id, ordered index, vector string", async () => {
    const { client, capture } = makeClient({ existingCount: 0 })
    const result = await indexFileSections({
      client,
      userId: "user-42",
      fileId: "file-7",
      text: LONG_TEXT,
      chunkOptions: SMALL_CHUNKS,
      embed: fakeEmbed,
    })
    expect(result.status).toBe("indexed")
    expect(result.sections).toBeGreaterThan(1)
    const rows = capture.insertedRows as Array<Record<string, unknown>>
    expect(rows).toHaveLength(result.sections)
    rows.forEach((row, i) => {
      expect(row.user_id).toBe("user-42")
      expect(row.file_id).toBe("file-7")
      expect(row.section_index).toBe(i)
      expect(typeof row.content).toBe("string")
      // pgvector text representation.
      expect(row.embedding).toBe(JSON.stringify([i, i + 1, i + 2]))
    })
  })

  test("force → clears existing then inserts, skipping the count check", async () => {
    const { client, capture } = makeClient({ existingCount: 9 })
    const result = await indexFileSections({
      client,
      userId: "u1",
      fileId: "f1",
      text: LONG_TEXT,
      chunkOptions: SMALL_CHUNKS,
      force: true,
      embed: fakeEmbed,
    })
    expect(capture.deleted).toBe(true)
    expect(result.status).toBe("indexed")
    // The pre-existing 9 didn't short-circuit because force skips the count.
    expect(capture.insertedRows).not.toBeNull()
  })

  test("FK violation on insert → skipped/file_not_found (not thrown)", async () => {
    const { client } = makeClient({
      existingCount: 0,
      insertError: { code: "23503", message: "violates foreign key constraint" },
    })
    const result = await indexFileSections({
      client,
      userId: "u1",
      fileId: "missing",
      text: LONG_TEXT,
      chunkOptions: SMALL_CHUNKS,
      embed: fakeEmbed,
    })
    expect(result).toEqual({ status: "skipped", sections: 0, reason: "file_not_found" })
  })

  test("non-FK insert error → throws", async () => {
    const { client } = makeClient({
      existingCount: 0,
      insertError: { code: "42P01", message: "relation does not exist" },
    })
    await expect(
      indexFileSections({
        client,
        userId: "u1",
        fileId: "f1",
        text: LONG_TEXT,
        chunkOptions: SMALL_CHUNKS,
        embed: fakeEmbed,
      })
    ).rejects.toThrow(/file_sections insert failed/)
  })
})

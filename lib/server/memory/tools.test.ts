import { describe, expect, test } from "bun:test"

import { buildMemoryTools, type MemoryToolDeps } from "./tools"

type Err = { message: string } | null

/** Fake of the Supabase surface the memory tools touch. */
function fakeClient(opts: { insertError?: Err; selectError?: Err; deleteError?: Err } = {}) {
  const inserted: unknown[] = []
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from: () => ({
      insert: async (row: unknown) => {
        inserted.push(row)
        return { error: opts.insertError ?? null }
      },
      select: () => ({
        eq: async () => ({
          data: [{ id: "m1", fact: "likes tea" }],
          error: opts.selectError ?? null,
        }),
      }),
      delete: () => ({ in: async () => ({ error: opts.deleteError ?? null }) }),
    }),
  }
  const deps = { getClient: async () => client } as unknown as MemoryToolDeps
  return { deps, inserted }
}

const run = (t: { execute?: unknown }, input: unknown) =>
  (t.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {
    toolCallId: "t",
    messages: [],
  })

describe("memory tools surface DB failures", () => {
  test("rememberFact → ok when the insert succeeds", async () => {
    const { deps, inserted } = fakeClient()
    const { rememberFact } = buildMemoryTools({ conversationId: null }, deps)
    expect(await run(rememberFact, { fact: "likes tea" })).toEqual({ ok: true })
    expect(inserted).toHaveLength(1)
  })

  test("rememberFact → not ok when the insert returns an error", async () => {
    const { deps } = fakeClient({ insertError: { message: "rls" } })
    const { rememberFact } = buildMemoryTools({ conversationId: null }, deps)
    expect(await run(rememberFact, { fact: "likes tea" })).toEqual({
      ok: false,
      error: "could not save",
    })
  })

  test("forgetFact → not ok when the delete returns an error", async () => {
    const { deps } = fakeClient({ deleteError: { message: "rls" } })
    const { forgetFact } = buildMemoryTools({ conversationId: null }, deps)
    expect(await run(forgetFact, { fact: "likes tea" })).toMatchObject({ ok: false, removed: 0 })
  })

  test("forgetFact → not ok when the lookup returns an error", async () => {
    const { deps } = fakeClient({ selectError: { message: "down" } })
    const { forgetFact } = buildMemoryTools({ conversationId: null }, deps)
    expect(await run(forgetFact, { fact: "likes tea" })).toMatchObject({ ok: false, removed: 0 })
  })

  test("forgetFact → removes the matched memory", async () => {
    const { deps } = fakeClient()
    const { forgetFact } = buildMemoryTools({ conversationId: null }, deps)
    expect(await run(forgetFact, { fact: "likes tea" })).toEqual({ ok: true, removed: 1 })
  })
})

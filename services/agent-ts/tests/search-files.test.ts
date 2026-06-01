/**
 * Tests for the agent-ts `searchFiles` tool.
 *
 * The Postgres RPC + transaction-scoped `SET LOCAL ROLE`
 * impersonation is exercised in integration; here we drive the
 * tool's `execute()` through a fake `Sql` that returns canned rows,
 * to verify:
 *   - input validation (auth, db config),
 *   - row → result mapping (fragments split on the delimiter),
 *   - the same code/wire shape agent-py + the Next.js inline skill
 *     return for the same inputs.
 */

import { describe, test, expect } from "bun:test"

import {
  type SearchFilesResult,
  buildSearchFilesTool,
} from "../src/search-files"

interface FakeSqlOpts {
  /** Rows to return from the RPC. Empty → simulates "no match /
   *  not_indexed". */
  rows?: Array<{ excerpt: string | null; rank: number | string }>
  /** Throw inside the transaction. */
  throwInside?: Error
  /** Throw on `begin` itself (connection failure). */
  throwOnBegin?: Error
  /** Capture statements + parameters for assertion. */
  captured?: Array<{ stmt: string; params?: unknown[] }>
}

/** Minimal fake of the `postgres` driver's `sql.begin(callback)`
 *  + `tx.unsafe(stmt, params)` surface — just enough to exercise
 *  the searchFiles transaction. */
function makeFakeSql(opts: FakeSqlOpts) {
  const capture = opts.captured ?? []
  const tx = {
    unsafe: async (stmt: string, params?: unknown[]) => {
      capture.push({ stmt, params })
      if (opts.throwInside) throw opts.throwInside
      if (stmt.includes("public.search_file_sections")) {
        return opts.rows ?? []
      }
      // SET LOCAL ROLE / set_config — no rows.
      return []
    },
  }
  type Tx = { unsafe: (stmt: string, params?: unknown[]) => Promise<unknown[]> }
  return {
    begin: async (cb: (tx: Tx) => Promise<unknown>) => {
      if (opts.throwOnBegin) throw opts.throwOnBegin
      return cb(tx as Tx)
    },
  } as never
}

interface ToolInvocableWithExecute {
  execute: (args: { fileId: string; query: string }) => Promise<SearchFilesResult>
}

describe("buildSearchFilesTool — guard paths", () => {
  test("empty userId → not_signed_in (no DB call)", async () => {
    const captured: FakeSqlOpts["captured"] = []
    const sql = makeFakeSql({ captured })
    const tool = buildSearchFilesTool({ userId: "", sql }) as unknown as ToolInvocableWithExecute
    const result = await tool.execute({ fileId: "abc", query: "x" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("not_signed_in")
      expect(result.fileId).toBe("abc")
      expect(result.query).toBe("x")
    }
    // Should NOT have made any SQL calls.
    expect(captured.length).toBe(0)
  })

  test("null sql → upstream code (no DB call)", async () => {
    const tool = buildSearchFilesTool({
      userId: "u-1",
      sql: null,
    }) as unknown as ToolInvocableWithExecute
    const result = await tool.execute({ fileId: "abc", query: "x" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("upstream")
      expect(result.error.toLowerCase()).toContain("database")
    }
  })
})

describe("buildSearchFilesTool — RLS impersonation pattern", () => {
  test("sets role + claims inside the transaction, then runs the RPC", async () => {
    const captured: FakeSqlOpts["captured"] = []
    const sql = makeFakeSql({
      captured,
      rows: [
        {
          excerpt: "first frag‖second frag‖third frag",
          rank: 0.42,
        },
      ],
    })
    const tool = buildSearchFilesTool({ userId: "user-1", sql }) as unknown as ToolInvocableWithExecute
    await tool.execute({ fileId: "00000000-0000-0000-0000-000000000001", query: "test" })

    // Should be three statements in order: SET ROLE → set_config → SELECT.
    expect(captured.length).toBe(3)
    expect(captured[0]?.stmt).toContain("SET LOCAL ROLE authenticated")
    expect(captured[1]?.stmt).toContain("set_config('request.jwt.claims'")
    const claimsParam = captured[1]?.params?.[0] as string | undefined
    expect(typeof claimsParam).toBe("string")
    expect(JSON.parse(claimsParam ?? "{}")).toEqual({
      sub: "user-1",
      role: "authenticated",
    })
    expect(captured[2]?.stmt).toContain("public.search_file_sections")
    expect(captured[2]?.params).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "test",
      3,
      120,
      30,
    ])
  })
})

describe("buildSearchFilesTool — result mapping", () => {
  test("split on FRAGMENT_DELIMITER → fragments[]", async () => {
    const sql = makeFakeSql({
      rows: [
        {
          excerpt: "alpha‖beta‖gamma",
          rank: 0.5,
        },
      ],
    })
    const tool = buildSearchFilesTool({ userId: "u", sql }) as unknown as ToolInvocableWithExecute
    const result = await tool.execute({ fileId: "f-1", query: "q" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.fragments).toEqual(["alpha", "beta", "gamma"])
      expect(result.rank).toBe(0.5)
    }
  })

  test("empty excerpt rows → no_match", async () => {
    const sql = makeFakeSql({
      rows: [{ excerpt: "", rank: 0.5 }],
    })
    const tool = buildSearchFilesTool({ userId: "u", sql }) as unknown as ToolInvocableWithExecute
    const result = await tool.execute({ fileId: "f", query: "q" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("no_match")
  })

  test("rank 0 (ts_headline fallback) → no_match", async () => {
    const sql = makeFakeSql({
      rows: [{ excerpt: "some text", rank: 0 }],
    })
    const tool = buildSearchFilesTool({ userId: "u", sql }) as unknown as ToolInvocableWithExecute
    const result = await tool.execute({ fileId: "f", query: "q" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("no_match")
  })

  test("zero rows → not_indexed", async () => {
    const sql = makeFakeSql({ rows: [] })
    const tool = buildSearchFilesTool({ userId: "u", sql }) as unknown as ToolInvocableWithExecute
    const result = await tool.execute({ fileId: "f", query: "q" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("not_indexed")
  })

  test("DB throw inside transaction → upstream code", async () => {
    const sql = makeFakeSql({
      throwInside: new Error("connection lost"),
    })
    const tool = buildSearchFilesTool({ userId: "u", sql }) as unknown as ToolInvocableWithExecute
    const result = await tool.execute({ fileId: "f", query: "q" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("upstream")
      expect(result.error).toContain("connection lost")
    }
  })

  test("rank coerced from string (postgres driver numeric)", async () => {
    const sql = makeFakeSql({
      rows: [{ excerpt: "a‖b", rank: "0.123" }],
    })
    const tool = buildSearchFilesTool({ userId: "u", sql }) as unknown as ToolInvocableWithExecute
    const result = await tool.execute({ fileId: "f", query: "q" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.rank).toBe(0.123)
  })

  test("trims + drops empty fragments from delimiter splits", async () => {
    const sql = makeFakeSql({
      rows: [
        {
          excerpt: "  one ‖  ‖two‖   ‖three",
          rank: 0.9,
        },
      ],
    })
    const tool = buildSearchFilesTool({ userId: "u", sql }) as unknown as ToolInvocableWithExecute
    const result = await tool.execute({ fileId: "f", query: "q" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.fragments).toEqual(["one", "two", "three"])
  })
})

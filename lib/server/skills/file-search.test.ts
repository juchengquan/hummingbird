import { describe, expect, test } from "bun:test"

import type { SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "@/shared/supabase/types"

import {
  blendSearchFragments,
  buildSearchFilesTool,
  clampMaxSearchFiles,
  searchFilesSkill,
  type SearchFilesLog,
  type SearchFilesResult,
} from "./file-search"

// --- clampMaxSearchFiles ---------------------------------------------------

describe("clampMaxSearchFiles", () => {
  test("default for non-finite input", () => {
    expect(clampMaxSearchFiles(Number.NaN)).toBe(3)
    expect(clampMaxSearchFiles(Number.POSITIVE_INFINITY)).toBe(3)
  })
  test("rounds and clamps to [1, 10]", () => {
    expect(clampMaxSearchFiles(0)).toBe(1)
    expect(clampMaxSearchFiles(0.4)).toBe(1)
    expect(clampMaxSearchFiles(2.6)).toBe(3)
    expect(clampMaxSearchFiles(100)).toBe(10)
  })
})

// --- searchFilesSkill registry shape --------------------------------------

describe("searchFilesSkill", () => {
  test("has id 'searchFiles' and tool name 'searchFiles'", () => {
    expect(searchFilesSkill.id).toBe("searchFiles")
    expect(searchFilesSkill.toolName).toBe("searchFiles")
  })
  test("promptFragment is non-empty and mentions the tool signature", () => {
    const note = searchFilesSkill.promptFragment(undefined)
    expect(note).not.toBeNull()
    expect(note!.length).toBeGreaterThan(0)
    expect(note).toContain("searchFiles({ fileId, query })")
    expect(note).toContain("HARD LIMIT")
  })
})

// --- buildSearchFilesTool: integration via stubbed Supabase client --------

/**
 * Stubs the subset of SupabaseClient we use: `.rpc(name, params)`
 * returning `{ data, error }`. Records the most recent call so tests
 * can assert what was sent.
 */
function makeFakeClient(
  rpcImpl: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message: string } | null }>
): {
  client: SupabaseClient<Database>
  lastCall: { name: string; args: Record<string, unknown> } | null
} {
  let last: { name: string; args: Record<string, unknown> } | null = null
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      last = { name, args }
      return rpcImpl(name, args)
    },
  } as unknown as SupabaseClient<Database>
  // Test helper: read .lastCall via a getter on the returned object,
  // not on the client itself.
  return {
    client,
    get lastCall() {
      return last
    },
  }
}

async function execTool(
  t: ReturnType<typeof buildSearchFilesTool>,
  fileId: string,
  query: string
): Promise<SearchFilesResult> {
  if (!t.execute) throw new Error("tool has no execute")
  return (await t.execute(
    { fileId, query },
    { toolCallId: "test", messages: [] }
  )) as SearchFilesResult
}

describe("buildSearchFilesTool", () => {
  test("not_signed_in: client is null → returns code 'not_signed_in' without RPC", async () => {
    const log: SearchFilesLog = []
    const t = buildSearchFilesTool(log, { maxCalls: 3, client: null })
    const out = await execTool(t, "file-1", "anything")
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("expected failure")
    expect(out.code).toBe("not_signed_in")
    expect(log).toEqual([
      { fileId: "file-1", query: "anything", ok: false, fragmentCount: 0 },
    ])
  })

  test("happy path: RPC returns excerpt + rank → fragments parsed and returned", async () => {
    const fake = makeFakeClient(async () => ({
      data: [
        {
          excerpt:
            "Some text mentioning «query» here.‖Another fragment with «query» in it.",
          rank: 0.42,
        },
      ],
      error: null,
    }))
    const log: SearchFilesLog = []
    const t = buildSearchFilesTool(log, { maxCalls: 3, client: fake.client })
    const out = await execTool(t, "file-1", "query")
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error("expected success")
    expect(out.fragments).toEqual([
      "Some text mentioning «query» here.",
      "Another fragment with «query» in it.",
    ])
    expect(out.rank).toBe(0.42)
    expect(log).toEqual([
      { fileId: "file-1", query: "query", ok: true, fragmentCount: 2 },
    ])
  })

  test("happy path: RPC args carry the per-call defaults", async () => {
    const fake = makeFakeClient(async () => ({
      data: [{ excerpt: "fragment", rank: 0.1 }],
      error: null,
    }))
    const log: SearchFilesLog = []
    const t = buildSearchFilesTool(log, { maxCalls: 3, client: fake.client })
    await execTool(t, "file-id-123", "search query")
    expect(fake.lastCall?.name).toBe("search_file_sections")
    expect(fake.lastCall?.args).toMatchObject({
      p_file_id: "file-id-123",
      p_query: "search query",
      p_max_fragments: 3,
      p_max_words: 120,
      p_min_words: 30,
    })
  })

  test("not_indexed: empty rows → code 'not_indexed'", async () => {
    const fake = makeFakeClient(async () => ({ data: [], error: null }))
    const log: SearchFilesLog = []
    const t = buildSearchFilesTool(log, { maxCalls: 3, client: fake.client })
    const out = await execTool(t, "file-x", "anything")
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("expected failure")
    expect(out.code).toBe("not_indexed")
  })

  test("no_match: rank=0 → code 'no_match' (ts_headline fallback excerpt)", async () => {
    // ts_headline returns the file's opening text even when nothing
    // matches; rank=0 is the signal.
    const fake = makeFakeClient(async () => ({
      data: [{ excerpt: "Opening words of the file…", rank: 0 }],
      error: null,
    }))
    const log: SearchFilesLog = []
    const t = buildSearchFilesTool(log, { maxCalls: 3, client: fake.client })
    const out = await execTool(t, "file-1", "nonexistent term")
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("expected failure")
    expect(out.code).toBe("no_match")
  })

  test("upstream: RPC error surfaces as code 'upstream'", async () => {
    const fake = makeFakeClient(async () => ({
      data: null,
      error: { message: "permission denied" },
    }))
    const log: SearchFilesLog = []
    const t = buildSearchFilesTool(log, { maxCalls: 3, client: fake.client })
    const out = await execTool(t, "file-1", "q")
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("expected failure")
    expect(out.code).toBe("upstream")
    expect(out.error).toContain("permission denied")
  })

  test("budget: cap exhausted → code 'budget'", async () => {
    const fake = makeFakeClient(async () => ({
      data: [{ excerpt: "ok", rank: 0.5 }],
      error: null,
    }))
    const log: SearchFilesLog = []
    const t = buildSearchFilesTool(log, { maxCalls: 1, client: fake.client })
    const first = await execTool(t, "file-1", "q1")
    expect(first.ok).toBe(true)
    const second = await execTool(t, "file-1", "q2")
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error("expected failure")
    expect(second.code).toBe("budget")
    expect(log.length).toBe(2)
  })

  test("rate_limit: consumeBudget refuses → code 'rate_limit' without RPC", async () => {
    let rpcCalls = 0
    const fake = makeFakeClient(async () => {
      rpcCalls++
      return { data: [], error: null }
    })
    const log: SearchFilesLog = []
    const t = buildSearchFilesTool(log, {
      maxCalls: 3,
      client: fake.client,
      consumeBudget: () => ({ allowed: false, retryAfterSec: 17 }),
    })
    const out = await execTool(t, "file-1", "q")
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("expected failure")
    expect(out.code).toBe("rate_limit")
    expect(out.error).toContain("17s")
    expect(rpcCalls).toBe(0)
  })

  test("fragment splitting tolerates leading/trailing whitespace and empties", async () => {
    const fake = makeFakeClient(async () => ({
      data: [{ excerpt: "  one  ‖‖  two  ‖", rank: 0.3 }],
      error: null,
    }))
    const t = buildSearchFilesTool([], { maxCalls: 3, client: fake.client })
    const out = await execTool(t, "f", "q")
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error("expected success")
    expect(out.fragments).toEqual(["one", "two"])
  })
})

// --- blendSearchFragments (pure) ------------------------------------------

describe("blendSearchFragments", () => {
  test("empty vector arm → FTS verbatim (capped)", () => {
    expect(blendSearchFragments(["a", "b", "c"], [], 5)).toEqual(["a", "b", "c"])
    expect(blendSearchFragments(["a", "b", "c"], [], 2)).toEqual(["a", "b"])
  })

  test("FTS first, then novel vector fragments fill remaining slots", () => {
    const out = blendSearchFragments(["fts one", "fts two"], ["vec one"], 5)
    expect(out).toEqual(["fts one", "fts two", "vec one"])
  })

  test("dedupes a vector chunk that repeats an FTS excerpt (markers ignored)", () => {
    // Same span: FTS marks the matched term, vector returns it raw.
    const out = blendSearchFragments(
      ["The «invoice» total was $4,200 due in March."],
      ["The invoice total was $4,200 due in March.", "A genuinely different chunk."],
      5
    )
    expect(out).toEqual([
      "The «invoice» total was $4,200 due in March.",
      "A genuinely different chunk.",
    ])
  })

  test("respects the cap across both arms", () => {
    const out = blendSearchFragments(["a", "b", "c"], ["d", "e"], 4)
    expect(out).toHaveLength(4)
    expect(out).toEqual(["a", "b", "c", "d"])
  })

  test("drops blank fragments", () => {
    expect(blendSearchFragments(["  ", "real"], ["", "  vec  "], 5)).toEqual([
      "real",
      "vec",
    ])
  })
})

// --- hybrid execute (FTS + vector) ----------------------------------------

/**
 * Routes `.rpc(name, …)` to a per-name handler so a hybrid call can
 * return distinct FTS and vector payloads.
 */
function makeHybridClient(handlers: {
  fts: () => { data: unknown; error: { message: string } | null }
  vector: () => { data: unknown; error: { message: string } | null }
}): SupabaseClient<Database> {
  return {
    rpc: async (name: string) => {
      if (name === "match_file_sections") return handlers.vector()
      return handlers.fts()
    },
  } as unknown as SupabaseClient<Database>
}

const fakeEmbedQuery = async (): Promise<number[]> => [0.1, 0.2, 0.3]

describe("buildSearchFilesTool — hybrid (vector arm enabled)", () => {
  test("fuses FTS excerpts with novel vector chunks", async () => {
    const client = makeHybridClient({
      fts: () => ({ data: [{ excerpt: "lexical hit", rank: 0.5 }], error: null }),
      vector: () => ({
        data: [
          { content: "semantic chunk", similarity: 0.8 },
          { content: "lexical hit", similarity: 0.6 }, // dupes the FTS one
        ],
        error: null,
      }),
    })
    const log: SearchFilesLog = []
    const t = buildSearchFilesTool(log, {
      maxCalls: 3,
      client,
      embedQuery: fakeEmbedQuery,
    })
    const out = await execTool(t, "f1", "q")
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error("expected success")
    expect(out.fragments).toEqual(["lexical hit", "semantic chunk"])
  })

  test("vector rescues an FTS miss (rank 0 → semantic match returned)", async () => {
    const client = makeHybridClient({
      // ts_headline fallback: opening words, rank 0 = no real match.
      fts: () => ({ data: [{ excerpt: "opening words…", rank: 0 }], error: null }),
      vector: () => ({
        data: [{ content: "the semantically relevant passage", similarity: 0.7 }],
        error: null,
      }),
    })
    const t = buildSearchFilesTool([], {
      maxCalls: 3,
      client,
      embedQuery: fakeEmbedQuery,
    })
    const out = await execTool(t, "f1", "q")
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error("expected success")
    expect(out.fragments).toEqual(["the semantically relevant passage"])
    expect(out.rank).toBe(0)
  })

  test("low-similarity vector chunks are filtered out", async () => {
    const client = makeHybridClient({
      fts: () => ({ data: [], error: null }),
      vector: () => ({
        data: [{ content: "barely related", similarity: 0.05 }],
        error: null,
      }),
    })
    const t = buildSearchFilesTool([], {
      maxCalls: 3,
      client,
      embedQuery: fakeEmbedQuery,
    })
    const out = await execTool(t, "f1", "q")
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error("expected failure")
    expect(out.code).toBe("not_indexed")
  })

  test("vector RPC error degrades to FTS-only (still succeeds)", async () => {
    const client = makeHybridClient({
      fts: () => ({ data: [{ excerpt: "lexical hit", rank: 0.5 }], error: null }),
      vector: () => ({ data: null, error: { message: "vector index missing" } }),
    })
    const t = buildSearchFilesTool([], {
      maxCalls: 3,
      client,
      embedQuery: fakeEmbedQuery,
    })
    const out = await execTool(t, "f1", "q")
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error("expected success")
    expect(out.fragments).toEqual(["lexical hit"])
  })

  test("embed failure degrades to FTS-only (still succeeds)", async () => {
    const client = makeHybridClient({
      fts: () => ({ data: [{ excerpt: "lexical hit", rank: 0.5 }], error: null }),
      vector: () => ({ data: [{ content: "unused", similarity: 0.9 }], error: null }),
    })
    const t = buildSearchFilesTool([], {
      maxCalls: 3,
      client,
      embedQuery: async () => {
        throw new Error("embedder down")
      },
    })
    const out = await execTool(t, "f1", "q")
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error("expected success")
    expect(out.fragments).toEqual(["lexical hit"])
  })
})

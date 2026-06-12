import "server-only"

/**
 * File-search skill — Postgres FTS over attached files' full text.
 *
 * Phase 3 of the file full-text retrieval plan
 * (docs/PLAN-file-full-text-retrieval.md). Exposes a single
 * `searchFiles({ fileId, query })` tool to the model. The tool RPCs
 * into `search_file_sections` (0009 migration), which wraps Postgres
 * `ts_headline` over the `files.full_text` column added in 0007.
 *
 * Why this skill exists: Phase 1 raised the inline file budget to
 * 100 KB but real PDFs routinely extract to 500+ KB. With Phase 2,
 * the full text lives in `files.full_text` (up to 1 MB). The
 * `searchFiles` tool is how the model gets at the sections that
 * didn't fit the inline budget — narrow, query-driven retrieval
 * instead of dumping the whole file into every turn.
 *
 * Authorization: the function is SECURITY INVOKER, so RLS on `files`
 * (0002) evaluates against the caller's `auth.uid()`. A signed-in
 * user can only search their own files; an anonymous request gets a
 * structured error ("not signed in") and the model is told to
 * mention that.
 *
 * No-backward-compat note: when a file's `full_text` is null (file
 * was uploaded before Phase 2 shipped, or extraction produced no
 * text), the tool returns `code: 'not_indexed'` rather than falling
 * back to `extracted_text`. The user has to re-upload the file to
 * enable search. This is intentional per the user's
 * "active-development, no backward compat" stance — cleaner than
 * juggling two retrieval paths.
 */

import { tool } from "ai"
import { z } from "zod"

import type { SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "@/shared/supabase/types"
import { embedText, isEmbeddingConfigured } from "@/server/embeddings/provider"

const DEFAULT_MAX_CALLS = 3
const MIN_MAX_CALLS = 1
const MAX_MAX_CALLS = 10

const MAX_FRAGMENTS_DEFAULT = 3
const MAX_WORDS_DEFAULT = 120
const MIN_WORDS_DEFAULT = 30

const FRAGMENT_DELIMITER = "‖"

// --- Hybrid (FTS + vector) knobs -------------------------------------------
// The vector arm (PLAN-local-rag.md PR 3) augments the lexical FTS arm
// with cosine matches from `match_file_sections`. It only runs when an
// embedder is configured AND the file has embedded chunks; otherwise this
// stays pure FTS, byte-for-byte as before.

/** Chunks pulled from the vector index per query. */
const VECTOR_MATCH_COUNT = 5
/** Minimum cosine similarity (1 - distance) for a vector chunk to count.
 *  A coarse noise floor — `match_file_sections` already returns the
 *  nearest K, so this just drops obviously-unrelated tails. Tuned for
 *  `nomic-embed-text`; a different model may want a different floor. */
const MIN_VECTOR_SIMILARITY = 0.3
/** Cap on the fused fragment list returned to the model. Slightly above
 *  the FTS-only default (3) so vector matches can add to — not just
 *  replace — the lexical hits. */
const MAX_BLENDED_FRAGMENTS = 5

export function clampMaxSearchFiles(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MAX_CALLS
  const r = Math.round(n)
  if (r < MIN_MAX_CALLS) return MIN_MAX_CALLS
  if (r > MAX_MAX_CALLS) return MAX_MAX_CALLS
  return r
}

export interface SearchFilesInvocation {
  fileId: string
  query: string
  ok: boolean
  /** Number of fragments returned. Zero on miss or error. */
  fragmentCount: number
}

export type SearchFilesLog = SearchFilesInvocation[]

interface SearchFilesSuccess {
  ok: true
  fileId: string
  query: string
  /** Ordered list of best-matching fragments. Each contains matched
   *  terms wrapped in « / » markers so the model can see what
   *  triggered the hit. */
  fragments: string[]
  /** Postgres `ts_rank` score. Useful diagnostic, no UX use today. */
  rank: number
}

interface SearchFilesFailure {
  ok: false
  fileId: string
  query: string
  error: string
  code:
    | "rate_limit"
    | "budget"
    | "not_signed_in"
    | "not_indexed"
    | "not_found"
    | "no_match"
    | "upstream"
}

export type SearchFilesResult = SearchFilesSuccess | SearchFilesFailure

interface BuildOpts {
  maxCalls: number
  /** Supabase client bound to the caller's session (cookies). RLS on
   *  `files` flows through the user's `auth.uid()`, so we don't need
   *  a separate authorization layer here. When null, the tool
   *  returns `code: 'not_signed_in'` for every call. */
  client: SupabaseClient<Database> | null
  consumeBudget?: () => { allowed: boolean; retryAfterSec: number }
  /** Embeds the query for the vector arm. When set, the tool also runs
   *  `match_file_sections` and fuses the results with FTS. When absent
   *  (no embedder configured), the tool is pure FTS. Injected so tests
   *  can exercise the hybrid path without a live embedder. */
  embedQuery?: (query: string) => Promise<number[]>
}

/** Strip the « » match markers FTS adds, lowercase, and collapse
 *  whitespace — a normalized key for cross-arm dedupe (FTS excerpts and
 *  vector chunks overlap in source text but aren't byte-identical). */
function normalizeFragment(s: string): string {
  return s
    .replace(/[«»]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Fuse lexical (FTS) and semantic (vector) fragments into one ranked,
 * de-duplicated list. FTS fragments come first — they carry the « »
 * term highlighting the model uses to see what matched — then novel
 * vector chunks fill the remaining slots up to `cap`. Dedupe is a
 * heuristic prefix-containment check: two fragments collapse when one's
 * normalized 80-char prefix is contained in the other (cheap, and the
 * two arms quote overlapping spans of the same file).
 *
 * Pure (no I/O) so it's unit-tested in isolation. With an empty `vec`
 * arm it returns FTS verbatim (capped), so FTS-only behaviour is
 * unchanged when no embedder is configured.
 */
export function blendSearchFragments(
  fts: string[],
  vec: string[],
  cap: number
): string[] {
  const out: string[] = []
  const seen: string[] = []
  const isDupe = (norm: string): boolean =>
    seen.some(
      (k) => k.includes(norm.slice(0, 80)) || norm.includes(k.slice(0, 80))
    )
  const add = (frag: string): void => {
    if (out.length >= cap) return
    const f = frag.trim()
    if (!f) return
    const norm = normalizeFragment(f)
    if (!norm || isDupe(norm)) return
    seen.push(norm)
    out.push(f)
  }
  for (const f of fts) add(f)
  for (const v of vec) add(v)
  return out
}

export function buildSearchFilesTool(log: SearchFilesLog, opts: BuildOpts) {
  const cap = clampMaxSearchFiles(opts.maxCalls)
  return tool({
    description:
      "Search the full text of an attached file for sections matching a query. " +
      "Use this when an attached file's inline view was truncated and the user's " +
      "question references content that might be in the omitted portion. The tool " +
      "returns paragraph-sized excerpts ranked by relevance — keyword full-text " +
      "search, blended with semantic (vector) matching when the file is embedded — " +
      "with matched terms wrapped in « » markers. " +
      `HARD LIMIT: ${cap} call${cap === 1 ? "" : "s"} per turn. ` +
      "Only works on files attached to the current chat; pick the most likely " +
      "file rather than searching every attachment.",
    inputSchema: z.object({
      fileId: z
        .string()
        .min(1)
        .max(64)
        .describe(
          "ID of the attached file to search. Must be one of the files the " +
            "user has attached to this conversation."
        ),
      query: z
        .string()
        .min(1)
        .max(400)
        .describe(
          "Natural-language search query. Stemmed via Postgres English FTS, " +
            "so word forms (run/ran/running) match each other."
        ),
    }),
    execute: async ({ fileId, query }): Promise<SearchFilesResult> => {
      // Per-IP cross-turn gate first — webSearch/webFetch/searchFiles
      // share the same chat-route bucket today.
      const budget = opts.consumeBudget?.()
      if (budget && !budget.allowed) {
        log.push({ fileId, query, ok: false, fragmentCount: 0 })
        return {
          ok: false,
          fileId,
          query,
          code: "rate_limit",
          error:
            `searchFiles rate limit exceeded for this IP. Retry in ${budget.retryAfterSec}s. ` +
            "The chat route shares this bucket across webSearch, webFetch, and searchFiles.",
        }
      }

      if (log.length >= cap) {
        log.push({ fileId, query, ok: false, fragmentCount: 0 })
        return {
          ok: false,
          fileId,
          query,
          code: "budget",
          error:
            `searchFiles budget exhausted (${cap} ${cap === 1 ? "call" : "calls"} per turn). ` +
            "Answer with the excerpts already returned or ask the user to focus the question.",
        }
      }

      if (!opts.client) {
        log.push({ fileId, query, ok: false, fragmentCount: 0 })
        return {
          ok: false,
          fileId,
          query,
          code: "not_signed_in",
          error:
            "searchFiles requires sign-in. Full text is only stored for files " +
            "uploaded by signed-in users. Tell the user they need to sign in.",
        }
      }

      // --- Lexical arm (FTS) -------------------------------------------
      const { data, error } = await opts.client.rpc("search_file_sections", {
        p_file_id: fileId,
        p_query: query,
        p_max_fragments: MAX_FRAGMENTS_DEFAULT,
        p_max_words: MAX_WORDS_DEFAULT,
        p_min_words: MIN_WORDS_DEFAULT,
      })

      const ftsRow = !error && data && data.length > 0 ? data[0] : null
      // ts_headline returns the file's opening words even with no match;
      // a zero ts_rank is the "no real match" signal, so only harvest
      // fragments when the rank is positive.
      const ftsRank = ftsRow?.rank ?? 0
      const ftsFragments =
        ftsRow && ftsRank > 0
          ? (ftsRow.excerpt ?? "")
              .split(FRAGMENT_DELIMITER)
              .map((s) => s.trim())
              .filter(Boolean)
          : []

      // --- Semantic arm (vector) — best-effort augmentation -----------
      // Runs only when an embedder is wired (opts.embedQuery set). Any
      // failure (embed error, RPC error, no embedded chunks) degrades to
      // FTS-only — the vector arm never turns a working search into an
      // error.
      let vectorFragments: string[] = []
      if (opts.embedQuery) {
        try {
          const queryVector = await opts.embedQuery(query)
          if (queryVector.length > 0) {
            const { data: vData, error: vError } = await opts.client.rpc(
              "match_file_sections",
              {
                p_file_id: fileId,
                // pgvector accepts its text representation.
                p_query_embedding: JSON.stringify(queryVector),
                p_match_count: VECTOR_MATCH_COUNT,
              }
            )
            if (!vError && vData) {
              vectorFragments = vData
                .filter((r) => (r.similarity ?? 0) >= MIN_VECTOR_SIMILARITY)
                .map((r) => r.content)
                .filter((c): c is string => Boolean(c))
            }
          }
        } catch {
          // Swallow — semantic search is additive over the lexical arm.
        }
      }

      // --- Fuse -------------------------------------------------------
      const fragments = blendSearchFragments(
        ftsFragments,
        vectorFragments,
        MAX_BLENDED_FRAGMENTS
      )

      if (fragments.length > 0) {
        log.push({ fileId, query, ok: true, fragmentCount: fragments.length })
        return { ok: true, fileId, query, fragments, rank: ftsRank }
      }

      // Nothing from either arm. Preserve the FTS-only failure taxonomy
      // so the model gets the same actionable message as before.
      if (error) {
        log.push({ fileId, query, ok: false, fragmentCount: 0 })
        return {
          ok: false,
          fileId,
          query,
          code: "upstream",
          error: `searchFiles upstream error: ${error.message}`,
        }
      }

      // Zero rows = file doesn't exist for this user (RLS filtered), OR
      // exists but has no full_text (not_indexed) and no embedded chunks.
      // "Not found" is a fine umbrella either way — re-upload fixes both.
      if (!data || data.length === 0) {
        log.push({ fileId, query, ok: false, fragmentCount: 0 })
        return {
          ok: false,
          fileId,
          query,
          code: "not_indexed",
          error:
            "File not found or not yet indexed. Either the file isn't attached " +
            "to this chat, or it was uploaded before full-text indexing was " +
            "enabled and needs to be re-uploaded.",
        }
      }

      log.push({ fileId, query, ok: false, fragmentCount: 0 })
      return {
        ok: false,
        fileId,
        query,
        code: "no_match",
        error:
          `No sections of this file match "${query}". Try a different query, ` +
          "or use a broader phrasing.",
      }
    },
  })
}

// --- ServerSkill entry -----------------------------------------------------

import type { ServerSkill } from "@/server/skills/registry"
import { getSupabaseServerClient } from "@/server/supabase/server"

/**
 * Registry entry for the searchFiles skill. The skill adapter resolves
 * the per-request Supabase server client (from auth cookies) and hands
 * it to the tool builder. Anonymous callers get a `client === null`
 * tool, which returns `code: 'not_signed_in'` on invocation rather
 * than refusing to register — that way the model can mention the
 * sign-in requirement to the user instead of pretending the tool
 * doesn't exist.
 */
export const searchFilesSkill: ServerSkill = {
  id: "searchFiles",
  toolName: "searchFiles",
  buildTool(_requestEntry, ctx) {
    // The plan documents a per-skill maxCalls knob (Phase 5 polish),
    // but we don't have a config schema for it yet. Default is fine.
    const log: SearchFilesLog = []
    // Enable the semantic arm only when an embedder is wired. Constant
    // across the request, so resolve once. When unset, the tool is pure
    // FTS (PLAN-local-rag.md PR 3).
    const embedQuery = isEmbeddingConfigured() ? embedText : undefined
    // ServerSkill.buildTool is synchronous but client resolution is
    // async. Resolve eagerly inside an IIFE — the AI SDK only calls
    // execute() once the model picks the tool, by which point the
    // client is settled. This is the same pattern other server-side
    // resolves would use (no current example to mirror — first one).
    let clientPromise: Promise<SupabaseClient<Database> | null> | null = null
    const getClient = () => {
      if (!clientPromise) clientPromise = getSupabaseServerClient()
      return clientPromise
    }
    // Wrap the tool's execute in a lazy-client passthrough. We build
    // the AI-SDK tool with a placeholder client of null, and intercept
    // execute() to await the real one. Cleaner than reshaping the
    // ServerSkill interface to be async.
    const lazyTool = buildSearchFilesTool(log, {
      maxCalls: DEFAULT_MAX_CALLS,
      client: null, // overridden via the proxy below
      consumeBudget: ctx.consumeBudget,
      embedQuery,
    })
    // The `tool()` helper returns an object whose `execute` we can
    // replace. Wrap to inject the resolved client.
    type ExecuteFn = (
      input: { fileId: string; query: string },
      opts: unknown
    ) => Promise<SearchFilesResult>
    lazyTool.execute = (async (input, sdkOpts) => {
      const client = await getClient()
      // Rebuild the tool with the real client and invoke once. Light:
      // the rebuild is just constant assembly, no I/O.
      const realTool = buildSearchFilesTool(log, {
        maxCalls: DEFAULT_MAX_CALLS,
        client,
        consumeBudget: ctx.consumeBudget,
        embedQuery,
      })
      return (realTool.execute as ExecuteFn)(input, sdkOpts)
    }) as typeof lazyTool.execute
    return lazyTool
  },
  promptFragment() {
    return (
      "You can call `searchFiles({ fileId, query })` to pull additional sections " +
      "from an attached file when its inline view was truncated. Returns " +
      "paragraph-sized excerpts ranked by relevance — keyword full-text search, " +
      "blended with semantic (vector) matching when the file has been embedded — " +
      "with matched terms wrapped in « » markers. Use this when the user's question references " +
      "content that may be in the omitted portion of a file (look for `[truncated]` " +
      "or `[Additional files omitted]` markers in the attachment block). " +
      `HARD LIMIT: ${DEFAULT_MAX_CALLS} calls per turn. Requires sign-in — for ` +
      "anonymous chats the tool returns a `not_signed_in` error and you should " +
      "tell the user to sign in instead of retrying."
    )
  },
}

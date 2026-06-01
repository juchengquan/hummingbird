/**
 * `searchFiles` tool — agent-ts implementation.
 *
 * Mirror of `services/agent-py/src/agent_py/tools/search_files.py` —
 * calls the `search_file_sections` Postgres RPC under per-user RLS
 * impersonation (`SET LOCAL ROLE authenticated` + the
 * `request.jwt.claims` GUC). Same SQL, same result shape, same
 * `FRAGMENT_DELIMITER` split as agent-py.
 *
 * Why a parallel impl instead of reusing
 * `lib/server/skills/file-search.ts`: that skill resolves Supabase
 * via cookies (`getSupabaseServerClient()`) and PostgREST. agent-ts
 * authenticates via the verified JWT `sub` claim and connects
 * directly through the `postgres` driver, so it can't use the
 * cookie path. The impersonation pattern here is the same one
 * `services/agent-ts/src/mcp.ts` uses for cloud-mode MCP cred
 * decrypt — proven shape, copied.
 *
 * Closes the open `searchFiles` follow-up surfaced in PR #143:
 * before this, `searchFilesSkill.buildTool` returned a tool whose
 * `execute` always returned `not_signed_in` because no cookie-based
 * Supabase client was available in the agent-ts process.
 */

import { tool } from "ai"
import { z } from "zod"

import type { Sql } from "./db"

const FRAGMENT_DELIMITER = "‖"
const MAX_FRAGMENTS = 3
const MAX_WORDS = 120
const MIN_WORDS = 30

const SET_ROLE_SQL = "SET LOCAL ROLE authenticated"
const SET_CLAIMS_SQL = "SELECT set_config('request.jwt.claims', $1, true)"
const SEARCH_SQL =
  "SELECT excerpt, rank FROM public.search_file_sections($1::uuid, $2::text, $3::int, $4::int, $5::int)"

export interface SearchFilesArgs {
  fileId: string
  query: string
}

export interface SearchFilesSuccess {
  ok: true
  fileId: string
  query: string
  /** Up to 3 paragraph-sized fragments, matched terms wrapped in
   *  « » markers (the `ts_headline` opening + closing tokens the
   *  RPC was configured with). */
  fragments: string[]
  rank: number
}

export interface SearchFilesFailure {
  ok: false
  fileId: string
  query: string
  error: string
  code: "not_signed_in" | "not_indexed" | "no_match" | "upstream"
}

export type SearchFilesResult = SearchFilesSuccess | SearchFilesFailure

interface SearchFilesRow {
  excerpt: string | null
  rank: number | string
}

/** Low-level: call the RPC under user impersonation. Returns the
 *  raw rows so the tool builder can map them into the same wire
 *  shape `lib/server/skills/file-search.ts` produces. */
export async function searchFileSections(
  sql: Sql,
  {
    userId,
    fileId,
    query,
  }: { userId: string; fileId: string; query: string },
): Promise<Array<{ excerpt: string; rank: number }>> {
  const rows = await sql.begin(async (tx) => {
    await tx.unsafe(SET_ROLE_SQL)
    await tx.unsafe(SET_CLAIMS_SQL, [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ])
    return tx.unsafe<SearchFilesRow[]>(SEARCH_SQL, [
      fileId,
      query,
      MAX_FRAGMENTS,
      MAX_WORDS,
      MIN_WORDS,
    ])
  })
  return rows.map((r) => ({
    excerpt: r.excerpt ?? "",
    rank: typeof r.rank === "number" ? r.rank : Number(r.rank) || 0,
  }))
}

export interface BuildSearchFilesToolOpts {
  /** Verified JWT sub claim. Empty / missing → the tool returns
   *  `not_signed_in` for every call without touching the DB. */
  userId: string
  /** Postgres pool from `db.ts`. When null (dev / no
   *  `SUPABASE_DB_URL`) we surface `upstream` rather than crash —
   *  same defensive behaviour as `mcp.ts`. */
  sql: Sql | null
}

/** Build the AI SDK `searchFiles` tool for an agent-ts chat turn.
 *  Same input schema, same `SearchFilesResult` wire shape as the
 *  Next.js inline skill — only the auth + DB path differs. */
export function buildSearchFilesTool(opts: BuildSearchFilesToolOpts) {
  return tool({
    description:
      "Search the full text of an attached file for sections matching a query. " +
      "Use this when an attached file's inline view was truncated and the user's " +
      "question references content that might be in the omitted portion. The tool " +
      "returns up to 3 paragraph-sized excerpts ranked by relevance, with matched " +
      "terms wrapped in « » markers. " +
      "Only works on files attached to the current chat; pick the most likely " +
      "file rather than searching every attachment.",
    inputSchema: z.object({
      fileId: z
        .string()
        .min(1)
        .max(64)
        .describe(
          "ID of the attached file to search. Must be one of the files the " +
            "user has attached to this conversation.",
        ),
      query: z
        .string()
        .min(1)
        .max(400)
        .describe(
          "Natural-language search query. Stemmed via Postgres English FTS, " +
            "so word forms (run/ran/running) match each other.",
        ),
    }),
    execute: async ({
      fileId,
      query,
    }: SearchFilesArgs): Promise<SearchFilesResult> => {
      if (!opts.userId) {
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
      if (!opts.sql) {
        return {
          ok: false,
          fileId,
          query,
          code: "upstream",
          error: "searchFiles: database pool is not configured on the agent service.",
        }
      }
      let rows: Array<{ excerpt: string; rank: number }>
      try {
        rows = await searchFileSections(opts.sql, {
          userId: opts.userId,
          fileId,
          query,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          ok: false,
          fileId,
          query,
          code: "upstream",
          error: `searchFiles upstream error: ${message}`,
        }
      }
      if (rows.length === 0) {
        // Same umbrella message as agent-py: zero rows means either
        // RLS hid the file or it has no indexed full_text. Re-upload
        // fixes both.
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
      const row = rows[0]
      if (!row) {
        return {
          ok: false,
          fileId,
          query,
          code: "not_indexed",
          error: "File not found or not yet indexed.",
        }
      }
      const fragments = row.excerpt
        .split(FRAGMENT_DELIMITER)
        .map((s: string) => s.trim())
        .filter(Boolean)
      // `ts_headline` returns the file's opening words when no FTS
      // match is found. Distinguish "real match" from "fallback
      // excerpt" via `ts_rank == 0` — same as agent-py / Next.js.
      if (row.rank === 0 || fragments.length === 0) {
        return {
          ok: false,
          fileId,
          query,
          code: "no_match",
          error:
            `No sections of this file match "${query}". Try a different query, ` +
            "or use a broader phrasing.",
        }
      }
      return {
        ok: true,
        fileId,
        query,
        fragments,
        rank: row.rank,
      }
    },
  })
}

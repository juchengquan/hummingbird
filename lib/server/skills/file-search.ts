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

const DEFAULT_MAX_CALLS = 3
const MIN_MAX_CALLS = 1
const MAX_MAX_CALLS = 10

const MAX_FRAGMENTS_DEFAULT = 3
const MAX_WORDS_DEFAULT = 120
const MIN_WORDS_DEFAULT = 30

const FRAGMENT_DELIMITER = "‖"

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
}

export function buildSearchFilesTool(log: SearchFilesLog, opts: BuildOpts) {
  const cap = clampMaxSearchFiles(opts.maxCalls)
  return tool({
    description:
      "Search the full text of an attached file for sections matching a query. " +
      "Use this when an attached file's inline view was truncated and the user's " +
      "question references content that might be in the omitted portion. The tool " +
      "returns up to 3 paragraph-sized excerpts ranked by relevance, with matched " +
      "terms wrapped in « » markers. " +
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

      const { data, error } = await opts.client.rpc("search_file_sections", {
        p_file_id: fileId,
        p_query: query,
        p_max_fragments: MAX_FRAGMENTS_DEFAULT,
        p_max_words: MAX_WORDS_DEFAULT,
        p_min_words: MIN_WORDS_DEFAULT,
      })

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

      // Zero rows = file doesn't exist for this user (RLS filtered),
      // OR exists but has no full_text (not_indexed). The
      // function's WHERE clause filters `full_text is not null`, so
      // we can't distinguish from inside SQL without a second query.
      // For the model, "not found" is a fine umbrella message either
      // way — re-upload fixes both.
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

      const row = data[0]
      const fragments = (row.excerpt ?? "")
        .split(FRAGMENT_DELIMITER)
        .map((s) => s.trim())
        .filter(Boolean)

      // ts_headline returns the file's opening words when no FTS match
      // is found. Distinguish "real match" from "fallback excerpt" via
      // ts_rank — zero rank means no match.
      if (row.rank === 0 || fragments.length === 0) {
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
      }

      log.push({ fileId, query, ok: true, fragmentCount: fragments.length })
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
      })
      return (realTool.execute as ExecuteFn)(input, sdkOpts)
    }) as typeof lazyTool.execute
    return lazyTool
  },
  promptFragment() {
    return (
      "You can call `searchFiles({ fileId, query })` to pull additional sections " +
      "from an attached file when its inline view was truncated. Returns up to 3 " +
      "paragraph-sized excerpts ranked by Postgres full-text search, with matched " +
      "terms wrapped in « » markers. Use this when the user's question references " +
      "content that may be in the omitted portion of a file (look for `[truncated]` " +
      "or `[Additional files omitted]` markers in the attachment block). " +
      `HARD LIMIT: ${DEFAULT_MAX_CALLS} calls per turn. Requires sign-in — for ` +
      "anonymous chats the tool returns a `not_signed_in` error and you should " +
      "tell the user to sign in instead of retrying."
    )
  },
}

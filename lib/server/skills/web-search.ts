import "server-only"
/**
 * Web search skill — single tool, multiple providers under the hood.
 *
 * The model sees one tool, `webSearch({ query })`. When invoked, the
 * server runs the query against every enabled+configured provider in
 * parallel (Tavily, Brave), dedupes by URL, interleaves the results so
 * neither provider dominates the first slots, and returns a single
 * merged result list. From the model's perspective, the choice of
 * provider is invisible — it just gets richer, dedup'd web results.
 *
 * Cap budget: one `webSearch` tool invocation = one cap unit, even when
 * it fans out to multiple providers. Matches the user's mental model
 * ("how many times can the model decide to search?") rather than
 * counting upstream API hits.
 *
 * Per-provider knobs (Tavily `searchDepth`, Brave `freshness`, …) are
 * resolved client-side from the cascade and arrive on the request as
 * `ResolvedWebSearchConfig`. Each provider's invocation uses its own
 * sub-config.
 *
 * Server-only: api keys live in env, never in the browser bundle.
 * Per-provider failures are tolerated — Tavily returning 500 doesn't
 * suppress Brave's results, and vice versa. If both fail we surface a
 * concise error to the model so it can fall back to training data.
 */

import { tool } from "ai"
import { z } from "zod"

import {
  clampMaxWebSearches,
  DEFAULT_BRAVE_FRESHNESS,
  DEFAULT_MAX_WEB_SEARCHES,
  DEFAULT_TAVILY_SEARCH_DEPTH,
  type BraveFreshness,
  type ResolvedWebSearchConfig,
  type TavilySearchDepth,
} from "@/shared/skills/web-search-config"

const SNIPPET_MAX = 600
const PER_PROVIDER_RESULTS = 5

export interface WebSearchInvocation {
  /** Which providers we asked on this tool call (in dispatch order). */
  providers: ("tavily" | "brave")[]
  query: string
  /** Count of unique results returned after dedup + merge. */
  resultCount: number
}

/**
 * Per-turn log of webSearch tool calls. Each entry counts as ONE cap
 * unit even when it fanned out to multiple providers. The chat route
 * reads this at stream end for diagnostics + the empty-response check.
 */
export type WebSearchLog = WebSearchInvocation[]

// --- Provider config detection ----------------------------------------------

export function isTavilyConfigured(): boolean {
  return !!process.env.TAVILY_API_KEY
}

export function isBraveConfigured(): boolean {
  return !!process.env.BRAVE_SEARCH_API_KEY
}

/** True when any provider is usable. */
export function isWebSearchConfigured(): boolean {
  return isTavilyConfigured() || isBraveConfigured()
}

// --- Shared types -----------------------------------------------------------

interface NormalizedResult {
  title: string
  url: string
  snippet: string
}

function clipSnippet(s: string): string {
  return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX)}…` : s
}

/**
 * Dedup key: normalise scheme + host + path (drop trailing slash). We
 * deliberately keep query + hash distinct because different params can
 * mean different pages on the same path (e.g. ?id=...). Tracking
 * params (utm_*, fbclid, gclid, ref) are stripped because they're
 * always cosmetic — two URLs that differ only in those are the same
 * page.
 */
function dedupKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    const TRACKING = /^(utm_|fbclid$|gclid$|mc_(c|e)id$|ref$|ref_$|igshid$|si$)/i
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING.test(key)) u.searchParams.delete(key)
    }
    const path = u.pathname.replace(/\/+$/, "") || "/"
    const search = u.searchParams.toString()
    return `${u.protocol}//${u.hostname.toLowerCase()}${path}${search ? `?${search}` : ""}`
  } catch {
    return rawUrl.trim().toLowerCase()
  }
}

// --- Tavily ----------------------------------------------------------------

interface TavilyResult {
  title: string
  url: string
  content: string
  score?: number
}

interface TavilyResponse {
  answer?: string
  results?: TavilyResult[]
}

const TAVILY_ENDPOINT = "https://api.tavily.com/search"

/** Per-provider call timeout. Bounds the chat-turn latency at this
 *  value even if one upstream is slow or hung. `Promise.all` over both
 *  providers then runs in parallel, so the user waits at most this
 *  long before the merge step. */
const PROVIDER_CALL_TIMEOUT_MS = 8_000

/**
 * Build the per-provider fetch signal. Combines a fresh
 * `PROVIDER_CALL_TIMEOUT_MS` timer with the upstream caller signal so
 * the outbound call aborts on whichever fires first (timeout OR
 * client disconnect).
 */
function buildProviderSignal(upstream: AbortSignal | undefined): {
  signal: AbortSignal
  cancel: () => void
} {
  const timer = new AbortController()
  const t = setTimeout(() => timer.abort(), PROVIDER_CALL_TIMEOUT_MS)
  const signal = upstream
    ? AbortSignal.any([timer.signal, upstream])
    : timer.signal
  return { signal, cancel: () => clearTimeout(t) }
}

async function tavilySearch(
  query: string,
  opts: { searchDepth: TavilySearchDepth; signal?: AbortSignal }
): Promise<{ results: NormalizedResult[] } | { results: []; error: string }> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) {
    return { results: [], error: "Tavily is not configured (missing TAVILY_API_KEY)." }
  }
  const { signal, cancel } = buildProviderSignal(opts.signal)
  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: PER_PROVIDER_RESULTS,
        search_depth: opts.searchDepth,
        include_answer: false,
      }),
      signal,
    })
    if (!res.ok) {
      return { results: [], error: `Tavily search failed (HTTP ${res.status}).` }
    }
    const data = (await res.json()) as TavilyResponse
    const results = (data.results ?? [])
      .slice(0, PER_PROVIDER_RESULTS)
      .map((r) => ({
        title: r.title ?? "",
        url: r.url,
        snippet: clipSnippet(r.content ?? ""),
      }))
      .filter((r) => r.url)
    return { results }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        results: [],
        error: `Tavily timed out after ${PROVIDER_CALL_TIMEOUT_MS}ms`,
      }
    }
    return {
      results: [],
      error: err instanceof Error ? err.message : "Tavily search failed",
    }
  } finally {
    cancel()
  }
}

// --- Brave -----------------------------------------------------------------

interface BraveWebResult {
  title?: string
  url?: string
  description?: string
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] }
}

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"

async function braveSearch(
  query: string,
  opts: { freshness: BraveFreshness; signal?: AbortSignal }
): Promise<{ results: NormalizedResult[] } | { results: []; error: string }> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY
  if (!apiKey) {
    return {
      results: [],
      error: "Brave Search is not configured (missing BRAVE_SEARCH_API_KEY).",
    }
  }
  const { signal, cancel } = buildProviderSignal(opts.signal)
  try {
    const url = new URL(BRAVE_ENDPOINT)
    url.searchParams.set("q", query)
    url.searchParams.set("count", String(PER_PROVIDER_RESULTS))
    if (opts.freshness !== "any") {
      url.searchParams.set("freshness", opts.freshness)
    }
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal,
    })
    if (!res.ok) {
      return { results: [], error: `Brave search failed (HTTP ${res.status}).` }
    }
    const data = (await res.json()) as BraveResponse
    const results = (data.web?.results ?? [])
      .slice(0, PER_PROVIDER_RESULTS)
      .filter((r): r is BraveWebResult & { url: string } => typeof r.url === "string")
      .map((r) => ({
        title: typeof r.title === "string" ? r.title : "",
        url: r.url,
        snippet: clipSnippet(r.description ?? ""),
      }))
    return { results }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        results: [],
        error: `Brave timed out after ${PROVIDER_CALL_TIMEOUT_MS}ms`,
      }
    }
    return {
      results: [],
      error: err instanceof Error ? err.message : "Brave search failed",
    }
  } finally {
    cancel()
  }
}

// --- Merge -----------------------------------------------------------------

/**
 * Round-robin merge across the per-provider result lists, deduping by
 * normalised URL on the way through. Order: take index 0 from each
 * provider in turn, then index 1, etc. Skips entries whose dedup key
 * we've already emitted. Preserves the relative "this provider thinks
 * this is the best hit" ranking signal — neither provider's #1 is
 * pushed below the other's #1.
 */
function interleaveAndDedupe(
  lists: NormalizedResult[][]
): NormalizedResult[] {
  const out: NormalizedResult[] = []
  const seen = new Set<string>()
  const maxLen = Math.max(0, ...lists.map((l) => l.length))
  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      const r = list[i]
      if (!r) continue
      const key = dedupKey(r.url)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(r)
    }
  }
  return out
}

// --- Tool builder ----------------------------------------------------------

export function buildWebSearchTool(
  log: WebSearchLog,
  config?: Partial<ResolvedWebSearchConfig>,
  /** Upstream abort signal (typically `req.signal` from the chat route).
   *  Propagated into each provider call alongside their own per-call
   *  timeout so client disconnect cancels in-flight searches. */
  upstreamSignal?: AbortSignal
) {
  // Decide which providers can actually run: enabled by user AND
  // configured on the server. If neither qualifies, don't register the
  // tool at all — the route detects this via the return value and tells
  // the model "search isn't available."
  const maxCalls = clampMaxWebSearches(config?.maxCalls ?? DEFAULT_MAX_WEB_SEARCHES)
  const tavilyOn = (config?.tavily?.enabled ?? true) && isTavilyConfigured()
  const braveOn = (config?.brave?.enabled ?? true) && isBraveConfigured()
  if (!tavilyOn && !braveOn) return null
  const tavilyDepth = config?.tavily?.searchDepth ?? DEFAULT_TAVILY_SEARCH_DEPTH
  const braveFreshness = config?.brave?.freshness ?? DEFAULT_BRAVE_FRESHNESS

  const providersDescriptionFragment = [
    tavilyOn ? "Tavily" : null,
    braveOn ? "Brave" : null,
  ]
    .filter(Boolean)
    .join(" + ")

  return tool({
    description:
      `Search the public web (${providersDescriptionFragment}) for current information ` +
      `when the user asks about something the model might not have, or asks for the latest ` +
      `details. The tool fans out to enabled providers in parallel, dedupes by URL, and ` +
      `returns merged results with title, URL, and a short snippet. Cite the URLs you use.`,
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(400)
        .describe(
          "Concise search query, like what you would type into a search engine."
        ),
    }),
    execute: async ({ query }) => {
      // Cap check: one tool invocation = one cap unit, regardless of
      // how many providers it fans out to.
      if (log.length >= maxCalls) {
        return {
          results: [],
          error: `Search budget exhausted (max ${maxCalls} per turn). Stop calling webSearch and answer from the results you already have.`,
        }
      }

      const runs: Array<{
        provider: "tavily" | "brave"
        result: Awaited<ReturnType<typeof tavilySearch>>
      }> = []
      const tasks: Promise<void>[] = []
      if (tavilyOn) {
        tasks.push(
          tavilySearch(query, { searchDepth: tavilyDepth, signal: upstreamSignal }).then((r) => {
            runs.push({ provider: "tavily", result: r })
          })
        )
      }
      if (braveOn) {
        tasks.push(
          braveSearch(query, { freshness: braveFreshness, signal: upstreamSignal }).then((r) => {
            runs.push({ provider: "brave", result: r })
          })
        )
      }
      // Each task swallows its own errors and returns an `error` field,
      // so `Promise.all` is equivalent to `allSettled` here — except
      // `all` short-circuits on a synchronous throw before the catch,
      // which neither helper should do. The per-provider timeouts above
      // bound the total wait time at `PROVIDER_CALL_TIMEOUT_MS`.
      await Promise.all(tasks)

      // Preserve the registration order (tavily, brave) when interleaving.
      runs.sort(
        (a, b) =>
          (a.provider === "tavily" ? 0 : 1) - (b.provider === "tavily" ? 0 : 1)
      )

      const lists = runs.map((r) =>
        "error" in r.result ? [] : r.result.results
      )
      const providerErrors = runs
        .filter((r) => "error" in r.result && r.result.error)
        .map((r) => `${r.provider}: ${(r.result as { error: string }).error}`)

      const merged = interleaveAndDedupe(lists)

      if (merged.length === 0) {
        // Both providers returned empty (or both errored). Surface the
        // error(s) so the model knows why and can fall back to training
        // data instead of pretending it searched.
        return {
          results: [],
          error:
            providerErrors.length > 0
              ? `All providers failed: ${providerErrors.join("; ")}`
              : "No results found.",
        }
      }

      log.push({
        providers: runs.map((r) => r.provider),
        query,
        resultCount: merged.length,
      })
      return { query, results: merged }
    },
  })
}

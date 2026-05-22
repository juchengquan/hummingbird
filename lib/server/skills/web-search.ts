import "server-only"
/**
 * Web search skill — single tool, multiple providers under the hood.
 *
 * The model sees one tool, `webSearch({ query })`. When invoked, the
 * server runs the query against every enabled+configured provider in
 * parallel (Tavily, Brave, Exa), dedupes by URL, interleaves the
 * results so no single provider dominates the first slots, and returns
 * a single merged result list. From the model's perspective, the
 * choice of provider is invisible — it just gets richer, dedup'd web
 * results.
 *
 * Cap budget: one `webSearch` tool invocation = one cap unit, even when
 * it fans out to multiple providers. Matches the user's mental model
 * ("how many times can the model decide to search?") rather than
 * counting upstream API hits.
 *
 * Per-provider knobs (Tavily `searchDepth`, Brave `freshness`, Exa
 * `type`, …) are resolved client-side from the cascade and arrive on
 * the request as `ResolvedWebSearchConfig`. Each provider's invocation
 * uses its own sub-config.
 *
 * Server-only: api keys live in env, never in the browser bundle.
 * Per-provider failures are tolerated — Tavily returning 500 doesn't
 * suppress Brave's results, and vice versa. If all enabled providers
 * fail we surface a concise error to the model so it can fall back to
 * training data.
 */

import { tool } from "ai"
import { z } from "zod"

import {
  clampMaxWebSearches,
  DEFAULT_BRAVE_FRESHNESS,
  DEFAULT_EXA_SEARCH_TYPE,
  DEFAULT_MAX_WEB_SEARCHES,
  DEFAULT_TAVILY_SEARCH_DEPTH,
  type BraveFreshness,
  type ExaSearchType,
  type ResolvedWebSearchConfig,
  type TavilySearchDepth,
} from "@/shared/skills/web-search-config"

const SNIPPET_MAX = 600
const PER_PROVIDER_RESULTS = 5

export type WebSearchProvider = "tavily" | "brave" | "exa"

export interface WebSearchInvocation {
  /** Which providers we asked on this tool call (in dispatch order). */
  providers: WebSearchProvider[]
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

export function isExaConfigured(): boolean {
  return !!process.env.EXA_API_KEY
}

/** True when any provider is usable. */
export function isWebSearchConfigured(): boolean {
  return isTavilyConfigured() || isBraveConfigured() || isExaConfigured()
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

/**
 * Per-result schema — permissive on optional fields so a single
 * malformed row (e.g. `title: 42`) drops out via per-row `safeParse`
 * rather than killing the whole response. The wrapper schema below
 * is strict on the array's presence, which is what catches the
 * scenario this validation pass exists to catch: an upstream
 * renaming `results` (or removing it entirely) instead of having it
 * silently produce empty results forever.
 */
const TavilyResultSchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  content: z.string().optional(),
  score: z.number().optional(),
})

/** Wrapper schema — `results` is required (per Tavily's docs, always
 *  present in 200 responses). Element shape is checked per-row below. */
const TavilyResponseSchema = z.object({
  results: z.array(z.unknown()),
})

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

/**
 * Compact one-liner of a Zod issue list for the model-facing error
 * field. Matches the style used by `lib/server/providers-config.ts`
 * for `config/providers.json` validation — easy to grep for when a
 * provider's API actually changes shape.
 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`)
    .slice(0, 3)
    .join("; ")
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
    const wrapper = TavilyResponseSchema.safeParse(await res.json())
    if (!wrapper.success) {
      return {
        results: [],
        error: `Tavily response shape changed: ${describeIssues(wrapper.error)}`,
      }
    }
    const results: NormalizedResult[] = []
    for (const raw of wrapper.data.results) {
      const r = TavilyResultSchema.safeParse(raw)
      if (!r.success || !r.data.url) continue
      results.push({
        title: r.data.title ?? "",
        url: r.data.url,
        snippet: clipSnippet(r.data.content ?? ""),
      })
      if (results.length >= PER_PROVIDER_RESULTS) break
    }
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

const BraveResultSchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  description: z.string().optional(),
})

/** Brave's `web` block can be entirely absent on no-web-results
 *  responses (e.g. queries answered by news/discussion mixers).
 *  When present, the inner `results` array is required — that's the
 *  wrapper-rename guard. */
const BraveResponseSchema = z.object({
  web: z
    .object({
      results: z.array(z.unknown()),
    })
    .optional(),
})

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
    const wrapper = BraveResponseSchema.safeParse(await res.json())
    if (!wrapper.success) {
      return {
        results: [],
        error: `Brave response shape changed: ${describeIssues(wrapper.error)}`,
      }
    }
    const results: NormalizedResult[] = []
    for (const raw of wrapper.data.web?.results ?? []) {
      const r = BraveResultSchema.safeParse(raw)
      if (!r.success || !r.data.url) continue
      results.push({
        title: r.data.title ?? "",
        url: r.data.url,
        snippet: clipSnippet(r.data.description ?? ""),
      })
      if (results.length >= PER_PROVIDER_RESULTS) break
    }
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

// --- Exa --------------------------------------------------------------------

const ExaResultSchema = z.object({
  title: z.string().nullable().optional(),
  url: z.string().optional(),
  // `text` is what we ask for via `contents.text`; `summary` is the
  // documented per-result LLM summary if `contents.summary` is set.
  // Both nullable per Exa docs.
  text: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
})

const ExaResponseSchema = z.object({
  results: z.array(z.unknown()),
})

const EXA_ENDPOINT = "https://api.exa.ai/search"

async function exaSearch(
  query: string,
  opts: { type: ExaSearchType; signal?: AbortSignal }
): Promise<{ results: NormalizedResult[] } | { results: []; error: string }> {
  const apiKey = process.env.EXA_API_KEY
  if (!apiKey) {
    return { results: [], error: "Exa is not configured (missing EXA_API_KEY)." }
  }
  const { signal, cancel } = buildProviderSignal(opts.signal)
  try {
    const res = await fetch(EXA_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        query,
        numResults: PER_PROVIDER_RESULTS,
        type: opts.type,
        // Ask Exa to include a text excerpt so we have something for
        // the snippet field. `maxCharacters` keeps the response size
        // bounded; `clipSnippet` enforces the final per-result cap.
        contents: {
          text: { maxCharacters: SNIPPET_MAX },
        },
      }),
      signal,
    })
    if (!res.ok) {
      return { results: [], error: `Exa search failed (HTTP ${res.status}).` }
    }
    const wrapper = ExaResponseSchema.safeParse(await res.json())
    if (!wrapper.success) {
      return {
        results: [],
        error: `Exa response shape changed: ${describeIssues(wrapper.error)}`,
      }
    }
    const results: NormalizedResult[] = []
    for (const raw of wrapper.data.results) {
      const r = ExaResultSchema.safeParse(raw)
      if (!r.success || !r.data.url) continue
      results.push({
        title: r.data.title ?? "",
        url: r.data.url,
        snippet: clipSnippet(r.data.text ?? r.data.summary ?? ""),
      })
      if (results.length >= PER_PROVIDER_RESULTS) break
    }
    return { results }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        results: [],
        error: `Exa timed out after ${PROVIDER_CALL_TIMEOUT_MS}ms`,
      }
    }
    return {
      results: [],
      error: err instanceof Error ? err.message : "Exa search failed",
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
  upstreamSignal?: AbortSignal,
  /** Per-IP cross-turn budget gate. Called once per tool invocation;
   *  when refused, the tool returns a soft error with retry-after.
   *  Distinct from `config.maxCalls` (per-turn). Omitted → no gate. */
  consumeBudget?: () => { allowed: boolean; retryAfterSec: number }
) {
  // Decide which providers can actually run: enabled by user AND
  // configured on the server. If neither qualifies, don't register the
  // tool at all — the route detects this via the return value and tells
  // the model "search isn't available."
  const maxCalls = clampMaxWebSearches(config?.maxCalls ?? DEFAULT_MAX_WEB_SEARCHES)
  const tavilyOn = (config?.tavily?.enabled ?? true) && isTavilyConfigured()
  const braveOn = (config?.brave?.enabled ?? true) && isBraveConfigured()
  const exaOn = (config?.exa?.enabled ?? true) && isExaConfigured()
  if (!tavilyOn && !braveOn && !exaOn) return null
  const tavilyDepth = config?.tavily?.searchDepth ?? DEFAULT_TAVILY_SEARCH_DEPTH
  const braveFreshness = config?.brave?.freshness ?? DEFAULT_BRAVE_FRESHNESS
  const exaType = config?.exa?.type ?? DEFAULT_EXA_SEARCH_TYPE

  const providersDescriptionFragment = [
    tavilyOn ? "Tavily" : null,
    braveOn ? "Brave" : null,
    exaOn ? "Exa" : null,
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
      // Per-IP cross-turn gate first.
      const budget = consumeBudget?.()
      if (budget && !budget.allowed) {
        return {
          results: [],
          error: `webSearch rate limit exceeded for this IP. Retry in ${budget.retryAfterSec}s. The chat route caps outbound web tools (webSearch + webFetch combined) per minute.`,
        }
      }
      // Per-turn cap: one tool invocation = one cap unit, regardless
      // of how many providers it fans out to.
      if (log.length >= maxCalls) {
        return {
          results: [],
          error: `Search budget exhausted (max ${maxCalls} per turn). Stop calling webSearch and answer from the results you already have.`,
        }
      }

      const runs: Array<{
        provider: WebSearchProvider
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
      if (exaOn) {
        tasks.push(
          exaSearch(query, { type: exaType, signal: upstreamSignal }).then((r) => {
            runs.push({ provider: "exa", result: r })
          })
        )
      }
      // Each task swallows its own errors and returns an `error` field,
      // so `Promise.all` is equivalent to `allSettled` here — except
      // `all` short-circuits on a synchronous throw before the catch,
      // which neither helper should do. The per-provider timeouts above
      // bound the total wait time at `PROVIDER_CALL_TIMEOUT_MS`.
      await Promise.all(tasks)

      // Preserve the registration order (tavily, brave, exa) when interleaving.
      const PROVIDER_ORDER: Record<WebSearchProvider, number> = {
        tavily: 0,
        brave: 1,
        exa: 2,
      }
      runs.sort(
        (a, b) => PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider]
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

/** @internal — exported for tests only. Not part of the public surface;
 *  do not import outside `*.test.ts`. */
export const __test = {
  clipSnippet,
  dedupKey,
  interleaveAndDedupe,
}

// --- ServerSkill entry -----------------------------------------------------

import type { ServerSkill } from "@/server/skills/registry"
import { resolveWebSearchConfig } from "@/shared/skills/web-search-config"

/**
 * Registry entry for the webSearch skill. Threads the per-request
 * config from `body.skills` through the shared resolver, owns its
 * per-turn log internally, and returns either a Tool ready for the
 * AI SDK or null when no provider is actually available.
 */
export const webSearchSkill: ServerSkill = {
  id: "webSearch",
  toolName: "webSearch",
  buildTool(requestEntry, ctx) {
    const config = resolveWebSearchConfig(undefined, requestEntry?.webSearchConfig)
    // Per-turn log is opaque to the route — only the tool's `execute`
    // reads it back. Allocated fresh per build (i.e. per chat turn).
    const log: WebSearchLog = []
    return buildWebSearchTool(log, config, ctx.signal, ctx.consumeBudget)
  },
  promptFragment(requestEntry) {
    const config = resolveWebSearchConfig(undefined, requestEntry?.webSearchConfig)
    const tavilyLive = config.tavily.enabled && isTavilyConfigured()
    const braveLive = config.brave.enabled && isBraveConfigured()
    const exaLive = config.exa.enabled && isExaConfigured()
    if (tavilyLive || braveLive || exaLive) {
      const providers = [
        tavilyLive ? "Tavily" : null,
        braveLive ? "Brave" : null,
        exaLive ? "Exa" : null,
      ]
        .filter(Boolean)
        .join(" + ")
      const cap = config.maxCalls
      return (
        `You can call \`webSearch({ query })\` when the user asks about current information ` +
        `or facts you may not have. The tool fans out to enabled providers (${providers}) ` +
        `in parallel and returns deduped, merged results. ` +
        `Cite sources using bracket markers \`[1]\`, \`[2]\`, etc. placed inline at the end of ` +
        `the sentence they support, matching the order results were returned. Do not repeat ` +
        `the URL in the text — the UI renders \`[N]\` as a clickable link to source N. ` +
        `HARD LIMIT: ${cap} tool call${cap === 1 ? "" : "s"} per turn (regardless of how many ` +
        `providers each call fans out to). After ${cap} call${cap === 1 ? "" : "s"} any further ` +
        `attempts will return an error. Plan: pick 1-2 broad queries that cover the question, ` +
        `then write the answer from the snippets you have. Do not split one question into many ` +
        `narrow searches.`
      )
    }
    if (!isWebSearchConfigured()) {
      // Skill is on but the server doesn't have any provider key.
      // Be explicit so the user can grep their setup.
      return (
        'The user enabled "Web search" but no provider is configured on the server ' +
        "(missing TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, and EXA_API_KEY). You cannot " +
        "actually search — say so briefly and answer from training data instead."
      )
    }
    // Configured on the server but every provider has been disabled
    // by the user's per-provider toggles. Be honest about it.
    return (
      'The user enabled "Web search" but disabled every provider in the skill settings. ' +
      "You cannot actually search — say so briefly and answer from training data instead."
    )
  },
}

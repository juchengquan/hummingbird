import "server-only"

/**
 * Web-fetch skill.
 *
 * Exposes a single `webFetch({ url })` tool to the model. The
 * implementation reuses `fetchUrlBookmark` (same code path that backs
 * the smart-paste URL bookmarks): outbound-URL validation, manual
 * redirect handling with re-validation, 10s timeout, 5 MB body cap,
 * 200 KB extracted-text budget. So the tool inherits the SSRF and
 * size protections by construction; nothing new to audit here.
 *
 * Per-turn cap mirrors webSearch's pattern: a `WebFetchLog` array is
 * passed in by the chat route, and `execute` rejects (returns an error
 * payload, not a thrown exception) once `log.length >= maxCalls`. The
 * model sees a normal tool result with an `error` field, which it
 * handles by switching to a different approach instead of cascading
 * the failure.
 */

import { tool } from "ai"
import { z } from "zod"

import { fetchUrlBookmark } from "@/server/url/fetch"
import { clampMaxWebFetches } from "@/shared/skills/web-fetch-config"

export interface WebFetchInvocation {
  url: string
  ok: boolean
  /** Bytes of extracted content returned to the model — useful for the
   *  diagnostics log; we don't show this to users today. */
  contentLength: number
}

/** Per-turn log of webFetch tool calls. One entry per invocation,
 *  successful or not. The chat route reads it at stream end. */
export type WebFetchLog = WebFetchInvocation[]

interface WebFetchSuccess {
  ok: true
  url: string
  title: string
  /** Extracted plain text (HTML stripped). Capped at 200 KB by the
   *  fetcher. Truncation surfaces via `contentTruncated`. */
  content: string
  contentTruncated: boolean
  description?: string
}

interface WebFetchFailure {
  ok: false
  url: string
  error: string
}

type WebFetchResult = WebFetchSuccess | WebFetchFailure

interface BuildOpts {
  /** Per-turn cap. After this many invocations any further calls return
   *  a soft error. */
  maxCalls: number
  /** Upstream abort signal — typically the chat route's `req.signal`.
   *  Propagated into the URL fetcher so an in-flight tool call cancels
   *  when the client tab closes mid-stream, instead of running its
   *  internal 10s timer out to completion. */
  signal?: AbortSignal
  /** Per-IP cross-turn budget gate. Called once per tool invocation.
   *  When refused (`allowed: false`), the tool returns a soft error
   *  with the suggested retry-after. Distinct from `maxCalls` (which
   *  is a within-turn budget). When omitted, no cross-turn gate is
   *  applied. */
  consumeBudget?: () => { allowed: boolean; retryAfterSec: number }
}

export function buildWebFetchTool(log: WebFetchLog, opts: BuildOpts) {
  const maxCalls = clampMaxWebFetches(opts.maxCalls)
  return tool({
    description:
      "Fetch a single web page by URL and return its extracted plain-text content. " +
      "Use this when the user references a specific URL or after webSearch finds a result " +
      "you want to read in full. Each call returns at most ~200 KB of extracted text. " +
      "Cannot fetch internal or private network addresses.",
    inputSchema: z.object({
      url: z
        .string()
        .url()
        .describe("Absolute http(s) URL of the page to fetch."),
    }),
    execute: async ({ url }): Promise<WebFetchResult> => {
      // Per-IP cross-turn gate first — if the user has been hammering
      // the chat web tools we refuse before even checking the local
      // log so a one-line tool result tells them to back off.
      const budget = opts.consumeBudget?.()
      if (budget && !budget.allowed) {
        log.push({ url, ok: false, contentLength: 0 })
        return {
          ok: false,
          url,
          error: `webFetch rate limit exceeded for this IP. Retry in ${budget.retryAfterSec}s. The chat route caps outbound web tools (webSearch + webFetch combined) per minute.`,
        }
      }
      // Soft cap — return a tool result with an error rather than
      // throwing so the model handles it gracefully.
      if (log.length >= maxCalls) {
        log.push({ url, ok: false, contentLength: 0 })
        return {
          ok: false,
          url,
          error: `webFetch budget exhausted (${maxCalls} ${maxCalls === 1 ? "call" : "calls"} per turn). Answer with the content already fetched or ask the user to focus the request.`,
        }
      }

      const res = await fetchUrlBookmark(url, { signal: opts.signal })
      if (!res.ok) {
        log.push({ url, ok: false, contentLength: 0 })
        const e = res.error
        const message =
          e.code === "http_error"
            ? `HTTP ${e.status} from upstream`
            : e.code === "validation"
              ? `URL refused (${e.validation.code})`
              : e.message
        return { ok: false, url, error: message }
      }

      log.push({
        url: res.snapshot.url,
        ok: true,
        contentLength: res.snapshot.content.length,
      })
      return {
        ok: true,
        url: res.snapshot.url,
        title: res.snapshot.title,
        content: res.snapshot.content,
        contentTruncated: res.snapshot.contentTruncated,
        ...(res.snapshot.description
          ? { description: res.snapshot.description }
          : {}),
      }
    },
  })
}

// --- ServerSkill entry -----------------------------------------------------

import type { ServerSkill } from "@/server/skills/registry"
import { DEFAULT_MAX_WEB_FETCHES } from "@/shared/skills/web-fetch-config"

/**
 * Registry entry for the webFetch skill. Threads the per-request
 * `webFetchConfig.maxCalls` through the shared clamp, owns its
 * per-turn log internally, and produces a Tool that the AI SDK can
 * register. The prompt fragment mirrors the runtime cap exactly so
 * the model sees the same number it's actually constrained by.
 */
export const webFetchSkill: ServerSkill = {
  id: "webFetch",
  toolName: "webFetch",
  buildTool(requestEntry, ctx) {
    const maxCalls = clampMaxWebFetches(
      requestEntry?.webFetchConfig?.maxCalls ?? DEFAULT_MAX_WEB_FETCHES
    )
    const log: WebFetchLog = []
    return buildWebFetchTool(log, {
      maxCalls,
      signal: ctx.signal,
      consumeBudget: ctx.consumeBudget,
    })
  },
  promptFragment(requestEntry) {
    const maxCalls = clampMaxWebFetches(
      requestEntry?.webFetchConfig?.maxCalls ?? DEFAULT_MAX_WEB_FETCHES
    )
    return (
      `You can call \`webFetch({ url })\` to fetch a single web page and read its full ` +
      `extracted text. Use this when the user references a specific URL, or when a ` +
      `\`webSearch\` snippet looks promising but you need the full content to answer ` +
      `accurately. Each call returns up to ~200 KB of plain text plus the page title and ` +
      `description. Cannot fetch internal or private network addresses. HARD LIMIT: ` +
      `${maxCalls} ${maxCalls === 1 ? "call" : "calls"} per turn — pick the URLs that ` +
      `most directly answer the question rather than fetching everything.`
    )
  },
}

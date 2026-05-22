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

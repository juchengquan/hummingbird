import "server-only"
/**
 * Web search skill — Tavily-backed.
 *
 * Server-only: TAVILY_API_KEY lives in env, never in the browser bundle.
 * When the key isn't set, `buildWebSearchTool` returns null and the chat
 * route omits the tool from the model's tool list. A small note in the
 * system prompt tells the model so it can fall back to "as of my training
 * data" instead of inventing a search call that will never run.
 *
 * The tool returns a compact result set the model can quote/cite. Snippets
 * are limited to ~600 chars each to keep context budget under control.
 */

import { tool } from "ai"
import { z } from "zod"

interface TavilyResult {
  title: string
  url: string
  content: string
  /** Optional. Newer Tavily responses include a relevance score. */
  score?: number
}

interface TavilyResponse {
  answer?: string
  results?: TavilyResult[]
}

const TAVILY_ENDPOINT = "https://api.tavily.com/search"
const SNIPPET_MAX = 600
const RESULTS_DEFAULT = 5

export interface WebSearchInvocation {
  query: string
  resultCount: number
}

/**
 * Tracks every webSearch call the model made during a single chat turn.
 * The chat route reads this at stream end to append a persistent footer
 * to the assistant message so the record survives reload.
 */
export type WebSearchLog = WebSearchInvocation[]

export function isWebSearchConfigured(): boolean {
  return !!process.env.TAVILY_API_KEY
}

export function buildWebSearchTool(log: WebSearchLog) {
  if (!isWebSearchConfigured()) return null

  return tool({
    description:
      "Search the public web for current information when the user asks about something the model might not have, or asks for the latest details. Returns the top results with title, URL, and a short snippet. Cite the URLs you use.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(400)
        .describe("Concise search query, like what you would type into a search engine."),
    }),
    execute: async ({ query }) => {
      const apiKey = process.env.TAVILY_API_KEY
      if (!apiKey) {
        return { results: [], error: "Web search is not configured." }
      }
      try {
        const res = await fetch(TAVILY_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: RESULTS_DEFAULT,
            search_depth: "basic",
            include_answer: false,
          }),
        })
        if (!res.ok) {
          return {
            results: [],
            error: `Search failed (HTTP ${res.status}).`,
          }
        }
        const data = (await res.json()) as TavilyResponse
        const results = (data.results ?? []).slice(0, RESULTS_DEFAULT).map((r) => ({
          title: r.title,
          url: r.url,
          snippet:
            r.content.length > SNIPPET_MAX
              ? `${r.content.slice(0, SNIPPET_MAX)}…`
              : r.content,
        }))
        log.push({ query, resultCount: results.length })
        return { query, results }
      } catch (err) {
        return {
          results: [],
          error: err instanceof Error ? err.message : "Search failed",
        }
      }
    },
  })
}

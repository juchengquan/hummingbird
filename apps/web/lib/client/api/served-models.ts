"use client"
import "client-only"

/**
 * Loads agent-py's `GET /v1/models` (wave 10, Q119) into
 * `@/shared/served-models`, once per page; the model rules read it there. A
 * failed read leaves the built-in `anthropic/*` list in place and is tried
 * again the next time (`useServedModels` asks on mount). An empty list is an
 * answer, not a failure: no model provider on this deploy (Q131).
 */

import {
  isEmptyModelList,
  markNoModelProvider,
  markServedModelsSettled,
  noModelProvider,
  parseServedModels,
  servedModels,
  setServedModels,
} from "@/shared/served-models"

type Fetch = (url: string) => Promise<Response>

let inFlight: Promise<void> | null = null

export function loadServedModels(baseUrl: string, fetcher: Fetch = (url) => fetch(url)): Promise<void> {
  if (servedModels() || noModelProvider()) return Promise.resolve()
  inFlight ??= (async () => {
    try {
      const res = await fetcher(`${baseUrl.replace(/\/$/, "")}/v1/models`)
      if (!res.ok) return
      const body: unknown = await res.json()
      const parsed = parseServedModels(body)
      if (parsed) setServedModels(parsed)
      // Q131: read, and empty — no provider on this deploy (not a failure).
      else if (isEmptyModelList(body)) markNoModelProvider()
    } catch {
      // Offline or not deployed yet: the built-in list stands.
    } finally {
      inFlight = null
      markServedModelsSettled()
    }
  })()
  return inFlight
}

/** Forget an in-flight load (tests). */
export function resetServedModelsLoad(): void {
  inFlight = null
}

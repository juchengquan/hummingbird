"use client"
import "client-only"

/**
 * Loads agent-py's `GET /v1/models` (wave 10, Q119) into
 * `@/shared/served-models`, once per page; the model rules read it there. A
 * failed read leaves the built-in `anthropic/*` list in place and is tried
 * again the next time (`useServedModels` asks on mount).
 */

import {
  markServedModelsSettled,
  parseServedModels,
  servedModels,
  setServedModels,
} from "@/shared/served-models"

type Fetch = (url: string) => Promise<Response>

let inFlight: Promise<void> | null = null

export function loadServedModels(baseUrl: string, fetcher: Fetch = (url) => fetch(url)): Promise<void> {
  if (servedModels()) return Promise.resolve()
  inFlight ??= (async () => {
    try {
      const res = await fetcher(`${baseUrl.replace(/\/$/, "")}/v1/models`)
      if (!res.ok) return
      const parsed = parseServedModels(await res.json())
      if (parsed) setServedModels(parsed)
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

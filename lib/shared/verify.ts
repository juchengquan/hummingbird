/**
 * Citation-verification core types + pure helpers
 * (`docs/PLAN-citation-verifiability.md`). Isomorphic and dependency-free
 * — no React, no fetch, no provider SDK. The verifier runs in agent-py (a
 * post-turn pass that classifies each `[N]`-cited sentence of a retrieval
 * answer against the cited sources); the client validates its verdicts
 * (`parseVerificationFrame`) and renders them.
 */

export type ClaimStatus = "supported" | "unsupported" | "partial"

/** Per-claim grounding verdict returned to the UI. */
export interface ClaimCheck {
  claim: string
  status: ClaimStatus
  /** Ids of sources the verifier found to support the claim. */
  sourceIds: string[]
}

export interface VerificationSummary {
  supported: number
  partial: number
  unsupported: number
  total: number
}

export interface VerificationResult {
  checks: ClaimCheck[]
  summary: VerificationSummary
}

const STATUSES: ReadonlySet<string> = new Set<ClaimStatus>([
  "supported",
  "unsupported",
  "partial",
])

/**
 * Validate a `data-verification` wire payload into a `VerificationResult`,
 * or `null` if malformed. Defensive at the client boundary — an older /
 * buggy server emit is dropped rather than corrupting the message. The
 * summary is recomputed from the checks so it can't drift from them.
 */
export function parseVerificationFrame(data: unknown): VerificationResult | null {
  if (!data || typeof data !== "object") return null
  const rawChecks = (data as { checks?: unknown }).checks
  if (!Array.isArray(rawChecks)) return null
  const checks: ClaimCheck[] = []
  for (const item of rawChecks) {
    if (!item || typeof item !== "object") continue
    const { claim, status, sourceIds } = item as Record<string, unknown>
    if (typeof claim !== "string" || !STATUSES.has(status as string)) continue
    checks.push({
      claim,
      status: status as ClaimStatus,
      sourceIds: Array.isArray(sourceIds)
        ? sourceIds.filter((x): x is string => typeof x === "string")
        : [],
    })
  }
  if (checks.length === 0) return null
  return { checks, summary: summarizeChecks(checks) }
}

/** Tally claim statuses for the per-message confidence summary
 *  ("8/9 grounded"). */
export function summarizeChecks(checks: ClaimCheck[]): VerificationSummary {
  const summary: VerificationSummary = {
    supported: 0,
    partial: 0,
    unsupported: 0,
    total: checks.length,
  }
  for (const c of checks) {
    if (c.status === "supported") summary.supported += 1
    else if (c.status === "partial") summary.partial += 1
    else summary.unsupported += 1
  }
  return summary
}

/**
 * Per-source count of how many *supported* claims each source backs,
 * keyed by source id. Drives the Sources-strip "supports N claims"
 * badges. Only `supported` claims count — a `partial` is too weak a
 * signal to advertise a source as backing a claim.
 */
export function countSupportPerSource(
  checks: ClaimCheck[]
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const c of checks) {
    if (c.status !== "supported") continue
    for (const id of c.sourceIds) {
      counts[id] = (counts[id] ?? 0) + 1
    }
  }
  return counts
}

/** One inline mark for a single citation marker `[N]`. The
 *  renderer uses this to wrap the rendered `[N]` token in a
 *  styled span (see components/panels/citation-marker.tsx). */
export type CitationMarkerMark = {
  markerId: string
  claimText: string
  status: ClaimStatus
}

/**
 * Build a `Map<markerId, CitationMarkerMark>` from the
 * `VerificationResult.checks`. Used by the inline renderer to
 * wrap each `[N]` token in the rendered assistant message.
 *
 * - Skips `supported` claims (no UI cost).
 * - Skips claims with empty `sourceIds` (no marker to mark).
 * - First claim wins per marker when two flagged claims share a
 *   sourceId (rare; happens when the model's `[1]` and `[2]`
 *   lists disagree with the verifier's sourceIds). The first
 *   claim is the one closest to the citation in the assistant
 *   message order.
 */
export function markerMarksFor(
  checks: ClaimCheck[]
): Map<string, CitationMarkerMark> {
  const out = new Map<string, CitationMarkerMark>()
  for (const c of checks) {
    if (c.status === "supported") continue
    if (c.sourceIds.length === 0) continue
    for (const id of c.sourceIds) {
      if (out.has(id)) continue
      out.set(id, {
        markerId: id,
        claimText: c.claim,
        status: c.status,
      })
    }
  }
  return out
}

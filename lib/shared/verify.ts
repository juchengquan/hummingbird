/**
 * Citation-verification core types + pure helpers
 * (`docs/PLAN-citation-verifiability.md`). Isomorphic and dependency-free
 * — no React, no fetch, no provider SDK — so the server verifier
 * (`lib/server/verify/verify-answer.ts`) and the client renderer consume
 * the same claim-extraction, parsing, and summary logic. Mirrors the
 * `suggestions-parser.ts` split (pure shared core + thin server call).
 *
 * The method (per the plan): a post-turn pass over a retrieval answer.
 * We treat each sentence that carries a `[N]` citation marker as a
 * *claim*; uncited prose isn't claiming a source, so it's left unmarked.
 * A verifier model then classifies each claim against the cited sources.
 */

export type ClaimStatus = "supported" | "unsupported" | "partial"

/** A source the turn retrieved (web search / searchFiles), as cited by
 *  `[N]` markers in the answer. `id` is the marker number as a string
 *  ("1", "2", …) so claims and sources line up. */
export interface RetrievedSource {
  id: string
  title: string
  url?: string
  /** The text we have to ground claims against (search snippet / file
   *  fragment). */
  snippet: string
}

/** A sentence in the answer that carries one or more citation markers. */
export interface CitedClaim {
  text: string
  /** 1-based source indices the claim cites, deduped + ascending. */
  citedIndices: number[]
}

/** Per-claim grounding verdict returned to the UI. */
export interface ClaimCheck {
  claim: string
  status: ClaimStatus
  /** Ids of sources the verifier found to support the claim. */
  sourceIds: string[]
}

/** Verifier model output before it's mapped back onto claim text.
 *  `claim` is the 1-based index into the extracted claim list. */
export interface RawClaimCheck {
  claim: number
  status: ClaimStatus
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

// Sentence boundary: end punctuation followed by whitespace, or a
// newline. Naive but adequate — claims are matched by the presence of a
// citation marker, so an over-eager split just yields smaller claims.
const CLAIM_SPLIT_RE = /(?<=[.!?])\s+|\n+/
// `[1]`, `[1][2]`, or `[1, 2]` — capture the inner index list per bracket.
const CITATION_RE = /\[(\d+(?:\s*,\s*\d+)*)\]/g

const FENCE_HEAD_RE = /^```(?:json)?\s*\n?/
const FENCE_TAIL_RE = /\n?```\s*$/

const STATUSES: ReadonlySet<string> = new Set<ClaimStatus>([
  "supported",
  "unsupported",
  "partial",
])

/**
 * Pull the cited claims out of an answer: sentences that carry at least
 * one `[N]` marker, paired with the source indices they cite. Returns
 * `[]` for an answer with no citations — the caller skips verification
 * entirely (cost guard).
 */
export function extractCitedClaims(answer: string): CitedClaim[] {
  const out: CitedClaim[] = []
  for (const segment of answer.split(CLAIM_SPLIT_RE)) {
    const text = segment.trim()
    if (!text) continue
    const indices = new Set<number>()
    CITATION_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = CITATION_RE.exec(text)) !== null) {
      for (const part of m[1].split(",")) {
        const n = Number.parseInt(part.trim(), 10)
        if (Number.isFinite(n)) indices.add(n)
      }
    }
    if (indices.size === 0) continue
    out.push({ text, citedIndices: [...indices].sort((a, b) => a - b) })
  }
  return out
}

/**
 * Lenient parse of a verifier model's raw text into `RawClaimCheck[]`.
 * Tolerates markdown fences and either a `{ checks: [...] }` envelope or
 * a bare array. Any decode / shape failure yields `[]` — verification is
 * advisory, so a malformed response just means "nothing flagged".
 */
export function parseVerificationJson(raw: string): RawClaimCheck[] {
  try {
    const cleaned = raw
      .trim()
      .replace(FENCE_HEAD_RE, "")
      .replace(FENCE_TAIL_RE, "")
      .trim()
    const parsed: unknown = JSON.parse(cleaned)
    const arr: unknown = Array.isArray(parsed)
      ? parsed
      : (parsed as { checks?: unknown })?.checks
    if (!Array.isArray(arr)) return []
    const out: RawClaimCheck[] = []
    for (const item of arr) {
      if (!item || typeof item !== "object") continue
      const { claim, status, sourceIds } = item as Record<string, unknown>
      if (typeof claim !== "number" || !STATUSES.has(status as string)) continue
      out.push({
        claim,
        status: status as ClaimStatus,
        sourceIds: Array.isArray(sourceIds)
          ? sourceIds.filter((x): x is string => typeof x === "string")
          : [],
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * Map index-keyed raw checks back onto claim text, dropping out-of-range
 * and duplicate claim indices. Pure — the boundary the orchestrator and
 * tests share.
 */
export function mapRawChecks(
  claims: CitedClaim[],
  raw: RawClaimCheck[]
): ClaimCheck[] {
  const out: ClaimCheck[] = []
  const seen = new Set<number>()
  for (const r of raw) {
    if (r.claim < 1 || r.claim > claims.length || seen.has(r.claim)) continue
    seen.add(r.claim)
    out.push({
      claim: claims[r.claim - 1].text,
      status: r.status,
      sourceIds: r.sourceIds,
    })
  }
  return out
}

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

import "server-only"

/**
 * Retrieval-grounded citation verifier
 * (`docs/PLAN-citation-verifiability.md`, commit 1). Runs a post-turn
 * pass over a retrieval answer: extracts the cited claims, asks a cheap
 * cross-family verifier model whether the cited sources support each,
 * and returns per-claim verdicts + a confidence summary.
 *
 * Advisory and non-blocking, exactly like `suggestions.ts`: every
 * failure path (no claims, no sources, decode error, provider down)
 * returns an empty result rather than throwing, so a chat turn is never
 * blocked on verification. The model call is structured-output first
 * (gated on `modelSupportsStructuredOutput`) with a lenient text-parse
 * fallback — the same belt-and-suspenders the other non-chat calls use.
 *
 * The model step is injectable (`runVerifier`) so the orchestration
 * (claim extraction, the no-op cost guard, index→claim mapping, the
 * summary) is unit-tested without a live model.
 */

import { generateText } from "ai"
import { z } from "zod"

import { generateStructured } from "@/server/ai/structured"
import { selectModel } from "@/server/model-provider"
import { modelSupportsStructuredOutput } from "@/shared/models"
import {
  extractCitedClaims,
  mapRawChecks,
  parseVerificationJson,
  summarizeChecks,
  type CitedClaim,
  type RawClaimCheck,
  type RetrievedSource,
  type VerificationResult,
} from "@/shared/verify"

/** Cheap, fast, cross-family from the typical answerer — the plan calls
 *  for a different model than the one that wrote the answer (self-checking
 *  is weaker). Override per call via `opts.modelId`. */
const DEFAULT_VERIFIER_MODEL = "google/gemini-2.5-flash"

/** Keep source snippets from blowing up the verifier prompt. */
const MAX_SNIPPET_CHARS = 600
const MAX_OUTPUT_TOKENS = 800

const VerificationSchema = z.object({
  checks: z
    .array(
      z.object({
        claim: z.number().int(),
        status: z.enum(["supported", "unsupported", "partial"]),
        sourceIds: z.array(z.string()).max(20),
      })
    )
    .max(50),
})

/** Build the verifier prompt: the numbered sources, then the numbered
 *  claims with the markers they cite, then a strict-JSON instruction.
 *  Pure (exported for testing the rendered prompt). */
export function buildVerifyPrompt(
  claims: CitedClaim[],
  sources: RetrievedSource[]
): string {
  const sourceBlock = sources
    .map(
      (s) =>
        `[${s.id}] ${s.title}${s.url ? ` (${s.url})` : ""}\n${s.snippet
          .slice(0, MAX_SNIPPET_CHARS)
          .trim()}`
    )
    .join("\n\n")

  const claimBlock = claims
    .map(
      (c, i) =>
        `${i + 1}. ${c.text}  (cites: ${c.citedIndices
          .map((n) => `[${n}]`)
          .join(", ")})`
    )
    .join("\n")

  return `You are a citation verifier. For each CLAIM, decide whether the cited SOURCES support it.

- "supported": the sources clearly state or directly entail the claim.
- "partial": the sources are related but don't fully establish the claim.
- "unsupported": the sources do not support the claim.

Be conservative: only mark "unsupported" when the claim is clearly NOT supported by its cited sources. When unsure, prefer "partial". Judge each claim only against the evidence in the sources, not outside knowledge.

SOURCES:
${sourceBlock}

CLAIMS:
${claimBlock}

Reply with strict JSON only — no prose, no markdown fences:
{"checks":[{"claim":1,"status":"supported","sourceIds":["1"]}]}
where "claim" is the claim number above and "sourceIds" lists the sources that support it.`
}

/** The model step: prompt in, raw per-claim checks out. */
export type RunVerifier = (
  prompt: string,
  signal?: AbortSignal
) => Promise<RawClaimCheck[]>

function makeDefaultRunVerifier(modelId: string): RunVerifier {
  return async (prompt, signal) => {
    if (modelSupportsStructuredOutput(modelId)) {
      try {
        const { checks } = await generateStructured({
          modelId,
          schema: VerificationSchema,
          prompt,
          abortSignal: signal,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0,
        })
        return checks
      } catch {
        // Fall through to the lenient text path (also covers an
        // unconfigured provider — the retry fails the same way and the
        // orchestrator's catch returns an empty result).
      }
    }
    const { text } = await generateText({
      model: selectModel(modelId),
      prompt,
      abortSignal: signal,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
    })
    return parseVerificationJson(text)
  }
}

export interface VerifyAnswerOptions {
  /** Verifier model id. Defaults to a cheap cross-family model. */
  modelId?: string
  signal?: AbortSignal
  /** Injected for tests; defaults to the real structured/text call. */
  runVerifier?: RunVerifier
}

/**
 * Verify a retrieval answer's cited claims against its sources. Returns
 * `{ checks, summary }`; an empty result (no checks) when there's nothing
 * to verify or the verifier failed.
 */
export async function verifyAnswer(
  answer: string,
  sources: RetrievedSource[],
  opts: VerifyAnswerOptions = {}
): Promise<VerificationResult> {
  const claims = extractCitedClaims(answer)
  // Cost guard: no cited claims, or no sources to check against → skip
  // the model call entirely.
  if (claims.length === 0 || sources.length === 0) {
    return { checks: [], summary: summarizeChecks([]) }
  }

  const run =
    opts.runVerifier ?? makeDefaultRunVerifier(opts.modelId ?? DEFAULT_VERIFIER_MODEL)

  let raw: RawClaimCheck[]
  try {
    raw = await run(buildVerifyPrompt(claims, sources), opts.signal)
  } catch {
    return { checks: [], summary: summarizeChecks([]) }
  }

  const checks = mapRawChecks(claims, raw)
  return { checks, summary: summarizeChecks(checks) }
}

import "server-only"

/**
 * Native structured-output helper. Wraps the AI SDK's `generateObject`
 * (constrained decoding against a JSON schema) for the deterministic
 * non-chat call sites — follow-up suggestions, summaries — that today
 * coax JSON out of a free-text response and parse it back with a lenient
 * fallback.
 *
 * This is the *supported* path only: callers gate on
 * `modelSupportsStructuredOutput(modelId)` first and keep their existing
 * lenient text-parse path as the fallback (so behaviour is unchanged for
 * models/providers without native support, and on any structured error).
 * Keeping the support-check + fallback at the call site (rather than in
 * here) lets each site choose its own failure semantics — suggestions
 * degrade to `[]`, summaries surface a 502 — and lets
 * `ProviderUnavailableError` propagate to the route's auth handling
 * instead of being silently swallowed.
 *
 * See `docs/PLAN-structured-outputs.md`.
 */

import { generateObject } from "ai"
import type { z } from "zod"

import { selectModel } from "@/server/model-provider"

export interface GenerateStructuredOptions<T> {
  modelId: string
  schema: z.ZodType<T>
  prompt: string
  abortSignal?: AbortSignal
  maxOutputTokens?: number
  temperature?: number
}

/**
 * Generate a schema-conformant object. Throws on provider/decoding
 * failure (including `ProviderUnavailableError` from `selectModel`) — the
 * caller is expected to catch and fall back to its lenient path.
 */
export async function generateStructured<T>(
  opts: GenerateStructuredOptions<T>
): Promise<T> {
  const { object } = await generateObject({
    model: selectModel(opts.modelId),
    schema: opts.schema,
    prompt: opts.prompt,
    abortSignal: opts.abortSignal,
    maxOutputTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
  })
  return object
}

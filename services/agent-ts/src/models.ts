/**
 * Owner-approved model allowlist for agent-ts.
 *
 * One list governs every backend: `config/models.json`. agent-ts calls
 * Anthropic directly, so it accepts only the file's `anthropic/*`
 * entries and maps each catalog id (`anthropic/claude-sonnet-4.6`) to
 * the Anthropic API id it sends upstream (`claude-sonnet-4-6`, from the
 * entry's `anthropicModelId`). Anything else — a non-Anthropic catalog
 * id, a raw API id, a typo — is `400 unknown_model`, the same code the
 * Next.js routes return. The mapping lives in `@/shared/models`
 * (`ANTHROPIC_SERVICE_MODELS`); agent-py implements the same rule in
 * `agent_py/model_allowlist.py`.
 */

import { getAnthropicApiModelId } from "@/shared/models"

import { getEnv } from "./env"

/** Name-matched by `categorizeError` (`@/shared/api-errors`) → 400
 *  `unknown_model`, same as the Next.js `UnknownModelError`. */
export class UnknownModelError extends Error {
  readonly code = "unknown_model" as const
  readonly modelId: string
  constructor(modelId: string) {
    super(
      `Unknown model "${modelId}". This backend serves only the anthropic/* models listed in config/models.json.`,
    )
    this.name = "UnknownModelError"
    this.modelId = modelId
  }
}

/** Map an allowed catalog id to its Anthropic API id. Throws
 *  `UnknownModelError` for anything not on the allowlist. */
export function resolveAnthropicApiModelId(modelId: string): string {
  const apiId = getAnthropicApiModelId(modelId)
  if (apiId === null) throw new UnknownModelError(modelId)
  return apiId
}

/** Anthropic API id of `AGENT_DEFAULT_MODEL` — validated against the
 *  allowlist when the env is parsed, so this never throws after boot. */
export function defaultAnthropicApiModelId(): string {
  return resolveAnthropicApiModelId(getEnv().AGENT_DEFAULT_MODEL)
}

/** Resolve an optional request `model`: absent / empty → the service
 *  default; anything else must be on the allowlist. */
export function resolveRequestedModel(requested: string | null | undefined): string {
  return requested ? resolveAnthropicApiModelId(requested) : defaultAnthropicApiModelId()
}

/** Re-validate a run checkpoint's `config.model` before the executor
 *  calls Anthropic. `tasks.checkpoint` is RLS-writable by the run's
 *  owner, so the id `/api/tasks` validated at creation may have been
 *  tampered with since. Returns the API id, or null when the checkpoint
 *  names no model (the executor's stub path); throws
 *  `UnknownModelError` — which fails the run — for anything else. */
export function resolveCheckpointModel(checkpoint: Record<string, unknown>): string | null {
  const cfg = checkpoint.config
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null
  const raw = (cfg as Record<string, unknown>).model
  if (raw === undefined || raw === null || raw === "") return null
  if (typeof raw !== "string") throw new UnknownModelError(String(raw))
  return resolveAnthropicApiModelId(raw)
}

/** Wire body for a 400 `unknown_model` — the Next.js error envelope. */
export function unknownModelBody(err: UnknownModelError): { code: "unknown_model"; message: string } {
  return { code: err.code, message: err.message }
}

import "server-only"

import { CHAT_MODELS, type ChatModel } from "@/shared/models"

/**
 * Resolve the model used for vision document extraction, server-side, so
 * the `/api/extract` contract stays file-only (no model parameter). Order:
 *   1. `VISION_MODEL` env override, if it names a vision-capable model.
 *   2. The first vision-capable model in the registry.
 *   3. `null` — no vision-capable model configured → vision path skipped.
 *
 * `models` / `env` are injectable for testing; production uses the real
 * registry + `process.env`.
 */
export function resolveVisionModel(
  models: ChatModel[] = CHAT_MODELS,
  env: Record<string, string | undefined> = process.env
): string | null {
  const override = env.VISION_MODEL
  if (override && models.some((m) => m.id === override && m.supportsVision === true)) {
    return override
  }
  return models.find((m) => m.supportsVision === true)?.id ?? null
}

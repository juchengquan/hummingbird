import "server-only"

/**
 * Server-side model dispatcher.
 *
 * Resolves a `provider/model` id to a `LanguageModel` instance the AI
 * SDK can consume. Almost everything routes through the Vercel AI
 * Gateway (`@ai-sdk/gateway`); the one exception is the `minimax/*`
 * family, which can be diverted to a Minimax-CN endpoint via the
 * native Anthropic provider when both `MINIMAX_CN_BASE_URL` and
 * `MINIMAX_CN_API_KEY` are configured. Minimax-CN exposes both
 * OpenAI-compatible and Anthropic-compatible APIs; per Minimax's own
 * guidance the Anthropic-compatible interface is the preferred one,
 * so we point `@ai-sdk/anthropic` at the custom baseURL.
 *
 * If either env var is unset the dispatcher falls back to the gateway
 * for `minimax/*` ids too — same behaviour as before this module
 * existed, so nothing breaks when the override isn't configured.
 */

import { createAnthropic } from "@ai-sdk/anthropic"
import type { LanguageModel } from "ai"

import type { createGateway } from "@ai-sdk/gateway"

type GatewayProvider = ReturnType<typeof createGateway>

/** Lazily initialised — `createAnthropic` reads env at call time and
 *  we don't want to construct it on every request. The cached instance
 *  is keyed by the env values; if they change at runtime we rebuild
 *  (rare, but cheap). */
let cachedMinimax:
  | { baseURL: string; apiKey: string; client: ReturnType<typeof createAnthropic> }
  | null = null

function getMinimaxCnClient(): ReturnType<typeof createAnthropic> | null {
  const baseURL = process.env.MINIMAX_CN_BASE_URL?.trim()
  const apiKey = process.env.MINIMAX_CN_API_KEY?.trim()
  if (!baseURL || !apiKey) return null
  if (
    cachedMinimax &&
    cachedMinimax.baseURL === baseURL &&
    cachedMinimax.apiKey === apiKey
  ) {
    return cachedMinimax.client
  }
  const client = createAnthropic({
    baseURL,
    apiKey,
  })
  cachedMinimax = { baseURL, apiKey, client }
  return client
}

/**
 * Returns a `LanguageModel` for the given gateway-style id. Pass the
 * already-constructed `gateway` provider as the fallback — the
 * dispatcher uses it for every non-minimax id, and for minimax ids
 * when the Minimax-CN override isn't configured.
 */
export function selectModel(
  modelId: string,
  gateway: GatewayProvider
): LanguageModel {
  if (modelId.startsWith("minimax/")) {
    const minimaxCn = getMinimaxCnClient()
    if (minimaxCn) {
      // Strip the `minimax/` prefix — the Minimax API expects bare
      // model names (e.g. `minimax-m2.7`), not the gateway namespacing.
      const bare = modelId.slice("minimax/".length)
      return minimaxCn(bare)
    }
  }
  return gateway(modelId)
}

/** Surface whether the Minimax-CN override is active. Useful for
 *  diagnostics and the `/api/health`-style endpoints we may add later. */
export function isMinimaxCnConfigured(): boolean {
  return getMinimaxCnClient() !== null
}

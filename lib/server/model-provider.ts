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

/** Tracks env-misconfiguration warnings so we log them once per process
 *  instead of on every request. */
let warnedPartialEnv = false
let warnedBadUrl: string | null = null

/**
 * Validate `MINIMAX_CN_BASE_URL` against the SSRF-style guardrails the
 * rest of the app uses on outbound URLs. We don't run async DNS
 * resolution here (that's `validateOutboundUrl`'s job and it's awaitable);
 * instead we do the cheap syntactic checks: must be `https:`, must have a
 * hostname, must not be `localhost` or a literal loopback / private IP.
 *
 * Network-level rebinding protection still kicks in at request time
 * because every outbound fetch from the AI SDK eventually hits the OS
 * resolver — the goal here is just to refuse the obviously-broken
 * configurations at boot rather than silently exfiltrating the
 * `MINIMAX_CN_API_KEY` to an http://localhost:8080 endpoint someone
 * forgot to remove from their .env.
 */
function isMinimaxBaseUrlSafe(input: string): boolean {
  let u: URL
  try {
    u = new URL(input)
  } catch {
    return false
  }
  if (u.protocol !== "https:") return false
  const host = u.hostname.toLowerCase()
  if (!host) return false
  if (host === "localhost") return false
  if (host.endsWith(".local") || host.endsWith(".internal")) return false
  // Literal loopback / private addresses (text-level — only catches
  // the cases someone is most likely to mis-set; full DNS resolution
  // is out of scope for a synchronous gate).
  if (/^127\./.test(host)) return false
  if (host === "0.0.0.0") return false
  if (/^10\./.test(host)) return false
  if (/^192\.168\./.test(host)) return false
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return false
  if (host === "::1" || host === "[::1]") return false
  return true
}

function getMinimaxCnClient(): ReturnType<typeof createAnthropic> | null {
  const baseURL = process.env.MINIMAX_CN_BASE_URL?.trim()
  const apiKey = process.env.MINIMAX_CN_API_KEY?.trim()
  if (!baseURL && !apiKey) return null
  if (!baseURL || !apiKey) {
    // Exactly one of the two is set — almost certainly a config
    // mistake (the user pasted half the override). Warn once so a
    // grep through logs surfaces it.
    if (!warnedPartialEnv) {
      console.warn(
        `[minimax-cn] only one of MINIMAX_CN_BASE_URL / MINIMAX_CN_API_KEY is set; the Minimax-CN override needs both. Falling back to the gateway for minimax/* ids.`
      )
      warnedPartialEnv = true
    }
    return null
  }
  if (!isMinimaxBaseUrlSafe(baseURL)) {
    // Refuse to construct the client — sending MINIMAX_CN_API_KEY as
    // an Authorization header to e.g. http://internal.svc would
    // exfiltrate it. Warn once per distinct bad value.
    if (warnedBadUrl !== baseURL) {
      console.warn(
        `[minimax-cn] refusing to use MINIMAX_CN_BASE_URL="${baseURL}" — must be an https:// URL with a public hostname. Falling back to the gateway for minimax/* ids.`
      )
      warnedBadUrl = baseURL
    }
    return null
  }
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

/** Exported for tests only. */
export const __test = { isMinimaxBaseUrlSafe }

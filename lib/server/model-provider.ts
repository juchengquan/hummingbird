import "server-only"

/**
 * Server-side model dispatcher.
 *
 * Resolves a `provider/model` id to a `LanguageModel` instance the AI
 * SDK can consume. Routing is driven by `config/models.json` (per-model
 * route list) and `config/providers.json` (provider credentials),
 * loaded by `lib/shared/models.ts` and `lib/server/providers-config.ts`
 * respectively.
 *
 * For each model the dispatcher tries routes in declaration order and
 * picks the first whose provider is configured (env var set, or inline
 * `apiKey` / `baseURL` present in `providers.json`). Three provider
 * types are supported today:
 *
 * - `gateway`   → Vercel AI Gateway via `@ai-sdk/gateway`.
 * - `anthropic` → `@ai-sdk/anthropic` pointed at the given baseURL.
 *                  Use this for any Anthropic-compatible endpoint —
 *                  the bundled `minimax-cn` provider is one such case.
 * - `openai`    → `@ai-sdk/openai-compatible` pointed at the given
 *                  baseURL. Use this for any OpenAI-compatible
 *                  endpoint (OpenRouter, Together, Groq, vLLM, LM
 *                  Studio, Ollama, self-hosted, …).
 *
 * If no route resolves the dispatcher throws `ProviderUnavailableError`
 * so the calling route can return a typed 401 instead of leaking the
 * underlying SDK error.
 */

import { createAnthropic } from "@ai-sdk/anthropic"
import { createGateway } from "@ai-sdk/gateway"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModel } from "ai"

import { CHAT_MODELS, getChatModel, type ChatModelRoute } from "@/shared/models"
import {
  resolveProvider,
  isProviderConfigured,
  type ResolvedProvider,
} from "@/server/providers-config"

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProviderUnavailableError"
  }
}

/** Cached client per provider name, keyed by the resolved credentials
 *  so a runtime env-var change (rare) rebuilds the client cleanly. */
type AnthropicClient = ReturnType<typeof createAnthropic>
type GatewayClient = ReturnType<typeof createGateway>
type OpenAIClient = ReturnType<typeof createOpenAICompatible>
type ProviderClient = AnthropicClient | GatewayClient | OpenAIClient
type CachedClient =
  | { type: "anthropic"; baseURL: string; apiKey: string; client: AnthropicClient }
  | { type: "openai"; baseURL: string; apiKey: string; client: OpenAIClient }
  | { type: "gateway"; apiKey: string; client: GatewayClient }

const CLIENT_CACHE = new Map<string, CachedClient>()

function getOrBuildClient(
  name: string,
  resolved: ResolvedProvider
): ProviderClient {
  const cached = CLIENT_CACHE.get(name)
  if (cached && cached.type === resolved.type) {
    if (resolved.type === "gateway" && cached.type === "gateway") {
      if (cached.apiKey === resolved.apiKey) return cached.client
    } else if (cached.type !== "gateway" && resolved.type !== "gateway") {
      if (
        cached.baseURL === resolved.baseURL &&
        cached.apiKey === resolved.apiKey
      ) {
        return cached.client
      }
    }
  }
  if (resolved.type === "anthropic") {
    const client = createAnthropic({
      baseURL: resolved.baseURL,
      apiKey: resolved.apiKey,
    })
    CLIENT_CACHE.set(name, {
      type: "anthropic",
      baseURL: resolved.baseURL,
      apiKey: resolved.apiKey,
      client,
    })
    return client
  }
  if (resolved.type === "openai") {
    // `createOpenAICompatible` requires a `name` for diagnostics — use
    // the provider's configured name so error messages and traces are
    // self-describing.
    //
    // Per-route fallbacks (today: openrouter) are wired via
    // `transformRequestBody`. The hook gets the assembled body just
    // before it's sent; we use the body's `model` field to look up the
    // route's `fallbacks` list and inject it as `body.models = [...]`.
    // OpenRouter reads this field natively; other openai-compatible
    // endpoints ignore unknown body fields, so installing the hook
    // unconditionally is a safe no-op for self-hosted / Ollama / vLLM.
    const fallbacksByUpstreamId = buildFallbackTable(name)
    const client = createOpenAICompatible({
      name,
      baseURL: resolved.baseURL,
      apiKey: resolved.apiKey,
      transformRequestBody: (body) => {
        if (fallbacksByUpstreamId.size === 0) return body
        const upstreamId = typeof body.model === "string" ? body.model : null
        if (!upstreamId) return body
        const fallbacks = fallbacksByUpstreamId.get(upstreamId)
        if (!fallbacks || fallbacks.length === 0) return body
        // Don't overwrite a `models` field the caller already supplied
        // (e.g. a future per-request override). Belt-and-braces: today
        // no caller sets it, but the merge keeps that contract honest.
        if (Array.isArray(body.models) && body.models.length > 0) return body
        return { ...body, models: fallbacks }
      },
    })
    CLIENT_CACHE.set(name, {
      type: "openai",
      baseURL: resolved.baseURL,
      apiKey: resolved.apiKey,
      client,
    })
    return client
  }
  const client = createGateway({ apiKey: resolved.apiKey })
  CLIENT_CACHE.set(name, { type: "gateway", apiKey: resolved.apiKey, client })
  return client
}

/** Walk the bundled model registry once per provider and produce a
 *  `upstreamId → fallbacks[]` map for the routes that declare a
 *  `fallbacks` list. The `upstreamId` is what the provider sees as
 *  `body.model` at request time (`route.upstreamId ?? model.id`),
 *  which is the same key `transformRequestBody` uses to look up the
 *  fallback list.
 *
 *  Returned empty when no model in this provider has fallbacks — the
 *  hook then short-circuits and the request body flows through
 *  untouched. Built lazily inside `getOrBuildClient` so the cache key
 *  (provider name) lines up with the cached client.
 *
 *  Exported for `model-provider.test.ts`. */
export function buildFallbackTable(providerName: string): Map<string, string[]> {
  const table = new Map<string, string[]>()
  for (const model of CHAT_MODELS) {
    for (const route of model.routes) {
      if (route.via !== providerName) continue
      if (!route.fallbacks || route.fallbacks.length === 0) continue
      const upstreamId = route.upstreamId ?? model.id
      // First route declaration wins when an upstream id is reused
      // across model entries (unlikely; guard for it anyway).
      if (!table.has(upstreamId)) {
        table.set(upstreamId, [...route.fallbacks])
      }
    }
  }
  return table
}

function buildLanguageModel(
  name: string,
  resolved: ResolvedProvider,
  route: ChatModelRoute,
  modelId: string
): LanguageModel {
  const client = getOrBuildClient(name, resolved)
  const upstreamId = route.upstreamId ?? modelId
  return client(upstreamId)
}

export interface SelectModelOptions {
  /** Per-request override for the gateway provider's API key. Used by
   *  the editor route to honour a user-supplied key from the settings
   *  dialog. Only takes effect on gateway routes — non-gateway routes
   *  (e.g. minimax-cn) are unaffected. */
  gatewayApiKeyOverride?: string
}

/**
 * Resolve a model id to a `LanguageModel`. Throws
 * `ProviderUnavailableError` when no route is configured — callers
 * should translate this into a 401 response.
 *
 * Unknown ids are still attempted via the implicit `gateway` route
 * (preserves the prior behaviour for per-request model overrides that
 * aren't in `config/models.json`) — when `gateway` itself isn't
 * configured the same `ProviderUnavailableError` surfaces.
 */
export function selectModel(
  modelId: string,
  opts?: SelectModelOptions
): LanguageModel {
  const override = opts?.gatewayApiKeyOverride?.trim() || null
  const model = getChatModel(modelId)
  const routes: ChatModelRoute[] = model?.routes ?? [{ via: "gateway" }]

  for (const route of routes) {
    let resolved = resolveProvider(route.via)
    if (route.via === "gateway" && override) {
      resolved = { type: "gateway", apiKey: override }
    }
    if (!resolved) continue
    return buildLanguageModel(route.via, resolved, route, modelId)
  }

  const tried = routes.map((r) => r.via).join(", ")
  throw new ProviderUnavailableError(
    `401 Unauthorized: no provider configured for model "${modelId}" (tried: ${tried}). ` +
      `Add credentials via env vars or inline keys in config/providers.json.`
  )
}

/** Surface whether the Minimax-CN override is active. Kept for
 *  backward compatibility with diagnostics / `/api/health`-style
 *  endpoints — equivalent to `isProviderConfigured('minimax-cn')`. */
export function isMinimaxCnConfigured(): boolean {
  return isProviderConfigured("minimax-cn")
}

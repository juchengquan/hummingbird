import "server-only"

import { z } from "zod"

import rawProviders from "@/config/providers.json"

/**
 * Server-side provider registry. Source of truth lives in
 * `config/providers.json` and is **never** bundled to the client — this
 * module is `server-only`, so a stray client import would fail at build
 * time. That isolation lets the JSON safely hold inline `apiKey` /
 * `baseURL` values for users who'd rather paste credentials into the
 * config than wire env vars, while keeping the env-var path (the
 * default) intact.
 *
 * Each model in `config/models.json` lists one or more provider names
 * in its `routes`; the server-side dispatcher looks each name up here
 * to find the actual baseURL / apiKey to call.
 */

const BaseFieldsSchema = z.object({
  /** Inline API key. Wins over `apiKeyEnv` when set. Keep this
   *  server-only — the file is not bundled to the client. */
  apiKey: z.string().min(1).optional(),
  /** Name of an env var to read the API key from. Looked up only when
   *  `apiKey` isn't set. */
  apiKeyEnv: z.string().min(1).optional(),
})

const GatewayProviderSchema = BaseFieldsSchema.extend({
  type: z.literal("gateway"),
})

const AnthropicProviderSchema = BaseFieldsSchema.extend({
  type: z.literal("anthropic"),
  /** Inline base URL. Must include the `/v1` suffix (the Anthropic SDK
   *  only appends `/messages`). Wins over `baseURLEnv` when set. */
  baseURL: z.string().url().optional(),
  /** Name of an env var to read the base URL from. Looked up only when
   *  `baseURL` isn't set. */
  baseURLEnv: z.string().min(1).optional(),
})

// TODO(openai-compatible): add an `openai` variant once we wire
// `@ai-sdk/openai`-compatible providers (baseURL + apiKey) into the
// dispatcher.
const ProviderSchema = z.discriminatedUnion("type", [
  GatewayProviderSchema,
  AnthropicProviderSchema,
])

const ProvidersConfigSchema = z.record(z.string().min(1), ProviderSchema)

export type ProviderConfig = z.infer<typeof ProviderSchema>
export type GatewayProviderConfig = z.infer<typeof GatewayProviderSchema>
export type AnthropicProviderConfig = z.infer<typeof AnthropicProviderSchema>

const parsed = ProvidersConfigSchema.safeParse(rawProviders)
if (!parsed.success) {
  throw new Error(
    `config/providers.json is invalid: ${parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")}`
  )
}

const PROVIDERS: Record<string, ProviderConfig> = parsed.data

/** Look up a provider definition by name. Returns null when the name
 *  is not declared in `config/providers.json`. */
export function getProviderConfig(name: string): ProviderConfig | null {
  return PROVIDERS[name] ?? null
}

/** Resolved at-rest provider credentials. `null` when neither the
 *  inline value nor the named env var is populated, which the
 *  dispatcher treats as "this route isn't available, try the next
 *  one." */
export interface ResolvedAnthropicProvider {
  type: "anthropic"
  baseURL: string
  apiKey: string
}
export interface ResolvedGatewayProvider {
  type: "gateway"
  apiKey: string
}
export type ResolvedProvider =
  | ResolvedAnthropicProvider
  | ResolvedGatewayProvider

function pickApiKey(cfg: ProviderConfig): string | null {
  if (cfg.apiKey) return cfg.apiKey
  if (cfg.apiKeyEnv) {
    const v = process.env[cfg.apiKeyEnv]?.trim()
    if (v) return v
  }
  return null
}

function pickBaseURL(cfg: AnthropicProviderConfig): string | null {
  if (cfg.baseURL) return cfg.baseURL
  if (cfg.baseURLEnv) {
    const v = process.env[cfg.baseURLEnv]?.trim()
    if (v) return v
  }
  return null
}

/**
 * SSRF-style guardrails for anthropic-compatible provider base URLs.
 * Cheap syntactic checks only — must be `https:`, must have a hostname,
 * must not be `localhost` / a literal loopback / a private-range IP /
 * a `.local` or `.internal` suffix. Full DNS-resolution-based
 * rebinding protection is out of scope for a synchronous gate; the
 * goal here is to refuse the obviously-broken configurations at
 * resolution time rather than silently exfiltrating a provider's
 * api key to an http://localhost:8080 endpoint someone forgot to
 * clear from their .env.
 */
function isSafeBaseUrl(input: string): boolean {
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
  if (/^127\./.test(host)) return false
  if (host === "0.0.0.0") return false
  if (/^10\./.test(host)) return false
  if (/^192\.168\./.test(host)) return false
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return false
  if (host === "::1" || host === "[::1]") return false
  return true
}

/** Per-process warn-once trackers so misconfigurations don't spam the
 *  logs on every request. */
const warnedPartial = new Set<string>()
const warnedBadUrl = new Map<string, string>()

function envLabel(inline: string | undefined, envName: string | undefined): string {
  return envName ?? (inline ? "<inline>" : "<unset>")
}

/** Resolve a provider's credentials at request time. Returns null when
 *  the provider isn't fully configured (caller should skip the route).
 *  Anthropic-compatible providers additionally fail closed when the
 *  base URL doesn't pass `isSafeBaseUrl`. */
export function resolveProvider(name: string): ResolvedProvider | null {
  const cfg = getProviderConfig(name)
  if (!cfg) return null
  const apiKey = pickApiKey(cfg)
  if (cfg.type === "anthropic") {
    const baseURL = pickBaseURL(cfg)
    // Partial-env warning: one of the two is set but not the other.
    // Almost always a config mistake (user pasted half the override).
    if ((!!apiKey) !== (!!baseURL)) {
      if (!warnedPartial.has(name)) {
        console.warn(
          `[providers] ${name}: only one of ${envLabel(cfg.baseURL, cfg.baseURLEnv)} / ${envLabel(cfg.apiKey, cfg.apiKeyEnv)} is set; both are required. Skipping this provider.`
        )
        warnedPartial.add(name)
      }
      return null
    }
    if (!apiKey || !baseURL) return null
    if (!isSafeBaseUrl(baseURL)) {
      // Refuse to construct the client — sending the api key as an
      // Authorization header to e.g. http://internal.svc would
      // exfiltrate it. Warn once per distinct bad value.
      if (warnedBadUrl.get(name) !== baseURL) {
        console.warn(
          `[providers] ${name}: refusing to use baseURL="${baseURL}" — must be an https:// URL with a public hostname. Skipping this provider.`
        )
        warnedBadUrl.set(name, baseURL)
      }
      return null
    }
    return { type: "anthropic", baseURL, apiKey }
  }
  if (!apiKey) return null
  return { type: "gateway", apiKey }
}

/** True iff `resolveProvider(name)` would return a value. Cheap to
 *  call — handy for health endpoints. */
export function isProviderConfigured(name: string): boolean {
  return resolveProvider(name) !== null
}

/** Snapshot of the provider names declared in the config (without
 *  resolving credentials). Useful for diagnostics. */
export function listProviderNames(): string[] {
  return Object.keys(PROVIDERS)
}

/** Exported for tests only. */
export const __test = { isSafeBaseUrl }

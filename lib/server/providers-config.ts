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

/** Adds the `baseURL` / `baseURLEnv` pair to providers that talk to a
 *  user-configurable endpoint (anthropic-compatible, openai-compatible).
 *  Gateway providers don't need this since they don't expose a URL. */
const UrlBaseFieldsSchema = BaseFieldsSchema.extend({
  /** Inline base URL. Wins over `baseURLEnv` when set. The dispatcher
   *  passes this directly to the SDK; the SDK's path-suffix rules
   *  (`/messages` for anthropic, `/chat/completions` for openai) apply,
   *  so include any `/v1` suffix the endpoint expects. */
  baseURL: z.string().url().optional(),
  /** Name of an env var to read the base URL from. Looked up only when
   *  `baseURL` isn't set. */
  baseURLEnv: z.string().min(1).optional(),
})

const GatewayProviderSchema = BaseFieldsSchema.extend({
  type: z.literal("gateway"),
})

const AnthropicProviderSchema = UrlBaseFieldsSchema.extend({
  type: z.literal("anthropic"),
})

const OpenAIProviderSchema = UrlBaseFieldsSchema.extend({
  type: z.literal("openai"),
  /** Opt-in escape hatch for self-hosted local endpoints
   *  (Ollama, vLLM, LM Studio). When `true`:
   *    1. The `isSafeBaseUrl` SSRF gate is **skipped** — `http://` and
   *       loopback / private-network hostnames are allowed.
   *    2. The API key is **optional** — Ollama and similar local
   *       servers don't enforce auth, so an unset `apiKeyEnv` is fine.
   *  Default `false` keeps the safe path: https + public host + key.
   *  Only set this on providers the deployer fully controls and trusts
   *  — by enabling it you take responsibility for the upstream URL not
   *  being a credential-exfiltration sink. */
  allowInsecureBaseUrl: z.boolean().optional(),
})

const ProviderSchema = z.discriminatedUnion("type", [
  GatewayProviderSchema,
  AnthropicProviderSchema,
  OpenAIProviderSchema,
])

const ProvidersConfigSchema = z.record(z.string().min(1), ProviderSchema)

export type ProviderConfig = z.infer<typeof ProviderSchema>
export type GatewayProviderConfig = z.infer<typeof GatewayProviderSchema>
export type AnthropicProviderConfig = z.infer<typeof AnthropicProviderSchema>
export type OpenAIProviderConfig = z.infer<typeof OpenAIProviderSchema>
type UrlProviderConfig = AnthropicProviderConfig | OpenAIProviderConfig

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
export interface ResolvedOpenAIProvider {
  type: "openai"
  baseURL: string
  /** Empty string when the provider is configured with
   *  `allowInsecureBaseUrl: true` and no API key is supplied — used by
   *  local self-hosted endpoints (Ollama, vLLM, LM Studio) that don't
   *  enforce auth. The dispatcher passes an empty key straight to
   *  `createOpenAICompatible`, which accepts it. */
  apiKey: string
}
export interface ResolvedGatewayProvider {
  type: "gateway"
  apiKey: string
}
export type ResolvedProvider =
  | ResolvedAnthropicProvider
  | ResolvedOpenAIProvider
  | ResolvedGatewayProvider

function pickApiKey(cfg: ProviderConfig): string | null {
  if (cfg.apiKey) return cfg.apiKey
  if (cfg.apiKeyEnv) {
    const v = process.env[cfg.apiKeyEnv]?.trim()
    if (v) return v
  }
  return null
}

function pickBaseURL(cfg: UrlProviderConfig): string | null {
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
/** A parseable URL with `http:` or `https:` and a non-empty hostname.
 *  This check runs even on `allowInsecureBaseUrl` providers — a
 *  malformed URL would crash the SDK at request time anyway. */
function isParseableHttpUrl(input: string): boolean {
  let u: URL
  try {
    u = new URL(input)
  } catch {
    return false
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false
  if (!u.hostname) return false
  return true
}

function isSafeBaseUrl(input: string): boolean {
  if (!isParseableHttpUrl(input)) return false
  const u = new URL(input)
  if (u.protocol !== "https:") return false
  const host = u.hostname.toLowerCase()
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

function resolveUrlProvider(
  name: string,
  cfg: UrlProviderConfig
): { baseURL: string; apiKey: string } | null {
  const apiKey = pickApiKey(cfg)
  const baseURL = pickBaseURL(cfg)
  // `allowInsecureBaseUrl` is only on the openai-type provider. When set,
  // it relaxes both the apiKey-required and isSafeBaseUrl checks below.
  // Use case: Ollama / vLLM / LM Studio on a local box.
  const allowInsecure =
    cfg.type === "openai" && cfg.allowInsecureBaseUrl === true
  // Partial-env warning: one of the two is set but not the other.
  // Almost always a config mistake (user pasted half the override).
  // Skipped when `allowInsecureBaseUrl` is on, since apiKey is optional
  // in that mode and "baseURL set, apiKey unset" is a valid Ollama-style
  // configuration.
  if (!allowInsecure && (!!apiKey) !== (!!baseURL)) {
    if (!warnedPartial.has(name)) {
      console.warn(
        `[providers] ${name}: only one of ${envLabel(cfg.baseURL, cfg.baseURLEnv)} / ${envLabel(cfg.apiKey, cfg.apiKeyEnv)} is set; both are required. Skipping this provider.`
      )
      warnedPartial.add(name)
    }
    return null
  }
  if (!baseURL) return null
  if (!apiKey && !allowInsecure) return null
  // Always reject obviously-unparseable URLs — `new URL(value)` would
  // throw inside the SDK at first request and the error would be
  // opaque ("undefined fetch"); failing here surfaces it at boot
  // instead.
  if (!isParseableHttpUrl(baseURL)) {
    if (warnedBadUrl.get(name) !== baseURL) {
      console.warn(
        `[providers] ${name}: baseURL="${baseURL}" is not a parseable http(s) URL. Skipping this provider.`
      )
      warnedBadUrl.set(name, baseURL)
    }
    return null
  }
  if (!allowInsecure && !isSafeBaseUrl(baseURL)) {
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
  return { baseURL, apiKey: apiKey ?? "" }
}

/** Resolve a provider's credentials at request time. Returns null when
 *  the provider isn't fully configured (caller should skip the route).
 *  URL-bearing providers (anthropic / openai) additionally fail closed
 *  when the base URL doesn't pass `isSafeBaseUrl`. */
export function resolveProvider(name: string): ResolvedProvider | null {
  const cfg = getProviderConfig(name)
  if (!cfg) return null
  if (cfg.type === "anthropic") {
    const r = resolveUrlProvider(name, cfg)
    return r ? { type: "anthropic", ...r } : null
  }
  if (cfg.type === "openai") {
    const r = resolveUrlProvider(name, cfg)
    return r ? { type: "openai", ...r } : null
  }
  const apiKey = pickApiKey(cfg)
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
export const __test = {
  isSafeBaseUrl,
  /** Validate any config object against the providers schema. Lets
   *  tests assert that the openai / anthropic / gateway variants are
   *  accepted (or rejected) without round-tripping through the
   *  bundled `config/providers.json`. */
  parseConfig: (raw: unknown) => ProvidersConfigSchema.safeParse(raw),
}

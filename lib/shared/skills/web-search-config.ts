/**
 * Per-skill config for `webSearch`.
 *
 * Shape:
 *   {
 *     maxCalls?: number,           // tool-level — total calls per turn
 *     tavily?:  { enabled?, searchDepth? },
 *     brave?:   { enabled?, freshness? },
 *   }
 *
 * `maxCalls` is enforced at the tool level: one `webSearch` invocation
 * counts as one cap unit even when it fans out to multiple providers.
 *
 * Provider-level `enabled` is a user opt-out. The default is "use it if
 * the server has the API key" — i.e. enabled is treated as `true` when
 * absent and the server has the credential. Setting it to `false`
 * explicitly suppresses that provider regardless of credentials.
 *
 * Resolution order — for each scalar field — is conversation override
 * → workspace default → built-in default. Provider sub-objects merge
 * field-by-field rather than wholesale-replacing, so a workspace can
 * set `tavily.searchDepth = 'advanced'` and a conversation can set
 * `brave.enabled = false` without either erasing the other's setting.
 */

// --- Maxcalls ---------------------------------------------------------------

/** Built-in default when neither workspace nor conversation specifies. */
export const DEFAULT_MAX_WEB_SEARCHES = 3
/** Inclusive bounds the UI enforces on the stepper. */
export const MIN_MAX_WEB_SEARCHES = 1
export const MAX_MAX_WEB_SEARCHES = 10

export function clampMaxWebSearches(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MAX_WEB_SEARCHES
  const rounded = Math.round(n)
  if (rounded < MIN_MAX_WEB_SEARCHES) return MIN_MAX_WEB_SEARCHES
  if (rounded > MAX_MAX_WEB_SEARCHES) return MAX_MAX_WEB_SEARCHES
  return rounded
}

// --- Per-provider option types ---------------------------------------------

/** Tavily-specific knobs. */
export type TavilySearchDepth = "basic" | "advanced"
export const TAVILY_SEARCH_DEPTHS: ReadonlyArray<TavilySearchDepth> = [
  "basic",
  "advanced",
]
export const DEFAULT_TAVILY_SEARCH_DEPTH: TavilySearchDepth = "basic"

export interface TavilyConfig {
  enabled?: boolean
  searchDepth?: TavilySearchDepth
}

/** Brave-specific knobs. */
export type BraveFreshness = "any" | "pd" | "pw" | "pm" | "py"
export const BRAVE_FRESHNESSES: ReadonlyArray<BraveFreshness> = [
  "any",
  "pd",
  "pw",
  "pm",
  "py",
]
export const DEFAULT_BRAVE_FRESHNESS: BraveFreshness = "any"
/** User-facing labels for the freshness select. */
export const BRAVE_FRESHNESS_LABELS: Record<BraveFreshness, string> = {
  any: "Any time",
  pd: "Past 24 hours",
  pw: "Past week",
  pm: "Past month",
  py: "Past year",
}

export interface BraveConfig {
  enabled?: boolean
  freshness?: BraveFreshness
}

// --- Top-level config + resolver -------------------------------------------

export interface WebSearchConfig {
  maxCalls?: number
  tavily?: TavilyConfig
  brave?: BraveConfig
}

/**
 * Fully-resolved config after cascading + clamping. Every field is
 * concrete so server code doesn't have to keep guarding for `undefined`.
 */
export interface ResolvedWebSearchConfig {
  maxCalls: number
  tavily: { enabled: boolean; searchDepth: TavilySearchDepth }
  brave: { enabled: boolean; freshness: BraveFreshness }
}

export function resolveWebSearchConfig(
  workspaceCfg: WebSearchConfig | undefined,
  conversationCfg: WebSearchConfig | undefined
): ResolvedWebSearchConfig {
  const maxCalls = clampMaxWebSearches(
    conversationCfg?.maxCalls ??
      workspaceCfg?.maxCalls ??
      DEFAULT_MAX_WEB_SEARCHES
  )
  return {
    maxCalls,
    tavily: {
      enabled:
        conversationCfg?.tavily?.enabled ??
        workspaceCfg?.tavily?.enabled ??
        true,
      searchDepth:
        conversationCfg?.tavily?.searchDepth ??
        workspaceCfg?.tavily?.searchDepth ??
        DEFAULT_TAVILY_SEARCH_DEPTH,
    },
    brave: {
      enabled:
        conversationCfg?.brave?.enabled ??
        workspaceCfg?.brave?.enabled ??
        true,
      freshness:
        conversationCfg?.brave?.freshness ??
        workspaceCfg?.brave?.freshness ??
        DEFAULT_BRAVE_FRESHNESS,
    },
  }
}

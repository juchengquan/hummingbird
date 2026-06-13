import { z } from "zod"

import rawConfig from "@/config/models.json"

/**
 * Public model registry. Source of truth lives in `config/models.json`;
 * this module validates it at boot and exposes the same `CHAT_MODELS`
 * / `DEFAULT_CHAT_MODEL` / `getChatModel` API the rest of the app
 * already consumes. Safe to import from client components — the JSON
 * holds only display metadata + provider names, no secrets.
 */

const RouteSchema = z.object({
  /** Provider name referenced from `config/providers.json`. */
  via: z.string().min(1),
  /** Optional upstream model id when the provider expects a different
   *  string than this entry's `id` (e.g. stripping the `minimax/` prefix
   *  before sending to Minimax-CN). Defaults to the model `id` itself. */
  upstreamId: z.string().min(1).optional(),
  /** Ordered list of upstream model ids the provider should fall back
   *  to if the primary (`upstreamId` / route id) fails. Only honoured
   *  by providers that recognise the wire field (today: `openrouter`,
   *  which reads `body.models = [...]` as its fallback list). Other
   *  providers ignore this field silently — safe to set; no-op
   *  elsewhere. Cap is loose (8) to keep the body lean. */
  fallbacks: z.array(z.string().min(1)).max(8).optional(),
})

const ChatModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  provider: z.string().min(1),
  /** Total context window in tokens. Drives the chat header's context
   *  meter (how close the conversation is to the drop-old-messages
   *  threshold). */
  contextWindow: z.number().int().positive(),
  /** Ordered list of routes. The server-side dispatcher tries them in
   *  order and picks the first whose provider is configured (i.e. has
   *  the env vars / inline credentials it needs). At least one route
   *  is required. */
  routes: z.array(RouteSchema).min(1),
  /** When true, the model exposes a thinking-budget / reasoning-effort
   *  knob, so the chat header shows the Fast/Balanced/Thorough control
   *  and the route maps the chosen tier onto provider options. Absent /
   *  false → no control, provider default behaviour. See
   *  `@/shared/reasoning-effort`. */
  supportsReasoningEffort: z.boolean().optional(),
  /** When true, the model supports native structured output (constrained
   *  decoding against a JSON schema) via the AI SDK's `generateObject`.
   *  The deterministic non-chat calls (suggestions / summaries) use it
   *  when set and fall back to lenient text parsing otherwise. See
   *  `@/server/ai/structured`. */
  supportsStructuredOutput: z.boolean().optional(),
  /** Which tokenizer the context meter uses to estimate this model's
   *  token count. `tiktoken-o200k` (modern OpenAI), `tiktoken-cl100k`
   *  (older OpenAI; also a within-a-few-% proxy for Anthropic). Absent →
   *  the chars/4 heuristic, which undercounts code/JSON by 30-50%. See
   *  `@/shared/tokens`. */
  tokenizer: z.enum(["tiktoken-cl100k", "tiktoken-o200k", "heuristic"]).optional(),
})

const RoutingConfigSchema = z.object({
  /** Model the `auto` router escalates to for hard prompts. */
  strong: z.string().min(1),
  /** Model the `auto` router uses for easy prompts. */
  weak: z.string().min(1),
})

const ModelsConfigSchema = z.object({
  default: z.string().min(1),
  /** Strong/weak pair for the `auto` smart-routing option. Optional —
   *  absent → `auto` is unavailable (the picker hides it). */
  routing: RoutingConfigSchema.optional(),
  models: z.array(ChatModelSchema).min(1),
})

export type RoutingConfig = z.infer<typeof RoutingConfigSchema>

export type ChatModelRoute = z.infer<typeof RouteSchema>
export type ChatModel = z.infer<typeof ChatModelSchema>

const parsed = ModelsConfigSchema.safeParse(rawConfig)
if (!parsed.success) {
  throw new Error(
    `config/models.json is invalid: ${parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")}`
  )
}

const config = parsed.data

if (!config.models.some((m) => m.id === config.default)) {
  throw new Error(
    `config/models.json: default "${config.default}" is not in the models list`
  )
}

export const CHAT_MODELS: ChatModel[] = config.models
export const DEFAULT_CHAT_MODEL: string = config.default

// Validate the routing pair references real models — same boot-time
// guard as `default`, so a typo fails loudly instead of at request time.
if (config.routing) {
  for (const [slot, id] of [
    ["strong", config.routing.strong],
    ["weak", config.routing.weak],
  ] as const) {
    if (!config.models.some((m) => m.id === id)) {
      throw new Error(
        `config/models.json: routing.${slot} "${id}" is not in the models list`
      )
    }
  }
}

/** Sentinel model id for the smart-routing ("Auto") option — resolved
 *  server-side to a concrete model per prompt. Never sent to a provider
 *  directly. See `@/server/routing/router`. */
export const AUTO_MODEL_ID = "auto"

/** The configured strong/weak routing pair, or null when unconfigured
 *  (in which case `auto` is hidden + treated as the default model). */
export const ROUTING_CONFIG: RoutingConfig | null = config.routing ?? null

/** Whether the `auto` smart-routing option is available (a routing pair
 *  is configured). Gates the picker entry + the server-side resolve. */
export const ROUTING_AVAILABLE: boolean = ROUTING_CONFIG !== null

/** Whether `id` is the smart-routing sentinel. */
export function isAutoModel(id: string): boolean {
  return id === AUTO_MODEL_ID
}

/** Look up a model definition by id. Returns null when the id is
 *  unknown (rare — typically only on legacy state from before a model
 *  was removed). */
export function getChatModel(id: string): ChatModel | null {
  return CHAT_MODELS.find((m) => m.id === id) ?? null
}

/** Whether a model exposes a reasoning-effort / thinking-budget knob.
 *  Drives both the chat-header control's visibility and whether the
 *  client sends `reasoningEffort` on the wire. Unknown id → false. */
export function modelSupportsReasoningEffort(id: string): boolean {
  return getChatModel(id)?.supportsReasoningEffort === true
}

/** Whether a model supports native structured output (constrained
 *  decoding). Drives whether the deterministic call sites use
 *  `generateObject` or fall back to lenient text parsing. Unknown id →
 *  false. */
export function modelSupportsStructuredOutput(id: string): boolean {
  return getChatModel(id)?.supportsStructuredOutput === true
}

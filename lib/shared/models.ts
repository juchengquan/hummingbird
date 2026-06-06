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
})

const ModelsConfigSchema = z.object({
  default: z.string().min(1),
  models: z.array(ChatModelSchema).min(1),
})

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

/** Look up a model definition by id. Returns null when the id is
 *  unknown (rare — typically only on legacy state from before a model
 *  was removed). */
export function getChatModel(id: string): ChatModel | null {
  return CHAT_MODELS.find((m) => m.id === id) ?? null
}

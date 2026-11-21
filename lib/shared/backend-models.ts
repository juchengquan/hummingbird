/**
 * Which chat models a backend accepts (Q40 of
 * docs/PLAN-frontend-backend-split.md). The Next.js routes dispatch every
 * catalog model (and resolve `auto`); the agent services (agent-py,
 * agent-ts) accept only the `anthropic/*` allowlist and answer anything
 * else with 400 `unknown_model`, so on them the picker offers only those
 * models and a model they don't accept is switched to their default.
 */

import {
  ANTHROPIC_SERVICE_MODELS,
  AUTO_MODEL_ID,
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  ROUTING_AVAILABLE,
  type ChatModel,
} from "./models"

/** `"any"`: the Next.js routes. `"agent-service"`: agent-py / agent-ts. */
export type ModelBackendKind = "any" | "agent-service"

export function backendAcceptsModel(kind: ModelBackendKind, id: string): boolean {
  if (kind === "any") return id === AUTO_MODEL_ID ? ROUTING_AVAILABLE : CHAT_MODELS.some((m) => m.id === id)
  return ANTHROPIC_SERVICE_MODELS.has(id)
}

/** The picker's models for `kind`, in catalog order. */
export function modelsForBackend(kind: ModelBackendKind): ChatModel[] {
  return kind === "any" ? CHAT_MODELS : CHAT_MODELS.filter((m) => ANTHROPIC_SERVICE_MODELS.has(m.id))
}

/** Whether the smart-routing `auto` entry is offered (Next.js resolves it). */
export function autoAvailableForBackend(kind: ModelBackendKind): boolean {
  return kind === "any" && ROUTING_AVAILABLE
}

/**
 * The model to switch to when the selected one isn't accepted: the
 * catalog default when the backend takes it, else the first accepted
 * model in `config/models.json` order. `null` only if the catalog has no
 * model for the backend (it then can't serve chat at all).
 */
export function defaultModelForBackend(kind: ModelBackendKind): string | null {
  if (backendAcceptsModel(kind, DEFAULT_CHAT_MODEL)) return DEFAULT_CHAT_MODEL
  return modelsForBackend(kind)[0]?.id ?? null
}

export interface ModelBackend {
  kind: ModelBackendKind
  /** Shown in the switch note: "agent-py" / "agent-ts"; `null` for the Next.js routes. */
  name: string | null
}

const NEXT_ROUTES: ModelBackend = { kind: "any", name: null }

/**
 * The backend a chat turn reaches, mirroring the dispatch rules: the runs
 * option goes to agent-py signed in or out; `python` / `ts-service` reach
 * their service only when signed in (signed-out turns fall back to the
 * Next.js route, `resolveRemoteBackend`); an unconfigured service → Next.
 */
export function resolveModelBackend(
  chatBackend: "ts" | "python" | "ts-service" | "python-runs",
  signedIn: boolean,
  configured: { agentPy: boolean; agentTs: boolean },
): ModelBackend {
  switch (chatBackend) {
    case "python-runs":
      return configured.agentPy ? { kind: "agent-service", name: "agent-py" } : NEXT_ROUTES
    case "python":
      return configured.agentPy && signedIn ? { kind: "agent-service", name: "agent-py" } : NEXT_ROUTES
    case "ts-service":
      return configured.agentTs && signedIn ? { kind: "agent-service", name: "agent-ts" } : NEXT_ROUTES
    default:
      return NEXT_ROUTES
  }
}

/** The model to switch to, or `null` when `model` is fine on `backend`. */
export function modelSwitchFor(backend: ModelBackend, model: string): string | null {
  if (backendAcceptsModel(backend.kind, model)) return null
  const fallback = defaultModelForBackend(backend.kind)
  return fallback && fallback !== model ? fallback : null
}

/**
 * The error bubble's one-click fallback, among the models the serving
 * backend accepts: its default when that isn't the failed model,
 * otherwise the first other accepted model; null when there's none.
 */
export function pickFallbackModel(
  failedModelId: string | undefined,
  kind: ModelBackendKind = "any",
): { id: string; label: string } | null {
  const models = modelsForBackend(kind)
  const preferred = defaultModelForBackend(kind)
  if (preferred && preferred !== failedModelId) {
    const def = models.find((m) => m.id === preferred)
    if (def) return { id: def.id, label: def.label }
  }
  const other = models.find((m) => m.id !== failedModelId)
  return other ? { id: other.id, label: other.label } : null
}

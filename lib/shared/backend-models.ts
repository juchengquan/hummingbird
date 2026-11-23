/**
 * Which chat models a backend accepts (Q40 of
 * docs/PLAN-frontend-backend-split.md). The Next.js routes dispatch every
 * catalog model (and resolve `auto`); the agent services (agent-py,
 * agent-ts) accept only the `anthropic/*` allowlist and answer anything
 * else with 400 `unknown_model`, so on them the picker offers only those
 * models and a model they don't accept is switched to their default.
 * agent-py's runs API (`/v1/runs`) also routes `auto` when the catalog's
 * routing pair is on that allowlist (wave 5b-C); its `/v1/chat` and
 * agent-ts don't. Background tasks run in agent-py's worker whatever
 * serves chat, so they take the agent-service models (Q55).
 */

import {
  ANTHROPIC_SERVICE_MODELS,
  AUTO_MODEL_ID,
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  ROUTING_AVAILABLE,
  ROUTING_CONFIG,
  type ChatModel,
} from "./models"

/** `"any"`: the Next.js routes. `"agent-service"`: agent-py's `/v1/chat`
 *  and agent-ts. `"agent-runs"`: agent-py's runs API — the same models,
 *  plus `auto` when {@link RUNS_ROUTING_AVAILABLE}. */
export type ModelBackendKind = "any" | "agent-service" | "agent-runs"

/** Whether agent-py's runs route `auto`: the catalog has a routing pair
 *  and both of its models are on the agent-service allowlist (agent-py's
 *  `ModelAllowlist.routing`). */
export const RUNS_ROUTING_AVAILABLE: boolean =
  ROUTING_CONFIG !== null &&
  ANTHROPIC_SERVICE_MODELS.has(ROUTING_CONFIG.strong) &&
  ANTHROPIC_SERVICE_MODELS.has(ROUTING_CONFIG.weak)

export function backendAcceptsModel(kind: ModelBackendKind, id: string): boolean {
  if (id === AUTO_MODEL_ID) return autoAvailableForBackend(kind)
  if (kind === "any") return CHAT_MODELS.some((m) => m.id === id)
  return ANTHROPIC_SERVICE_MODELS.has(id)
}

/** The picker's models for `kind`, in catalog order. */
export function modelsForBackend(kind: ModelBackendKind): ChatModel[] {
  return kind === "any" ? CHAT_MODELS : CHAT_MODELS.filter((m) => ANTHROPIC_SERVICE_MODELS.has(m.id))
}

/** Whether the smart-routing `auto` entry is offered: the Next.js routes
 *  and agent-py's runs resolve it; agent-py's `/v1/chat` and agent-ts don't. */
export function autoAvailableForBackend(kind: ModelBackendKind): boolean {
  if (kind === "any") return ROUTING_AVAILABLE
  if (kind === "agent-runs") return RUNS_ROUTING_AVAILABLE
  return false
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
      return configured.agentPy ? { kind: "agent-runs", name: "agent-py" } : NEXT_ROUTES
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

/** The task worker, as a backend for the picker and its switch note (Q55). */
export const TASK_MODEL_BACKEND: ModelBackend = { kind: "agent-service", name: "tasks" }

/** What a task falls back to (Q67): agent-py's own default, the cheap one. */
export const TASK_FALLBACK_MODEL = "anthropic/claude-haiku-4.5"

/**
 * The model to launch a task with, when `requested` was asked for (absent
 * = the catalog default, as `POST /api/tasks` reads it): itself, or the
 * fallback with what it was switched from, to say so. `model` is null only
 * when the catalog has nothing the worker runs.
 */
export function taskModelFor(requested: string | null | undefined): {
  model: string | null
  switchedFrom: string | null
} {
  const asked = requested || DEFAULT_CHAT_MODEL
  if (backendAcceptsModel(TASK_MODEL_BACKEND.kind, asked)) return { model: asked, switchedFrom: null }
  const fallback = backendAcceptsModel(TASK_MODEL_BACKEND.kind, TASK_FALLBACK_MODEL)
    ? TASK_FALLBACK_MODEL
    : defaultModelForBackend(TASK_MODEL_BACKEND.kind)
  return { model: fallback, switchedFrom: asked }
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

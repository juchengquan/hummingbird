/**
 * Which chat models a backend accepts (Q40 of
 * docs/PLAN-frontend-backend-split.md). The Next.js routes dispatch every
 * catalog model (and resolve `auto`). agent-py runs the catalog models it
 * has a provider for (wave 10): its `GET /v1/models`, loaded once into
 * `@/shared/served-models`; until then, or when it can't be read, the
 * built-in `anthropic/*` list. agent-ts (frozen) accepts only that list.
 * On an agent service the picker offers only what it accepts, and a model
 * it doesn't accept is switched to its default. agent-py's runs API also
 * routes `auto` when its routing pair is served; its `/v1/chat` and
 * agent-ts don't. Background tasks run in agent-py's worker whatever serves
 * chat, so they take agent-py's task models (Q55, Q117).
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
import { noModelProvider, servedModels } from "./served-models"

/** `"any"`: the Next.js routes. `"agent-service"`: agent-py's `/v1/chat`.
 *  `"agent-runs"`: agent-py's runs API — the same models, plus `auto` when
 *  served. `"agent-tasks"`: agent-py's task worker — the models tasks run
 *  on. `"agent-ts"`: agent-ts, the `anthropic/*` list. */
export type ModelBackendKind = "any" | "agent-service" | "agent-runs" | "agent-tasks" | "agent-ts"

/** Whether agent-py's runs route `auto` by the built-in list: the catalog
 *  has a routing pair and both of its models are `anthropic/*` (used until
 *  agent-py's own answer arrives). */
export const RUNS_ROUTING_AVAILABLE: boolean =
  ROUTING_CONFIG !== null &&
  ANTHROPIC_SERVICE_MODELS.has(ROUTING_CONFIG.strong) &&
  ANTHROPIC_SERVICE_MODELS.has(ROUTING_CONFIG.weak)

/** Whether `kind` accepts what agent-py's `/v1/models` lists. */
export function usesAgentPyList(kind: ModelBackendKind): boolean {
  return kind === "agent-service" || kind === "agent-runs" || kind === "agent-tasks"
}

/**
 * Q131: whether a send on `kind` is refused because agent-py — which serves
 * it — answered its model list and the list was **empty** (no model provider
 * on the deploy): the picker and the chat say so instead of every send
 * failing 503. A list that could not be read never refuses (the built-in
 * list stands, as before). The Next routes and agent-ts are unaffected.
 */
export function sendRefusedNoProvider(kind: ModelBackendKind, agentPyConfigured: boolean): boolean {
  return usesAgentPyList(kind) && agentPyConfigured && noModelProvider()
}

/** The ids `kind` accepts, or null for every catalog model (Next). */
function acceptedIds(kind: ModelBackendKind): ReadonlySet<string> | ReadonlyMap<string, string> | null {
  if (!usesAgentPyList(kind)) return kind === "any" ? null : ANTHROPIC_SERVICE_MODELS
  const served = servedModels()
  if (!served) return ANTHROPIC_SERVICE_MODELS
  return kind === "agent-tasks" ? served.tasks : served.ids
}

export function backendAcceptsModel(kind: ModelBackendKind, id: string): boolean {
  if (id === AUTO_MODEL_ID) return autoAvailableForBackend(kind)
  const ids = acceptedIds(kind)
  return ids === null ? CHAT_MODELS.some((m) => m.id === id) : ids.has(id)
}

/** The picker's models for `kind`, in catalog order. */
export function modelsForBackend(kind: ModelBackendKind): ChatModel[] {
  const ids = acceptedIds(kind)
  return ids === null ? CHAT_MODELS : CHAT_MODELS.filter((m) => ids.has(m.id))
}

/** Whether the smart-routing `auto` entry is offered: the Next.js routes
 *  and agent-py's runs resolve it; agent-py's `/v1/chat`, its task worker
 *  and agent-ts don't. */
export function autoAvailableForBackend(kind: ModelBackendKind): boolean {
  if (kind === "any") return ROUTING_AVAILABLE
  if (kind === "agent-runs") return servedModels()?.auto ?? RUNS_ROUTING_AVAILABLE
  return false
}

/**
 * The model to switch to when the selected one isn't accepted: the
 * catalog default when the backend takes it, else agent-py's own default
 * when it takes that, else the first accepted model in `config/models.json`
 * order. `null` only if the catalog has no model for the backend (it then
 * can't serve chat at all).
 */
export function defaultModelForBackend(kind: ModelBackendKind): string | null {
  if (backendAcceptsModel(kind, DEFAULT_CHAT_MODEL)) return DEFAULT_CHAT_MODEL
  const own = usesAgentPyList(kind) ? servedModels()?.defaultModel : null
  if (own && backendAcceptsModel(kind, own)) return own
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
      return configured.agentTs && signedIn ? { kind: "agent-ts", name: "agent-ts" } : NEXT_ROUTES
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
export const TASK_MODEL_BACKEND: ModelBackend = { kind: "agent-tasks", name: "tasks" }

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

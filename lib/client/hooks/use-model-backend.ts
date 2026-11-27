"use client"
import "client-only"

/**
 * Q40 of docs/PLAN-frontend-backend-split.md: the chat model picker only
 * offers the models the backend that will actually serve the turn
 * accepts, and a selected model it doesn't accept is switched to its
 * default with a visible note — instead of every message failing with
 * 400 `unknown_model` (the agent services take only the `anthropic/*`
 * allowlist; see `@/shared/backend-models`).
 *
 * Task mode passes `TASK_MODEL_BACKEND` (Q55): the task worker takes the
 * same models, whatever serves chat.
 */

import { useEffect, useRef, useSyncExternalStore } from "react"
import { toast } from "sonner"

import { isAgentPyConfigured, isAgentTsConfigured } from "@/client/api-client"
import { useAuth } from "@/client/hooks/use-auth"
import { useStore } from "@/client/hooks/use-store"
import {
  modelSwitchFor,
  resolveModelBackend,
  sendRefusedNoProvider,
  TASK_MODEL_BACKEND,
  usesAgentPyList,
  type ModelBackend,
} from "@/shared/backend-models"
import { getChatModel, isAutoModel } from "@/shared/models"
import { noModelProvider, servedModelsSettled, subscribeServedModels } from "@/shared/served-models"

import { useServedModels } from "./use-served-models"

export function useModelBackend(): ModelBackend {
  const chatBackend = useStore((s) => s.chatBackend)
  const { status } = useAuth()
  // Loads agent-py's `/v1/models` and re-renders the picker when it arrives.
  useServedModels()
  return resolveModelBackend(chatBackend, status === "signed-in", {
    agentPy: isAgentPyConfigured(),
    agentTs: isAgentTsConfigured(),
  })
}

/** Q131: agent-py serves `backend` and has no model provider at all (its
 *  list settled empty): the picker and the chat say so, and sends are
 *  refused (`sendRefusedNoProvider`). Re-renders when the list arrives. */
export function useNoModelProvider(backend: ModelBackend): boolean {
  useServedModels()
  useSyncExternalStore(subscribeServedModels, noModelProvider, () => false)
  return sendRefusedNoProvider(backend.kind, isAgentPyConfigured())
}

function labelFor(id: string): string {
  if (isAutoModel(id)) return "Auto"
  return getChatModel(id)?.label ?? id
}

/** The note that says `from` was switched to `to` for `backend`. */
export function modelSwitchNote(backend: ModelBackend, from: string, to: string): string {
  const where =
    backend.name === TASK_MODEL_BACKEND.name ? "in tasks" : `on ${backend.name ?? "this backend"}`
  return `${labelFor(from)} isn't available ${where}. Switched to ${labelFor(to)}.`
}

function onFocusChange(notify: () => void): () => void {
  window.addEventListener("focus", notify)
  window.addEventListener("blur", notify)
  return () => {
    window.removeEventListener("focus", notify)
    window.removeEventListener("blur", notify)
  }
}

/**
 * Switch a model the backend doesn't accept to its default, once the
 * store has hydrated, with a toast saying so. Reacts to backend changes,
 * sign-in, workspace model pins and picks alike. Doesn't mark the session
 * as user-overridden (`setChatModel` would), so a workspace pin still
 * applies when the user goes back to a backend that accepts it.
 *
 * Task mode is per tab but the model is shared by all tabs, so a tab in
 * Task mode switches only while it has focus: it mustn't undo a pick made
 * for ordinary chat in another tab. A launch switches anyway
 * (`taskModelFor`).
 */
export function useModelBackendGuard(backend: ModelBackend, hydrated: boolean): void {
  const chatModel = useStore((s) => s.chatModel)
  const lastNote = useRef<string | null>(null)
  const { kind, name } = backend
  const focused = useSyncExternalStore(onFocusChange, () => document.hasFocus(), () => true)
  const waitsForFocus = name === TASK_MODEL_BACKEND.name && !focused
  // agent-py's list decides what it accepts (wave 10): until its first read
  // answers, a model the built-in list lacks may be served — keep it.
  const served = useServedModels()
  const settled = useSyncExternalStore(subscribeServedModels, servedModelsSettled, () => false)
  const waitsForList = usesAgentPyList(kind) && isAgentPyConfigured() && !settled
  useEffect(() => {
    if (!hydrated || waitsForFocus || waitsForList) return
    const next = modelSwitchFor({ kind, name }, chatModel)
    if (!next) {
      // An accepted model is showing: a later switch is a new one to say.
      lastNote.current = null
      return
    }
    useStore.setState({ chatModel: next })
    const note = `${chatModel}→${next}@${name}`
    if (lastNote.current === note) return
    lastNote.current = note
    toast.info(modelSwitchNote({ kind, name }, chatModel, next))
  }, [kind, name, chatModel, hydrated, waitsForFocus, waitsForList, served])
}

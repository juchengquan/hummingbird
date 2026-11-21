"use client"
import "client-only"

/**
 * Q40 of docs/PLAN-frontend-backend-split.md: the chat model picker only
 * offers the models the backend that will actually serve the turn
 * accepts, and a selected model it doesn't accept is switched to its
 * default with a visible note — instead of every message failing with
 * 400 `unknown_model` (the agent services take only the `anthropic/*`
 * allowlist; see `@/shared/backend-models`).
 */

import { useEffect, useRef } from "react"
import { toast } from "sonner"

import { isAgentPyConfigured, isAgentTsConfigured } from "@/client/api-client"
import { useAuth } from "@/client/hooks/use-auth"
import { useStore } from "@/client/hooks/use-store"
import {
  modelSwitchFor,
  resolveModelBackend,
  type ModelBackend,
} from "@/shared/backend-models"
import { getChatModel, isAutoModel } from "@/shared/models"

export function useModelBackend(): ModelBackend {
  const chatBackend = useStore((s) => s.chatBackend)
  const { status } = useAuth()
  return resolveModelBackend(chatBackend, status === "signed-in", {
    agentPy: isAgentPyConfigured(),
    agentTs: isAgentTsConfigured(),
  })
}

function labelFor(id: string): string {
  if (isAutoModel(id)) return "Auto"
  return getChatModel(id)?.label ?? id
}

/**
 * Switch a model the backend doesn't accept to its default, once the
 * store has hydrated, with a toast saying so. Reacts to backend changes,
 * sign-in, workspace model pins and picks alike. Doesn't mark the session
 * as user-overridden (`setChatModel` would), so a workspace pin still
 * applies when the user goes back to a backend that accepts it.
 */
export function useModelBackendGuard(backend: ModelBackend, hydrated: boolean): void {
  const chatModel = useStore((s) => s.chatModel)
  const lastNote = useRef<string | null>(null)
  const { kind, name } = backend
  useEffect(() => {
    if (!hydrated) return
    const next = modelSwitchFor({ kind, name }, chatModel)
    if (!next) return
    useStore.setState({ chatModel: next })
    const note = `${chatModel}→${next}@${name}`
    if (lastNote.current === note) return
    lastNote.current = note
    toast.info(
      `${labelFor(chatModel)} isn't available on ${name ?? "this backend"}. Switched to ${labelFor(next)}.`,
    )
  }, [kind, name, chatModel, hydrated])
}

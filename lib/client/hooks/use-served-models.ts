"use client"
import "client-only"

/**
 * agent-py's served models (wave 10, Q119), loaded on first use when
 * agent-py is configured; re-renders when they arrive, so the model picker,
 * the switch note and the editor's list follow them. `null` until then.
 */

import { useEffect, useSyncExternalStore } from "react"

import { AGENT_PY_BASE_URL, isAgentPyConfigured } from "@/client/api-client"
import { loadServedModels } from "@/client/api/served-models"
import { servedModels, subscribeServedModels, type ServedModels } from "@/shared/served-models"

export function useServedModels(): ServedModels | null {
  const served = useSyncExternalStore(subscribeServedModels, servedModels, () => null)
  useEffect(() => {
    if (isAgentPyConfigured()) void loadServedModels(AGENT_PY_BASE_URL)
  }, [])
  return served
}

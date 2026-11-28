/**
 * The persona a user message was sent as (Q52). It is recorded on the
 * message so every way of sending that turn again (Regenerate, Edit,
 * Retry, the automatic retry, a UI card's answer) runs as the same
 * persona. Pure: no I/O, no React.
 */

import { z } from "zod"

import type { Agent, Message, TurnPersona } from "../types"
import { resolveAgent, type ResolvedAgent } from "./resolve"

const TurnPersonaSchema = z.object({
  agentId: z.string(),
  allowedMcpServerIds: z.array(z.string()),
})

/** What to store on the user message. */
export function recordTurnPersona(agent: Agent): TurnPersona {
  return { agentId: agent.id, allowedMcpServerIds: [...agent.allowedMcpServerIds] }
}

/** The record that governs a send: its newest user message's. */
export function latestTurnPersona(history: readonly Message[]): TurnPersona | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return history[i].turnPersona
  }
  return undefined
}

/**
 * A turn's overrides: the persona's prompt, model and skills as they are
 * now, and the recorded MCP allow-list as a ceiling (a persona narrowed
 * since narrows it, a widened one adds nothing). A persona that is gone,
 * or that this device doesn't have, still leaves its list in force.
 */
export function resolveTurnPersona(
  record: TurnPersona | undefined,
  agents: readonly Agent[],
): ResolvedAgent {
  if (!record) return resolveAgent(null)
  const current = resolveAgent(agents.find((a) => a.id === record.agentId))
  const now = current.allowedMcpServerIds
  return {
    ...current,
    allowedMcpServerIds: record.allowedMcpServerIds.filter((id) => !now || now.includes(id)),
  }
}

/** Read a synced record. An unreadable one fails closed: no MCP. */
export function parseTurnPersona(raw: unknown): TurnPersona | undefined {
  if (raw === null || raw === undefined) return undefined
  const parsed = TurnPersonaSchema.safeParse(raw)
  return parsed.success ? parsed.data : { agentId: "", allowedMcpServerIds: [] }
}

export function sameTurnPersona(a: TurnPersona | undefined, b: TurnPersona | undefined): boolean {
  if (!a || !b) return a === b
  return (
    a.agentId === b.agentId &&
    a.allowedMcpServerIds.length === b.allowedMcpServerIds.length &&
    a.allowedMcpServerIds.every((id, i) => id === b.allowedMcpServerIds[i])
  )
}

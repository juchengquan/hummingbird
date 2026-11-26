/**
 * The deploy's default chat backend (wave 11, Q110): "agent-py (runs)" when
 * agent-py is configured (`NEXT_PUBLIC_AGENT_PY_URL`), else the Next.js
 * route. A browser that never chose one follows it; the stored value is
 * then unset (`null`), so a deploy that changes its default moves it too.
 */

export const CHAT_BACKENDS = ["ts", "python", "ts-service", "python-runs"] as const
export type ChatBackendValue = (typeof CHAT_BACKENDS)[number]

export function isChatBackend(value: unknown): value is ChatBackendValue {
  return (CHAT_BACKENDS as readonly unknown[]).includes(value)
}

export function defaultChatBackend(agentPyConfigured: boolean): ChatBackendValue {
  return agentPyConfigured ? "python-runs" : "ts"
}

/**
 * On sign-in (Q111): a set account value wins — applied, not written back;
 * an unset one takes the browser's explicit choice (pushed up); unset on both
 * sides leaves the default in place and writes nothing.
 */
export function reconcileChatBackend(input: {
  server: ChatBackendValue | null
  local: ChatBackendValue
  localExplicit: boolean
}): { apply?: ChatBackendValue; push?: ChatBackendValue } {
  const { server, local, localExplicit } = input
  if (server !== null) return server !== local || !localExplicit ? { apply: server } : {}
  return localExplicit ? { push: local } : {}
}

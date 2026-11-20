import "server-only"

import { aiAuthDeps, type AiAuthDeps } from "../require-ai-auth"

/**
 * Route-test helper for the REQUIRE_AUTH_FOR_AI gate. Swaps the gate's
 * dependencies (flag value, Supabase-configured check, session) on the
 * shared `aiAuthDeps` object and returns a restore fn — no process-global
 * `mock.module`, so nothing leaks into other test files.
 */
export type AiAuthScenario =
  | "flag-off"
  | "supabase-unconfigured"
  | "anonymous"
  | "signed-in"

export function setAiAuthScenario(scenario: AiAuthScenario): () => void {
  const saved: AiAuthDeps = { ...aiAuthDeps }
  aiAuthDeps.env = () => (scenario === "flag-off" ? "false" : "true")
  aiAuthDeps.supabaseConfigured = () => scenario !== "supabase-unconfigured"
  aiAuthDeps.getClient = async () => ({
    auth: {
      getUser: async () =>
        scenario === "signed-in"
          ? {
              data: { user: { id: "user-1" } as never },
              error: null,
            }
          : {
              data: { user: null },
              error: { message: "Auth session missing!" },
            },
    },
  })
  return () => Object.assign(aiAuthDeps, saved)
}

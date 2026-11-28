/**
 * Tests for the agent-py target resolvers (wave 13, Q142): every call
 * goes to agent-py, with the session's token or tokenless. In tests
 * Supabase isn't configured, so there is never a session — the tokenless
 * path, which must still resolve to agent-py (never `null`, never a
 * fallback), except for the tasks panel (background runs are signed-in
 * only).
 */

import { describe, expect, test } from "bun:test"

import { AGENT_PY_BASE_URL } from "@/client/api-client"

import { resolveAgentPyTarget, resolveRunsTarget, resolveTasksTarget } from "./backend-resolver"

describe("resolveAgentPyTarget", () => {
  test("no session → agent-py, tokenless", async () => {
    expect(await resolveAgentPyTarget()).toEqual({ baseUrl: AGENT_PY_BASE_URL, authToken: null })
  })
})

describe("resolveRunsTarget", () => {
  test("no session → an anonymous run on agent-py (no token re-read)", async () => {
    const target = await resolveRunsTarget()
    expect(target).toEqual({ baseUrl: AGENT_PY_BASE_URL, authToken: null })
    expect(target.getAuthToken).toBeUndefined()
  })
})

describe("resolveTasksTarget", () => {
  test("no session → null: background runs are signed-in only", async () => {
    expect(await resolveTasksTarget()).toBeNull()
  })
})

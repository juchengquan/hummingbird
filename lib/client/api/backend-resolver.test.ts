/**
 * Tests for the `resolveRemoteBackend()` helper. The store branch
 * (`chatBackend === 'ts'`) and the env-var gate (no base URL set) are
 * the two paths that don't need any mocking — they short-circuit
 * before the Supabase import. The full happy-path resolution is
 * tested integration-style in `api-client.test.ts` because the env
 * vars are captured at module load time by `api-client.ts`, making
 * isolated unit tests fragile.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { useStore } from "@/client/hooks/use-store"

import { resolveRemoteBackend } from "./backend-resolver"

const ORIGINAL_BACKEND = useStore.getState().chatBackend

afterEach(() => {
  useStore.getState().setChatBackend(ORIGINAL_BACKEND)
})

describe("resolveRemoteBackend", () => {
  test("returns null when chatBackend = 'ts' (in-Next route)", async () => {
    useStore.getState().setChatBackend("ts")
    expect(await resolveRemoteBackend()).toBeNull()
  })

  test("returns null when a remote backend is selected but its env URL is unset", async () => {
    // The default-from-the-store path. agent-py/agent-ts URLs are
    // captured at module load — in tests they default to "" since
    // `NEXT_PUBLIC_AGENT_*_URL` aren't set, so this branch always
    // hits the early-return.
    useStore.getState().setChatBackend("python")
    expect(await resolveRemoteBackend()).toBeNull()

    useStore.getState().setChatBackend("ts-service")
    expect(await resolveRemoteBackend()).toBeNull()
  })
})

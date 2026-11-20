import { describe, expect, test } from "bun:test"

import {
  RequireAuthConfigError,
  isAiAuthRequired,
  parseRequireAuthFlag,
  requireAiAuth,
  type AiAuthDeps,
} from "./require-ai-auth"

type GetUser = Awaited<
  ReturnType<NonNullable<Awaited<ReturnType<AiAuthDeps["getClient"]>>>["auth"]["getUser"]>
>

/** Defaults: flag on, Supabase configured, anonymous session. */
function deps(
  overrides: Partial<AiAuthDeps> & { getUser?: () => Promise<GetUser> } = {},
): AiAuthDeps & { getClientCalls: number } {
  const getUser =
    overrides.getUser ??
    (async (): Promise<GetUser> => ({
      data: { user: null },
      error: { message: "Auth session missing!" },
    }))
  const d = {
    getClientCalls: 0,
    env: overrides.env ?? (() => "true"),
    supabaseConfigured: overrides.supabaseConfigured ?? (() => true),
    getClient:
      overrides.getClient ??
      (async () => {
        d.getClientCalls++
        return { auth: { getUser } }
      }),
  }
  return d
}

const signedInUser = (id = "user-1") =>
  ({ data: { user: { id } as unknown as NonNullable<GetUser["data"]["user"]> }, error: null }) as GetUser

describe("parseRequireAuthFlag", () => {
  test("unset / empty → off", () => {
    expect(parseRequireAuthFlag(undefined)).toBe(false)
    expect(parseRequireAuthFlag("")).toBe(false)
    expect(parseRequireAuthFlag("   ")).toBe(false)
  })

  test("true / 1 → on; false / 0 → off (case + whitespace tolerant)", () => {
    expect(parseRequireAuthFlag("true")).toBe(true)
    expect(parseRequireAuthFlag("1")).toBe(true)
    expect(parseRequireAuthFlag(" TRUE ")).toBe(true)
    expect(parseRequireAuthFlag("false")).toBe(false)
    expect(parseRequireAuthFlag("0")).toBe(false)
    expect(parseRequireAuthFlag("False")).toBe(false)
  })

  test("anything else throws (no silent fail-open on a typo)", () => {
    for (const bad of ["yes", "on", "ture", "2", "true!", "no"]) {
      expect(() => parseRequireAuthFlag(bad)).toThrow(RequireAuthConfigError)
    }
  })
})

describe("requireAiAuth", () => {
  test("flag off → pass-through without touching Supabase", async () => {
    for (const env of [undefined, "", "false", "0"]) {
      const d = deps({ env: () => env })
      const result = await requireAiAuth(d)
      expect(result).toEqual({ ok: true, user: null })
      expect(d.getClientCalls).toBe(0)
    }
  })

  test("flag on but Supabase unconfigured → pass-through", async () => {
    const d = deps({ supabaseConfigured: () => false })
    expect(isAiAuthRequired(d)).toBe(false)
    const result = await requireAiAuth(d)
    expect(result).toEqual({ ok: true, user: null })
    expect(d.getClientCalls).toBe(0)
  })

  test("flag on + anonymous → 401 auth_required envelope", async () => {
    const result = await requireAiAuth(deps())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(401)
    const body = await result.response.json()
    expect(body.code).toBe("auth_required")
    expect(typeof body.message).toBe("string")
  })

  test("flag on + signed in → ok with the getUser() user", async () => {
    const result = await requireAiAuth(deps({ getUser: async () => signedInUser("u-42") }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.user?.id).toBe("u-42")
  })

  test("fails closed: null client, getUser error, thrown lookup → 401", async () => {
    const nullClient = await requireAiAuth(deps({ getClient: async () => null }))
    expect(nullClient.ok).toBe(false)

    const errored = await requireAiAuth(
      deps({
        getUser: async () =>
          ({ data: { user: { id: "x" } }, error: { message: "network" } }) as unknown as GetUser,
      }),
    )
    expect(errored.ok).toBe(false)

    const thrown = await requireAiAuth(
      deps({
        getClient: async () => {
          throw new Error("cookies() outside request scope")
        },
      }),
    )
    expect(thrown.ok).toBe(false)
    if (!thrown.ok) expect(thrown.response.status).toBe(401)
  })

  test("invalid flag value throws (route fails loudly with 500)", async () => {
    await expect(requireAiAuth(deps({ env: () => "yes" }))).rejects.toThrow(
      RequireAuthConfigError,
    )
  })
})

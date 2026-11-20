import { beforeEach, describe, expect, test } from "bun:test"

import {
  AUTH_REQUIRED_TOAST_COOLDOWN_MS,
  isAuthRequiredError,
  notifyAuthRequired,
  openSignIn,
  resetAuthRequiredNotice,
  useSignInPrompt,
} from "./auth-required"

beforeEach(() => {
  resetAuthRequiredNotice()
  useSignInPrompt.getState().setOpen(false)
})

describe("isAuthRequiredError", () => {
  test("matches only the auth_required code (not the no-key `auth`)", () => {
    expect(isAuthRequiredError({ code: "auth_required" })).toBe(true)
    expect(isAuthRequiredError({ code: "auth" })).toBe(false)
    expect(isAuthRequiredError(undefined)).toBe(false)
    expect(isAuthRequiredError(null)).toBe(false)
  })
})

describe("notifyAuthRequired", () => {
  test("background calls are rate-limited; user-initiated ones always show", () => {
    const t0 = 1_000_000
    expect(notifyAuthRequired({ background: true }, t0)).toBe(true)
    expect(notifyAuthRequired({ background: true }, t0 + 1_000)).toBe(false)
    expect(notifyAuthRequired({}, t0 + 2_000)).toBe(true)
    expect(
      notifyAuthRequired({ background: true }, t0 + 2_000 + AUTH_REQUIRED_TOAST_COOLDOWN_MS),
    ).toBe(true)
  })
})

describe("openSignIn", () => {
  test("opens the sign-in prompt store", () => {
    expect(useSignInPrompt.getState().open).toBe(false)
    openSignIn()
    expect(useSignInPrompt.getState().open).toBe(true)
  })
})

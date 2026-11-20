import "client-only"

/**
 * Client side of the `REQUIRE_AUTH_FOR_AI` policy. When an AI route
 * answers `401 { code: "auth_required" }` the caller isn't signed in and
 * the server refuses anonymous AI calls — the UI should say so and offer
 * a sign-in, not show a generic failure (and never the "no AI key" mock
 * fallback, which keys off the different `auth` code).
 *
 * - `useSignInPrompt` — tiny store the `<SignInPromptHost/>` (mounted in
 *   the dashboard + editor pages) reads to open the sign-in dialog from
 *   anywhere (error bubble button, toast action) without prop threading.
 * - `notifyAuthRequired()` — one deduped toast with a "Sign in" action.
 *   Rate-limited for background callers (file summaries on upload,
 *   ghost-text autocomplete while typing) so they can't keep re-raising it.
 */

import { toast } from "sonner"
import { create } from "zustand"

import { AUTH_REQUIRED_MESSAGE } from "@/shared/api-errors"

export { isAuthRequiredError } from "@/shared/api-errors"

interface SignInPromptStore {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useSignInPrompt = create<SignInPromptStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

/** Open the sign-in dialog (no-op visually if no host is mounted). */
export function openSignIn(): void {
  useSignInPrompt.getState().setOpen(true)
}

export const AUTH_REQUIRED_TITLE = "Sign in required"
export const AUTH_REQUIRED_TOAST_ID = "auth-required"
/** Minimum gap before a *background* caller may re-raise the toast. */
export const AUTH_REQUIRED_TOAST_COOLDOWN_MS = 60_000

let lastNotifiedAt = Number.NEGATIVE_INFINITY

/**
 * Show the "sign in to use AI" toast (fixed id, so a visible one is
 * updated rather than stacked). `background: true` — for calls the user
 * didn't explicitly trigger (file summary on upload, ghost-text
 * autocomplete) — is suppressed within the cooldown so a dismissed toast
 * doesn't keep coming back. User-initiated calls always show it.
 * Returns false when suppressed. `now` is injectable for tests.
 */
export function notifyAuthRequired(
  options: { background?: boolean } = {},
  now: number = Date.now(),
): boolean {
  if (options.background && now - lastNotifiedAt < AUTH_REQUIRED_TOAST_COOLDOWN_MS) {
    return false
  }
  lastNotifiedAt = now
  toast.error(AUTH_REQUIRED_TITLE, {
    id: AUTH_REQUIRED_TOAST_ID,
    description: AUTH_REQUIRED_MESSAGE,
    action: { label: "Sign in", onClick: openSignIn },
  })
  return true
}

/** Test-only: reset the cooldown. */
export function resetAuthRequiredNotice(): void {
  lastNotifiedAt = Number.NEGATIVE_INFINITY
}

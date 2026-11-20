"use client"

import { AuthDialog } from "@/components/auth/auth-dialog"
import { useSignInPrompt } from "@/client/auth/auth-required"

/**
 * Page-level host for the sign-in dialog opened by `openSignIn()` —
 * the "Sign in" action on an `auth_required` error bubble or toast
 * (REQUIRE_AUTH_FOR_AI). Lives outside the sidebar so it works while
 * the (mobile) sidebar sheet is closed.
 */
export function SignInPromptHost() {
  const open = useSignInPrompt((s) => s.open)
  const setOpen = useSignInPrompt((s) => s.setOpen)
  // Mount only while open — AuthDialog subscribes to auth state, and
  // the sidebar's AccountMenu already holds the long-lived subscription.
  if (!open) return null
  return <AuthDialog open={open} onOpenChange={setOpen} />
}

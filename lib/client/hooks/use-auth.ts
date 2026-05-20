"use client"

import { useCallback, useEffect, useState } from "react"
import type { User } from "@supabase/supabase-js"
import { getSupabaseBrowserClient } from "@/client/supabase/client"

export type AuthStatus = "unconfigured" | "loading" | "signed-out" | "signed-in"

export interface AuthState {
  status: AuthStatus
  user: User | null
  /** Email + password sign-in. Resolves with `{ error }` on failure. */
  signIn: (email: string, password: string) => Promise<{ error?: string }>
  signOut: () => Promise<void>
}

export function useAuth(): AuthState {
  const client = getSupabaseBrowserClient()
  const [status, setStatus] = useState<AuthStatus>(client ? "loading" : "unconfigured")
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    if (!client) return
    let active = true

    client.auth.getSession().then(({ data }) => {
      if (!active) return
      setUser(data.session?.user ?? null)
      setStatus(data.session?.user ? "signed-in" : "signed-out")
    })

    const { data: sub } = client.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      setStatus(session?.user ? "signed-in" : "signed-out")
    })

    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [client])

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!client) return { error: "Supabase is not configured" }
      const { error } = await client.auth.signInWithPassword({ email, password })
      return error ? { error: error.message } : {}
    },
    [client]
  )

  const signOut = useCallback(async () => {
    if (!client) return
    await client.auth.signOut()
  }, [client])

  return { status, user, signIn, signOut }
}

"use client"
import "client-only"

import { useCallback, useEffect, useState } from "react"
import type { User } from "@supabase/supabase-js"
import { getSupabaseBrowserClient } from "@/client/supabase/client"
import { resetSyncQueue, whenDrained } from "@/client/sync/sync-queue"

/** Upper bound on how long sign-out waits for pending sync writes. */
const SIGN_OUT_DRAIN_MS = 3_000

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
    // Give this user's queued writes a brief chance to reach the cloud,
    // then drop whatever is left so it can't be replayed under the next
    // account on a shared machine (the queue also filters by owner, this
    // just keeps stale ops from lingering in localStorage). Local store
    // data is deliberately NOT wiped — that would be silent data loss; a
    // different account signing in next gets the reconcile prompt.
    await whenDrained(SIGN_OUT_DRAIN_MS)
    try {
      await client.auth.signOut()
    } finally {
      resetSyncQueue()
    }
  }, [client])

  return { status, user, signIn, signOut }
}

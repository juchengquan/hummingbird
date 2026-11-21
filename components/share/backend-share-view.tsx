"use client"

import { useEffect, useState } from "react"
import { notFound } from "next/navigation"

import { apiClient } from "@/client/api-client"
import type { ResolvedShareResponse } from "@/shared/api-schemas"

import { SharedConversationView, SharedFooter } from "./shared-conversation-view"
import { SharedDocumentView } from "./shared-document-view"

type LoadState =
  | { status: "loading" }
  | { status: "ready"; share: ResolvedShareResponse }
  | { status: "not-found" }
  | { status: "error" }

/**
 * Share page body when a backend is configured (`NEXT_PUBLIC_AGENT_PY_URL`):
 * the browser reads the share anonymously from `GET /v1/share/{token}`
 * (`apiClient.share.resolve`) instead of the Next server reading Supabase
 * with the service-role key (PLAN-frontend-backend-split Q9). Renders the
 * same views as the server path; a 404 — or a share of the other kind
 * than the URL says — renders the same not-found page.
 */
export function BackendShareView({
  kind,
  token,
}: {
  kind: ResolvedShareResponse["kind"]
  token: string
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    apiClient.share.resolve(token, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) setState({ status: "ready", share: result.data })
      else setState({ status: result.notFound ? "not-found" : "error" })
    })
    return () => controller.abort()
  }, [token, attempt])

  if (state.status === "not-found") notFound()
  if (state.status === "ready" && state.share.kind !== kind) notFound()

  if (state.status === "ready") {
    return state.share.kind === "conversation" ? (
      <SharedConversationView share={state.share} />
    ) : (
      <SharedDocumentView share={state.share} />
    )
  }

  const label = kind === "conversation" ? "conversation" : "document"
  return (
    <main className="mx-auto max-w-3xl px-4 py-10" aria-busy={state.status === "loading"}>
      {state.status === "loading" ? (
        <div role="status" className="animate-pulse space-y-3">
          <span className="sr-only">Loading shared {label}…</span>
          <div className="h-3 w-40 rounded bg-[var(--muted)]" />
          <div className="h-7 w-2/3 rounded bg-[var(--muted)]" />
          <div className="mt-8 h-4 w-full rounded bg-[var(--muted)]" />
          <div className="h-4 w-5/6 rounded bg-[var(--muted)]" />
          <div className="h-4 w-4/6 rounded bg-[var(--muted)]" />
        </div>
      ) : (
        <div role="alert" className="space-y-3 text-sm">
          <p>Couldn&apos;t load this shared {label}. Check your connection and try again.</p>
          <button
            type="button"
            onClick={() => {
              setState({ status: "loading" })
              setAttempt((n) => n + 1)
            }}
            className="rounded border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--muted)]"
          >
            Try again
          </button>
        </div>
      )}
      <SharedFooter />
    </main>
  )
}

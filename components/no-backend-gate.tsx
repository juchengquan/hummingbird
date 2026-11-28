import type { ReactNode } from "react"

import { resolveBackendBaseUrl } from "@/shared/backend-base-url"

/**
 * Q137/Q142: every surface reaches only agent-py, so a deploy built
 * without `NEXT_PUBLIC_AGENT_PY_URL` has nothing to talk to. It still
 * builds, and every page — the app, the editor, share pages — shows this
 * full-page screen pointing at the setup docs instead. Mounted around the
 * root layout's children (`app/layout.tsx`).
 *
 * No hooks: it renders the same on the server and in the browser (the
 * variable is inlined at build time), so nothing flashes.
 */

export const NO_BACKEND_TITLE = "This deploy has no backend configured"

/** Where agent-py's setup is documented (running it, then pointing the
 *  frontend at it). */
export const NO_BACKEND_DOCS_URL =
  "https://github.com/juchengquan/hummingbird/blob/main/services/agent-py/README.md#run-locally"

const BUILD_CONFIGURED = resolveBackendBaseUrl(
  typeof process !== "undefined" ? process.env.NEXT_PUBLIC_AGENT_PY_URL : undefined
).configured

export function NoBackendGate({
  configured = BUILD_CONFIGURED,
  children,
}: {
  /** Whether the build names a backend; defaults to the build's
   *  `NEXT_PUBLIC_AGENT_PY_URL` (tests pass it). */
  configured?: boolean
  children?: ReactNode
}) {
  if (configured) return <>{children}</>
  return <NoBackendScreen />
}

function NoBackendScreen() {
  return (
    <main
      role="alert"
      className="min-h-svh flex items-center justify-center bg-[var(--background)] px-4 text-[var(--foreground)]"
    >
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-lg font-semibold">{NO_BACKEND_TITLE}</h1>
        <p className="text-sm text-[var(--muted-foreground)]">
          Hummingbird needs its backend, agent-py. Run it, then rebuild this
          frontend with <code className="font-mono">NEXT_PUBLIC_AGENT_PY_URL</code>{" "}
          set to its URL (or <code className="font-mono">/</code> when it is
          served on this origin).
        </p>
        <p className="text-sm">
          <a
            href={NO_BACKEND_DOCS_URL}
            className="text-[var(--primary)] underline underline-offset-2"
            target="_blank"
            rel="noreferrer"
          >
            How to set up the backend
          </a>
        </p>
      </div>
    </main>
  )
}

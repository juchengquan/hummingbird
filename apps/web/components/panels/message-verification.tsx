"use client"

/**
 * Per-message citation-verification surface
 * (`docs/PLAN-citation-verifiability.md`, commit 2). Renders a
 * confidence chip — "N/M claims grounded" — and, when any claim was
 * flagged, an expandable list of the unsupported / partial claims so the
 * user can see exactly what wasn't backed by the cited sources.
 *
 * Scope note: this is the summary + flagged-claims disclosure. Decorating
 * the unsupported spans *inline* within the rendered markdown is fiddly
 * (claims straddle markdown formatting) and is deferred to a follow-up;
 * the disclosure surfaces the same information without that risk.
 *
 * Advisory only — nothing is suppressed; this is a trust signal layered
 * beneath the answer and its Sources strip.
 */

import { useState } from "react"
import { ShieldCheck, ShieldAlert, ChevronRight } from "lucide-react"

import type { ClaimCheck, VerificationResult } from "@/shared/verify"
import { cn } from "@/shared/utils"

const STATUS_LABEL: Record<ClaimCheck["status"], string> = {
  supported: "supported",
  partial: "partially supported",
  unsupported: "not found in sources",
}

export function MessageVerification({
  verification,
}: {
  verification: VerificationResult
}) {
  const [open, setOpen] = useState(false)
  const { checks, summary } = verification
  if (checks.length === 0) return null

  // Flagged = anything not fully grounded, unsupported listed first.
  const flagged = checks
    .filter((c) => c.status !== "supported")
    .sort((a, b) =>
      a.status === b.status ? 0 : a.status === "unsupported" ? -1 : 1
    )
  const hasFlags = flagged.length > 0
  const allGrounded = summary.unsupported === 0 && summary.partial === 0

  const Icon = allGrounded ? ShieldCheck : ShieldAlert
  const tone = allGrounded
    ? "text-emerald-600 dark:text-emerald-400"
    : summary.unsupported > 0
      ? "text-red-600 dark:text-red-400"
      : "text-amber-600 dark:text-amber-400"

  const label = `${summary.supported}/${summary.total} claim${
    summary.total === 1 ? "" : "s"
  } grounded`

  return (
    <div className="mt-2 text-[13px]">
      <button
        type="button"
        disabled={!hasFlags}
        onClick={() => hasFlags && setOpen((v) => !v)}
        aria-expanded={hasFlags ? open : undefined}
        aria-label={
          hasFlags
            ? `${label} — show ${flagged.length} flagged claim${
                flagged.length === 1 ? "" : "s"
              }`
            : label
        }
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2 py-1",
          "border border-[var(--border)] bg-[var(--muted)]/40",
          tone,
          hasFlags && "cursor-pointer hover:bg-[var(--muted)]"
        )}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="font-medium">{label}</span>
        {hasFlags && (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 transition-transform",
              open && "rotate-90"
            )}
          />
        )}
      </button>

      {hasFlags && open && (
        <ul className="mt-1.5 space-y-1.5 border-l-2 border-[var(--border)] pl-3">
          {flagged.map((c, i) => (
            <li key={i} className="text-[var(--muted-foreground)]">
              <span
                className={cn(
                  "mr-1.5 rounded px-1 py-0.5 text-[11px] font-medium uppercase tracking-wide",
                  c.status === "unsupported"
                    ? "bg-red-500/15 text-red-600 dark:text-red-400"
                    : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                )}
              >
                {STATUS_LABEL[c.status]}
              </span>
              <span className="text-[var(--foreground)]">{c.claim}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

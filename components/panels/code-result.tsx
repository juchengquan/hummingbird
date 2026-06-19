"use client"
import "client-only"

import { useState } from "react"

import type { CodeResultPart } from "@/shared/types"

/** Renders a code-interpreter result: a collapsible stdout/stderr block
 *  + inline text results. Charts render via the image gallery, not here. */
export function CodeResult({ part }: { part: CodeResultPart }) {
  const [open, setOpen] = useState(true)
  const texts = part.results.filter(
    (r): r is { type: "text"; value: string } => r.type === "text",
  )
  const hasStderr = part.stderr.trim().length > 0
  return (
    <div className="my-2 rounded border border-[var(--border)] text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-2 py-1 text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
      >
        <span aria-hidden>{open ? "▾" : "▸"}</span>
        <span>Code output{hasStderr ? " (with errors)" : ""}</span>
      </button>
      {open ? (
        <div className="space-y-1 px-2 py-1">
          {part.stdout ? (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px]">
              {part.stdout}
            </pre>
          ) : null}
          {texts.map((t, i) =>
            t.value === part.stdout ? null : (
              <pre
                key={i}
                className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px]"
              >
                {t.value}
              </pre>
            ),
          )}
          {hasStderr ? (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--destructive)]">
              {part.stderr}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

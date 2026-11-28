"use client"

import type { DiffSegment } from "@/shared/artifacts/diff"
import { cn } from "@/shared/utils"

/** Renders pre-computed line-diff segments as a git-style block:
 *  green = inserted (in current), red = deleted (in the older version). */
export function ArtifactDiffView({ segments }: { segments: DiffSegment[] }) {
  return (
    <pre className="text-xs font-mono whitespace-pre-wrap break-words m-0">
      {segments.map((seg, i) => (
        <span
          key={i}
          className={cn(
            "block",
            seg.op === "insert" && "bg-green-500/15 text-green-700 dark:text-green-300",
            seg.op === "delete" && "bg-red-500/15 text-red-700 dark:text-red-300 line-through",
            seg.op === "equal" && "text-[var(--muted-foreground)]",
          )}
        >
          {seg.op === "insert" ? "+ " : seg.op === "delete" ? "- " : "  "}
          {seg.text}
        </span>
      ))}
    </pre>
  )
}

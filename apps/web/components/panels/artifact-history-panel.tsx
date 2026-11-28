"use client"

import { useState } from "react"
import { RotateCcw, X } from "lucide-react"

import type { Artifact } from "@/shared/types"
import { diffLines, prettyForDiff } from "@/shared/artifacts/diff"
import { useStore } from "@/client/hooks/use-store"
import { cn } from "@/shared/utils"
import { Button } from "@/components/ui/button"
import { ArtifactDiffView } from "@/components/panels/artifact-diff-view"

/** Version history for one artifact: list of prior snapshots (newest
 *  first), a diff of the selected version → current, and Restore. */
export function ArtifactHistoryPanel({
  artifact,
  onClose,
}: {
  artifact: Artifact
  onClose: () => void
}) {
  const restoreArtifactVersion = useStore((s) => s.restoreArtifactVersion)
  const versions = artifact.versions ?? []
  // Newest first; default-select the most recent prior version.
  const ordered = [...versions].reverse()
  const [selectedId, setSelectedId] = useState<string | null>(ordered[0]?.id ?? null)
  const selected = ordered.find((v) => v.id === selectedId) ?? ordered[0] ?? null

  const segments = selected
    ? diffLines(
        prettyForDiff(selected.content, artifact.kind),
        prettyForDiff(artifact.content, artifact.kind),
      )
    : []

  return (
    <div className="flex h-full min-h-0">
      <div className="w-48 shrink-0 border-r border-[var(--border)] overflow-y-auto">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="text-xs font-medium text-[var(--muted-foreground)]">History</span>
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onClose} aria-label="Close history">
            <X size={12} />
          </Button>
        </div>
        <ul className="m-0 p-0 list-none">
          <li className="px-2 py-1.5 text-xs text-[var(--muted-foreground)] italic">Current</li>
          {ordered.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => setSelectedId(v.id)}
                className={cn(
                  "w-full text-left px-2 py-1.5 text-xs hover:bg-[var(--accent)]",
                  v.id === selectedId && "bg-[var(--primary)]/10 text-[var(--primary)]",
                )}
              >
                {new Date(v.createdAt).toLocaleString()}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center justify-end px-2 py-1.5 border-b border-[var(--border)]">
          <Button
            size="sm"
            variant="outline"
            disabled={!selected}
            onClick={() => selected && restoreArtifactVersion(artifact.id, selected.id)}
            className="gap-1.5"
          >
            <RotateCcw size={12} />
            Restore this version
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-3">
          {selected ? (
            <ArtifactDiffView segments={segments} />
          ) : (
            <p className="text-xs text-[var(--muted-foreground)]">No prior versions.</p>
          )}
        </div>
      </div>
    </div>
  )
}

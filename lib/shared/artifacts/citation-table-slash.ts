import type { Artifact } from "@/shared/types"

/** A slash-menu descriptor for inserting an embedded citation table. */
export interface CitationTableSlashItem {
  artifactId: string
  label: string
}

/** Map the workspace's artifacts to citation-table slash items: keep only
 *  `kind:'table'`, in the given order, mapping id→artifactId and title→label
 *  (falling back to "Untitled table" for an empty title). Pure — no Plate,
 *  store, or React dependency. */
export function buildCitationTableSlashItems(
  artifacts: Artifact[],
): CitationTableSlashItem[] {
  return artifacts
    .filter((a) => a.kind === "table")
    .map((a) => ({ artifactId: a.id, label: a.title || "Untitled table" }))
}

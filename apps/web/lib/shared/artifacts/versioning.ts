import type { ArtifactVersion } from "@/shared/types"

/** Max prior versions kept per artifact (oldest dropped past this). */
export const MAX_ARTIFACT_VERSIONS = 10

/** Append `newVersion` to `versions` and cap to the last `cap` entries
 *  (drops the oldest). Pure — the caller builds `newVersion` (with its
 *  uuid + timestamp) so this stays deterministic. */
export function pushArtifactVersion(
  versions: ArtifactVersion[] | undefined,
  newVersion: ArtifactVersion,
  cap: number = MAX_ARTIFACT_VERSIONS,
): ArtifactVersion[] {
  const next = [...(versions ?? []), newVersion]
  return next.length > cap ? next.slice(next.length - cap) : next
}

import "server-only"

import { MOUNT_COUNT_MAX, MOUNT_DIR, MOUNT_FILE_MAX, MOUNT_TOTAL_MAX } from "./config"

export interface MountManifestEntry {
  name: string
  fileId: string
  /** Present for local-only files; absent for cloud files. */
  dataBase64?: string
}

export interface ResolvedMounts {
  files: { path: string; bytes: Uint8Array }[]
  notes: string[]
}

/** Reduce a guest filename to a single safe path segment under MOUNT_DIR
 *  (strip any directory components, so a crafted name can't escape). */
export function safeMountPath(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file"
  const cleaned = base.replace(/[^\w.\-]+/g, "_").slice(0, 200) || "file"
  return `${MOUNT_DIR}/${cleaned}`
}

/** Resolve model-named files to bytes. `download(fileId)` fetches a cloud
 *  file's bytes (RLS-scoped by the caller) or returns null when
 *  unavailable. Pure except for the injected download — caps + selection
 *  are unit-tested. Never throws; failures become notes. */
export async function resolveMountFiles(
  names: string[],
  manifest: MountManifestEntry[],
  download: (fileId: string) => Promise<Uint8Array | null>
): Promise<ResolvedMounts> {
  const byName = new Map(manifest.map((m) => [m.name, m]))
  const files: { path: string; bytes: Uint8Array }[] = []
  const notes: string[] = []
  let total = 0

  for (const name of names) {
    if (files.length >= MOUNT_COUNT_MAX) {
      notes.push(`Skipped "${name}": too many files mounted (max ${MOUNT_COUNT_MAX}).`)
      continue
    }
    const entry = byName.get(name)
    if (!entry) {
      notes.push(`"${name}" is not an available attachment; skipped.`)
      continue
    }
    let bytes: Uint8Array | null = null
    if (entry.dataBase64 !== undefined) {
      bytes = new Uint8Array(Buffer.from(entry.dataBase64, "base64"))
    } else {
      bytes = await download(entry.fileId).catch(() => null)
    }
    if (!bytes) {
      notes.push(`"${name}" could not be loaded into the sandbox; skipped.`)
      continue
    }
    if (bytes.length > MOUNT_FILE_MAX) {
      notes.push(`"${name}" is too large to mount (max ${MOUNT_FILE_MAX} bytes); skipped.`)
      continue
    }
    if (total + bytes.length > MOUNT_TOTAL_MAX) {
      notes.push(`"${name}" skipped: total mounted size would exceed ${MOUNT_TOTAL_MAX} bytes.`)
      continue
    }
    total += bytes.length
    files.push({ path: safeMountPath(name), bytes })
  }
  return { files, notes }
}

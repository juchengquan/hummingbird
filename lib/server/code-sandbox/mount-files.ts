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

/** Make `path` unique against `used` by inserting -1, -2, … before the
 *  extension. Assumes `path` itself is already taken. Prevents two distinct
 *  attachments that sanitize to the same name from silently overwriting. */
export function dedupePath(path: string, used: Set<string>): string {
  const slash = path.lastIndexOf("/")
  const dir = path.slice(0, slash + 1)
  const base = path.slice(slash + 1)
  const dot = base.lastIndexOf(".")
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ""
  let i = 1
  let candidate = `${dir}${stem}-${i}${ext}`
  while (used.has(candidate)) {
    i++
    candidate = `${dir}${stem}-${i}${ext}`
  }
  return candidate
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
  const usedPaths = new Set<string>()
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
    const wanted = safeMountPath(name)
    const path = usedPaths.has(wanted) ? dedupePath(wanted, usedPaths) : wanted
    usedPaths.add(path)
    if (path !== wanted) {
      notes.push(`"${name}" mounted at ${path} (renamed to avoid a name collision).`)
    }
    files.push({ path, bytes })
  }
  return { files, notes }
}

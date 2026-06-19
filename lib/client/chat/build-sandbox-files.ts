import "client-only"

/** Per-file / count caps mirrored from the server (kept in sync with
 *  lib/server/code-sandbox/config.ts). */
const MOUNT_FILE_MAX = 10_000_000
const MOUNT_COUNT_MAX = 10

export interface SandboxFileSource {
  fileId: string
  name: string
  /** Non-null → cloud (server downloads; no bytes sent). Null → local. */
  storagePath: string | null
  /** Lazily read the local file's bytes (only called for local files). */
  readBytes: () => Promise<Uint8Array>
}

export interface SandboxFileEntry {
  name: string
  fileId: string
  dataBase64?: string
}

/** Base64-encode in fixed-size chunks. A naive
 *  `String.fromCharCode(...bytes)` spreads the whole array onto the call
 *  stack and overflows for large files; chunking keeps each
 *  `fromCharCode` call bounded. Output is byte-identical to the naive
 *  form. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000 // 32 KiB per fromCharCode call
  let bin = ""
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK)
    bin += String.fromCharCode.apply(null, slice as unknown as number[])
  }
  return btoa(bin)
}

/** Build the runCode mount manifest: cloud files become bytes-less entries
 *  (the server downloads them by fileId under RLS); local files carry
 *  base64 bytes, dropping any over the per-file cap or beyond the count. */
export async function buildSandboxFiles(
  sources: SandboxFileSource[],
): Promise<SandboxFileEntry[]> {
  const out: SandboxFileEntry[] = []
  for (const s of sources) {
    if (out.length >= MOUNT_COUNT_MAX) break
    if (s.storagePath) {
      out.push({ name: s.name, fileId: s.fileId })
      continue
    }
    const bytes = await s.readBytes()
    if (bytes.length > MOUNT_FILE_MAX) continue
    out.push({ name: s.name, fileId: s.fileId, dataBase64: toBase64(bytes) })
  }
  return out
}

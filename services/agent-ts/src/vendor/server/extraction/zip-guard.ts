// VENDORED from `lib/server/extraction/zip-guard.ts` (Next app) at commit afc33009135d6166adb4196598350638a8aafc3f.
// Frozen copy — agent-ts is frozen (docs/PLAN-frontend-backend-split.md Q11); do not extend.
// Fixes to the original no longer propagate here. Only import specifiers were rewritten
// (`@/server/*` / `@/shared/*` → relative, `@/config/*` → `@config/*`) unless a
// "VENDOR DEVIATION" note below says otherwise.

import "server-only"

import { inflateRawSync } from "node:zlib"

/**
 * Zip-bomb guard for OOXML uploads (docx via mammoth/JSZip, xlsx via
 * SheetJS). Both libraries inflate every entry fully into memory with no
 * output cap, so a 5 MB upload could expand to gigabytes. This runs
 * BEFORE the parser and:
 *
 *   1. walks the central directory (the same index JSZip and SheetJS
 *      read) and fails fast on too many entries or too large a DECLARED
 *      total, then
 *   2. actually inflates each entry with `maxOutputLength` set to the
 *      remaining budget — declared sizes are attacker-controlled, so the
 *      real decompressed byte count is what's enforced.
 *
 * Inflate work is bounded by the budget itself, so the guard can't be
 * turned into the DoS it prevents. Only stored (0) and deflate (8)
 * entries are accepted — the only methods JSZip/SheetJS can read anyway.
 */

/** Default caps. A 5 MB upload (FILE_SIZE_LIMIT) at a generous ~20×
 *  XML compression ratio stays well under 100 MB; real docx/xlsx files
 *  have tens to a few hundred entries. */
export const ZIP_MAX_ENTRIES = 5_000
export const ZIP_MAX_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ZipLimitError"
  }
}

const EOCD_SIG = 0x06054b50
const CDH_SIG = 0x02014b50
const LFH_SIG = 0x04034b50
const EOCD_MIN = 22
const MAX_COMMENT = 0xffff

/** Offset of the End Of Central Directory record, searched backwards
 *  (last match wins — same as JSZip), or -1 if absent. */
function findEocd(buf: Buffer): number {
  const stop = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT)
  for (let i = buf.length - EOCD_MIN; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/** True when `buf` is (or claims to be) a zip archive. */
export function looksLikeZip(buf: Buffer): boolean {
  if (buf.length >= 4 && buf.readUInt32LE(0) === LFH_SIG) return true
  return buf.length >= EOCD_MIN && findEocd(buf) !== -1
}

/** Read the zip64 extended-information extra field (id 0x0001) for an
 *  entry whose 32-bit sizes/offset are saturated. Fields appear in
 *  order, only for the values that were 0xFFFFFFFF. */
function readZip64Extra(
  extra: Buffer,
  need: { usize: boolean; csize: boolean; offset: boolean }
): { usize?: number; csize?: number; offset?: number } {
  let p = 0
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p)
    const len = extra.readUInt16LE(p + 2)
    const body = extra.subarray(p + 4, p + 4 + len)
    if (id === 0x0001) {
      const out: { usize?: number; csize?: number; offset?: number } = {}
      let q = 0
      const take = () => {
        if (q + 8 > body.length) throw new ZipLimitError("Malformed zip64 extra field.")
        const v = body.readBigUInt64LE(q)
        q += 8
        if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new ZipLimitError("Zip entry size out of range.")
        }
        return Number(v)
      }
      if (need.usize) out.usize = take()
      if (need.csize) out.csize = take()
      if (need.offset) out.offset = take()
      return out
    }
    p += 4 + len
  }
  throw new ZipLimitError("Zip64 entry is missing its size field.")
}

export function assertZipWithinLimits(
  buf: Buffer,
  limits: { maxEntries?: number; maxTotalUncompressed?: number } = {}
): void {
  const maxEntries = limits.maxEntries ?? ZIP_MAX_ENTRIES
  const maxTotal = limits.maxTotalUncompressed ?? ZIP_MAX_TOTAL_UNCOMPRESSED

  const eocd = findEocd(buf)
  if (eocd === -1) throw new ZipLimitError("Not a readable zip archive.")
  const entryCount = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (entryCount === 0xffff || cdOffset === 0xffffffff) {
    // A zip64 central directory: > 65k entries or a > 4 GB archive —
    // never a legitimate upload under the 5 MB cap.
    throw new ZipLimitError("Zip archive is too large to extract.")
  }
  if (entryCount > maxEntries) {
    throw new ZipLimitError(
      `Zip archive has too many entries (${entryCount} > ${maxEntries}).`
    )
  }
  // Tolerate prepended bytes the way JSZip does: the CD sits right
  // before the EOCD, so derive the shift from where it actually ends.
  const shift = eocd - (cdOffset + cdSize)
  if (shift < 0) throw new ZipLimitError("Malformed zip central directory.")

  interface Entry { method: number; csize: number; usize: number; lfh: number }
  const entries: Entry[] = []
  let declaredTotal = 0
  let p = cdOffset + shift
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH_SIG) {
      throw new ZipLimitError("Malformed zip central directory.")
    }
    const method = buf.readUInt16LE(p + 10)
    let csize = buf.readUInt32LE(p + 20)
    let usize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    let lfh = buf.readUInt32LE(p + 42)
    const need = {
      usize: usize === 0xffffffff,
      csize: csize === 0xffffffff,
      offset: lfh === 0xffffffff,
    }
    if (need.usize || need.csize || need.offset) {
      const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
      const z = readZip64Extra(extra, need)
      usize = z.usize ?? usize
      csize = z.csize ?? csize
      lfh = z.offset ?? lfh
    }
    if (method !== 0 && method !== 8) {
      throw new ZipLimitError(`Unsupported zip compression method ${method}.`)
    }
    declaredTotal += usize
    if (declaredTotal > maxTotal) {
      throw new ZipLimitError(
        `Zip archive expands beyond the ${maxTotal}-byte extraction limit.`
      )
    }
    entries.push({ method, csize, usize, lfh: lfh + shift })
    p += 46 + nameLen + extraLen + commentLen
  }

  // Declared sizes can lie — enforce the real inflated size.
  let actualTotal = 0
  for (const e of entries) {
    if (e.lfh + 30 > buf.length || buf.readUInt32LE(e.lfh) !== LFH_SIG) {
      throw new ZipLimitError("Malformed zip local header.")
    }
    const dataStart = e.lfh + 30 + buf.readUInt16LE(e.lfh + 26) + buf.readUInt16LE(e.lfh + 28)
    const data = buf.subarray(dataStart, dataStart + e.csize)
    if (data.length !== e.csize) throw new ZipLimitError("Truncated zip entry.")
    const remaining = maxTotal - actualTotal
    let produced: number
    if (e.method === 0) {
      produced = e.csize
    } else {
      try {
        produced = inflateRawSync(data, { maxOutputLength: Math.max(1, remaining) }).length
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code === "ERR_BUFFER_TOO_LARGE") {
          throw new ZipLimitError(
            `Zip archive expands beyond the ${maxTotal}-byte extraction limit.`
          )
        }
        throw new ZipLimitError("Corrupt zip entry.")
      }
    }
    actualTotal += produced
    if (actualTotal > maxTotal) {
      throw new ZipLimitError(
        `Zip archive expands beyond the ${maxTotal}-byte extraction limit.`
      )
    }
  }
}

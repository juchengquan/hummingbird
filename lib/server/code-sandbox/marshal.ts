import "server-only"

import { RESULT_CAP, STDOUT_CAP } from "./config"
import type { CodeResult, CodeRunResult } from "./types"

/** The shape the microsandbox client hands the pure mapper. */
export interface RawRun {
  stdout: string
  stderr: string
  exitCode: number
  images: { format: "png" | "svg"; data: string }[]
  timedOut: boolean
  /** Set when the runtime itself failed to boot/exec (not the user code). */
  upstreamError?: string
}

function truncate(s: string): string {
  if (s.length <= STDOUT_CAP) return s
  return `${s.slice(0, STDOUT_CAP)}\n…[truncated ${s.length - STDOUT_CAP} chars]`
}

export function toCodeRunResult(raw: RawRun): CodeRunResult {
  const stdout = truncate(raw.stdout)
  const stderr = truncate(raw.stderr)

  const results: CodeResult[] = []
  if (stdout) results.push({ type: "text", value: stdout })
  // Add images while staying under the total byte cap; drop whole images
  // that would exceed it (never emit a partial base64 blob).
  let used = 0
  for (const img of raw.images) {
    if (used + img.data.length > RESULT_CAP) continue
    used += img.data.length
    results.push({ type: "image", format: img.format, data: img.data })
  }

  if (raw.upstreamError !== undefined) {
    return { ok: false, stdout, stderr, results, error: { code: "upstream", message: raw.upstreamError } }
  }
  if (raw.timedOut) {
    return { ok: false, stdout, stderr, results, error: { code: "timeout", message: "Execution exceeded the time limit." } }
  }
  if (raw.exitCode !== 0) {
    return { ok: false, stdout, stderr, results, error: { code: "runtime", message: stderr || `Exited with code ${raw.exitCode}.` } }
  }
  return { ok: true, stdout, stderr, results }
}

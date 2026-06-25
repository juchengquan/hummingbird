import "server-only"

import type { CodeSandboxLanguage } from "./runtime"

/** A single rich cell output. v1 emits `image` + `text`; `table` is
 *  reserved for a later PR (microsandbox has no kernel MIME channel). */
export type CodeResult =
  | { type: "image"; format: "png" | "svg"; data: string /* base64 */ }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "text"; value: string }

/** A whole file the run wrote to the designated output dir
 *  (`/tmp/outputs/`). Distinct from `CodeResult` cells, which render
 *  inline in the code-output block; files are downloadable artifacts. */
export interface CodeFile {
  name: string
  mimeType: string
  sizeBytes: number
  /** Base64 of the file bytes. */
  data: string
}

export interface CodeRunResult {
  ok: boolean
  stdout: string
  stderr: string
  results: CodeResult[]
  /** Files the run wrote to `/tmp/outputs/`. Surfaced as download
   *  chips + `file` artifacts, separate from the inline `results`. */
  files?: CodeFile[]
  error?: {
    code: "timeout" | "runtime" | "upstream" | "budget"
    message: string
  }
}

export interface CodeRunInput {
  code: string
  language: CodeSandboxLanguage
  timeoutMs: number
  signal?: AbortSignal
  /** Files to write into the sandbox fs before running. `path` is an
   *  absolute guest path (already sanitized by the caller). */
  files?: { path: string; bytes: Uint8Array }[]
}

export interface CodeSandbox {
  run(input: CodeRunInput): Promise<CodeRunResult>
}

import "server-only"

/** A single rich cell output. v1 emits `image` + `text`; `table` is
 *  reserved for a later PR (microsandbox has no kernel MIME channel). */
export type CodeResult =
  | { type: "image"; format: "png" | "svg"; data: string /* base64 */ }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "text"; value: string }

export interface CodeRunResult {
  ok: boolean
  stdout: string
  stderr: string
  results: CodeResult[]
  error?: {
    code: "timeout" | "runtime" | "upstream" | "budget"
    message: string
  }
}

export interface CodeRunInput {
  code: string
  language: "python"
  timeoutMs: number
  signal?: AbortSignal
}

export interface CodeSandbox {
  run(input: CodeRunInput): Promise<CodeRunResult>
}

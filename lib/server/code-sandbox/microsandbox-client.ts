import "server-only"

import { ExecTimeoutError, MiB, Sandbox } from "microsandbox"

import { CPUS, MEM_MIB, sandboxConfig } from "./config"
import { toCodeRunResult, type RawRun } from "./marshal"
import type { CodeRunInput, CodeRunResult, CodeSandbox } from "./types"

/** A short, fs-safe sandbox name. Date.now/Math.random are fine in the
 *  server runtime (the no-Date/Random rule is workflow-script-only); a
 *  cheap per-call counter is enough for uniqueness within a process. */
let seq = 0
const nextName = () => `runcode-${(seq = (seq + 1) % 1_000_000)}`

const IMG_DIR = "/tmp"
const IMG_RE = /\.(png|svg)$/i

/** Detect a timeout from the SDK regardless of error class identity
 *  (covers ExecTimeoutError plus any message-level "timeout" signal). */
function isTimeout(err: unknown): boolean {
  if (err instanceof ExecTimeoutError) return true
  return String(err).toLowerCase().includes("timeout")
}

export function createMicrosandboxClient(): CodeSandbox {
  return {
    async run(input: CodeRunInput): Promise<CodeRunResult> {
      const cfg = sandboxConfig()
      if (!cfg) {
        return toCodeRunResult({
          stdout: "",
          stderr: "",
          exitCode: 0,
          images: [],
          timedOut: false,
          upstreamError: "Sandbox not configured.",
        })
      }

      let sb: Sandbox | null = null
      try {
        sb = await Sandbox.builder(nextName())
          .image("python")
          .replace()
          .cpus(CPUS)
          .memory(MiB(MEM_MIB))
          .disableNetwork() // network OFF in v1 (airgapped microVM)
          .create()

        let timedOut = false
        let stdout = ""
        let stderr = ""
        let exitCode = 0
        try {
          const out = await sb.execWith("python3", (e) =>
            e.args(["-c", input.code]).timeout(input.timeoutMs),
          )
          stdout = out.stdout()
          stderr = out.stderr()
          exitCode = out.code
        } catch (err) {
          // The SDK throws on timeout; map it rather than failing the run.
          if (isTimeout(err)) {
            timedOut = true
            exitCode = 124
          } else {
            throw err
          }
        }

        // Read back any chart files the run wrote to /tmp.
        const images: RawRun["images"] = []
        try {
          const entries = await sb.fs().list(IMG_DIR)
          for (const entry of entries) {
            // `entry.path` may be a basename or a full path depending on
            // the runtime; normalise to an absolute path under /tmp.
            const path = entry.path.startsWith("/") ? entry.path : `${IMG_DIR}/${entry.path}`
            if (entry.kind !== "file" || !IMG_RE.test(path)) continue
            const bytes = await sb.fs().read(path)
            const data = Buffer.from(bytes).toString("base64")
            images.push({
              format: path.toLowerCase().endsWith(".svg") ? "svg" : "png",
              data,
            })
          }
        } catch {
          // fs listing best-effort; absence of charts is not an error.
        }

        return toCodeRunResult({ stdout, stderr, exitCode, images, timedOut })
      } catch (err) {
        return toCodeRunResult({
          stdout: "",
          stderr: "",
          exitCode: 1,
          images: [],
          timedOut: false,
          upstreamError: err instanceof Error ? err.message : "Sandbox failed to run.",
        })
      } finally {
        if (sb) await sb.stop().catch(() => {})
      }
    },
  }
}

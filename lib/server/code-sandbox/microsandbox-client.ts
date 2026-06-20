import "server-only"

import { ExecTimeoutError, MiB, Sandbox } from "microsandbox"

import {
  CPUS,
  MAX_CONCURRENT,
  MEM_MIB,
  MOUNT_DIR,
  RESULT_CAP,
  RESULT_FILE_MAX,
  sandboxConfig,
} from "./config"
import { toCodeRunResult, type RawRun } from "./marshal"
import { ABORTED, raceAbort } from "./race-abort"
import { runtimeFor } from "./runtime"
import { createSemaphore } from "./semaphore"
import type { CodeRunInput, CodeRunResult, CodeSandbox } from "./types"

/** A short, fs-safe sandbox name. Date.now/Math.random are fine in the
 *  server runtime (the no-Date/Random rule is workflow-script-only); a
 *  cheap per-call counter is enough for uniqueness within a process. */
let seq = 0
const nextName = () => `runcode-${(seq = (seq + 1) % 1_000_000)}`

const IMG_DIR = "/tmp"
const IMG_RE = /\.(png|svg)$/i
const TABLE_RE = /\.table\.json$/i

/** Bounds how many microVMs boot/run at once across the whole process. Each
 *  holds ~MEM_MIB of guest RAM, so without this a burst of runCode calls could
 *  OOM a small self-host VM. Module-level on purpose: selectSandbox() builds a
 *  fresh client per request, so a per-client limiter wouldn't bound anything. */
const slots = createSemaphore(MAX_CONCURRENT)

/** Detect an exec timeout from the SDK. Uses the typed class plus a
 *  cross-realm-safe name/code check — NOT a loose substring, which could
 *  misread a user error that merely mentions "timeout" as a sandbox timeout. */
function isTimeout(err: unknown): boolean {
  if (err instanceof ExecTimeoutError) return true
  if (typeof err !== "object" || err === null) return false
  const e = err as { name?: unknown; code?: unknown }
  return e.name === "ExecTimeoutError" || e.code === "execTimeout"
}

/** Result for a run the caller cancelled (client disconnect / new turn). The
 *  stream is usually already closing, so the shape rarely reaches a UI — the
 *  point of handling abort is to stop the microVM and free its slot promptly. */
function cancelledResult(): CodeRunResult {
  return toCodeRunResult({
    stdout: "",
    stderr: "",
    exitCode: 1,
    images: [],
    timedOut: false,
    upstreamError: "Run cancelled.",
  })
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

      const { signal } = input
      if (signal?.aborted) return cancelledResult()

      // #4: cap concurrent microVMs. #2: drop the request if the caller aborts
      // while we're queued behind other runs rather than booting anyway.
      try {
        await slots.acquire(signal)
      } catch {
        return cancelledResult()
      }

      const rt = runtimeFor(input.language)
      let sb: Sandbox | null = null
      // On abort, tear the microVM down immediately rather than waiting out the
      // wall-clock timeout (also unblocks a queued run sooner via the finally).
      const onAbort = () => {
        void sb?.stop().catch(() => {})
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      try {
        sb = await Sandbox.builder(nextName())
          .image(rt.image)
          .replace()
          .cpus(CPUS)
          .memory(MiB(MEM_MIB))
          .disableNetwork() // network OFF in v1 (airgapped microVM)
          .create()
        if (signal?.aborted) return cancelledResult()

        // Mount any caller-provided files into the guest fs before exec.
        // A write failure must NOT silently run without the files the user
        // asked for — let it propagate to the outer catch (→ upstream error).
        if (input.files?.length) {
          try {
            await sb.fs().mkdir(MOUNT_DIR)
          } catch {
            // The mount dir may already exist; mkdir is best-effort.
          }
          for (const f of input.files) {
            await sb.fs().write(f.path, f.bytes)
          }
        }

        let timedOut = false
        let stdout = ""
        let stderr = ""
        let exitCode = 0
        try {
          const execP = sb.execWith(rt.cmd, (e) =>
            e.args([rt.flag, input.code]).timeout(input.timeoutMs),
          )
          // Race the exec against caller abort; on abort, bail without waiting
          // for the (now-doomed) exec — the finally stops the microVM.
          const out = await raceAbort(execP, signal)
          if (out === ABORTED) return cancelledResult()
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

        // Read back chart + table files the run wrote to /tmp. Bound the work
        // BEFORE reading: cap the file count and skip files whose listed size
        // can't fit the remaining byte budget, so a run that spams /tmp can't
        // force the server to read huge/many blobs into memory. The
        // marshaller's RESULT_CAP is the final, precise payload gate.
        const images: RawRun["images"] = []
        const tables: unknown[] = []
        try {
          const entries = await sb.fs().list(IMG_DIR)
          let readBytes = 0
          let filesRead = 0
          for (const entry of entries) {
            if (filesRead >= RESULT_FILE_MAX) break
            if (entry.kind !== "file") continue
            // `entry.path` may be a basename or a full path depending on
            // the runtime; normalise to an absolute path under /tmp.
            const path = entry.path.startsWith("/") ? entry.path : `${IMG_DIR}/${entry.path}`
            const isTable = TABLE_RE.test(path)
            if (!isTable && !IMG_RE.test(path)) continue
            // Skip without reading when the listed size can't fit the budget.
            if (readBytes + entry.size > RESULT_CAP) continue
            const bytes = await sb.fs().read(path)
            readBytes += bytes.length
            filesRead++
            if (isTable) {
              try {
                tables.push(JSON.parse(Buffer.from(bytes).toString("utf8")))
              } catch {
                // skip a malformed table file
              }
            } else {
              images.push({
                format: path.toLowerCase().endsWith(".svg") ? "svg" : "png",
                data: Buffer.from(bytes).toString("base64"),
              })
            }
          }
        } catch {
          // fs listing best-effort; absence of charts/tables is not an error.
        }

        return toCodeRunResult({ stdout, stderr, exitCode, images, timedOut, tables })
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
        signal?.removeEventListener("abort", onAbort)
        if (sb) await sb.stop().catch(() => {})
        slots.release()
      }
    },
  }
}

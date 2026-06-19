# Code interpreter (`runCode`) with microsandbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship PR-1 of the code interpreter: a `runCode` ServerSkill that runs model-written Python in a local microsandbox microVM (network OFF, budget-gated, 30s timeout) and renders stdout/stderr + charts end-to-end in chat.

**Architecture:** A TS `CodeSandbox` adapter in `lib/server/code-sandbox/` (interface + pure result-marshaller + microsandbox Node-SDK client + env-gated selector). A `codeInterpreter` ServerSkill calls it. The chat route splits results: charts reuse the existing image-gallery path; stdout/stderr/text emit a new `data-code-result` SSE part rendered by a new component. microsandbox is exec+filesystem (not a Jupyter kernel) — charts come from `savefig('/tmp/*.png')` read back via `sb.fs()`.

**Tech Stack:** TypeScript, Next.js, AI SDK v5 (`tool`), Zod, microsandbox Node SDK (Node ≥22), Zustand, bun:test.

**Spec:** `docs/superpowers/specs/2026-06-19-code-interpreter-microsandbox-design.md`
**Design refs:** `docs/PLAN-code-interpreter.md` (consumer) · `docs/PLAN-execution-sandbox.md` (runtime + verified Node-SDK mapping).

---

## File structure

**New:**
- `lib/server/code-sandbox/types.ts` — `CodeSandbox`, `CodeRunResult`, `CodeResult`.
- `lib/server/code-sandbox/config.ts` — caps + env helpers (`hasSandboxConfig`, `RUN_TIMEOUT_MS`, `STDOUT_CAP`, `RESULT_CAP`, `MEM_MIB`, `CPUS`).
- `lib/server/code-sandbox/marshal.ts` — pure `toCodeRunResult(raw)`.
- `lib/server/code-sandbox/marshal.test.ts` — mapper unit tests.
- `lib/server/code-sandbox/microsandbox-client.ts` — `createMicrosandboxClient()`.
- `lib/server/code-sandbox/select-sandbox.ts` — `selectSandbox()`.
- `lib/server/code-sandbox/select-sandbox.test.ts` — gate test.
- `lib/server/skills/code-interpreter.ts` — `codeInterpreterSkill`.
- `lib/server/skills/code-interpreter.test.ts` — gate + descriptor tests.
- `components/panels/code-result.tsx` — stdout/stderr render.

**Modified:**
- `lib/shared/skills/types.ts` — `SkillId` += `"codeInterpreter"`.
- `lib/shared/skills/registry.ts` — client metadata entry.
- `lib/server/skills/registry.ts` — `SERVER_SKILLS` += `codeInterpreterSkill`.
- `lib/server/chat/sse-emitter.ts` (+ `.test.ts`) — `codeResult()` method + payload type.
- `lib/client/chat/sse-frame-translator.ts` (+ `.test.ts`) — `data-code-result` → `code_result`.
- `lib/shared/types.ts` — `CodeResultPart` + `Message.codeResults?`.
- `lib/client/hooks/store/slices/messages.ts` — `appendMessageCodeResult`.
- `app/api/chat/route.ts` — `maybeEmitCodeResultFrames()`.
- `components/panels/chat-message.tsx` — render `<CodeResult>`.
- `.env.example`, `CLAUDE.md` — env docs.
- `package.json` — `microsandbox` dependency.

**Persist note:** `Message.codeResults?` is a **nested** optional field on `Message` (exactly like `generatedImages`/`toolCalls`), persisted inside the already-allowlisted `conversations` key. It is **not** a new top-level persisted key, so **no `STORE_VERSION` bump and no `partializeState`/`persist.test.ts` change** — old messages simply lack the field.

---

## Phase 1 — adapter library

### Task 1.1: Types

**Files:** Create `lib/server/code-sandbox/types.ts`

- [ ] **Step 1: Write the file**

```ts
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
```

- [ ] **Step 2: Typecheck** — `bun run typecheck` → clean.
- [ ] **Step 3: Commit**

```bash
git add lib/server/code-sandbox/types.ts
git commit -m "feat(code-sandbox): CodeSandbox interface + result types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.2: Config + env gate

**Files:** Create `lib/server/code-sandbox/config.ts`

- [ ] **Step 1: Write the file**

```ts
import "server-only"

/** Wall-clock cap per run (ms). Env override: CODE_SANDBOX_TIMEOUT_MS. */
export const RUN_TIMEOUT_MS = Number(process.env.CODE_SANDBOX_TIMEOUT_MS) || 30_000
/** stdout/stderr char cap. */
export const STDOUT_CAP = Number(process.env.CODE_SANDBOX_STDOUT_CAP) || 256_000
/** Total result bytes cap (sum of image payloads). */
export const RESULT_CAP = Number(process.env.CODE_SANDBOX_RESULT_CAP) || 10_000_000
/** microVM resources. */
export const MEM_MIB = Number(process.env.CODE_SANDBOX_MEM_MIB) || 512
export const CPUS = Number(process.env.CODE_SANDBOX_CPUS) || 1

/** True when a local/remote sandbox runtime is configured. Mirrors the
 *  model-provider.ts custom-base-URL gating: absent → the skill is never
 *  registered (no mock — code execution has no meaningful mock). */
export function hasSandboxConfig(): boolean {
  return !!process.env.CODE_SANDBOX_BASE_URL
}

export function sandboxConfig(): { baseUrl: string; apiKey: string | undefined } | null {
  const baseUrl = process.env.CODE_SANDBOX_BASE_URL
  if (!baseUrl) return null
  return { baseUrl, apiKey: process.env.CODE_SANDBOX_API_KEY }
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
bun run typecheck
git add lib/server/code-sandbox/config.ts
git commit -m "feat(code-sandbox): env gate + resource/cap config

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.3: Pure result marshaller (TDD)

**Files:** Create `lib/server/code-sandbox/marshal.ts` + `marshal.test.ts`

The marshaller is the pure boundary between the microsandbox client's raw
output and `CodeRunResult`. The client produces a `RawRun` (defined here)
so the mapper stays testable without the SDK.

- [ ] **Step 1: Write the failing test** — `lib/server/code-sandbox/marshal.test.ts`

```ts
import { describe, expect, test } from "bun:test"

import { toCodeRunResult, type RawRun } from "./marshal"

const base: RawRun = { stdout: "", stderr: "", exitCode: 0, images: [], timedOut: false }

describe("toCodeRunResult", () => {
  test("exit 0 → ok, stdout as a text result", () => {
    const r = toCodeRunResult({ ...base, stdout: "4\n" })
    expect(r.ok).toBe(true)
    expect(r.stdout).toBe("4\n")
    expect(r.results).toContainEqual({ type: "text", value: "4\n" })
  })
  test("non-zero exit → not ok + runtime error, stderr carried", () => {
    const r = toCodeRunResult({ ...base, stderr: "Traceback...", exitCode: 1 })
    expect(r.ok).toBe(false)
    expect(r.stderr).toBe("Traceback...")
    expect(r.error?.code).toBe("runtime")
  })
  test("timedOut → timeout error regardless of exit", () => {
    const r = toCodeRunResult({ ...base, exitCode: 137, timedOut: true })
    expect(r.error?.code).toBe("timeout")
    expect(r.ok).toBe(false)
  })
  test("images become base64 image results", () => {
    const r = toCodeRunResult({ ...base, images: [{ format: "png", data: "AAAA" }] })
    expect(r.results).toContainEqual({ type: "image", format: "png", data: "AAAA" })
  })
  test("empty stdout produces no text result", () => {
    const r = toCodeRunResult({ ...base, images: [{ format: "png", data: "AAAA" }] })
    expect(r.results.some((x) => x.type === "text")).toBe(false)
  })
  test("stdout truncated at STDOUT_CAP with a marker", () => {
    const big = "x".repeat(300_000)
    const r = toCodeRunResult({ ...base, stdout: big })
    expect(r.stdout.length).toBeLessThanOrEqual(256_000 + 32)
    expect(r.stdout).toContain("truncated")
  })
  test("images beyond RESULT_CAP are dropped (not partial)", () => {
    const huge = "a".repeat(6_000_000) // ~6MB each; 2 exceed 10MB cap
    const r = toCodeRunResult({ ...base, images: [
      { format: "png", data: huge }, { format: "png", data: huge },
    ] })
    expect(r.results.filter((x) => x.type === "image").length).toBe(1)
  })
})
```

- [ ] **Step 2: Run → FAIL** — `bun test lib/server/code-sandbox/marshal.test.ts` (module missing).

- [ ] **Step 3: Write `lib/server/code-sandbox/marshal.ts`**

```ts
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
```

- [ ] **Step 4: Run → PASS.** **Step 5: typecheck + commit**

```bash
bun test lib/server/code-sandbox/marshal.test.ts && bun run typecheck
git add lib/server/code-sandbox/marshal.ts lib/server/code-sandbox/marshal.test.ts
git commit -m "feat(code-sandbox): pure result marshaller (text/image, caps, error codes)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.4: microsandbox client

**Files:** Create `lib/server/code-sandbox/microsandbox-client.ts`; modify `package.json`

The client is the only impure piece; it's thin and verified by manual
smoke (Task 6), with logic delegated to the tested `toCodeRunResult`.

- [ ] **Step 1: Add the dependency**

Run: `bun add microsandbox` (Node SDK; requires Node ≥22 for `await using`). Confirm it lands in `package.json` dependencies.

- [ ] **Step 2: Write the client**

API mapping is the verified one from `PLAN-execution-sandbox.md` §Phase 1. Chart convention: prompt the model to `savefig('/tmp/<name>.png')`; after exec, list `/tmp` for `*.png`/`*.svg` and read them back.

```ts
import "server-only"

import { MiB, Sandbox } from "microsandbox"

import { CPUS, MEM_MIB, sandboxConfig } from "./config"
import { toCodeRunResult, type RawRun } from "./marshal"
import type { CodeRunInput, CodeRunResult, CodeSandbox } from "./types"

/** A short, fs-safe sandbox name. Uniqueness via a per-call counter +
 *  the build-time avoidance of Date.now/Math.random in this codebase is
 *  not required here (server runtime), but keep it cheap. */
let seq = 0
const nextName = () => `runcode-${(seq = (seq + 1) % 1_000_000)}`

const IMG_DIR = "/tmp"
const IMG_RE = /\.(png|svg)$/i

export function createMicrosandboxClient(): CodeSandbox {
  return {
    async run(input: CodeRunInput): Promise<CodeRunResult> {
      const cfg = sandboxConfig()
      if (!cfg) {
        return toCodeRunResult({
          stdout: "", stderr: "", exitCode: 0, images: [], timedOut: false,
          upstreamError: "Sandbox not configured.",
        })
      }
      let sb: Awaited<ReturnType<ReturnType<typeof Sandbox.builder>["create"]>> | null = null
      try {
        sb = await Sandbox.builder(nextName())
          .image("python")
          .replace()
          .cpus(CPUS)
          .memory(MiB(MEM_MIB))
          .network("airgapped") // network OFF in v1
          .create()

        let timedOut = false
        const r = await sb
          .execWith("python3", (e) => e.args(["-c", input.code]).timeout(input.timeoutMs))
          .catch((err: unknown) => {
            // The SDK throws on timeout; map it rather than failing the run.
            if (String(err).toLowerCase().includes("timeout")) {
              timedOut = true
              return { stdout: () => "", stderr: () => "", code: 124 }
            }
            throw err
          })

        // Read back any chart files the run wrote to /tmp.
        const images: RawRun["images"] = []
        try {
          const entries = await sb.fs().list(IMG_DIR)
          for (const name of entries.filter((n) => IMG_RE.test(n))) {
            const bytes = await sb.fs().read(`${IMG_DIR}/${name}`)
            const data = Buffer.from(bytes).toString("base64")
            images.push({ format: name.toLowerCase().endsWith(".svg") ? "svg" : "png", data })
          }
        } catch {
          // fs listing best-effort; absence of charts is not an error.
        }

        return toCodeRunResult({
          stdout: r.stdout(), stderr: r.stderr(), exitCode: r.code, images, timedOut,
        })
      } catch (err) {
        return toCodeRunResult({
          stdout: "", stderr: "", exitCode: 1, images: [], timedOut: false,
          upstreamError: err instanceof Error ? err.message : "Sandbox failed to run.",
        })
      } finally {
        if (sb) await sb.stop().catch(() => {})
      }
    },
  }
}
```

> **Adaptation note:** match the installed `microsandbox` SDK's exact
> surface — confirm `Sandbox.builder().network(...)` (airgapped policy),
> `execWith(...).timeout()`, `r.stdout()/r.stderr()/r.code`, and
> `sb.fs().list()/read()` against the package's types after `bun add`.
> If a method name differs, adapt the call but keep the `RawRun` shape
> fed to `toCodeRunResult` identical (that's the tested contract).

- [ ] **Step 3: Typecheck + commit**

```bash
bun run typecheck
git add lib/server/code-sandbox/microsandbox-client.ts package.json bun.lock
git commit -m "feat(code-sandbox): microsandbox Node-SDK client (airgapped, savefig→fs read)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.5: Selector + gate test (TDD)

**Files:** Create `lib/server/code-sandbox/select-sandbox.ts` + `select-sandbox.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, test } from "bun:test"

import { hasSandboxConfig } from "./config"
import { selectSandbox } from "./select-sandbox"

const orig = process.env.CODE_SANDBOX_BASE_URL
afterEach(() => {
  if (orig === undefined) delete process.env.CODE_SANDBOX_BASE_URL
  else process.env.CODE_SANDBOX_BASE_URL = orig
})

describe("selectSandbox / hasSandboxConfig", () => {
  test("no base URL → null + gate false", () => {
    delete process.env.CODE_SANDBOX_BASE_URL
    expect(hasSandboxConfig()).toBe(false)
    expect(selectSandbox()).toBeNull()
  })
  test("base URL set → a CodeSandbox + gate true", () => {
    process.env.CODE_SANDBOX_BASE_URL = "http://localhost:5555"
    expect(hasSandboxConfig()).toBe(true)
    const sb = selectSandbox()
    expect(sb).not.toBeNull()
    expect(typeof sb?.run).toBe("function")
  })
})
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Write `select-sandbox.ts`**

```ts
import "server-only"

import { hasSandboxConfig } from "./config"
import { createMicrosandboxClient } from "./microsandbox-client"
import type { CodeSandbox } from "./types"

/** Pick the configured sandbox backend, or null when none is configured.
 *  microsandbox is the only backend today; the env seam
 *  (CODE_SANDBOX_BASE_URL) keeps E2B / others droppable without touching
 *  call sites — mirrors model-provider.ts. */
export function selectSandbox(): CodeSandbox | null {
  if (!hasSandboxConfig()) return null
  return createMicrosandboxClient()
}
```

- [ ] **Step 4: Run → PASS; typecheck; commit**

```bash
bun test lib/server/code-sandbox/select-sandbox.test.ts && bun run typecheck
git add lib/server/code-sandbox/select-sandbox.ts lib/server/code-sandbox/select-sandbox.test.ts
git commit -m "feat(code-sandbox): env-gated sandbox selector

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — the runCode skill

### Task 2.1: SkillId + client metadata entry

**Files:** Modify `lib/shared/skills/types.ts`, `lib/shared/skills/registry.ts`

- [ ] **Step 1: Extend `SkillId`**

In `lib/shared/skills/types.ts`, change:
```ts
export type SkillId = "webSearch" | "webFetch" | "imageGen" | "searchFiles"
```
to:
```ts
export type SkillId = "webSearch" | "webFetch" | "imageGen" | "searchFiles" | "codeInterpreter"
```

- [ ] **Step 2: Add the client metadata entry**

In `lib/shared/skills/registry.ts`, append after the `searchFiles` entry (match the existing object shape — `id`, `name`, `description`, `icon`, `default`, `requiresEnv`, `slashTriggers`). Pick an existing lucide icon already imported there or add one (e.g. `Terminal` / `Code`):
```ts
  {
    id: "codeInterpreter",
    name: "Code interpreter",
    description:
      "Let the model run Python in a sandboxed microVM and return stdout plus charts (matplotlib). Network is off; pandas/numpy/matplotlib are available. Requires a configured local sandbox.",
    icon: Terminal,
    default: false,
    requiresEnv: true,
    slashTriggers: ["code", "run"],
  },
```
Add `Terminal` (or chosen icon) to the `lucide-react` import at the top of the file.

- [ ] **Step 3: Typecheck + commit**

```bash
bun run typecheck
git add lib/shared/skills/types.ts lib/shared/skills/registry.ts
git commit -m "feat(skills): register codeInterpreter skill metadata

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.2: The skill + tests (TDD)

**Files:** Create `lib/server/skills/code-interpreter.ts` + `code-interpreter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"

import { codeInterpreterSkill } from "./code-interpreter"

const origUrl = process.env.CODE_SANDBOX_BASE_URL

describe("codeInterpreterSkill", () => {
  test("identity", () => {
    expect(codeInterpreterSkill.id).toBe("codeInterpreter")
    expect(codeInterpreterSkill.toolName).toBe("runCode")
  })
  test("buildTool returns null when no sandbox configured (gate)", () => {
    delete process.env.CODE_SANDBOX_BASE_URL
    expect(codeInterpreterSkill.buildTool(undefined, {})).toBeNull()
    if (origUrl !== undefined) process.env.CODE_SANDBOX_BASE_URL = origUrl
  })
  test("buildTool returns a tool when configured", () => {
    process.env.CODE_SANDBOX_BASE_URL = "http://localhost:5555"
    const t = codeInterpreterSkill.buildTool(undefined, {})
    expect(t).not.toBeNull()
    if (origUrl === undefined) delete process.env.CODE_SANDBOX_BASE_URL
    else process.env.CODE_SANDBOX_BASE_URL = origUrl
  })
  test("promptFragment mentions runCode + savefig + no network", () => {
    const p = codeInterpreterSkill.promptFragment(undefined) ?? ""
    expect(p).toContain("runCode")
    expect(p.toLowerCase()).toContain("savefig")
    expect(p.toLowerCase()).toContain("no network")
  })
})
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Write `code-interpreter.ts`**

```ts
import "server-only"

import { tool } from "ai"
import { z } from "zod"

import { RUN_TIMEOUT_MS, hasSandboxConfig } from "@/server/code-sandbox/config"
import { selectSandbox } from "@/server/code-sandbox/select-sandbox"
import type { ServerSkill } from "@/server/skills/registry"

const PROMPT = [
  "You have a `runCode` tool: it runs Python in a sandboxed microVM and",
  "returns stdout/stderr plus any charts. Prefer it for real computation,",
  "data analysis, and plotting instead of guessing numeric answers.",
  "pandas, numpy, and matplotlib are available. There is NO network access.",
  "Print results you want shown (the sandbox is not a notebook — only stdout",
  "is captured). For charts, save figures to /tmp, e.g.",
  "`plt.savefig('/tmp/plot.png')` — saved PNG/SVG files are returned as images.",
].join(" ")

export const codeInterpreterSkill: ServerSkill = {
  id: "codeInterpreter",
  toolName: "runCode",
  buildTool(_entry, ctx) {
    if (!hasSandboxConfig()) return null
    return tool({
      description:
        "Run Python in a sandboxed microVM and return stdout/stderr plus charts (matplotlib). No network.",
      inputSchema: z.object({ code: z.string().min(1).max(50_000) }),
      async execute({ code }, { abortSignal }) {
        const gate = ctx.consumeBudget?.()
        if (gate && !gate.allowed) {
          return {
            ok: false,
            stdout: "",
            stderr: "",
            results: [],
            error: { code: "budget", message: `Rate limited. Retry in ${gate.retryAfterSec}s.` },
          }
        }
        const sandbox = selectSandbox()
        if (!sandbox) {
          return { ok: false, stdout: "", stderr: "", results: [], error: { code: "upstream", message: "Sandbox unavailable." } }
        }
        return sandbox.run({ code, language: "python", timeoutMs: RUN_TIMEOUT_MS, signal: abortSignal })
      },
    })
  },
  promptFragment() {
    return PROMPT
  },
}
```

- [ ] **Step 4: Run → PASS; typecheck; commit**

```bash
bun test lib/server/skills/code-interpreter.test.ts && bun run typecheck
git add lib/server/skills/code-interpreter.ts lib/server/skills/code-interpreter.test.ts
git commit -m "feat(skills): runCode code-interpreter skill (budget gate, timeout, prompt)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.3: Register in SERVER_SKILLS (TDD)

**Files:** Modify `lib/server/skills/registry.ts`; create/extend a registry test

- [ ] **Step 1: Write the failing test** — `lib/server/skills/registry.test.ts` (create if absent)

```ts
import { describe, expect, test } from "bun:test"

import { SERVER_SKILLS } from "./registry"

describe("SERVER_SKILLS", () => {
  test("includes codeInterpreter after searchFiles", () => {
    const ids = SERVER_SKILLS.map((s) => s.id)
    expect(ids).toContain("codeInterpreter")
    expect(ids.indexOf("codeInterpreter")).toBeGreaterThan(ids.indexOf("searchFiles"))
  })
})
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Wire it**

In `lib/server/skills/registry.ts`: add the import beside the others —
```ts
import { codeInterpreterSkill } from "@/server/skills/code-interpreter"
```
and append to the `SERVER_SKILLS` array after `searchFilesSkill`:
```ts
  codeInterpreterSkill,
```

- [ ] **Step 4: Run → PASS; typecheck; commit**

```bash
bun test lib/server/skills/registry.test.ts && bun run typecheck
git add lib/server/skills/registry.ts lib/server/skills/registry.test.ts
git commit -m "feat(skills): register codeInterpreter in SERVER_SKILLS

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — emission

### Task 3.1: `codeResult` SSE part (TDD)

**Files:** Modify `lib/server/chat/sse-emitter.ts` + `sse-emitter.test.ts`

- [ ] **Step 1: Write the failing test** (append to `sse-emitter.test.ts`)

```ts
test("codeResult → data-code-result", () => {
  const { emitter, frames } = makeEmitter() // use the test file's existing harness
  emitter.codeResult({
    id: "c1",
    stdout: "4\n",
    stderr: "",
    results: [{ type: "text", value: "4\n" }],
  })
  const frame = frames.at(-1)!
  expect(frame.type).toBe("data-code-result")
  expect((frame as { data: { id: string } }).data.id).toBe("c1")
})
```
> Match the existing test's emitter-construction helper (see the `toolImage` test ~line 170 for the exact harness names).

- [ ] **Step 2: Run → FAIL.** **Step 3: Add the method**

In `lib/server/chat/sse-emitter.ts`, add a payload type near `ToolImagePayload`:
```ts
export interface CodeResultPayload {
  id: string
  stdout: string
  stderr: string
  results: import("@/server/code-sandbox/types").CodeResult[]
}
```
and a method beside `toolImage`:
```ts
  /** Emit a code-interpreter result as a `data-code-result` custom part
   *  (stdout/stderr/text; images go via toolImage). */
  codeResult(payload: CodeResultPayload): void {
    this.send({
      type: "data-code-result",
      id: payload.id,
      data: {
        id: payload.id,
        stdout: payload.stdout,
        stderr: payload.stderr,
        results: payload.results,
      },
    })
  }
```

- [ ] **Step 4: Run → PASS; typecheck; commit**

```bash
bun test lib/server/chat/sse-emitter.test.ts && bun run typecheck
git add lib/server/chat/sse-emitter.ts lib/server/chat/sse-emitter.test.ts
git commit -m "feat(chat): emitter.codeResult → data-code-result part

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3.2: Split results in the chat route

**Files:** Modify `app/api/chat/route.ts`

- [ ] **Step 1: Add `maybeEmitCodeResultFrames`**

Read `maybeEmitImageFrame` (~line 132) and the tool-result handling loop (~line 540) to match conventions. Add a helper that, given a `runCode` tool result (`CodeRunResult`) and a stable id, splits it:

```ts
import type { CodeRunResult } from '@/server/code-sandbox/types'

async function maybeEmitCodeResultFrames(
  emitter: SseEmitter,            // match the route's emitter type name
  id: string,
  result: CodeRunResult,
): Promise<void> {
  // Images → existing gallery path (persist + toolImage).
  const imgs = result.results.filter((r) => r.type === 'image')
  if (imgs.length > 0) {
    const inputs: ImageToPersist[] = imgs.map((r) => ({
      // map base64 + format onto ImageToPersist — match its fields
      // (the type is imported at route.ts:41). Provide a data URL or
      // bytes per its contract.
      dataBase64: r.type === 'image' ? r.data : '',
      format: r.type === 'image' ? r.format : 'png',
    })) as ImageToPersist[]
    const persisted = await persistGeneratedImages(inputs, { /* match maybeEmitImageFrame's opts */ })
    emitter.toolImage({ id, mode: 'code', images: persisted })
  }
  // stdout/stderr/text → new part.
  emitter.codeResult({
    id,
    stdout: result.stdout,
    stderr: result.stderr,
    results: result.results.filter((r) => r.type !== 'image'),
  })
}
```
> **Adaptation:** mirror `maybeEmitImageFrame` exactly for the
> `persistGeneratedImages` call shape + `ImageToPersist` fields + the
> `toolImage` payload (the route already constructs these for Minimax
> images). The only new part is the `emitter.codeResult(...)` call.

- [ ] **Step 2: Call it after a `runCode` tool result**

In the tool-result handling (where `tool-output-available` / tool results are processed, near the `emitter.toolCall`/image handling ~line 540–560), when the tool name is `runCode`, call `await maybeEmitCodeResultFrames(emitter, <toolCallId>, <result as CodeRunResult>)`. Match how `maybeEmitImageFrame` is currently invoked for the image tool.

- [ ] **Step 3: Typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add app/api/chat/route.ts
git commit -m "feat(chat): emit code-interpreter results (images→gallery, rest→data-code-result)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — client wire + render

> **Execution order:** run **Task 4.2 (Message type + store mutator) FIRST** — it defines `CodeResultCell` / `CodeResultPart` in `@/shared/types`, which Task 4.1 (translator), 4.3 (dispatch), and 4.4 (render) all import. (Numbering kept for readability; the controller dispatches 4.2 → 4.1 → 4.3 → 4.4.)

### Task 4.1: Frame translator (TDD)

**Files:** Modify `lib/client/chat/sse-frame-translator.ts` + `.test.ts`

- [ ] **Step 1: Write the failing test** (append to the translator test)

```ts
test("data-code-result → code_result", () => {
  const out = translateFrame({
    type: "data-code-result",
    data: { id: "c1", stdout: "4\n", stderr: "", results: [{ type: "text", value: "4\n" }] },
  } as never)
  expect(out).toEqual({
    type: "code_result",
    id: "c1",
    stdout: "4\n",
    stderr: "",
    results: [{ type: "text", value: "4\n" }],
  })
})

test("malformed data-code-result → null", () => {
  expect(translateFrame({ type: "data-code-result" } as never)).toBeNull()
})
```
> Use the test file's existing `translateFrame` import + call style.

- [ ] **Step 2: Run → FAIL.** **Step 3: Add the case**

In `lib/client/chat/sse-frame-translator.ts`, beside the `data-tool-image` block (~line 148), add:
```ts
  if (t === "data-code-result") {
    const data = raw.data as
      | { id?: unknown; stdout?: unknown; stderr?: unknown; results?: unknown }
      | undefined
    if (!data || typeof data !== "object") return null
    return {
      type: "code_result",
      id: typeof data.id === "string" ? data.id : undefined,
      stdout: typeof data.stdout === "string" ? data.stdout : "",
      stderr: typeof data.stderr === "string" ? data.stderr : "",
      results: Array.isArray(data.results) ? data.results : [],
    }
  }
```
Extend the translator's return union type with the `code_result` variant (find the union this function returns and add `{ type: "code_result"; id?: string; stdout: string; stderr: string; results: CodeResultCell[] }`, importing `CodeResultCell` from `@/shared/types` — defined in Task 4.2, which runs first).

- [ ] **Step 4: Run → PASS; typecheck; commit**

```bash
bun test lib/client/chat/sse-frame-translator.test.ts && bun run typecheck
git add lib/client/chat/sse-frame-translator.ts lib/client/chat/sse-frame-translator.test.ts
git commit -m "feat(chat): translate data-code-result → code_result frame

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4.2: Message type + store mutator

**Files:** Modify `lib/shared/types.ts`, `lib/client/hooks/store/slices/messages.ts`

- [ ] **Step 1: Add the part type + Message field**

In `lib/shared/types.ts`, near `generatedImages` (~line 488), add:
```ts
/** A persisted code-interpreter result on a message. Images are stored
 *  via `generatedImages` (gallery); this carries stdout/stderr/text. */
export type CodeResultCell =
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "text"; value: string }
export interface CodeResultPart {
  id: string
  stdout: string
  stderr: string
  results: CodeResultCell[]
}
```
and add to the `Message` interface beside `generatedImages?`:
```ts
  codeResults?: CodeResultPart[]
```

- [ ] **Step 2: Add the append mutator**

In `lib/client/hooks/store/slices/messages.ts`, mirror `appendMessageGeneratedImages` (interface decl ~line 74, impl ~line 279):

Interface:
```ts
  appendMessageCodeResult: (messageId: string, part: import("@/shared/types").CodeResultPart) => void
```
Impl (inside the slice factory):
```ts
  appendMessageCodeResult: (messageId, part) =>
    set((s) => ({
      conversations: s.conversations.map((c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === messageId
            ? { ...m, codeResults: [...(m.codeResults ?? []), part] }
            : m,
        ),
      })),
    })),
```
> Match the exact reducer shape the file uses for `appendMessageGeneratedImages` (it may scope by active conversation rather than mapping all — copy that file's pattern precisely).

- [ ] **Step 3: Typecheck + commit**

```bash
bun run typecheck
git add lib/shared/types.ts lib/client/hooks/store/slices/messages.ts
git commit -m "feat(store): Message.codeResults + appendMessageCodeResult

Nested optional field (like generatedImages) persisted within
conversations — no top-level persist-key change, no STORE_VERSION bump.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4.3: Wire the translated frame into the store

**Files:** Modify the SSE consumer that handles translated frames (find where `tool_image` → `appendMessageGeneratedImages` is dispatched — likely `lib/client/hooks/use-chat-send.ts` or a stream handler).

- [ ] **Step 1: Dispatch `code_result`**

Find where translated frames are consumed (grep `appendMessageGeneratedImages(` and `case "tool_image"` / `=== "tool_image"`). Beside that, handle `code_result`:
```ts
// when frame.type === "code_result":
appendMessageCodeResult(messageId, {
  id: frame.id ?? "",
  stdout: frame.stdout,
  stderr: frame.stderr,
  results: frame.results,
})
```
Wire `appendMessageCodeResult` from the store the same way `appendMessageGeneratedImages` is obtained there.

- [ ] **Step 2: Typecheck + commit**

```bash
bun run typecheck
git add -A
git commit -m "feat(chat): persist code_result frames onto the message

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4.4: Render component

**Files:** Create `components/panels/code-result.tsx`; modify `components/panels/chat-message.tsx`

- [ ] **Step 1: Write the component**

```tsx
"use client"
import "client-only"

import { useState } from "react"

import type { CodeResultPart } from "@/shared/types"

/** Renders a code-interpreter result: a collapsible stdout/stderr block
 *  + inline text results. Charts render via the image gallery, not here. */
export function CodeResult({ part }: { part: CodeResultPart }) {
  const [open, setOpen] = useState(true)
  const texts = part.results.filter((r) => r.type === "text") as { type: "text"; value: string }[]
  const hasStderr = part.stderr.trim().length > 0
  return (
    <div className="my-2 rounded border border-[var(--border)] text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-2 py-1 text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
      >
        <span aria-hidden>{open ? "▾" : "▸"}</span>
        <span>Code output{hasStderr ? " (with errors)" : ""}</span>
      </button>
      {open ? (
        <div className="space-y-1 px-2 py-1">
          {part.stdout ? (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px]">
              {part.stdout}
            </pre>
          ) : null}
          {texts.map((t, i) =>
            t.value === part.stdout ? null : (
              <pre key={i} className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px]">
                {t.value}
              </pre>
            ),
          )}
          {hasStderr ? (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--destructive)]">
              {part.stderr}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 2: Render it in `chat-message.tsx`**

Find where `message.generatedImages` is rendered (the `GeneratedImagesGallery` usage) and add, beside it:
```tsx
{message.codeResults?.map((part) => <CodeResult key={part.id} part={part} />)}
```
Import `CodeResult` from `@/components/panels/code-result`.

- [ ] **Step 3: Typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add components/panels/code-result.tsx components/panels/chat-message.tsx
git commit -m "feat(ui): render code-interpreter stdout/stderr results

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — env docs + verification + PR

### Task 5.1: Env docs

**Files:** Modify `.env.example`, `CLAUDE.md`

- [ ] **Step 1: `.env.example`** — add a block:
```
# Code interpreter sandbox (optional). When CODE_SANDBOX_BASE_URL is set,
# the runCode skill registers and executes Python in a local microsandbox
# microVM. Network is OFF inside the sandbox.
CODE_SANDBOX_BASE_URL=
CODE_SANDBOX_API_KEY=
# Optional overrides: CODE_SANDBOX_TIMEOUT_MS, CODE_SANDBOX_STDOUT_CAP,
# CODE_SANDBOX_RESULT_CAP, CODE_SANDBOX_MEM_MIB, CODE_SANDBOX_CPUS
```

- [ ] **Step 2: `CLAUDE.md`** — add a short bullet to the Environment Variables section describing the `CODE_SANDBOX_*` group (gated registration of `runCode`; microsandbox; network off; references the two PLAN docs).

- [ ] **Step 3: Commit**
```bash
git add .env.example CLAUDE.md
git commit -m "docs: document CODE_SANDBOX_* env for the runCode skill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 5.2: Full gate

- [ ] **Step 1:** `bun run typecheck` → clean.
- [ ] **Step 2:** `bun run lint` → 0 errors (pre-existing warnings in `app/api/summarize/route.ts` + `services/agent-ts/*` are unrelated).
- [ ] **Step 3:** `bun run test` → all pass (new marshal / select / skill / registry / emitter / translator tests included).
- [ ] **Step 4:** `bun run build` → succeeds.
- [ ] **Step 5:** `bun run audit:bundle` → no server-only paths/secrets in client chunks (the sandbox code is `server-only`; confirm `lib/server/code-sandbox/` does not leak into client bundles).

### Task 5.3: Manual smoke (requires the local microsandbox runtime)

Document results in the PR. Prereqs: Node ≥22; `CODE_SANDBOX_BASE_URL` set; microsandbox runtime installed (first run fetches to `~/.microsandbox/`).
1. Enable the Code-interpreter skill in a workspace; ask "what is 2+2? use code" → a code-output block shows `4`.
2. "plot y=x^2 for x in 0..10 and save it" → a chart appears in the gallery.
3. "loop forever" → a `timeout` error surfaces; no hung request.
4. Exhaust the budget → clean `budget` error.
5. Reload the page → the code output persists on the message.

### Task 5.4: Open the PR into `dev`

Push `feat/code-interpreter-microsandbox`; open a PR into `dev`. Body: summary (microsandbox `runCode`, PR-1, network-off, env-gated), spec + the two PLAN-doc links, the note that the nsjail spec/plan are superseded, the automated-test list, and the manual-smoke results. Commit trailer as above.

---

## Out of scope (this PR)

File mounting (PR 2); rich `table` data-grid + JavaScript (PR 3); persistent warm sessions (PR 4); `services/agent-py`/`agent-ts` parity; an E2B client. The `table` `CodeResult` variant exists in the type but v1 marshalling never emits it.

## Risks

- **microsandbox SDK surface drift** — Task 1.4 pins the verified mapping but the implementer must confirm method names against the installed package; the `RawRun` contract to `toCodeRunResult` is the stable seam.
- **No automated integration test** — deliberate (heavy runtime, CI absence); the pure marshaller + gates carry coverage, the microVM path is smoke-verified (Task 5.3).
- **Chart-via-fs convention** — depends on the model saving to `/tmp`; mis-saves degrade gracefully (stdout still returns).
- **`ImageToPersist` mapping** — Task 3.2 reuses the Minimax persistence path; confirm the base64/format field names match `image-storage.ts`.

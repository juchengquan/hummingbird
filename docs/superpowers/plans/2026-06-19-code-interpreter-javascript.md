# Code interpreter — JavaScript (PR-4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `runCode` can run JavaScript (Node.js) as well as Python, selected via a `language` param (default Python).

**Architecture:** A pure `runtimeFor(language)` map (`python` → image `python` + `python3 -c`; `javascript` → image `node` + `node -e`, spike-verified) is the only new logic. The microsandbox client picks image + exec from it; the skill exposes `language` on the tool and threads it through. Everything downstream (result read-back, files, charts, tables, caps, render) is language-agnostic and unchanged. Default Python keeps full back-compat.

**Tech Stack:** TypeScript, microsandbox Node SDK, AI SDK v5, Zod, bun:test.

**Spec:** `docs/superpowers/specs/2026-06-19-code-interpreter-javascript-design.md` · **Builds on:** #243/#244/#245.

---

## File structure

**New:**
- `lib/server/code-sandbox/runtime.ts` — `CodeSandboxLanguage` type + pure `runtimeFor()`.
- `lib/server/code-sandbox/runtime.test.ts` — `runtimeFor` unit tests.

**Modified:**
- `lib/server/code-sandbox/types.ts` — `CodeRunInput.language` widened to `CodeSandboxLanguage`.
- `lib/server/code-sandbox/microsandbox-client.ts` — image + exec from `runtimeFor`.
- `lib/server/skills/code-interpreter.ts` (+ `.test.ts`) — `language` tool input, threaded to `run`, prompt + description.

**Unchanged (language-agnostic):** `marshal.ts`, the `/tmp` read-back, file mounting, table parsing, the chat route, SSE emitter/translator, store, render, wire schema, caps.

---

## Task 1: `runtimeFor` map (TDD)

**Files:** Create `lib/server/code-sandbox/runtime.ts` + `runtime.test.ts`

- [ ] **Step 1: Write the failing test** — `lib/server/code-sandbox/runtime.test.ts`

```ts
import { describe, expect, test } from "bun:test"

import { runtimeFor } from "./runtime"

describe("runtimeFor", () => {
  test("python → python image + python3 -c", () => {
    expect(runtimeFor("python")).toEqual({ image: "python", cmd: "python3", flag: "-c" })
  })
  test("javascript → node image + node -e", () => {
    expect(runtimeFor("javascript")).toEqual({ image: "node", cmd: "node", flag: "-e" })
  })
  test("unknown / undefined → python mapping (safe default)", () => {
    expect(runtimeFor(undefined as never)).toEqual({ image: "python", cmd: "python3", flag: "-c" })
    expect(runtimeFor("ruby" as never)).toEqual({ image: "python", cmd: "python3", flag: "-c" })
  })
})
```

- [ ] **Step 2: Run → FAIL** — `bun test lib/server/code-sandbox/runtime.test.ts` (module missing).

- [ ] **Step 3: Write `runtime.ts`**

```ts
import "server-only"

/** Languages `runCode` can execute. */
export type CodeSandboxLanguage = "python" | "javascript"

/** Per-language microsandbox runtime: which image to boot, the exec
 *  command, and the inline-code flag. Spike-verified (2026-06-19): the
 *  `node` image runs JS; the `python` image has no node. Pure. Unknown
 *  input defaults to python (the route's Zod enum already rejects bad
 *  values; this is belt-and-suspenders). */
export function runtimeFor(
  language: CodeSandboxLanguage,
): { image: string; cmd: string; flag: string } {
  if (language === "javascript") {
    return { image: "node", cmd: "node", flag: "-e" }
  }
  return { image: "python", cmd: "python3", flag: "-c" }
}
```

- [ ] **Step 4: Run → PASS; typecheck; commit**

```bash
bun test lib/server/code-sandbox/runtime.test.ts && bun run typecheck
git add lib/server/code-sandbox/runtime.ts lib/server/code-sandbox/runtime.test.ts
git commit -m "feat(code-sandbox): runtimeFor language→image/exec map (python + node)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Widen `CodeRunInput` + use `runtimeFor` in the client

**Files:** Modify `lib/server/code-sandbox/types.ts`, `lib/server/code-sandbox/microsandbox-client.ts`

- [ ] **Step 1: Widen the input type**

In `lib/server/code-sandbox/types.ts`, import the language type and widen the field. Change `language: "python"` (line 23) to `language: CodeSandboxLanguage`, and add the import at the top:

```ts
import type { CodeSandboxLanguage } from "./runtime"
```
(and `language: CodeSandboxLanguage` in `CodeRunInput`).

- [ ] **Step 2: Use the runtime map in the client**

In `lib/server/code-sandbox/microsandbox-client.ts`:
- Add the import: `import { runtimeFor } from "./runtime"`.
- Compute the runtime once, before the builder (near where `sandboxConfig()` / boot happens): `const rt = runtimeFor(input.language)`.
- Replace `.image("python")` (line 44) with `.image(rt.image)`.
- Replace the exec (lines 70-72):
  ```ts
          const out = await sb.execWith(rt.cmd, (e) =>
            e.args([rt.flag, input.code]).timeout(input.timeoutMs),
          )
  ```

- [ ] **Step 3: Typecheck + commit**

```bash
bun run typecheck
git add lib/server/code-sandbox/types.ts lib/server/code-sandbox/microsandbox-client.ts
git commit -m "feat(code-sandbox): select image + exec per language via runtimeFor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Skill — `language` tool input + prompt

**Files:** Modify `lib/server/skills/code-interpreter.ts` (+ `code-interpreter.test.ts`)

- [ ] **Step 1: Write the failing tests** (append to `code-interpreter.test.ts`)

```ts
test("tool input accepts language: javascript", () => {
  process.env.CODE_SANDBOX_BASE_URL = "http://localhost:5555"
  const t = codeInterpreterSkill.buildTool(undefined, {})
  const parsed = (t as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } })
    .inputSchema.safeParse({ code: "console.log(1)", language: "javascript" })
  expect(parsed.success).toBe(true)
})
test("tool input rejects an unknown language", () => {
  process.env.CODE_SANDBOX_BASE_URL = "http://localhost:5555"
  const t = codeInterpreterSkill.buildTool(undefined, {})
  const parsed = (t as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } })
    .inputSchema.safeParse({ code: "x", language: "ruby" })
  expect(parsed.success).toBe(false)
})
test("promptFragment mentions JavaScript / node", () => {
  const p = codeInterpreterSkill.promptFragment(undefined) ?? ""
  expect(p.toLowerCase()).toContain("javascript")
})
```
> Match the existing test file's `inputSchema` access pattern (it was used in the PR-2/PR-3 tests for `files`); if the AI SDK `tool()` doesn't expose `inputSchema` readably, mirror whatever those tests already do.

- [ ] **Step 2: Run → FAIL.** **Step 3: Update the skill**

In `lib/server/skills/code-interpreter.ts`:
- Add `language` to the `inputSchema` (line 33-36):
  ```ts
      inputSchema: z.object({
        code: z.string().min(1).max(50_000),
        language: z.enum(["python", "javascript"]).optional(),
        files: z.array(z.string().max(500)).max(10).optional(),
      }),
  ```
- Destructure it: `execute: async ({ code, files, language }, { abortSignal }) => {`.
- Pass it to `run` (line 75-81): change `language: "python",` to `language: language ?? "python",`.
- Update the tool `description` to mention both languages, e.g.: `"Run Python or JavaScript (Node.js) in a sandboxed microVM and return stdout/stderr plus charts/tables. No network."`.
- Extend the `PROMPT` array with a JavaScript line, e.g. after the existing intro lines:
  ```ts
    "Set `language: 'javascript'` to run Node.js instead of Python (default).",
    "For JavaScript use `console.log` for output; the file conventions are the",
    "same (mounted files at /mnt/files/<name>, tables to /tmp/<name>.table.json).",
    "Charts via matplotlib `savefig` are Python-only.",
  ```

- [ ] **Step 4: Run → PASS; typecheck + lint; commit**

```bash
bun test lib/server/skills/code-interpreter.test.ts && bun run typecheck && bun run lint
git add lib/server/skills/code-interpreter.ts lib/server/skills/code-interpreter.test.ts
git commit -m "feat(skills): runCode language param (python|javascript) + prompt

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Verification + PR

- [ ] **Step 1:** `bun run typecheck` → clean.
- [ ] **Step 2:** `bun run lint` → 0 errors (pre-existing warnings in `app/api/summarize/route.ts` + `services/agent-ts/*` unrelated).
- [ ] **Step 3:** `bun run test` → all pass (new `runtime` + skill tests + existing).
- [ ] **Step 4:** `bun run build` → succeeds (`microsandbox` already `serverExternalPackages` from PR-1; no config change).
- [ ] **Step 5:** `bun run audit:bundle` → no server-only paths/secrets in client chunks.
- [ ] **Step 6: Live smoke** (the controller can run this — the microsandbox runtime works on this machine; verified by the 2026-06-19 node-image spike). With `CODE_SANDBOX_BASE_URL` set, drive a `runCode` call (or a focused harness) with `language: "javascript"`, `code: "console.log(2+2)"` → stdout `4`, `ok: true`; a Python run (no `language`) still works; a JS run writing `/tmp/x.table.json` yields a `table` result.
- [ ] **Step 7: Open the PR into `dev`.** Body: summary (runCode JavaScript via a `node` image, `language` param, default Python = back-compat), spike result, spec + plan links, the automated-test list, and smoke results. Push `feat/code-interpreter-javascript`; commit trailer as above.

---

## Out of scope

Persistent warm sessions (PR-5, optional); TypeScript; in-sandbox `npm install` (network OFF; Node stdlib/built-ins only); per-language result special-casing; JS charting.

## Risks

- **`node` image name** — spike-verified today; `runtimeFor` is the single update point if the runtime ever renames it.
- **First JS run latency** — the `node` image fetches on first use (one-time, then cached); same as `python` did.
- **`node -e` inline semantics** — multi-statement is fine; top-level ESM/await differs from a file. Acceptable for single-cell exec; the prompt steers toward `console.log`.
- **Back-compat** — `language` is optional and defaults to `"python"`; all existing call sites + the no-`language` path are byte-identical to today (covered by the `runtimeFor` default test + the unchanged Python smoke).
```

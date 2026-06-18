# Plan: Sandboxed code interpreter

Status: **planning.** Drafted in the 2026-06-09 market refresh; item
from [MASTER_PLAN § Later](MASTER_PLAN.md) promoted to **Next**. Scope:
**L** (sandbox-provider integration + result marshalling + security
posture; a phased PR series). Origin: E2B-style sandboxed execution —
see [Sources](#sources).

## Why

Live artifacts (#36) *render* generated TSX/HTML/SVG/Mermaid, but they
can't *execute* arbitrary Python/JS and return computed results — a
chart from a real pandas run, a parsed CSV, a solved optimisation.
"Write me code" stops at the code; the user copies it elsewhere to run.

A sandboxed interpreter — E2B-style Firecracker microVMs, self-hostable,
with a Jupyter kernel — turns that into "run it and show me the answer."
It's rising table-stakes for data-analysis chat, but it becomes
genuinely *distinctive* when wired to surfaces Hummingbird already has:

- **Run code against an uploaded file** — the user attaches a CSV, the
  model runs pandas on it, returns a chart. Composes with conversation
  file attachments + the `searchFiles` retrieval surface.
- **Persist generated charts** — reuse the exact Storage path that
  `generateImage` already uses (`persistGeneratedImages` in
  `lib/server/image-storage.ts`), so a chart from code lands in the
  Library tab beside generated images.

The skill registry (`lib/server/skills/registry.ts`) is the natural
home: `runCode` is one more `ServerSkill` beside `generateImage`,
`webSearch`, `webFetch`, `searchFiles`.

## Non-goals — what this is NOT

- **Not a code editor / IDE.** No file tree, no LSP, no multi-file
  projects. One code cell per tool call.
- **Not arbitrary long-running processes.** Each run is bounded by a
  wall-clock timeout and the per-IP budget. No daemons, no servers
  bound inside the sandbox that outlive the call.
- **Not a replacement for live artifacts.** Artifacts render UI; the
  interpreter computes results. A run *can* emit an image that renders
  via the existing gallery, but it doesn't render interactive UI.
- **Not a self-owned sandbox cluster.** We integrate a provider (E2B
  hosted, or a self-host base URL behind an adapter), the way
  `model-provider.ts` integrates Minimax via a custom base URL. We do
  not own the microVM orchestration.

## Decisions to pin before code

1. **Provider.** Default to **E2B** (open-source, hosted + self-host
   via Terraform/GCP, mature `code-interpreter` SDK with a Jupyter
   kernel). Wrap behind a `CodeSandbox` interface so a self-host base
   URL or an alternative provider drops in without touching call sites
   — mirrors the Minimax-CN custom-base-URL pattern.
2. **Languages.** Phase 1: **Python** only (the data-analysis 80%).
   JavaScript in a follow-up — the SDK supports both; the prompt + the
   result marshalling are the only per-language deltas.
3. **Approval posture.** Two modes, pinned per workspace:
   - **Budget-gated auto-run** (default) — the tool executes
     immediately, gated by the existing `consumeBudget()` from
     `SkillRuntimeContext` + a wall-clock timeout. Good for trusted
     single-user use.
   - **HITL-gated** (opt-in) — build the tool with **no `execute`**
     (the existing `buildGatedMcpTool` / `makeAskUserTool` pattern) so
     the model emits the call and a human approves before it runs.
     Reuses the approval card. For shared/untrusted contexts.
4. **Result channels — reuse what exists.**
   - **Images** (matplotlib PNGs, etc.) → `persistGeneratedImages()` →
     `data-tool-image` frame → `appendMessageGeneratedImages` → the
     existing `GeneratedImagesGallery`. Zero new render code for charts.
   - **stdout / stderr / tables / return values** → a **new**
     `data-code-result` AI SDK part rendered by a new component.
5. **Env-gated registration.** The skill registers only when a sandbox
   credential is present (`E2B_API_KEY`, or `CODE_SANDBOX_BASE_URL` +
   `CODE_SANDBOX_API_KEY`). Absent → the skill is simply not in
   `SERVER_SKILLS`, exactly like image-gen degrades without a Minimax
   key. No mock — code execution has no meaningful mock.
6. **File access (Phase 2).** Attached files are uploaded into the
   sandbox fs before the run; the tool input names which attachment(s)
   to mount. Until Phase 2, `runCode` is stateless (no fs).

## Shape — code surface

### Provider abstraction — `lib/server/code-sandbox/`

```ts
// lib/server/code-sandbox/types.ts
export interface CodeRunResult {
  ok: boolean
  stdout: string
  stderr: string
  results: CodeResult[]          // rich cell outputs
  error?: { code: "timeout" | "runtime" | "upstream" | "budget"; message: string }
}
export type CodeResult =
  | { type: "image"; format: "png" | "svg"; data: string /* base64 */ }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "text"; value: string }

export interface CodeSandbox {
  run(input: { code: string; language: "python"; timeoutMs: number; signal?: AbortSignal }): Promise<CodeRunResult>
}
```

- `lib/server/code-sandbox/e2b-client.ts` — `createE2bSandbox()`:
  creates a Firecracker sandbox, runs the cell on the Jupyter kernel,
  maps E2B's rich outputs onto `CodeResult[]`, always tears the sandbox
  down in a `finally`.
- `lib/server/code-sandbox/select-sandbox.ts` — picks E2B vs a
  self-host base URL from env (the `model-provider.ts` pattern).

### Skill — `lib/server/skills/code-interpreter.ts`

A `ServerSkill` (id `"codeInterpreter"`, toolName `"runCode"`):

```ts
export const codeInterpreterSkill: ServerSkill = {
  id: "codeInterpreter",
  toolName: "runCode",
  buildTool(entry, ctx) {
    if (!hasSandboxConfig()) return null
    return tool({
      description: "Run Python in a sandbox and return stdout + rich results (charts, tables).",
      inputSchema: z.object({ code: z.string(), files: z.array(z.string()).optional() }),
      async execute({ code }, { abortSignal }) {
        const gate = ctx.consumeBudget?.()
        if (gate && !gate.allowed) return { ok: false, code: "budget", retryAfterSec: gate.retryAfterSec }
        const sandbox = selectSandbox()
        return sandbox.run({ code, language: "python", timeoutMs: RUN_TIMEOUT_MS, signal: abortSignal })
      },
    })
  },
  promptFragment: () => CODE_INTERPRETER_PROMPT, // "you have a runCode tool; prefer it for computation/charts"
}
```

Registered in `SERVER_SKILLS` (`lib/server/skills/registry.ts`) after
`searchFilesSkill`.

### Emission — `app/api/chat/route.ts`

A `maybeEmitCodeResultFrames()` beside the existing
`maybeEmitImageFrame()`: after `runCode` returns, split the result —
image `CodeResult`s go through `persistGeneratedImages()` + the
existing `emitter.toolImage(...)`; the remaining stdout/stderr/table/
text payload emits via a new `emitter.codeResult({ id, stdout, stderr,
results })` (`data-code-result` part).

### Wire — translator + store + render

- `lib/client/chat/sse-frame-translator.ts` — `"data-code-result"` →
  `{ type: "code_result", … }`; union extended.
- `lib/client/hooks/store/slices/messages.ts` —
  `appendMessageCodeResult(messageId, result)` → `Message.codeResults?`
  (additive; migration + `STORE_VERSION` bump per the persist contract).
- `components/panels/code-result.tsx` (new) — renders a collapsible
  stdout/stderr block + a simple data-grid for `table` results. Charts
  already render through `GeneratedImagesGallery`.
- `components/panels/chat-message.tsx` — render `<CodeResult>` for each
  `message.codeResults` entry.

## Sequencing — PR series

1. **PR 1 — provider + stateless `runCode` (Python, no fs).** The
   `CodeSandbox` interface + E2B client + select-sandbox; the skill;
   stdout/stderr/text + image results; budget gate + timeout; the
   `data-code-result` part end-to-end. HITL-gated mode behind the
   workspace flag.
2. **PR 2 — file mounting.** Upload named conversation attachments into
   the sandbox fs before the run; the model can read an uploaded CSV.
   Reuses the attachment-resolution path the chat route already runs.
3. **PR 3 — table rendering polish + JS language.** Rich data-grid for
   `table` results (sort/export); add `"javascript"` to the language
   union + prompt.
4. **PR 4 (optional) — persistent kernel per conversation.** A warm
   sandbox session reused across turns so variables persist (the
   notebook experience). Adds session lifecycle + idle teardown; defer
   until single-shot proves valuable.

## Tests

- **Result marshalling (PR 1)** — a pure mapper from the provider's raw
  output → `CodeResult[]` (image/table/text discrimination, stderr
  capture, truncation of huge stdout). ~8 cases, no network.
- **`translateFrame` (PR 1)** — `data-code-result` → `code_result`;
  malformed → `null`.
- **Skill registration gate (PR 1)** — no sandbox config → skill absent
  from `SERVER_SKILLS` (regression guard).
- **Manual smoke (PR checklist)** — "plot y=x^2" returns a chart in the
  gallery; "print(2+2)" returns stdout; an infinite loop hits the
  timeout and surfaces a `timeout` error bubble; budget exhaustion
  surfaces cleanly.

## Open questions before PR 1

1. **Hosted vs self-host default for the project.** E2B hosted is the
   fastest path but adds a vendor + per-run cost. **Default: support
   both from day one via the adapter; document E2B hosted as the
   quickstart and self-host as the privacy/cost path.** The self-host
   runtime choice (which open-source sandbox fills the `CODE_SANDBOX_BASE_URL`
   slot, conditioned on the deploy host's KVM support) is worked out in
   [`PLAN-execution-sandbox.md`](PLAN-execution-sandbox.md).
2. **Wall-clock + output caps.** **Default: 30 s timeout, 256 KB stdout
   cap, 10 MB total result cap; all configurable via env.**
3. **Network egress from the sandbox.** Allowing `pip install` / HTTP
   from inside is convenient but widens the attack surface. **Default:
   network OFF in v1 (pre-baked data-science image with pandas/numpy/
   matplotlib); revisit a per-workspace "allow network" flag later.**

## Reopen / future work

- **Persistent kernel sessions** (PR 4) — the Jupyter-notebook
  experience where state carries across turns.
- **Agent-service parity** — the skill lives in the Next.js route
  first; port to `services/agent-py` + `services/agent-ts` once the
  contract settles (mirrors how every skill landed inline then ported).
- **Aider editor pair synergy** — the parked Aider plan notes a
  fast-model patch loop could reuse a sandbox; revisit together.

## Sources

- [E2B](https://e2b.dev/)
- [E2B code-interpreter SDK](https://github.com/e2b-dev/code-interpreter)
- [E2B repo](https://github.com/e2b-dev/e2b)

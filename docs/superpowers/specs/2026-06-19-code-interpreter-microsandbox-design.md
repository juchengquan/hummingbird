# Code interpreter (`runCode`) with microsandbox — Design

**Status:** Approved design (2026-06-19). Implements **PR-1** of the
code-interpreter feature with the **microsandbox** runtime.

**Supersedes** the nsjail/agent-py approach in
`docs/superpowers/specs/2026-06-15-code-interpreter-sandbox-design.md`
and `docs/superpowers/plans/2026-06-15-code-interpreter-sandbox.md`
(nsjail is Linux-only and the runtime decision changed to microsandbox).

**Builds on (current, merged design):**
- `docs/PLAN-code-interpreter.md` — the consumer: the `CodeSandbox`
  adapter in `lib/server/code-sandbox/`, the `runCode` ServerSkill,
  result channels, and the PR series. This design implements its PR 1.
- `docs/PLAN-execution-sandbox.md` — the runtime decision: **microsandbox**
  (libkrun microVMs, HVF on Apple Silicon), with the verified Node-SDK →
  `CodeSandbox` mapping and the exec-not-kernel chart delta.

## Goal

A `runCode` ServerSkill that runs model-written **Python** inside a local
microsandbox microVM and returns stdout/stderr + charts, wired end-to-end
into the chat UI. **Network OFF**, **budget-gated**, **wall-clock bounded**,
stateless (no filesystem mounting yet).

## Non-goals (this PR)

- File mounting of conversation attachments (PR 2).
- Rich data-grid `table` rendering + JavaScript (PR 3).
- Persistent kernel / warm session per conversation (PR 4).
- `services/agent-py` + `services/agent-ts` parity (later, once the inline
  contract settles — the established "inline first, port later" pattern).
- An E2B client. `select-sandbox.ts` keeps the env-gated seam so E2B or
  another provider drops in later without call-site changes, but only the
  microsandbox client is built now.

## Decisions locked

| # | Decision | Choice |
|---|---|---|
| D1 | Scope | **Full PR-1 end-to-end** — adapter + microsandbox client + marshalling + skill + emission + store + render. |
| D2 | Backend | **microsandbox only** behind the `CodeSandbox` adapter; env seam preserved for later providers. |
| D3 | Runtime model | microsandbox is **exec + filesystem, not a Jupyter kernel** — charts via `savefig`→`fs.read`; text/stdout/stderr from exec. |
| D4 | Network | **OFF** (airgapped microVM); pre-baked `python` image with pandas/numpy/matplotlib. |
| D5 | Languages | **Python only** this PR. |
| D6 | Tests | Pure unit tests automated; the live microVM run verified by **manual smoke** (runtime fetch is heavy + absent in CI) — matches both PLAN docs. |

## Architecture

```
runCode tool (skill) ──► CodeSandbox.run({code, language:"python", timeoutMs, signal})
                              │  selectSandbox() picks the microsandbox client (env-gated)
                              ▼
                    microsandbox-client.ts
                       boot microVM (image=python, cpus=1, mem=512MiB, network=airgapped)
                       exec python3 -c <code> with timeout
                       read back /tmp/*.png|*.svg via sb.fs()
                       teardown in finally
                              │  raw { stdout, stderr, code, images[] }
                              ▼
                    marshal.ts (pure) ──► CodeRunResult { ok, stdout, stderr, results: CodeResult[] }
                              │
        app/api/chat/route.ts: maybeEmitCodeResultFrames()
           image results ─► persistGeneratedImages() ─► emitter.toolImage  (existing gallery)
           stdout/stderr/text ─► emitter.codeResult  (new data-code-result part)
                              ▼
        client: translateFrame ─► messages slice (appendMessageCodeResult) ─► <CodeResult/>
```

The Zustand store stays the runtime source of truth; the sandbox exists
only server-side per call.

## Components & boundaries

**New — `lib/server/code-sandbox/` (TS, in-Next):**

| File | Responsibility |
|---|---|
| `types.ts` | `CodeSandbox` interface + `CodeRunResult` / `CodeResult` (`image`\|`table`\|`text`) — verbatim from `PLAN-code-interpreter.md`. |
| `microsandbox-client.ts` | `createMicrosandboxClient()` implementing `CodeSandbox` via the **Node SDK**: `Sandbox.builder(name).image("python").replace().cpus(1).memory(MiB(512)).create()`; run via `execWith("python3", e => e.args(["-c", code]).timeout(timeoutMs))`; **network policy = airgapped**; read back image files from `/tmp`; `await using`/`finally` teardown. Maps raw exec output + image bytes to the shape `marshal.ts` consumes. |
| `select-sandbox.ts` | `selectSandbox()` + `hasSandboxConfig()` — env-gated (`CODE_SANDBOX_BASE_URL`); returns the microsandbox client when configured, else null. Mirrors `model-provider.ts`'s custom-base-URL gating. |
| `marshal.ts` | **Pure** `toCodeResults(raw) -> CodeRunResult`: stdout→`text`, image bytes→`image` (base64), stderr captured, stdout truncated at 256 KB, exit code → `ok`. No I/O — unit-tested in isolation. |
| `config.ts` (or constants in `select-sandbox.ts`) | `RUN_TIMEOUT_MS` (30s), `STDOUT_CAP` (256 KB), `RESULT_CAP` (10 MB), `MEM_MIB` (512), `CPUS` (1) — env-overridable. |

**New — skill:** `lib/server/skills/code-interpreter.ts` — `ServerSkill`
(id `"codeInterpreter"`, tool `"runCode"`). `buildTool` returns null when
`!hasSandboxConfig()`. `execute({code}, {abortSignal})`: budget gate via
`ctx.consumeBudget?.()` (return a `budget` error when denied), then
`selectSandbox().run({code, language:"python", timeoutMs: RUN_TIMEOUT_MS,
signal: abortSignal})`. `promptFragment`: "prefer `runCode` for
computation/charts; print results to stdout; for charts `savefig` to
`/tmp/<name>.png`; pandas/numpy/matplotlib available; no network."

**Modified:**
- `lib/server/skills/registry.ts` — add `codeInterpreterSkill` to
  `SERVER_SKILLS` after `searchFilesSkill`.
- `app/api/chat/route.ts` — `maybeEmitCodeResultFrames()` beside
  `maybeEmitImageFrame()`: split results — images → `persistGeneratedImages()`
  + `emitter.toolImage(...)`; rest → `emitter.codeResult({id, stdout, stderr,
  results})`.
- The emitter (wherever `toolImage` lives) — add `codeResult(...)` emitting
  a `data-code-result` part.
- `lib/client/chat/sse-frame-translator.ts` — `"data-code-result"` →
  `{type:"code_result", ...}`; extend the union; malformed → null.
- `lib/client/hooks/store/slices/messages.ts` — `appendMessageCodeResult`
  → `Message.codeResults?: CodeResultPart[]`. Additive persisted-shape
  change → `STORE_VERSION` bump + `runMigrations` step + persist allowlist
  + `persist.test.ts` update (per the frozen-persist contract).
- `components/panels/code-result.tsx` (new) — collapsible stdout/stderr
  block; `text` results inline. Charts already render via the existing
  `GeneratedImagesGallery`. Rendered by `components/panels/chat-message.tsx`
  for each `message.codeResults` entry.
- `.env.example` — `CODE_SANDBOX_BASE_URL`, `CODE_SANDBOX_API_KEY`
  (+ optional cap overrides) documented.
- `CLAUDE.md` env section — note the new sandbox env group.

**Chart-via-fs convention (the main novel logic).** The prompt tells the
model to `savefig('/tmp/<name>.png')`. After `exec`, the client lists
`/tmp` for `*.png`/`*.svg` produced during the run and reads them via
`sb.fs().read(...)`. Total image bytes bounded by `RESULT_CAP`. No kernel
"last-expression value" — the model prints results explicitly.

## Data flow / error handling

`CodeRunResult.error.code ∈ {timeout, runtime, upstream, budget}`:
- **budget** — `consumeBudget` denied; no microVM booted.
- **timeout** — `execWith(...).timeout()` exceeded (or AbortSignal); microVM
  torn down; surfaces a timeout bubble.
- **runtime** — non-zero exit / Python exception (stderr carried through).
- **upstream** — microsandbox daemon/boot failure; teardown still runs in
  `finally`.
Stdout truncated at `STDOUT_CAP`; total result bytes capped at `RESULT_CAP`.

## Testing

**Automated (no runtime needed):**
- `marshal.test.ts` — ~8 cases: text/image discrimination, stderr capture,
  stdout truncation, exit-code→`ok`, empty output, multi-image, oversize→cap.
- `sse-frame-translator` — `data-code-result`→`code_result`; malformed→null.
- skill-registration gate — `hasSandboxConfig()` false → `codeInterpreterSkill`
  absent from the built `SERVER_SKILLS` (regression guard).
- persist contract — `Message.codeResults` key in the allowlist; `STORE_VERSION`
  bumped; pinned by `persist.test.ts`.

**Manual smoke (PR checklist; requires the local microsandbox runtime):**
1. "plot y=x²" → a chart appears in the gallery.
2. "print(2+2)" → `4` in a code-result block.
3. infinite loop → `timeout` error bubble; microVM torn down.
4. budget exhaustion → clean `budget` error, no microVM booted.
5. reload → `codeResults` persist on the message.

## Risks

- **New local dependency.** microsandbox needs Node ≥22 and a one-time
  runtime fetch to `~/.microsandbox/`; live execution only works on Apple
  Silicon / KVM hosts (see `PLAN-execution-sandbox.md` §Production caveat).
  Env-gated so absence = skill simply not registered (no crash).
- **Chart-via-fs is bespoke.** The `/tmp` read-back + the prompt convention
  are the main new logic; covered by the marshalling unit tests (mapper) +
  manual smoke (end-to-end).
- **No automated integration test in v1** — deliberate (heavy runtime, CI
  absence). The pure mapper + gates carry the automated coverage; the
  microVM path is smoke-verified.
- **Prompt reliability.** The model must print + `savefig`; the
  `promptFragment` instructs this. Mis-saved charts simply don't appear
  (graceful: stdout still returns).

## Sequencing note

This is PR 1. PR 2 (file mounting), PR 3 (tables + JS), PR 4 (warm
sessions), and agent-service parity follow per `PLAN-code-interpreter.md`
/ `PLAN-execution-sandbox.md`.

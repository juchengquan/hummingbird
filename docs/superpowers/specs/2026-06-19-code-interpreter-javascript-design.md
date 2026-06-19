# Code interpreter — JavaScript (PR-4) — Design

**Status:** Approved design (2026-06-19). Adds JavaScript to `runCode`.
Builds on PR-1 (`#243`), PR-2 (`#244`), PR-3 (`#245`).

**Runtime validated (2026-06-19 spike):** a microsandbox **`node` image**
boots and runs JS (`node -e "console.log(1+1)"` → `exit=0`, `JS_OK 2`).
The `python` image has **no** node (`spawn "node": No such file`), so
there is no single dual-runtime image — JS requires a dedicated `node`
image. Hence: **per-language image + exec**.

## Goal

`runCode` can run **JavaScript (Node.js)** as well as Python, chosen via a
`language` param (default Python). Network stays OFF; everything else
(files, charts, tables, caps, result rendering) composes unchanged.

## Decisions locked (brainstorming + spike)

| # | Decision | Choice |
|---|---|---|
| D1 | Selection | **One `runCode` tool** with `language?: "python" \| "javascript"` (default `"python"`). |
| D2 | Runtime | **Per-language image + exec** (spike-verified): `python` → image `python`, `python3 -c`; `javascript` → image `node`, `node -e`. |
| D3 | Default | **Python** (the data-analysis 80%; back-compat — no `language` behaves exactly as today). |

## Architecture

The only new logic is a language→runtime map; everything downstream is
language-agnostic and unchanged.

```
runCode({ code, language?: "python"|"javascript", files? })
   │  skill.execute → sandbox.run({ code, language, ... })
   ▼
microsandbox-client: runtimeFor(language) → { image, cmd, flag }
   .image(image)  +  execWith(cmd, e => e.args([flag, code]).timeout(...))
   ▼
(unchanged) read /tmp charts + /tmp/*.table.json + stdout → marshal → data-code-result → render
```

## Components & boundaries

### `runtimeFor` — the pure runtime map
New tiny pure helper (in `lib/server/code-sandbox/config.ts` or a new
`runtime.ts`): `runtimeFor(language: "python" | "javascript") -> { image: string; cmd: string; flag: string }`:
- `"python"` → `{ image: "python", cmd: "python3", flag: "-c" }`
- `"javascript"` → `{ image: "node", cmd: "node", flag: "-e" }`
- any other/undefined → the python mapping (safe default).
Pure + unit-tested — the one piece of real logic.

### `CodeRunInput` — `lib/server/code-sandbox/types.ts`
Widen `language: "python"` → `language: "python" | "javascript"`.

### microsandbox client — `lib/server/code-sandbox/microsandbox-client.ts`
Replace the hardcoded `.image("python")` and `execWith("python3", e => e.args(["-c", code])…)` with `runtimeFor(input.language)`: `.image(rt.image)` and `execWith(rt.cmd, e => e.args([rt.flag, code]).timeout(input.timeoutMs))`. The `/tmp` read-back (charts + tables), file-mount writes, caps, network-OFF, and teardown are unchanged.

### Skill + prompt — `lib/server/skills/code-interpreter.ts`
- Tool `inputSchema` gains `language: z.enum(["python", "javascript"]).optional()`.
- `execute` passes `language: language ?? "python"` to `sandbox.run`.
- `promptFragment` adds: set `language: "javascript"` to run Node.js (else Python); for JS use `console.log` for output. Clarify the existing conventions as language-aware: **files mount at `/mnt/files/` for both**; **tables** work in both (write `/tmp/<name>.table.json`); **charts via `savefig`** are Python/matplotlib-only.

### Unchanged (compose for free)
`marshal.ts` (result mapping), the `/tmp` read-back, file mounting (PR-2),
table parsing (PR-3), the chat route, SSE emitter/translator, store, render
component, wire schema, caps/timeout. None are language-specific.

## Error handling

- A `javascript` run that errors → non-zero exit / stderr, surfaced as a
  `runtime` error exactly like Python (the marshaller is language-agnostic).
- An unknown `language` value can't reach the client (the Zod enum rejects
  it at the route); `runtimeFor` still defaults to python defensively.
- Network OFF applies to the `node` image too (same `disableNetwork()`
  builder path) — no `npm install` in-sandbox; Node stdlib only.

## Testing

- **`runtimeFor` (pure):** python/javascript → correct `{image,cmd,flag}`;
  unknown/undefined → python mapping.
- **Tool input:** `language` enum accepted; invalid value rejected; absent
  → Python path (back-compat).
- **Manual smoke (microsandbox runtime):** `runCode` with
  `language:"javascript"`, `console.log(2+2)` → `4`; a Python run (no
  `language`) still works; a JS run that writes `/tmp/x.table.json`
  renders a data-grid; a JS run reading a mounted `/mnt/files/<name>`
  works.

## Scope / out

JavaScript language only. **Persistent warm sessions** (state across turns)
remain the optional PR-5. No TypeScript, no in-sandbox `npm install`
(network OFF; Node stdlib + built-ins only), no per-language result
special-casing, no matplotlib-equivalent charting for JS.

## Risks

- **`node` image availability** — spike-verified today; the image name
  `"node"` is what microsandbox served. If a future runtime renames it,
  `runtimeFor` is the single point to update (and it's env-overridable if
  we later want).
- **First JS run latency** — the `node` image is fetched on first use (like
  the `python` image was); a one-time cost, then cached in `~/.microsandbox/`.
- **`node -e` semantics** — inline eval; multi-statement programs are fine,
  but top-level `await`/ESM specifics differ from a file. Acceptable for
  v1 (single-cell exec); the prompt steers toward `console.log` output.

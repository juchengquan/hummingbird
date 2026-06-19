# Plan: Local segregated execution sandbox (microsandbox)

Status: **decided — locally validated (2026-06-16).** Runtime chosen:
**microsandbox**, run **locally** (co-located with the app, no managed
cloud), using **Hypervisor.framework (HVF)** on the Apple Silicon dev
machine. Backed by a deep-research sweep (2026-06-15: 25 sources → 21
claims confirmed via 3-vote adversarial verification) + a local capability
check **and microVM boot smoke tests (Python + Node SDKs)** (2026-06-16,
below). Resolves the "self-host" half of the open
question parked in [`PLAN-code-interpreter.md`](PLAN-code-interpreter.md)
§"Open questions before PR 1" #1. Scope: **M** (a local install + one
adapter backend + security posture; not a feature on its own).

Companion plans:
- [`PLAN-code-interpreter.md`](PLAN-code-interpreter.md) — the **consumer**.
  Defines the `CodeSandbox` adapter (`lib/server/code-sandbox/`) and the
  `CODE_SANDBOX_BASE_URL` / `CODE_SANDBOX_API_KEY` env path. This plan
  decides what runs behind it.
- [`PLAN-agent-api.md`](PLAN-agent-api.md) — the **host**. Relevant only
  *if* the sandbox ever leaves the local Apple-Silicon machine for a Linux
  server (see §Production caveat).

## Decision

**Run the sandbox locally with hardware-level segregation via microsandbox.**

- **"Local"** = same machine as the app, **not** a remote managed service
  (this rules out E2B hosted). On dev that's the Apple Silicon Mac; in
  production it's whichever host runs the app (see §Production caveat).
- **"Segregated"** = each run gets its **own Linux microVM with its own
  kernel** (via libkrun), so untrusted / AI-generated code cannot reach the
  host kernel or filesystem. This satisfies *both* readings of "segregated"
  — untrusted-code-safe **and** isolated-from-host.
- microsandbox is **Apache-2.0**, installs as a single binary + local
  daemon (JSON-RPC), **no Kubernetes**, no distributed stack — the right
  shape for a co-located local runtime.

### Why not the earlier gVisor pick

The first draft of this plan recommended **gVisor-under-Docker** — but that
was conditioned on a remote *Linux* host (the Hetzner CX22). gVisor is
**Linux-only**, so it is *not* a native option on macOS. For
local-on-Apple-Silicon, microsandbox is the correct strong-isolation choice
because **libkrun uses HVF on macOS/ARM64** directly. gVisor returns only as
the *Linux-production* fallback (see §Production caveat).

## Phase 0 — local capability check (✅ done, 2026-06-16)

Ran on the dev machine. HVF is available, so the microVM tier is reachable
locally with no nested-virtualization concern:

| Check | Result |
|---|---|
| OS / arch | macOS 26.3.1 (Darwin 25.3.0), **arm64** |
| Chip | Apple **M4 Pro** |
| `hw.optional.arm64` | `1` (Apple Silicon) |
| `kern.hv_support` | `1` (**Hypervisor.framework available**) |
| Docker | v29.5.2 present (container-tier fallback available locally) |

On macOS the relevant capability is **HVF**, not `/dev/kvm` (a Linux
concept — absent on macOS by design). `kern.hv_support = 1` is the green
light for libkrun / microsandbox.

## The landscape — three isolation tiers

For reference, the full open-source field the decision was drawn from. All
latency figures are **order-of-magnitude tier indicators, not benchmarks**
(they vary by method, hardware, and snapshot-restore vs cold boot).

### Tier 1 — MicroVM: strongest isolation (own kernel per sandbox) ← chosen

| Option | Mechanism | Boot | License | Local-Mac fit |
|---|---|---|---|---|
| **microsandbox** | per-sandbox microVM via **libkrun** (**HVF on macOS/ARM64**, KVM on Linux), single binary + JSON-RPC daemon, **no Kubernetes** | sub-100–320 ms (varies by method) | Apache-2.0 | ✅ **chosen — runs natively on the M4 Pro via HVF** |
| Firecracker | KVM microVM (the engine others build on) | ≤125 ms, ≤5 MiB VMM overhead | Apache-2.0 | ❌ KVM/Linux only |
| e2b | Firecracker + snapshot restore, dedicated kernel | ~150 ms | Apache-2.0 | ❌ managed/distributed stack; not local |

> Verified caveat: microsandbox's "under 100 ms average" claim was
> *refuted* (0-3 adversarial vote) — treat sub-200 ms as the honest figure.

### Tier 2 — Userspace kernel: medium isolation (Linux only)

| Option | Mechanism | Notes | License |
|---|---|---|---|
| **gVisor (`runsc`)** | Go "application kernel" intercepts syscalls; runs as a Docker runtime; default **Systrap** platform needs no `/dev/kvm` | Zero CPU-instruction cost; structural per-syscall penalty (getpid 62 ns → 830 ns). Ant Group ran 100K+ instances. **Linux-only** → not a native macOS option. | Apache-2.0 |
| nsjail | namespaces + cgroups + rlimits + seccomp-bpf | Lightweight, ~50 ms; weaker (no separate kernel); Linux-only | Apache-2.0 |

### Tier 3 — Container / library: weakest (shared host kernel)

| Option | Mechanism | Notes | License |
|---|---|---|---|
| **llm-sandbox** | wraps Docker / rootless Podman / Kubernetes | Runs locally via Docker's Linux VM. Shared kernel; security policies are advisory. **The local fallback if microVM isolation is overkill.** | MIT |
| Daytona | OCI/Docker shared-kernel containers | sub-90 ms, persistence; shared kernel; **AGPL-3.0** ⚠️ | AGPL-3.0 |
| ~~langchain-sandbox~~ | Pyodide (Python→WASM) in Deno | **Archived / deprecated 2026-01-14 — exclude.** | — |

## Production caveat — if this ever leaves the Mac

The decision is clean for **local/dev on Apple Silicon**. Moving the
sandbox onto a different host re-opens the hardware question, because
microsandbox needs hypervisor access on *that* host:

- **Apple Silicon, or a KVM-capable Linux box** (bare-metal / dedicated /
  NAS) → microsandbox still works (HVF or KVM respectively).
- **A non-KVM Linux VM** (e.g. Hetzner CX22 shared vCPU) → microsandbox
  **won't run**; fall back to **gVisor-under-Docker** (Linux, KVM-free via
  Systrap) or accept container-tier isolation (llm-sandbox).

This couples to [`PLAN-agent-api.md`](PLAN-agent-api.md) §Host decision. As
long as the sandbox stays local on the Mac — or the app is hosted on
Apple-Silicon / KVM-capable hardware — microsandbox is the single answer.

## Decisions to pin before code

1. **Runtime: microsandbox** (decided). gVisor reserved as the Linux
   fallback; llm-sandbox as the container-tier local fallback.
2. **Adapter boundary — reuse `CodeSandbox`.** The microsandbox client
   implements the interface from `PLAN-code-interpreter.md`
   (`lib/server/code-sandbox/types.ts`) and registers in `select-sandbox.ts`
   via `CODE_SANDBOX_BASE_URL = http://localhost:<port>`. No call-site
   changes; same pattern as the Minimax-CN custom base URL in
   `model-provider.ts`.
3. **Network egress: OFF in v1** (matches `PLAN-code-interpreter.md`
   §Open-questions #3) — pre-baked image with pandas/numpy/matplotlib; a
   per-workspace "allow network" flag later. Composes with the existing
   SSRF gate in `model-provider.ts`.
4. **License: clear.** microsandbox is Apache-2.0 — no AGPL obligation (the
   reason Daytona is only a fallback).

## Sequencing — phase series

1. **Phase 0 — local capability check. ✅ Done (2026-06-16):** HVF confirmed
   on the M4 Pro (table above). Recorded.
2. **Phase 1 — microsandbox install + adapter.**
   - **Validation gate ✅ done (2026-06-16) — both SDKs boot a microVM via
     HVF on the M4 Pro; neither needs a manually-started `msb server`:**
     - *Python* (`uv run --with microsandbox`, zero global install):
       `microsandbox.install()` fetched the runtime to `~/.microsandbox/`,
       `Sandbox.create("smoke", image="python", cpus=1, memory=512)` booted a
       microVM, ran a `print(...)`, returned stdout, stopped cleanly.
       (`Sandbox.create` signature `(name, **kwargs)`.)
     - *Node* (`npm i microsandbox` in a temp dir, Node v25) — the real TS
       code path:
       `Sandbox.builder("node-smoke").image("python").replace().cpus(1).memory(MiB(512)).create()`
       booted a microVM, `sandbox.exec("python3", ["-c", …])` returned the
       output with `exit code 0`, `sandbox.stop()` cleaned up. **Requires
       Node ≥ 22** (`await using` / `Symbol.asyncDispose`).
   - **Implement `lib/server/code-sandbox/microsandbox-client.ts`** against
     the `CodeSandbox` interface using the **Node** SDK (the Python SDK
     serves the later `services/agent-py` port). Verified API mapping onto
     `CodeSandbox.run({ code, language, timeoutMs, signal })`:
     - boot: `Sandbox.builder(name).image("python").replace().cpus(n).memory(MiB(m)).create()`
     - run + collect: `const r = await sb.exec("python3", ["-c", code])` →
       `r.stdout()` / `r.stderr()` / `r.code` map onto `CodeRunResult`.
     - timeout: `sb.execWith("python3", e => e.args([...]).timeout(timeoutMs))`.
     - network OFF: builder network policy → **airgapped** (the SDK default
       is "public-only"; v1 wants fully airgapped).
     - teardown: `await sb.stop()` in a `finally` (or `await using`).
     Enforce the wall-clock timeout + budget gate; wire through
     `select-sandbox.ts`.
   - **Rich outputs (charts/tables) — design delta from the E2B assumption.**
     microsandbox is **exec + filesystem**, *not* a Jupyter kernel, so it
     does not return rich MIME results the way `PLAN-code-interpreter.md`
     assumed for E2B's `code-interpreter` SDK. To produce a chart: have the
     run write the figure to the guest fs (e.g. `savefig('/tmp/out.png')`),
     then read it back via `sb.fs().read('/tmp/out.png')` and map to a
     `{ type: "image" }` `CodeResult`; table/text come from stdout. Fold this
     into the result-marshalling step (it's the main adapter delta vs E2B).
3. **Phase 2 — security posture.** Per-sandbox CPU/memory caps, ephemeral
   fs, no host mounts, explicit block of the metadata endpoint
   (`169.254.169.254`). The microVM kernel boundary already provides the
   host-kernel guarantee. Regression test: egress + host-fs access fail.
4. **Phase 3 — agent-service parity.** Port the microsandbox `CodeSandbox`
   selection into `services/agent-py` (+ `agent-ts`) once it settles inline
   (the way every skill landed inline then ported) — *if* the agent service
   runs on Apple-Silicon / KVM-capable hardware; otherwise it falls back per
   §Production caveat.
5. **Phase 4 (optional) — warm session reuse.** Persistent sandbox per
   conversation for notebook-style state. Mirrors `PLAN-code-interpreter.md`
   PR 4; defer until single-shot proves out.
   > **DEFERRED (2026-06-19).** microsandbox runs each cell as a one-shot
   > process (`python3 -c` / `node -e`), so a reused microVM persists the
   > **filesystem** but **not in-memory variables** — true notebook-style
   > state needs a long-lived in-guest REPL/kernel (research-grade,
   > unvalidated). Deferred for partial-value-vs-lifecycle-complexity +
   > unvalidated demand. Revisit if cross-turn state is requested.

## Tests

- **Phase-1 validation gate** — documented hello-world microVM boot + a
  `print(2+2)` run on the M4 Pro; no automated test (it's an install smoke).
- **Result marshalling** — pure mapper from microsandbox's raw output →
  `CodeResult[]` (image/table/text discrimination, stderr capture, stdout
  truncation). Reuses the `PLAN-code-interpreter.md` PR 1 test surface.
- **Isolation regression (Phase 2)** — inside the sandbox, attempts to
  (a) reach `169.254.169.254`, (b) read a host path, (c) exceed the memory
  cap all fail with the expected error code.
- **Selection gate** — absent local-sandbox config → adapter falls back per
  `select-sandbox.ts` (no crash).

## Open questions before Phase 1

1. ~~Does the host expose hardware virtualization?~~ **Resolved for local
   dev:** HVF present on the M4 Pro (Phase 0).
2. Realistic microsandbox **boot latency + steady-state CPU/memory
   overhead** on the M4 Pro for a Python cell — measure during the Phase 1
   validation gate (research figures are tier indicators only).
3. **Network egress + resource-limit** story (cgroup/rlimit, metadata
   block) once a per-workspace "allow network" flag is wanted.
4. **If/when this leaves the Mac:** the production host's KVM support, per
   §Production caveat.

## Reliability note

Isolation mechanisms and licenses were cross-checked against primary repos
(microsandbox, libkrun, gVisor, llm-sandbox, Daytona, langchain-sandbox).
**Comparative startup-latency figures were not** — they come from
vendor/aggregator blogs and are tier indicators only. Two claims were
adversarially refuted and excluded: microsandbox "under 100 ms average" and
an e2b "5–10 min session cap." The local capability check (Phase 0) is
first-hand, run on the dev machine 2026-06-16.

## Sources

Primary (verified against repo/docs):
- [microsandbox](https://github.com/superradcompany/microsandbox) + [libkrun](https://github.com/containers/libkrun) — microVM via HVF (macOS/ARM64) / KVM (Linux), single binary, Apache-2.0
- [gVisor performance guide](https://gvisor.dev/docs/architecture_guide/performance/) — Linux fallback: zero CPU cost, structural syscall cost
- [gVisor @ scale in Ant Group](https://gvisor.dev/blog/2021/12/02/running-gvisor-in-production-at-scale-in-ant/) — 100K+ instances
- [llm-sandbox](https://github.com/vndee/llm-sandbox) — container-tier local fallback (Docker/Podman/K8s)
- [Daytona](https://github.com/daytonaio/daytona) — AGPL-3.0, shared-kernel
- [Firecracker SPECIFICATION](https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md) — ≤125 ms / ≤5 MiB (KVM-only, not local-Mac)
- [langchain-sandbox](https://github.com/langchain-ai/langchain-sandbox) — archived 2026-01-14

Secondary / comparison (used for tier framing, not figures):
- [restyler/awesome-sandbox](https://github.com/restyler/awesome-sandbox)
- [Northflank: code-execution sandboxes for AI agents](https://northflank.com/blog/best-code-execution-sandbox-for-ai-agents)
- [Beam: E2B alternatives](https://www.beam.cloud/blog/best-e2b-alternatives)

# Sandbox Landscape Survey — Python Code Execution

Companion to `2026-06-15-code-interpreter-sandbox-design.md`. Captures
the full 22-project survey that produced the shortlist and
recommendation. Survey date: 2026-06-15. All GitHub data verified
against the live repo on the same day.

## Scope

- **Use case:** Python code execution for an agentic assistant
  (server-side, model-generated code).
- **Hard filters:** OSS license, self-hostable, single-Linux-VM
  deployable (Hetzner CX22 class, 4 GB RAM, 2 vCPU, no Kubernetes, no
  nested virt needed), active maintenance.
- **Capability envelope:** Python 3.12 with `pip install`, Jupyter
  session reuse preferred, 30s default timeout, network off in v1,
  per-session FS, mem/CPU/disk/pid caps, streaming stdout, embedded or
  sidecar process.

## License / correctness corrections to common assumptions

| Project | Common assumption | Actually is | Impact |
|---|---|---|---|
| **Judge0** | MIT | **GPL-3.0** | Network use is fine; static/dynamic link into a distributed binary is not. Sidestep by spawning Judge0 as an out-of-process service. |
| **nsjail** | MIT | **Apache-2.0** | Permissive. Fine. |
| **Open Interpreter (Python)** | The current "open interpreter" | The current GitHub `openinterpreter/openinterpreter` is a **Rust coding agent** (Apache-2.0), not a Python lib. The original AGPL Python project lives at `endolith/open-interpreter` — 8 stars, "vibe-coded mess" warning, last meaningful activity years ago. **Effectively abandoned. Don't depend.** |
| **Earthly** | Apache-2.0 build framework | **MPL-2.0** and the README itself says "Earthly is no longer actively maintained." v0.8.16 (Jul 2025) is 11 months stale. | Treat as feature-frozen. |
| **E2B** | OSS sandbox | Apache-2.0 **SDK** around a **closed-source** Firecracker backend. Self-host requires Terraform + cloud account; not single-VM. | Out of scope under strict-OSS + single-VM. |

## Per-project profiles (22 projects)

### 1. Daytona
- **Repo:** https://github.com/daytonaio/daytona
- **License:** AGPL-3.0 (control plane)
- **Latest:** v0.187.0 (Jun 11 2026) — 200+ releases, 72.4k stars
- **Architecture:** Full sandbox platform. NestJS control plane + Go
  "runner" + in-sandbox daemon. OCI/Docker-compatible containers,
  optionally VM-backed (Firecracker/Dragonball). SDKs in Python/TS/Ruby/Go/Java.
- **Isolation:** Container or microVM (per VMM backend)
- **Statefulness:** Yes — snapshot/persistence layer
- **Cold start:** Marketing <90ms; reality hundreds of ms to seconds
  on a single VM. Snapshot resume: near-instant.
- **Composes as a library?** No — it's a platform with a Python SDK
  over HTTP. Use it as a backend, not embedded in agent-py.
- **License worry:** AGPL-3.0. FSF says network-use triggers source
  disclosure on the *network-facing service* you run; wider consensus
  is more permissive. Talk to counsel.
- **Verdict:** Too heavy for a CX22 (it wants its own daemons,
  Postgres, Redis). Out of scope for the v1 sidecar model.

### 2. Pyodide
- **Repo:** https://github.com/pyodide/pyodide
- **License:** MPL-2.0
- **Latest:** 314.0.0 (Jun 9 2026) — date-style versioning tied to
  bundled CPython
- **Architecture:** CPython + stdlib + scientific stack compiled to
  WASM via Emscripten. Loads into a host process via JS↔Python FFI.
  **Embeddable as a library** — that's the whole point.
- **Isolation:** WASM sandbox; memory-safe; capability-based imports
  via WASI.
- **Python:** CPython 3.12 (3.13 in nightly). Bundles 100+ pre-built
  scientific packages (NumPy, pandas, scikit-learn, lxml, …).
- **Statefulness:** Yes — the interpreter is a persistent object.
  Re-import, re-load globals, run code. This *is* Jupyter session
  reuse, in-process.
- **Cold start:** Fresh interpreter 1–2s (WASM instantiation +
  interpreter init). Session resume: microseconds — just keep the
  interpreter alive.
- **Resource caps:** WASM linear memory (configurable up to 4 GiB
  wasm32, more wasm64). WASM is cooperative; interrupt via
  setTimeout or threads. Disk: tar-based in-memory FS, configurable.
- **Operational complexity:** A few MB of `.wasm` files served by
  FastAPI. `pip install pyodide` + load the wheel.
- **Weaknesses:** Not full CPython. `os.fork` doesn't exist; subprocess
  is limited; many C extensions aren't packaged (no `pip install
  torch`). Network is WASI sockets, not POSIX.
- **Verdict:** Best-in-class for *in-process* sandboxed Python without
  OS overhead. The constraint is "no real pip install from PyPI" — the
  user will hit that within 10 minutes of trying to use it.

### 3. Wasmtime
- **Repo:** https://github.com/bytecodealliance/wasmtime
- **License:** Apache-2.0
- **Latest:** v45.0.1 (Jun 5 2026) — 18.2k stars
- **Architecture:** Bytecode Alliance flagship WASM runtime. Rust
  crate, Cranelift JIT/AOT, WASI preview1+preview2. Language bindings
  for C/C++/Python/.NET/Go/Ruby. `wasmtime` on PyPI.
- **Isolation:** WASM; fuel (instruction counting), epoch interrupts,
  memory limits, table limits.
- **Python support:** None directly. Run CPython-on-WASM (i.e.,
  Pyodide) inside Wasmtime.
- **Verdict:** Substrate, not Python runtime. Doubles up with Pyodide
  if your goal is to run Python; use one or the other.

### 4. Wasmer
- **Repo:** https://github.com/wasmerio/wasmer
- **License:** MIT
- **Latest:** v7.1.0 (Mar 27 2026) — 20.8k stars
- **Architecture:** Rust WASM runtime like Wasmtime, plus the
  `wasmer.io` edge product, a package registry, and **WASIX** (POSIX-y
  extensions: sockets, threads, processes, fork).
- **Isolation:** WASM + WASIX (which muddies "secure sandbox" — same
  extensions that let you run `redis-server` inside WASM enlarge the
  syscall surface).
- **Verdict:** Substrate like Wasmtime. WASIX is interesting for
  running unmodified POSIX programs in WASM; less so for "run
  Python."

### 5. wazero
- **Repo:** https://github.com/tetratelabs/wazero
- **License:** Apache-2.0
- **Latest:** v1.12.0 (May 29 2026) — 6.2k stars
- **Architecture:** Pure-Go WASM runtime. Zero cgo. Interpreter +
  compiler. No fuel (epoch-based interrupt only). WASI preview1 only
  (preview2 lags Wasmtime).
- **Verdict:** Best if your host is Go. Awkward from Python.

### 6. WAMR (WebAssembly Micro Runtime)
- **Repo:** https://github.com/bytecodealliance/wasm-micro-runtime
- **License:** Apache-2.0 + LLVM exception
- **Latest:** 2.4.4 (Nov 24 2025) — 6k stars, **9 months stale at
  time of survey** (flag)
- **Architecture:** C library. Three modes: interpreter (~58 KiB),
  classic interpreter (~56 KiB), AOT runtime (~29 KiB). Multi-tier
  JIT. Optimized for embedded/IoT/SGX.
- **Verdict:** Smallest footprint, fastest cold start in interpreter
  mode (<1ms). Python integration story is weak.

### 7. Firecracker
- **Repo:** https://github.com/firecracker-microvm/firecracker
- **License:** Apache-2.0
- **Latest:** v1.16.0 (Jun 4 2026) — 34.9k stars
- **Architecture:** Rust VMM using Linux KVM. Single binary, REST API
  over Unix socket. "Jailer" wrapper applies cgroup + namespace +
  capability restrictions to the VMM process before exec.
- **Isolation:** Hardware-virtualized microVM. Each VM has its own
  kernel, separate netns, separate block devices. Host-kernel attack
  surface from the guest is minimal — Firecracker emulates ~5 devices
  vs ~30 in QEMU.
- **Cold start:** ~125–200ms (AWS marketing: 125ms; practical
  150–300ms). Python boot inside the VM adds 300–500ms.
- **Resource caps:** vCPUs, RAM, block I/O rate limiters, network
  bandwidth limiters.
- **Network:** TAP/net device per VM, configurable.
- **Filesystem:** virtio-block devices backed by file. Read-only
  rootfs + read-write overlay is the usual pattern.
- **Operational complexity:** Single binary, no daemon. **Requires
  KVM** (non-negotiable; Hetzner CX22 exposes `/dev/kvm`).
- **Strengths:** Gold standard for hard sandboxing. Production-hardened
  at Lambda / Fargate scale.
- **Weaknesses:** Per-VM overhead ~128–200 MiB. On a 4 GB CX22 you can
  fit 8–15 active Python sessions. Rootfs + kernel + snapshot
  management is days of work.
- **Verdict:** v2 "promote to microVM" escape hatch.

### 8. gVisor (runsc)
- **Repo:** https://github.com/google/gvisor
- **License:** Apache-2.0
- **Latest:** active, 18.5k stars
- **Architecture:** Go. User-space Linux syscall API ("application
  kernel"). Ships an OCI runtime called `runsc` that drops in as a
  Docker/containerd runtime. Every container syscall is intercepted
  in user-space and re-implemented.
- **Isolation:** Mid-tier — no separate kernel, but a much smaller
  attack surface than runc.
- **Cold start:** ~250–500ms per container.
- **Resource caps:** Standard cgroups through OCI.
- **Weaknesses:** Not 100% syscall coverage. Some apps (raw ptrace,
  exotic ioctls) fail. Python is fine; some C extensions with
  exotic syscalls can be flaky. ~10–30% syscall overhead.
- **Verdict:** Drop-in Docker runtime. Best for *test isolation* of
  the test suite itself; not the right primary sandbox for the
  interpreter (the syscall overhead hurts).

### 9. Kata Containers
- **Repo:** https://github.com/kata-containers/kata-containers
- **License:** Apache-2.0
- **Latest:** 3.31.0 (May 19 2026) — 8.1k stars, 1.5k open issues
- **Architecture:** Wraps QEMU, Firecracker, Cloud Hypervisor,
  Dragonball behind a single containerd / CRI-O runtime.
- **Isolation:** VM per container.
- **Cold start:** ~2s for QEMU, ~150–300ms for Firecracker/CH.
- **Verdict:** Useful if you want Docker workflow + VM isolation.
  Heavier than Firecracker-direct. 1.5k open issues is a yellow
  flag.

### 10. nsjail  ← **CHOSEN FOR V1**
- **Repo:** https://github.com/google/nsjail
- **License:** Apache-2.0
- **Latest:** 3.6 (Mar 18 2026) — 4k stars
- **Architecture:** Single C++ binary. Linux namespaces (mount, PID,
  UTS, IPC, NET, USER, CGROUP, TIME), cgroups (v1+v2), rlimits,
  seccomp-bpf with the **Kafel** policy DSL.
- **Isolation:** OS-level. Namespace + seccomp is strong; not
  VM-grade but in the "defense-in-depth good enough for adversarial
  code" category.
- **Cold start:** ~5–20ms per spawn.
- **Resource caps:** rlimit AS / CPU / fds; cgroup mem_max / pids_max
  / cpu_ms_per_sec.
- **Network:** Net namespace by default (no network), or MACVLAN, or
  `pasta` (rootless NAT).
- **Filesystem:** chroot or pivot_root, read-only bind mounts, tmpfs.
- **Operational complexity:** One binary + a protobuf config file.
- **Strengths:** The right tool for "run this Python process with no
  network, 512MB RAM, 30s timeout, kill it if it survives." Kafel DSL
  is much nicer than raw BPF. `pasta` mode is a clever rootless
  networking trick.
- **Weaknesses:** Not VM-grade. A kernel 0-day in the
  `clone()`/`seccomp` path compromises the host. No built-in "session
  reuse" — you wire it yourself (spawn nsjail once with a long-running
  subprocess and stream over stdio).
- **Verdict:** The right primary pick for v1. See
  `2026-06-15-code-interpreter-sandbox-design.md`.

### 11. Firejail
- **Repo:** https://github.com/netblue30/firejail
- **License:** GPL-2.0
- **Latest:** 0.9.80 (Mar 14 2026) — 7.5k stars
- **Architecture:** SUID-root binary. Wraps an app in namespace +
  seccomp + caps + Landlock. Ships 1342 application-specific profiles.
- **Weaknesses:** GPL-2.0 with SUID. Single-maintainer risk — security
  gaps have taken a long time to patch. Some namespaces restricted by
  kernel config on VPS providers.
- **Verdict:** Out — the SUID + GPL-2.0 + single-maintainer stack is
  too much risk for a primary sandbox.

### 12. Bubblewrap (bwrap)
- **Repo:** https://github.com/containers/bubblewrap
- **License:** LGPL-2.0 (SPDX tag is "Unknown" but conventionally
  LGPL-2.1+)
- **Latest:** 0.11.2 (Apr 23 2026) — 7.6k stars
- **Architecture:** Flatpak's underlying sandbox. C binary, **unprivileged**
  user namespaces (no SUID), configurable mount + seccomp.
- **Strengths:** No SUID = smaller sandbox-binary attack surface.
  Powers Flatpak.
- **Weaknesses:** No seccomp by default — you pass your own. "The
  level of protection between the sandboxed processes and the host
  system is entirely determined by the arguments passed to
  bubblewrap" (README). Unprivileged user namespaces sometimes
  disabled on hardened VPS providers.
- **Verdict:** Useful as a building block; doesn't replace nsjail
  because it doesn't enforce cgroup-level resource caps and the
  caller owns the entire seccomp policy.

### 13. isolate
- **Repo:** https://github.com/ioi/isolate
- **License:** Custom (GPL-compatible)
- **Latest:** rolling — single maintainer (Martin Mareš)
- **Architecture:** C program by the Codeforces contest authors.
  Namespaces + cgroups + rlimits. Companion daemon `isolate-cg-keeper`.
- **Strengths:** Purpose-built for "execute untrusted code with hard
  time/memory/disk limits and return a verdict." CPU-time vs wall-time
  is the right distinction.
- **Weaknesses:** Single-maintainer risk. No streaming — designed
  for "submit, wait, get verdict."
- **Verdict:** nsjail covers the same surface with a more active
  community. Keep as a runner-up if nsjail's maintenance ever stalls.

### 14. Judge0
- **Repo:** https://github.com/judge0/judge0
- **License:** **GPL-3.0**
- **Latest:** v1.13.1 (**Apr 2024 — 27 months stale at time of
  survey**)
- **Architecture:** Ruby on Rails app + Redis + Postgres. Workers use
  `isolate` as the sandbox. Supports 90+ languages. HTTP JSON API.
- **Weaknesses:** 27-month-old release — major abandonment red flag.
  No session reuse. CVE history (CVE-2024-28185/28189). GPL-3.0.
  Ruby in the stack.
- **Verdict:** Out — maintenance mode, GPL, and no session reuse.

### 15. Jupyter + jupyter_client + ipykernel  ← **CHOSEN FOR V1**
- **Repos:**
  - https://github.com/jupyter/jupyter_client (BSD-3, v8.9.1 Jun 9 2026)
  - https://github.com/ipython/ipykernel (BSD-3, v7.3.0 Jun 10 2026)
  - https://github.com/jupyter/notebook (BSD-3, v7.5.7 Jun 4 2026)
  - https://github.com/jupyterlite/jupyterlite (BSD-3, v0.7.6 May 7 2026)
  - https://github.com/jupyterhub/jupyterhub (BSD-3)
- **License:** BSD-3-Clause (all)
- **Architecture:** ZMQ-based JSON protocol (JEP). The kernel is a
  separate OS process that speaks the protocol. **No isolation at
  the protocol layer** — kernel runs with the privileges of the user
  that started it. Pair with nsjail for isolation.
- **Python:** CPython via ipykernel.
- **Statefulness:** **Yes — the canonical Jupyter model.** Variables,
  imports, definitions persist across `execute_request` messages.
- **Cold start:** ~1–3s for a fresh Python kernel.
- **Operational complexity:** `pip install jupyter_client ipykernel`
  + a kernel launcher. **The most natural fit for agent-py's
  "Jupyter-style session state" requirement.**
- **Composes as a library?** **Yes — `jupyter_client`'s
  `KernelManager` is a Python class you instantiate and call
  `client.execute("code")` on.** Run the kernel in-process or as a
  subprocess (we'll use a subprocess inside nsjail).
- **Verdict:** The right Python-side surface for v1. See
  `2026-06-15-code-interpreter-sandbox-design.md`.

### 16. RestrictedPython
- **Repo:** https://github.com/zopefoundation/RestrictedPython
- **License:** ZPL (GPL-compatible, Debian-permissive)
- **Latest:** rolling, recent
- **Architecture:** AST transformer + restricted builtins.
  `compile_restricted()` rejects `import os`, removes `eval`,
  `exec`, `getattr` per config.
- **Isolation:** **AST rewriting — the weakest tier of isolation.**
  Compiles the code; if compilation succeeds, the code runs in the
  same process.
- **Strengths:** Tiny, in-process, zero overhead. Right tool for "let
  users supply a small expression to compute on their data."
- **Weaknesses:** README is explicit: "not a sandbox system or a
  secured environment, but it helps to define a trusted environment."
  Many known escape paths (`().__class__.__bases__[0].__subclasses__()`).
- **Verdict:** Pair with nsjail as a fast first-pass filter for tiny
  expressions. Not a sandbox on its own.

### 17. Dagger
- **Repo:** https://github.com/dagger/dagger
- **License:** Apache-2.0
- **Latest:** v0.21.6 (Jun 11 2026) — 16k stars, 927 releases
- **Architecture:** Build automation engine. Go engine + generated
  Python/Go/TS SDKs. Runs everything in BuildKit containers.
- **Verdict:** Not a code-execution sandbox; it's a CI engine. You
  could abuse it but you'd be fighting the model.

### 18. Earthly
- **Repo:** https://github.com/earthly/earthly
- **License:** MPL-2.0
- **Latest:** v0.8.16 (Jul 16 2025) — **11 months stale, README
  says unmaintained**
- **Verdict:** Out — feature-frozen.

### 19. E2B
- **Repo:** https://github.com/e2b-dev/E2B
- **License:** Apache-2.0 SDK / **closed-source backend**
- **Latest:** @e2b/python-sdk 2.28.2 (Jun 12 2026) — 12.6k stars
- **Architecture:** SDK + Firecracker infra (closed). Self-host
  requires Terraform + AWS/GCP/Azure.
- **Verdict:** Out — closed backend, Terraform-only self-host, not
  single-VM. The original `PLAN-code-interpreter.md` named E2B; the
  design supersedes that.

### 20. MicroPython
- **Repo:** https://github.com/micropython/micropython
- **License:** MIT
- **Latest:** Apr 6 2026 — 21.8k stars
- **Architecture:** Lean Python 3 for microcontrollers. `unix` port
  runs as a normal Linux process; `webassembly` port runs in browser.
- **Verdict:** Not a sandbox. Subset of Python 3.4. No `pip install`.
  Out.

### 21. Open Interpreter (current Rust version)
- **Repo:** https://github.com/openinterpreter/openinterpreter
- **License:** Apache-2.0
- **Latest:** 64k stars, actively evolving
- **Architecture:** **A coding agent CLI, not a sandbox.** Native
  sandboxing on macOS (Seatbelt), Linux (Landlock/bubblewrap), Windows.
- **Verdict:** Different category. Not a library.

### 22. Codon
- **Repo:** https://github.com/exaloop/codon
- **License:** Apache-2.0
- **Latest:** v0.19.6 (Mar 4 2026) — 16.8k stars
- **Architecture:** AOT compiler from a Python subset to native code
  via LLVM. Re-implemented NumPy.
- **Verdict:** Not a sandbox — it's a compiler. 10–100× speedup over
  CPython for compute-heavy NumPy; could be paired with nsjail if
  numerical workload becomes a bottleneck. v2+ topic.

### Honourable mention: Landlock
- Not a project — Linux kernel LSM (since 5.13). Lets a process
  self-impose FS access restrictions via `prctl()` + a syscall.
- Composability: if you were writing a sandbox from scratch in
  Python, the `landlock` package on PyPI is a thin wrapper. nsjail
  already gives a more complete solution.

### Closed-source / not-OSS (mentioned for context, out of scope)
- **Modal, Runloop, Replit, CodeSandbox, StackBlitz** — all closed.
- **Riza** — closed.
- **Anthropic / OpenAI internal sandboxes** — not public.

## Comparison matrix

| Project | Identity & license | Latest release (2026-06-15) | Architecture | Isolation tier | Python | Statefulness | Cold start (fresh) | Cold start (resume) | Resource caps | Network | Filesystem | Operational complexity | Composable as lib? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Daytona** | AGPL-3.0 platform | v0.187.0 (Jun 11) | Container/VM sandbox platform + SDK | Container or microVM | CPython via image | Yes (snapshots) | ~hundreds of ms to seconds | near-instant via snapshot | per-sandbox | per-sandbox FW | per-sandbox volume | Heavy (full platform stack) | Yes (Python SDK over HTTP) |
| **Pyodide** | MPL-2.0 | 314.0.0 (Jun 9) | CPython→WASM, embedded lib | WASM sandbox | CPython 3.12/3.13 | Yes (interpreter object) | 1–2s | µs | WASM linear memory | WASI sockets (opt-in) | in-mem FS (MEMFS) or NODEFS | Low (a few MB of .wasm) | **Yes — by design** |
| **Open Interpreter (Rust)** | Apache-2.0 | rolling | Coding agent CLI, not a sandbox | OS-level per OS | subprocess | n/a (agent) | n/a | n/a | rlimits | per-OS | per-OS | Low (single binary) | No (CLI) |
| **Open Interpreter (Python, old)** | AGPL-3.0 | abandoned (2024) | Python lib w/ LLM | **None — `exec()` in-process** | CPython | Yes | µs | µs | None | full | full | n/a (don't use) | Yes (but dead) |
| **Judge0** | **GPL-3.0** | v1.13.1 (**Apr 2024 — 27 mo stale**) | Rails API + workers + Isolate | OS-level (Isolate) | Python (1 of 90+ langs) | No (one-shot) | ~100ms | n/a | isolate (mem/cpu/wall) | configurable | per-submission | Medium (Rails+Postgres+Redis) | No (HTTP service) |
| **Jupyter + jupyter_client** | BSD-3-Clause | v8.9.1 / v7.3.0 (Jun 9–10) | ZMQ protocol, kernel is OS process | **None at protocol layer** | CPython (ipykernel) | **Yes — canonical Jupyter model** | 1–3s | µs | rlimits (kernel sees host caps) | full | full | Low (`pip install`) | **Yes — perfect fit** |
| **RestrictedPython** | ZPL | rolling | AST transformer + safe_globals | **AST rewrite — weakest tier** | CPython 3.12 | Yes | µs | µs | None | none | none | Low (`pip install`) | Yes |
| **Firecracker** | Apache-2.0 | v1.16.0 (Jun 4) | KVM microVM + REST API | Hardware VM | N/A (rootfs) | per-VM (snapshot experimental) | ~125–200ms | ~50ms via snapshot restore | vCPUs/RAM/IO rate limiters | TAP/net | block devices (file-backed) | Medium (single binary + rootfs pipeline) | Yes (HTTP API; Rust SDK; firecracker-py) |
| **gVisor (runsc)** | Apache-2.0 | active | Application kernel in Go | user-space kernel (mid-tier) | N/A (container) | OCI containers | ~250–500ms | n/a | cgroups | OCI net | OCI FS layers | Low (single binary, drop-in OCI runtime) | No (OCI runtime) |
| **Kata Containers** | Apache-2.0 | 3.31.0 (May 19) | OCI runtime over VM | Hardware VM | N/A | OCI containers | ~150ms–2s | n/a | cgroups + VM config | OCI net | OCI FS | Medium-High | No (OCI runtime) |
| **Wasmtime** | Apache-2.0 | v45.0.1 (Jun 5) | Rust WASM runtime + WASI | WASM sandbox | via Pyodide-on-wasmtime | module-level | ~5–20ms | µs | fuel, epoch, mem | WASI sockets | WASI FS | Low (Rust crate + CLI; PyPI binding) | Yes (in Rust primarily) |
| **Wasmer** | MIT | v7.1.0 (Mar 27) | WASM runtime + WASIX | WASM (+ WASIX POSIX) | via wasmer/python pkg | module-level | ~5–20ms | µs | linear mem | WASIX sockets | WASIX FS | Low | Yes (in Rust) |
| **wazero** | Apache-2.0 | v1.12.0 (May 29) | Pure-Go WASM runtime | WASM | via Pyodide-on-wazero | module-level | ms range | µs | linear mem (no fuel) | WASI preview1 only | WASI preview1 FS | Low (Go) | Yes (in Go primarily) |
| **WAMR** | Apache-2.0 + LLVM exception | 2.4.4 (Nov 24, 2025) | C WASM runtime, interpreter/AOT/JIT | WASM | limited | module-level | <1ms interp | µs | linear mem | WASI sockets | WASI FS | Low (C embed) | Yes (in C; weak Python) |
| **nsjail** | **Apache-2.0** (not MIT) | 3.6 (Mar 18) | Single C++ binary, namespaces+cgroups+seccomp | OS-level (strong) | N/A (wraps any process) | per-spawn (subprocess stream for reuse) | ~5–20ms | n/a (subprocess) | rlimits + cgroups (mem/pids/cpu) | netns / MACVLAN / pasta | chroot / mount spec | Low (one binary + proto config) | Sort of (shell-out) |
| **Firejail** | GPL-2.0 | 0.9.80 (Mar 14) | SUID sandbox + profiles | OS-level | N/A | one-shot | ~10–30ms | n/a | rlimits | per-profile | per-profile | Low (one binary) | No (CLI; GPL barrier) |
| **bubblewrap** | LGPL-2.0 | 0.11.2 (Apr 23) | Flatpak's sandbox, unprivileged user ns | OS-level (user ns) | N/A | one-shot | ~5–15ms | n/a | rlimits (no cgroup) | netns | bind mounts / tmpfs | Low | No (CLI; LGPL barrier) |
| **isolate** | Custom (GPL-compatible) | rolling | Codeforces/Moe contest sandbox | OS-level (strong defaults) | N/A | one-shot | ~10–30ms | n/a | wall, CPU, mem, disk, pids (independent) | netns by default | chroot | Low (Debian pkg) | No (CLI) |
| **Dagger** | Apache-2.0 | v0.21.6 (Jun 11) | Build automation engine + SDK | container (BuildKit) | any container | content-cache | container ~100ms | n/a | container limits | OCI net | OCI FS | Med (engine + Docker + SDK) | Yes (Python SDK) |
| **Earthly** | MPL-2.0 | v0.8.16 (**Jul 16, 2025 — unmaintained**) | CI framework, Earthfile + BuildKit | container | any container | content-cache | BuildKit container | n/a | container limits | OCI net | OCI FS | Med (earthly daemon + buildkitd) | No (CI tool) |
| **E2B** | Apache-2.0 SDK / **closed backend** | @e2b/python-sdk 2.28.2 (Jun 12) | SDK + Firecracker infra (closed) | Firecracker | Python kernel | Yes (sessions) | ~200–400ms | µs | per-sandbox | per-sandbox | per-sandbox | **Heavy — Terraform + cloud account** | Yes (SDK) |
| **MicroPython** | MIT | Apr 6, 2026 | Lean Python 3, MCU + unix + WASM ports | None | Python 3.4 subset | Yes | <100ms | µs | rlimits | full | full | Low (build from source) | Embed C source / WASM build |
| **Codon** | Apache-2.0 | v0.19.6 (Mar 4) | Python-subset→native via LLVM | None (it's a compiler) | NumPy subset | n/a | compile time | n/a | n/a | full | full | Low (single binary) | No (compiler) |

## Threat-model recommendations

### Trusted code (developer running their own scripts)
**Primary: jupyter_client + ipykernel + nsjail.** Canonical Jupyter
session model via the `KernelManager` API. Wrap the kernel process in
nsjail with `--disable_clone_newnet` for v1 (no network), generous
resource caps, bind-mount the user's data. The kernel is a long-running
subprocess inside nsjail, you talk to it over ZMQ sockets, and stdout
streams over IOPub.

**Runner-up: Pyodide**, if the developer is willing to live within the
wheel constraints and you want zero per-session process overhead.

### Semi-trusted code (user's own data, model could be prompt-injected)
**Primary: nsjail + jupyter_client + ipykernel, hardened.** Same as
above with: `clone_newnet=true` (no network), Kafel seccomp policy,
RO bind-mount of user data with per-session RW overlay, 30s wall/25s
CPU, 512 MB mem, 256 pids.

**Runner-up: Firecracker for paranoid deployments.** ~200 ms cold
start, ~200 MB per session, snapshot the VM after each message.

### Untrusted / adversarial code (model reads hostile input and emits code)
**Primary: Firecracker.** Gold standard for hard sandboxing. ~125 ms
cold start, hardware-virtualized isolation, snapshot/restore for
resume. Budget ~200 MiB per session.

**Runner-up: gVisor (runsc) as a Docker runtime.** Drop-in: configure
Docker to use `runsc`. Lower overhead than Firecracker, but the threat
model is "the host kernel survives a `runsc` 0-day" rather than "the
host kernel survives a guest kernel compromise."

**Also worth considering: Pyodide**, in the narrow case where the
workload is pure-Python and doesn't need native C extensions.

**Do not use for this tier: RestrictedPython, Firejail, bubblewrap,
isolate as standalone.** They're all OS-level — they protect against
"the user wrote something dumb," not "the user wrote something
deliberately malicious." You could stack them inside a Firecracker VM
as defense-in-depth.

## Top picks for `agent-py`

The capability envelope (Python 3.12, arbitrary pip install,
Jupyter-style state, 30s timeout, network off, per-session FS,
resource caps, streaming output, embedded-or-sidecar) is met by the
**jupyter_client + nsjail** combination. Top pick.

### Pick 1: `jupyter_client` driving `ipykernel` inside `nsjail`
- The canonical Python library for driving a Jupyter kernel
  programmatically — `KernelManager().start_kernel()`, then
  `client.execute("import pandas as pd\ndf = pd.read_csv('/uploads/x.csv')")`.
- nsjail is the right Python-compatible OS sandbox — small, fast,
  Apache-2.0, actively maintained, supports cgroup v2 resource limits,
  has the Kafel seccomp DSL.
- Composes naturally: spawn `nsjail --config py.config.proto -- python3
  -m ipykernel -f /tmp/kernel.json`; agent-py consumes the connection
  file, opens ZMQ sockets, and talks Jupyter protocol.
- The capability envelope maps cleanly: session reuse = keep the
  kernel alive across messages; pip install = the kernel runs in a
  base image with PyPI access (or a pre-installed set); timeout =
  nsjail's `--time_limit`; resource caps = cgroup controls; FS =
  bind-mount per session; network = `--disable_clone_newnet` (or
  `clone_newnet=true` for v1).

**6–12 month outlook:** gaining momentum. jupyter_client 6-week
cadence, ipykernel actively developed, nsjail stable maintainer team.
Main risk: if Jupyter upstream deprecates ZMQ-protocol in favor of
Jupyter-Over-WebSocket, you'll have to migrate the client. Bounded
risk.

### Pick 2: Pyodide (embedded)
- Single Python in-process, no subprocess, no ZMQ, no nsjail, no
  Docker. Fastest possible cold start.
- `pip install` works for pure-Python wheels; Pyodide ships 100+
  pre-built packages for C extensions.
- Why not primary: no real `pip install numpy` from PyPI; many C
  extensions aren't packaged; no `os.fork`; limited `subprocess`;
  network requires WASI sockets.

### Pick 3: Firecracker
- Strongest isolation available on a single VM. VM-grade, not OS-grade.
- For deployments where you *cannot* tolerate "model-generated code
  reads /etc/shadow" or "pwns the agent-py user."
- Per-session overhead ~200 MiB. On a 4 GB CX22 you can sustain
  ~15 concurrent sessions. Cold start 150–300ms even with snapshot
  restore. Operational complexity: rootfs + kernel + snapshot
  management is days of work.

## Combination strategy (recommended)

- **v1 (now):** jupyter_client + nsjail. Ship the feature envelope.
  Use it for trusted and semi-trusted code.
- **v2 (if you ever process prompt-injected adversarial code at
  scale):** Add Firecracker as an opt-in per-session runtime. Same
  client code (the FastAPI layer); different backend.
- **Always available:** RestrictedPython for tiny expressions where
  spinning up a kernel is overkill.

## What would make Pick 1 wrong

1. **nsjail unprivileged user namespaces disabled on Hetzner.** Verify
   `kernel.unprivileged_userns_clone=1` on the target image. If 0,
   nsjail needs `CAP_SYS_ADMIN` — agent-py would need to start with
   that capability. Alternative: switch to `runsc` for the test
   container.

2. **ZMQ in a network namespace.** Jupyter's kernel uses ZMQ TCP
   sockets by default. Inside a nsjail netns, configure ZMQ to use
   `ipc://` over a unix socket. The chosen design (shared host netns)
   avoids this entirely.

3. **Jupyter protocol's implicit trust model.** Connection file
   contains an HMAC token. `0600` permissions; never world-readable.

4. **`ipykernel` does not enforce resource limits.** A
   `while True: pass` is killed by nsjail's `--time_limit`, not the
   kernel. Resource caps live at the nsjail layer.

5. **Python's syscall surface is wider than a tight seccomp policy
   can allow.** v1 ships a permissive Kafel policy. Tightening it is
   real work; track as v1.1.

## What would make Pick 2 wrong

1. **Customer-facing model emits `import torch`.** No Pyodide-built
   torch wheel. You ship your own or accept the gap.
2. **WASM linear memory grows unbounded.** A 4 GB list = 4 GB of
   agent-py RAM. Monitor and kill.
3. **pyodide-py wrapper bugs can crash your process.** Run Pyodide in
   a subprocess so a crash doesn't take down agent-py.

## What would make Pick 3 wrong

1. **Hetzner CX22 doesn't expose `/dev/kvm`.** Verify. Some
   lower-tier plans do, some don't.
2. **4 GB memory ceiling.** 8–15 concurrent sessions maxes out the
   host. 100+ concurrent → Firecracker fleet, not single VM.
3. **Snapshot/restore complexity.** Vsock IDs and clocks need careful
   handling. Days of engineering for 5s resume latency.

## Information that would change the recommendation

- **What threat model does the code face?** If the code is *only
  ever* the developer's own scripts, jupyter_client + plain
  `subprocess.run` (no nsjail) is enough.
- **What's the session-length distribution?** If most are 1-message
  one-shots, the Jupyter-kernel-stateful model is overkill; nsjail +
  `subprocess.run([python3, "-c", code])` is simpler.
- **What Python packages must work?** If the answer includes `torch`,
  `tensorflow`, `cuda-python`, Pyodide is out.
- **What's the concurrent-session count?** Sub-10: any of these work.
  10–100: nsjail + jupyter_client. 100+: Firecracker fleet.

## Operational worst case for each top pick

- **jupyter_client + nsjail:** nsjail has a Kafel policy evaluation
  bug that lets a process escape. Mitigation: pin nsjail to a
  known-good version; mirror their CVE feed into the dependency-update
  workflow. Recovery: agent-py restarts; lost session state recovered
  from the audit log.
- **Pyodide:** WASM JIT bug in the embedded engine crashes the host
  process. Mitigation: run Pyodide in a subprocess; the host respawns.
- **Firecracker:** misconfigured block device or network tap exposes
  the host. Mitigation: use the jailer; review the Firecracker
  production-host-setup guide before deploying.

## Source list (per-project)

- **Daytona** — https://github.com/daytonaio/daytona
- **Pyodide** — https://github.com/pyodide/pyodide
- **Open Interpreter (Rust, current)** — https://github.com/openinterpreter/openinterpreter
- **Open Interpreter (Python fork)** — https://github.com/endolith/open-interpreter
- **Judge0** — https://github.com/judge0/judge0
- **jupyter_client** — https://github.com/jupyter/jupyter_client
- **ipykernel** — https://github.com/ipython/ipykernel
- **Jupyter Notebook** — https://github.com/jupyter/notebook
- **JupyterLite** — https://github.com/jupyterlite/jupyterlite
- **JupyterHub** — https://github.com/jupyterhub/jupyterhub
- **RestrictedPython** — https://github.com/zopefoundation/RestrictedPython
- **Firecracker** — https://github.com/firecracker-microvm/firecracker
- **gVisor** — https://github.com/google/gvisor
- **Kata Containers** — https://github.com/kata-containers/kata-containers
- **Wasmtime** — https://github.com/bytecodealliance/wasmtime
- **Wasmer** — https://github.com/wasmerio/wasmer
- **wazero** — https://github.com/tetratelabs/wazero
- **WAMR** — https://github.com/bytecodealliance/wasm-micro-runtime
- **nsjail** — https://github.com/google/nsjail
- **Firejail** — https://github.com/netblue30/firejail
- **bubblewrap** — https://github.com/containers/bubblewrap
- **isolate** — https://github.com/ioi/isolate
- **Dagger** — https://github.com/dagger/dagger
- **Earthly** — https://github.com/earthly/earthly
- **E2B** — https://github.com/e2b-dev/E2B (README confirms closed-source backend, Terraform-based self-host)
- **MicroPython** — https://github.com/micropython/micropython
- **Codon** — https://github.com/exaloop/codon

### Additional context URLs

- **Firecracker "production host setup" guide** — https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md
- **nsjail Kafel DSL docs** — https://github.com/google/nsjail/tree/master/kafel
- **Pyodide deployment guide** — https://pyodide.org/en/stable/development/building-and-testing-packages.html
- **Jupyter protocol reference** — https://jupyter-client.readthedocs.io/en/stable/messaging.html
- **Landlock kernel docs** — https://www.kernel.org/doc/html/latest/userspace-api/landlock.html
- **Judge0 sandbox-escape writeups (CVE-2024-28185, CVE-2024-28189)** — GitHub Issues / Judge0 advisory
- **gVisor architecture** — https://gvisor.dev/docs/architecture/

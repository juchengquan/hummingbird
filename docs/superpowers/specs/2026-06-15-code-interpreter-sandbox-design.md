# Code Interpreter — Sandbox backend — Design

> ⚠️ **SUPERSEDED (2026-06-19)** by
> `docs/superpowers/specs/2026-06-19-code-interpreter-microsandbox-design.md`.
> The nsjail/agent-py approach below is Linux-only; the runtime decision
> changed to **microsandbox** (see `docs/PLAN-execution-sandbox.md`).
> Kept for history; do not implement.

Status: **approved design — ready for implementation plan.** Supersedes the
un-built portion of `docs/PLAN-code-interpreter.md` (which named E2B as the
default; E2B is closed-source and out of scope under the OSS-only
constraint this design accepts).

## Why

The repo's two planning-stage specs — `docs/PLAN-code-interpreter.md` and
`docs/MASTER_PLAN.md` line 84, 144 — call for a server-side Python code
interpreter. The original PLAN named E2B. A landscape survey of 22 OSS
code-execution sandbox projects (2026-06-15) ruled E2B out (closed
backend, Terraform-only self-host, not single-VM) and produced this
shortlist:

| | **Pick 1: jupyter_client + ipykernel + nsjail** | **Pick 2: Pyodide (embedded)** | **Pick 3: Firecracker (microVM)** |
|---|---|---|---|
| License | BSD-3 + Apache-2.0 | MPL-2.0 | Apache-2.0 |
| State (Jupyter session reuse) | ✓ | ✓ | per-VM snapshot |
| `pip install` anything from PyPI | ✓ | ⚠️ (pure-Python + pre-built Pyodide wheels only) | ✓ (in guest rootfs) |
| Isolation tier | namespace + seccomp + cgroup | WASM | KVM hardware VM |
| Cold start (fresh) | 1–3s | 1–2s | ~200ms + 300ms guest |
| Cold start (resume) | µs | µs | ~50ms (snapshot restore) |
| Per-session RAM | ~50–80 MB | ~50–200 MB | ~200 MB |
| Operational lift on a CX22 | `apt install nsjail` + `pip install` | `pip install pyodide` | rootfs + kernel + snapshots (days) |
| Threat model fit | trusted + semi-trusted | semi-trusted (small expressions) | untrusted / adversarial |

**Pick: Pick 1, with Pick 3 reserved as an opt-in v2 runtime for
adversarial workloads.**

## Non-goals (YAGNI)

- **No browser automation.** That's `docs/PLAN-browser-use.md` — separate
  spec, separate sandbox, reuses the *security model* of this design but
  not the code path.
- **No polyglot runtime.** Python only in v1. Adding JS/TS/Ruby would
  change the isolation story (Jupyter kernels exist for those, but the
  capability envelope was specified Python-only).
- **No network egress in v1.** The capability envelope in
  `PLAN-code-interpreter.md` says "network OFF in v1"; this design
  preserves that.
- **No GPU / CUDA.** v1 runs on the CX22's CPU only. CUDA pools are a v2
  topic if anyone hits the wall.
- **No streaming rich-media display (matplotlib inline).** IOPub supports
  it, but rendering `image/png` blobs in the chat surface is a frontend
  task, not a sandbox task. Output is text + a structured
  `execution_result` for now.
- **No TS-side surface in v1.** The skill is `agent-py` only. A Vercel
  route-handler surface (the original PLAN's `lib/server/code-sandbox/`
  design) is a v2 topic — it would call into the same `agent-py` skill
  over the same JWT-authenticated HTTP boundary the rest of the agent
  surface uses. Do not pre-build that abstraction.

## Top-level decision

The code interpreter is an **agent-py skill** (`runCode`), backed by a
`CodeSandbox` interface with a single v1 implementation:
`NsjailJupyterSandbox`. The interface is what enables v2 to swap in a
`FirecrackerSandbox` without touching call-sites.

```
LLM call: runCode({code, session_id, files?: [...]})
                |
                v
  +----------- agent-py /tools/code.py -----------+
  |                                                |
  |  1. Resolve session_id -> Session              |
  |     - SessionRegistry maps (user_id,           |
  |       session_id) -> NsjailJupyterSession      |
  |     - If absent: spawn nsjail + ipykernel      |
  |                                                |
  |  2. Upload any incoming files to the session   |
  |     scratch dir; rewrite the cell to read from |
  |     /work/uploads/                             |
  |                                                |
  |  3. jupyter_client.execute(code)               |
  |     - Stream IOPub (stdout/stderr)             |
  |     - Collect SHELL execute_result             |
  |                                                |
  |  4. Return { stdout, stderr, result,            |
  |             image_count, error? }              |
  |                                                |
  +------------------------------------------------+
```

Network boundary: per user decision, **kernel and agent-py share the
host network namespace**; the security boundary is the nsjail namespace
+ seccomp Kafel policy. ZMQ over TCP works out of the box; the simpler
wiring outweighs the marginal hardening of per-session netns in v1.

Session isolation: per user decision, **one nsjail per
`(user_id, session_id)`**. The jail stays alive for the conversation;
killed on conversation end or 30-min idle.

## Module layout

All new code lives under `services/agent-py/src/agent_py/`:

| Path | Purpose |
|---|---|
| `sandbox/__init__.py` | Re-exports `CodeSandbox`, `NsjailJupyterSandbox`, `SessionRegistry` |
| `sandbox/types.py` | `CodeSandbox` Protocol, `CodeRunRequest`, `CodeRunResult`, `CodeSandboxError` |
| `sandbox/nsjail.py` | `NsjailJupyterSandbox` — spawns nsjail + ipykernel, owns the `KernelManager` |
| `sandbox/sessions.py` | `SessionRegistry` — `(user_id, session_id)` -> `NsjailJupyterSession`, idle eviction, max-concurrency cap |
| `sandbox/proto/` | nsjail protobuf configs (one per risk profile) |
| `sandbox/kafel/` | Kafel seccomp policy text (committed, versioned) |
| `tools/code.py` | The `runCode` tool — agent-py's tool-calling entry point; thin wrapper around the sandbox |
| `tools/registry.py` | Register `runCode` in the default tool registry (alongside the existing six) |
| `tests/test_sandbox_*.py` | Unit + integration tests (see §Tests) |
| `scripts/agent-py-build-rootfs.sh` (later) | v2 Firecracker rootfs build — not in v1 scope |

A new top-level skill adapter in the `tools` module is the right shape
because every other agent-py tool (`webFetch`, `webSearch`,
`searchFiles`, `generateImage`, `askUser`, `renderUI`) follows the same
pattern in `services/agent-py/src/agent_py/tools/`. No need to invent a
new "skill" directory.

## The `CodeSandbox` interface

This is the v1 / v2 abstraction. The tool depends on the interface, not
on `NsjailJupyterSandbox` directly. Firecracker in v2 just writes a
second implementation.

```python
# services/agent-py/src/agent_py/sandbox/types.py
from typing import Protocol
from dataclasses import dataclass

@dataclass
class CodeRunRequest:
    user_id: str
    session_id: str
    code: str
    files: list[FileUpload] | None = None  # mounted into /work/uploads
    timeout_s: int = 30
    memory_mb: int = 512

@dataclass
class CodeRunResult:
    stdout: str
    stderr: str
    result: object | None          # last expression value, if any
    image_count: int = 0           # IOPub display_data with image/*
    duration_ms: int
    error: CodeSandboxError | None = None

class CodeSandboxError(Exception): ...

class CodeSandbox(Protocol):
    async def ensure_session(self, user_id: str, session_id: str) -> None: ...
    async def run(self, req: CodeRunRequest) -> CodeRunResult: ...
    async def close_session(self, user_id: str, session_id: str) -> None: ...
    async def close_all(self) -> None: ...
```

The two implementations diverge on `run()` and `ensure_session()`. They
share `close_all()` (used by FastAPI lifespan).

## `NsjailJupyterSandbox` — v1

```python
# services/agent-py/src/agent_py/sandbox/nsjail.py (sketch)
import os, json, tempfile, asyncio
from jupyter_client import KernelManager
from jupyter_client.manager import start_new_kernel
from .types import CodeSandbox, CodeRunRequest, CodeRunResult, CodeSandboxError

NSJAIL_BIN = "/usr/bin/nsjail"
KAFEL_POLICY = "/etc/agent-py/nsjail/sandbox.kafel"
ROOTFS_DIR  = "/var/lib/agent-py/sessions"

class NsjailSession:
    def __init__(self, user_id: str, session_id: str):
        self.user_id, self.session_id = user_id, session_id
        self.scratch = f"{ROOTFS_DIR}/{user_id}/{session_id}"
        self.kernel: KernelManager | None = None
        self.km, self.kc = None, None
        self.last_used = time.monotonic()

    def spawn(self):
        os.makedirs(self.scratch, exist_ok=True)
        os.makedirs(f"{self.scratch}/uploads", exist_ok=True)
        os.chmod(self.scratch, 0o700)

        # 1. write a unique connection file
        self.connection_file = f"{self.scratch}/kernel.json"
        # jupyter_client writes this on .start_kernel(); we just pick the path

        # 2. build the nsjail config from a proto template
        cfg = render_proto(
            template="sandbox.proto.tmpl",
            connection_file=self.connection_file,
            scratch=self.scratch,
            kafel=KAFEL_POLICY,
            mem_mb=512, pids_max=256, time_limit=30,
        )
        cfg_path = f"{self.scratch}/nsjail.cfg"
        with open(cfg_path, "w") as f: f.write(cfg)

        # 3. spawn nsjail -> ipykernel
        self.proc = await asyncio.create_subprocess_exec(
            NSJAIL_BIN, "--config", cfg_path, "--",
            "python3", "-m", "ipykernel",
            "-f", "/work/kernel.json",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )

        # 4. wait for the connection file to appear
        await wait_for_file(self.connection_file, timeout=10)

        # 5. attach the client
        from jupyter_client import BlockingKernelClient
        self.kc = BlockingKernelClient()
        self.kc.load_connection_file(self.connection_file)
        self.kc.start_channels()
        # jupyter_client.AsyncKernelManager would be the upgrade later

    async def run(self, req: CodeRunRequest) -> CodeRunResult:
        # 1. drop any uploaded files into scratch/uploads
        for f in req.files or []:
            write_uploaded(f, f"{self.scratch}/uploads/{f.name}")

        # 2. submit execute_request; jupyter_client returns a msg_id
        msg_id = self.kc.execute(req.code)

        # 3. stream IOPub until idle
        stdout, stderr, result, images, err = [], [], None, 0, None
        deadline = time.monotonic() + req.timeout_s
        while True:
            if time.monotonic() > deadline:
                self.proc.terminate()  # nsjail kills the kernel
                raise CodeSandboxError(f"timeout after {req.timeout_s}s")
            try:
                msg = self.kc.get_iopub_msg(timeout=0.5)
            except Empty:
                continue
            parent = msg["parent_header"].get("msg_id")
            if parent != msg_id: continue
            t = msg["header"]["msg_type"]
            c = msg["content"]
            if   t == "stream":      (stdout if c["name"]=="stdout" else stderr).append(c["text"])
            elif t == "execute_result": result = c["data"].get("text/plain")
            elif t == "display_data":
                if any(k.startswith("image/") for k in c["data"]): images += 1
            elif t == "error":       err = CodeSandboxError("\n".join(c["traceback"]))
            elif t == "status" and c["execution_state"] == "idle":
                break

        return CodeRunResult(
            stdout="".join(stdout), stderr="".join(stderr),
            result=result, image_count=images,
            duration_ms=int((time.monotonic()-start)*1000),
            error=err,
        )
```

The actual implementation uses `AsyncKernelManager` (or
`jupyter_client`'s asyncio support) and `structlog` for output, not the
sketch above — the sketch is to fix the shape.

## `SessionRegistry`

```python
# services/agent-py/src/agent_py/sandbox/sessions.py (sketch)
class SessionRegistry:
    def __init__(self, max_concurrent: int = 32, idle_minutes: int = 30):
        self._sessions: dict[tuple[str,str], NsjailSession] = {}
        self._max = max_concurrent
        self._idle_s = idle_minutes * 60

    async def get_or_create(self, user_id, session_id) -> NsjailSession:
        key = (user_id, session_id)
        s = self._sessions.get(key)
        if s is not None:
            s.last_used = time.monotonic()
            return s
        if len(self._sessions) >= self._max:
            await self._evict_oldest()
        s = NsjailJupyterSession(user_id, session_id)
        await s.spawn()
        self._sessions[key] = s
        return s

    async def _evict_oldest(self) -> None:
        oldest = min(self._sessions.values(), key=lambda s: s.last_used)
        await self.close(*oldest.key)

    async def close(self, user_id, session_id) -> None:
        s = self._sessions.pop((user_id, session_id), None)
        if s: await s.close()

    async def idle_reaper_loop(self) -> None:
        while True:
            await asyncio.sleep(60)
            now = time.monotonic()
            stale = [k for k,s in self._sessions.items()
                     if now - s.last_used > self._idle_s]
            for k in stale: await self.close(*k)
```

The reaper runs as a background `asyncio.Task` started in FastAPI
lifespan, same pattern as the existing `poller` task.

## nsjail config (the security boundary)

The committed `sandbox.proto` template (in `sandbox/proto/`) hard-codes
the policy. Sketch of the security-relevant fields:

```protobuf
# sandbox/proto/sandbox.proto.tmpl
name: "agent-py-code"
mode: ONCE
hostname: "sandbox"
cwd: "/work"
clone_newnet: false             # user decision: shared host netns
clone_newuser: true
clone_newns: true
clone_newpid: true
clone_newcgroup: true

uidmap { inside_id: "agent" outside_id: "<agent-py uid>" count: 1 }
gidmap { inside_id: "agent" outside_id: "<agent-py gid>" count: 1 }

mount {
  src: "<scratch>"   dst: "/work"   rw: true is_bind: true
}
mount { src: "/usr"      dst: "/usr"      ro: true is_bind: true }
mount { src: "/lib"      dst: "/lib"      ro: true is_bind: true }
mount { src: "/lib64"    dst: "/lib64"    ro: true is_bind: true }
mount { src: "/etc/ld.so.cache"  dst: "/etc/ld.so.cache"  ro: true is_bind: true }
mount { src: "/etc/ssl"          dst: "/etc/ssl"          ro: true is_bind: true }
mount { dst: "/tmp"   fstype: "tmpfs" rw: true }
mount { dst: "/proc"  fstype: "proc"  rw: false }
mount { dst: "/dev/null"  fstype: "none" rw: false }

rlimit_as: 536870912            # 512 MB
rlimit_nproc: 256
rlimit_fsize: 104857600         # 100 MB
rlimit_cpu: 25                  # CPU-time, not wall-time
time_limit: 30                  # wall-time, nsjail kills process group

cgroup_mem_max: 536870912
cgroup_pids_max: 256
cgroup_cpu_ms_per_sec: 100000   # 1 vCPU

kafel_policy_file: "<kafel path>"

exec_bin {
  path: "/usr/bin/python3"
  arg: "/usr/bin/python3"
  arg: "-m"
  arg: "ipykernel"
  arg: "-f"
  arg: "/work/kernel.json"
}
```

`kafel_policy_file` points to a committed Kafel policy under
`sandbox/kafel/sandbox.kafel`. The v1 Kafel policy has a **narrow
but explicit deny-list** for outbound network: it allows the
syscalls Python needs (file I/O, memory, threading, the ZMQ transport
the Jupyter kernel uses) but denies `socket(AF_INET, SOCK_STREAM, ...)`
and `socket(AF_INET6, SOCK_STREAM, ...)` to any non-loopback address
(verified by an integration test that calls
`socket.create_connection(("example.com", 80))` and asserts a
`PermissionError`). This is the v1 outbound block — without it,
`clone_newnet: false` would let the kernel reach the open internet.

A follow-up issue should track a tighter Kafel policy that audits
the rest of CPython's syscall surface (`strace -ff -e trace=all
python3 -c "<real workload>"` for the workload distribution).
v1's threat model is "the model is generating code, the user might
be prompt-injected," not "the user is actively trying to pwn the
host" — the latter is v2 Firecracker.

## `runCode` tool surface

```python
# services/agent-py/src/agent_py/tools/code.py (sketch)
from agent_py.sandbox import get_sandbox, CodeRunRequest, CodeSandboxError

class RunCodeTool:
    name = "runCode"
    description = "Execute Python in a sandboxed Jupyter session."
    input_schema = {
        "type": "object",
        "properties": {
            "session_id": {"type": "string", "description": "Reuse a session to keep state across calls."},
            "code":       {"type": "string", "description": "Python source."},
            "files":      {"type": "array", "items": {"type":"object", "properties":{
                              "name": {"type":"string"},
                              "content_b64": {"type":"string","description":"Base64 file bytes"},
                            }}},
        },
        "required": ["session_id", "code"],
    }
    ALWAYS_GATED = False  # approve-once per session, then trusted within that jail

    async def execute(self, args, context):
        req = CodeRunRequest(
            user_id=context.user_id,
            session_id=args["session_id"],
            code=args["code"],
            files=[FileUpload(**f) for f in args.get("files", [])],
        )
        sandbox = await get_sandbox()
        try:
            r = await sandbox.run(req)
        except CodeSandboxError as e:
            return {"error": str(e), "killed": True}
        return {
            "stdout":   r.stdout,
            "stderr":   r.stderr,
            "result":   r.result,
            "images":   r.image_count,
            "duration_ms": r.duration_ms,
        }
```

**Gating decision: `ALWAYS_GATED = False`.** The model gets
`runCode` once the user has approved it (per `requireApprovalFor` in
the checkpoint), then within the lifetime of an approved session,
subsequent `runCode` calls inside the same `session_id` flow without
prompting. This matches how a Jupyter notebook in ChatGPT/Claude.ai
behaves — the first cell triggers approval, then you're in.

If the user is uncomfortable with this, flip the flag in v1.1 — the
executor already has the per-tool approval gate wired.

## Resource limits and session lifecycle

| Knob | Value | Configurable per |
|---|---|---|
| Wall-time per `run` | 30s (default), max 300s | per call via `timeout_s` |
| CPU-time per `run` | 25s | nsjail config (rlimit) |
| Memory | 512 MB | nsjail config (cgroup) |
| Pids | 256 | nsjail config (cgroup) |
| Per-session scratch | 100 MB | janitor + nsjail rlimit |
| Concurrent sessions | 32 | `SessionRegistry(max_concurrent=…)` |
| Idle eviction | 30 min | `SessionRegistry(idle_minutes=…)` |
| Total on-disk session state | 10 GB | janitor (cron) |

All numbers are env-gated:
```
AGENT_PY_SANDBOX_MAX_CONCURRENT=32
AGENT_PY_SANDBOX_IDLE_MINUTES=30
AGENT_PY_SANDBOX_MEM_MB=512
AGENT_PY_SANDBOX_DISK_BUDGET_GB=10
AGENT_PY_SANDBOX_TIME_LIMIT_S=30
```

The CX22 has 4 GB. Worst case (32 sessions × 80 MB average) = 2.5 GB
for jail overhead; leaves 1.5 GB for agent-py itself, the poller, the
DB pool, and headroom. That's tight but workable. If a single user
holds 32 sessions simultaneously, expect OOM kills; the registry's
eviction should prevent that.

## Threat model and what's explicitly out of scope

**In scope (semi-trusted):**
- The model emits Python on behalf of a user.
- The Python may have been influenced by prompt-injected content
  (web pages, file uploads).
- A malicious payload should be unable to: read other users' data,
  escape the host kernel, consume unbounded resources, persist across
  sessions.
- It MAY be able to: spam the host's log, fill its own scratch
  (bounded), DoS itself (bounded by the 30s kill).

**Out of scope (v1):**
- Adversarial code written by a human attacker (not the model) — the
  v2 Firecracker path addresses this.
- GPU / CUDA workloads.
- Network egress.
- Polyglot.

If a future deployment needs to handle genuinely untrusted / hostile
code at scale, **swap the `NsjailJupyterSandbox` implementation for a
`FirecrackerSandbox`** (see v2 §). The tool surface and the
`SessionRegistry` do not change.

## v2: Firecracker escape hatch (sketch only)

Same `CodeSandbox` Protocol. Different implementation:

```
FirecrackerSandbox
  +-- builds a rootfs (Alpine + CPython + your deps) on first run
  +-- maintains a pool of warm microVMs (snapshot-restored)
  +-- each VM runs the same ipykernel, but over vsock
  +-- vsock -> host agent-py proxy -> FastAPI
```

Operational cost: 1–2 weeks of work to get a clean rootfs build,
snapshot pipeline, and a pool manager. Per-session RAM: ~200 MB. On a
CX22 that's a max of 8–15 concurrent sessions, not 32.

The choice between v1 (nsjail) and v2 (Firecracker) is **per session**
— the `CodeSandbox` interface hides the implementation. A future flag
(`AGENT_PY_SANDBOX_BACKEND=nsjail|firecracker|hybrid`) picks the
default; a per-tool-call override (`sandbox: "firecracker"`) lets the
tool ask for the paranoia upgrade on a specific call.

## Tests

The `bun run check:agent-py` job (ruff + mypy + pytest) must cover:

1. **`test_sandbox_types.py`** — Protocol surface, dataclass shape.
2. **`test_sandbox_nsjail_spawn.py`** — spawn, find connection file,
   `is_alive()` works.
3. **`test_sandbox_nsjail_run.py`** — `run("print('hi')")` returns
   `stdout="hi\n"`, `result=None`, no error. `run("1+1")` returns
   `result="2"`. `run("import sys; raise SystemExit")` returns
   `error` populated, jail stays alive.
4. **`test_sandbox_session_reuse.py`** — `x = 1;` then `x` returns `1`.
   The second `run()` is sub-second.
5. **`test_sandbox_resource_caps.py`** — `while True: pass` is killed
   at 30s; `x = " " * (2**30)` is OOM-killed.
6. **`test_sandbox_network_isolated.py`** — `import socket;
   socket.create_connection(("example.com", 80))` raises a
   socket-error-like exception (seccomp Kafel blocks it).
7. **`test_sandbox_idle_eviction.py`** — `last_used` older than the
   threshold reaps the session; the next `run()` re-spawns.
8. **`test_sandbox_max_concurrent.py`** — exceeding the cap evicts
   the LRU session.
9. **`test_sandbox_fs_isolation.py`** — the jail cannot read
   `/etc/shadow` or another user's session dir; the user CAN read
   `/work` and `/work/uploads`.
10. **`test_tool_code.py`** — tool input schema, gating decision,
    wiring into the default tool registry.
11. **A regression-guard test** in the spirit of
    `components/live-artifact/sandbox-guard.test.ts` — pin the
    nsjail proto's `clone_newnet: false`, the `cgroup_mem_max: 512`,
    the `time_limit: 30`, and the Kafel policy file path, so a careless
    edit to the template can't silently weaken the sandbox.

Tests run inside a Docker container with `--runtime=runsc` (gVisor) for
test isolation, so a flaky test can't compromise the host. This is the
existing test pattern in `services/agent-py/Dockerfile` (which already
sets up gVisor for CI per the repo's CI config — verify with
`docker/Dockerfile` before relying on it).

## Risks and unknowns

1. **nsjail unprivileged user namespaces on the target VM.** Verify
   `kernel.unprivileged_userns_clone=1` on the Hetzner image
   (`sysctl kernel.unprivileged_userns_clone`). If 0, nsjail needs
   `CAP_SYS_ADMIN` — agent-py would need to start with that capability.
   Fallback: switch to `runsc` (gVisor) and run the agent-py tests in
   a `runsc`-backed container; defer the CX22 nsjail install until
   confirmed.
2. **The Python syscall surface is wider than a tight seccomp policy
   can comfortably allow.** v1 ships a permissive Kafel policy.
   Auditing a tight one (run `strace -ff -e trace=all python3 -c
   "<real workload>"` for the actual workload distribution) is a v1.1
   task; track it as a follow-up issue.
3. **The Jupyter protocol's implicit trust model.** Anyone with the
   connection file can execute code. Set `0600` on it; pass it via
   bind-mount, not a world-readable dir.
4. **`ipykernel` does not enforce resource limits.** A `while True:
   pass` is killed by nsjail's `--time_limit`, not by the kernel.
   The resource caps live at the nsjail layer, never trust the kernel
   to enforce them.
5. **CX22 RAM budget.** 32 concurrent sessions × 80 MB average =
   2.5 GB. That's the upper bound. Set `AGENT_PY_SANDBOX_MAX_CONCURRENT=16`
   on a 4 GB VM unless you can prove the average per-session footprint
   is smaller. Add the env var to `.env.example` with that default.
6. **Kafel policies in production.** A bug in a Kafel policy can either
   over-block (legitimate code fails) or under-block (sandbox is
   leaky). The default policy is conservative-permissive; tighten in
   v1.1 only with real-world test coverage.

## Sources

Surveyed 2026-06-15; per-project verification against GitHub:

- **nsjail** — https://github.com/google/nsjail (Apache-2.0, v3.6 Mar 2026)
- **jupyter_client** — https://github.com/jupyter/jupyter_client (BSD-3, v8.9.1 Jun 9 2026)
- **ipykernel** — https://github.com/ipython/ipykernel (BSD-3, v7.3.0 Jun 10 2026)
- **Pyodide** — https://github.com/pyodide/pyodide (MPL-2.0, 314.0.0 Jun 9 2026) — runner-up only
- **Firecracker** — https://github.com/firecracker-microvm/firecracker (Apache-2.0, v1.16.0 Jun 4 2026) — v2 only
- **gVisor** — https://github.com/google/gvisor (Apache-2.0, active) — for test isolation
- **nsjail Kafel DSL** — https://github.com/google/nsjail/tree/master/kafel
- **Jupyter protocol** — https://jupyter-client.readthedocs.io/en/stable/messaging.html
- **Jupyter security model** — https://jupyter-notebook.readthedocs.io/en/stable/security.html

The full 22-project landscape (with Closed source / BSL / abandoned
projects also profiled for the record) is preserved in
`docs/superpowers/specs/2026-06-15-sandbox-landscape-survey.md` —
refer to it if any of the constraints above change (license,
self-host-on-CX22, etc.) and a re-survey is needed.

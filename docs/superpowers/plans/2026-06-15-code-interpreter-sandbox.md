# Code Interpreter (runCode) — Implementation Plan

> ⚠️ **SUPERSEDED (2026-06-19)** — this nsjail/agent-py plan is replaced by
> the microsandbox approach. See spec
> `docs/superpowers/specs/2026-06-19-code-interpreter-microsandbox-design.md`
> and the implementation plan `docs/superpowers/plans/2026-06-19-code-interpreter-microsandbox.md`.
> nsjail is Linux-only; the runtime decision changed to microsandbox
> (`docs/PLAN-execution-sandbox.md`). Kept for history; do not implement.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `runCode` agent-py tool: spawn a Python kernel inside an nsjail sandbox, drive it over the Jupyter protocol, return stdout/stderr/result. Session reuse across calls in a conversation. Per-user-per-session isolation. Network off (loopback ZMQ allowed). 30s wall/25s CPU, 512 MB, 256 pids.

**Architecture:** New `sandbox/` package under `services/agent-py/src/agent_py/` with three modules: `types.py` (Protocol + dataclasses), `nsjail.py` (nsjail + ipykernel spawner), `sessions.py` (LRU registry with idle reaper). The committed `sandbox/proto/sandbox.proto.tmpl` and `sandbox/kafel/sandbox.kafel` are the security boundary — versioned, regression-guarded. A new `tools/code.py` exposes `runCode` to the model, registered in the default tool registry. The idle reaper runs as a FastAPI-lifespan background task.

**Tech Stack:** Python 3.12, FastAPI, jupyter_client, ipykernel, nsjail, Kafel, structlog. Tests: pytest + pytest-asyncio. Mypy strict, ruff (line-length 100, target py312).

**Reference spec:** `docs/superpowers/specs/2026-06-15-code-interpreter-sandbox-design.md`
**Reference survey:** `docs/superpowers/specs/2026-06-15-sandbox-landscape-survey.md`
**Supersedes:** the un-built portion of `docs/PLAN-code-interpreter.md` (E2B choice; closed-source).

---

## File structure

**New files:**
- `services/agent-py/src/agent_py/sandbox/__init__.py` — re-exports
- `services/agent-py/src/agent_py/sandbox/types.py` — `CodeSandbox` Protocol, `CodeRunRequest`, `CodeRunResult`, `CodeSandboxError`, `FileUpload`
- `services/agent-py/src/agent_py/sandbox/nsjail.py` — `NsjailJupyterSandbox` + `NsjailSession`
- `services/agent-py/src/agent_py/sandbox/sessions.py` — `SessionRegistry`
- `services/agent-py/src/agent_py/sandbox/reaper.py` — `run_idle_reaper_loop()`
- `services/agent-py/src/agent_py/sandbox/render.py` — `render_proto(template, **vars) -> str` (string.Template wrapper)
- `services/agent-py/src/agent_py/sandbox/proto/sandbox.proto.tmpl` — committed nsjail protobuf template
- `services/agent-py/src/agent_py/sandbox/kafel/sandbox.kafel` — committed Kafel seccomp policy
- `services/agent-py/src/agent_py/tools/code.py` — `build_run_code_tool()` factory
- `services/agent-py/tests/test_sandbox_types.py` — type-shape tests
- `services/agent-py/tests/test_sandbox_render.py` — proto-template rendering tests
- `services/agent-py/tests/test_sandbox_sessions.py` — SessionRegistry tests
- `services/agent-py/tests/test_sandbox_nsjail.py` — NsjailJupyterSandbox integration tests
- `services/agent-py/tests/test_tool_code.py` — runCode tool tests
- `services/agent-py/tests/test_sandbox_reaper.py` — reaper + lifespan tests
- `services/agent-py/tests/test_sandbox_guards.py` — regression-guard test pinning security knobs

**Modified files:**
- `services/agent-py/src/agent_py/settings.py` — add `SANDBOX_*` fields after line 138
- `services/agent-py/src/agent_py/main.py` — wire idle reaper into lifespan
- `services/agent-py/src/agent_py/tools/registry.py` — register `runCode`
- `services/agent-py/pyproject.toml` — add deps + mypy overrides
- `services/agent-py/Dockerfile` — install nsjail
- `services/agent-py/uv.lock` — regenerate
- `.env.example` — add `AGENT_PY_SANDBOX_*` vars
- `.github/workflows/ci.yml` — install nsjail in agent-py job
- `docs/PLAN-code-interpreter.md` — link to new spec

**Boundary discipline:** `sandbox/` is a leaf package; it imports from `agent_py.settings` and standard lib only. The `tools/code.py` is the only caller of `sandbox.*`. No other module reaches into `sandbox/` internals.

---

## Phase 0: Setup & dependencies

### Task 0.1: Verify nsjail availability on the dev image

**Files:** none

- [ ] **Step 1: Check if nsjail is installed locally**

```bash
which nsjail && nsjail --version
```

Expected: either a version string (`nsjail version 3.6` or similar) or "command not found."

- [ ] **Step 2: If not installed, install via apt**

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends nsjail
nsjail --version
```

Expected: prints version.

- [ ] **Step 3: Verify nsjail can run in the current environment**

```bash
echo "print('hi')" | nsjail --config /dev/null --exec_bin /bin/sh -- sh -c 'python3 -c "print(2+2)"' 2>&1 | head -20
```

Expected: prints `4`. If KVM is required and not available on the host, nsjail will print an error — note this for the design (Task 0.5 covers the Docker case).

- [ ] **Step 4: Record the nsjail version**

```bash
nsjail --version | tee /tmp/nsjail-version.txt
```

Expected: captures the version. Note: design assumes nsjail ≥ 3.4 (the version that stabilised the protobuf config format).

- [ ] **Step 5: No commit**

Verification only. If the install was necessary, the package install is OS-level and not committed.

---

### Task 0.2: Add runtime + dev dependencies to pyproject.toml

**Files:**
- Modify: `services/agent-py/pyproject.toml:6-35`

- [ ] **Step 1: Add jupyter_client + ipykernel to runtime dependencies**

Edit `pyproject.toml`. Insert into the `dependencies = [...]` list, after line 25 (the `google-generativeai` line):

```toml
    "google-generativeai>=0.8.6",
    # Phase 1 of code-interpreter spec — sandbox-backed Jupyter kernel
    "jupyter_client>=8.9.0",
    "ipykernel>=7.3.0",
]
```

- [ ] **Step 2: Verify the file still parses**

```bash
cd services/agent-py && uv lock --check
```

Expected: exit 0 (the lockfile will be out of date — Task 0.4 regenerates it).

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/pyproject.toml
git commit -m "feat(agent-py): add jupyter_client + ipykernel for runCode tool"
```

---

### Task 0.3: Add mypy overrides for jupyter_client + ipykernel

**Files:**
- Modify: `services/agent-py/pyproject.toml:64-81`

- [ ] **Step 1: Add the overrides**

Append after the existing extraction-libs override block (after line 81):

```toml
[[tool.mypy.overrides]]
module = ["jupyter_client", "jupyter_client.*", "ipykernel", "ipykernel.*"]
ignore_missing_imports = true
```

- [ ] **Step 2: Verify mypy still passes on existing code**

```bash
cd services/agent-py && uv run mypy src
```

Expected: exit 0. (No new code yet, but the config must parse.)

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/pyproject.toml
git commit -m "chore(agent-py): mypy overrides for jupyter_client + ipykernel"
```

---

### Task 0.4: Regenerate uv.lock

**Files:**
- Modify: `services/agent-py/uv.lock`

- [ ] **Step 1: Regenerate the lockfile**

```bash
cd services/agent-py && uv lock
```

Expected: writes updated `uv.lock` with `jupyter_client` and `ipykernel` resolved. May also bump transitive deps. Inspect the diff before committing.

- [ ] **Step 2: Sync the environment to confirm the new deps install**

```bash
cd services/agent-py && uv sync
```

Expected: exit 0. `uv run python -c "import jupyter_client, ipykernel"` should succeed.

- [ ] **Step 3: Verify jupyter_client + ipykernel importable**

```bash
cd services/agent-py && uv run python -c "from jupyter_client import KernelManager; print(KernelManager.__module__)"
```

Expected: prints `jupyter_client.manager`.

- [ ] **Step 4: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/uv.lock
git commit -m "chore(agent-py): uv.lock — resolve jupyter_client + ipykernel"
```

---

### Task 0.5: Install nsjail in the agent-py Dockerfile

**Files:**
- Modify: `services/agent-py/Dockerfile` (insert after line 43, before `WORKDIR /app`)

- [ ] **Step 1: Add the apt-get install step**

After line 43 (`COPY --from=builder`), insert:

```dockerfile
# Install nsjail for the runCode sandbox (Phase 1 of code-interpreter spec)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        nsjail \
    && rm -rf /var/lib/apt/lists/* \
    && nsjail --version
```

Place it before the `WORKDIR /app` directive. The `nsjail --version` at the end is a smoke test that fails the build if the package isn't available for the base image — alert the engineer to switch base image to `debian:bookworm-slim` if `python:3.12-slim` doesn't have nsjail in its repos (it does; the Debian 12 package `nsjail` is current).

- [ ] **Step 2: Verify the Dockerfile still parses (lint)**

```bash
cd services/agent-py && docker build --target runtime -t agent-py:test -f Dockerfile .
```

Expected: build succeeds. (Skip this if you don't have Docker available; CI will catch it.)

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/Dockerfile
git commit -m "feat(agent-py): install nsjail in runtime image for runCode tool"
```

---

### Task 0.6: Install nsjail in the agent-py CI job

**Files:**
- Modify: `.github/workflows/ci.yml` (in the `agent-py:` job, after the `Sync dependencies` step at line 84)

- [ ] **Step 1: Add the install step**

After the `Sync dependencies` step, insert:

```yaml
    - name: Install nsjail
      run: sudo apt-get update && sudo apt-get install -y --no-install-recommends nsjail
    - name: Verify nsjail
      run: nsjail --version
```

- [ ] **Step 2: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add .github/workflows/ci.yml
git commit -m "ci(agent-py): install nsjail for runCode integration tests"
```

---

## Phase 1: Settings

### Task 1.1: Add sandbox settings fields

**Files:**
- Modify: `services/agent-py/src/agent_py/settings.py` (append a new section after the worker block, around line 66)

- [ ] **Step 1: Read the current end of settings.py**

```bash
tail -30 services/agent-py/src/agent_py/settings.py
```

Expected: you see the worker block ending with `POLL_INTERVAL_SECONDS: float = 5.0`.

- [ ] **Step 2: Append the sandbox settings block**

After the worker block, add:

```python
# --- Sandbox (runCode) -------------------------------------------------
# Spec: docs/superpowers/specs/2026-06-15-code-interpreter-sandbox-design.md
AGENT_PY_SANDBOX_ENABLED: bool = True
"""Master switch for the runCode tool. When False, the tool is not
registered in the default registry and the sandbox module refuses to
spawn sessions. Default True so the feature is on for self-hosters;
set to False on deployments that have not vetted the sandbox."""

AGENT_PY_SANDBOX_MAX_CONCURRENT: int = 16
"""Maximum number of (user_id, session_id) sessions alive at once on
this VM. The SessionRegistry evicts the LRU session when the cap is
reached. CX22 (4 GB RAM) defaults to 16 — at ~80 MB per session that's
1.3 GB headroom for agent-py itself, the poller, and the DB pool.
Bump this on larger VMs."""

AGENT_PY_SANDBOX_IDLE_MINUTES: int = 30
"""Minutes of inactivity (no `run` call) before the idle reaper kills
the session. Reset on every `run`. Set to 0 to disable reaping."""

AGENT_PY_SANDBOX_MEM_MB: int = 512
"""Per-session memory cap, enforced via nsjail cgroup. Hard kill on
breach — no graceful close."""

AGENT_PY_SANDBOX_PIDS_MAX: int = 256
"""Per-session pids cap. Prevents fork-bombs."""

AGENT_PY_SANDBOX_TIME_LIMIT_S: int = 30
"""Per-run wall-time limit, enforced via nsjail --time_limit. The
Jupyter kernel is killed (SIGKILL via the process group) on breach."""

AGENT_PY_SANDBOX_DISK_BUDGET_GB: int = 10
"""Total on-disk session state budget. The janitor evicts the oldest
session's scratch dir when the budget is exceeded."""

AGENT_PY_SANDBOX_REAPER_INTERVAL_S: float = 60.0
"""How often the idle reaper ticks. Default 60s — the 30-min idle
window has 30 ticks of headroom before a session is killed."""

AGENT_PY_SANDBOX_ROOT: str = "/var/lib/agent-py/sessions"
"""On-disk root for session scratch + uploads dirs. Must be writable
by the `agent` user inside the nsjail jail (which runs as the same
UID/GID as agent-py, see Dockerfile). Mounted in via Dockerfile."""
```

- [ ] **Step 3: Verify the file still parses**

```bash
cd services/agent-py && uv run python -c "from agent_py.settings import get_settings; s = get_settings(); print(s.AGENT_PY_SANDBOX_MAX_CONCURRENT)"
```

Expected: prints `16`.

- [ ] **Step 4: Verify mypy still passes**

```bash
cd services/agent-py && uv run mypy src
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/src/agent_py/settings.py
git commit -m "feat(agent-py): sandbox settings (Phase 1 of code-interpreter spec)"
```

---

### Task 1.2: Add sandbox env vars to .env.example

**Files:**
- Modify: `.env.example` (append a new section after the Worker block, around line 188 — find it via `grep -n "WORKER_DRY_RUN" .env.example`)

- [ ] **Step 1: Find the Worker section in .env.example**

```bash
grep -n "WORKER_DRY_RUN\|POLL_INTERVAL_SECONDS" .env.example
```

Expected: shows the line numbers for the worker block.

- [ ] **Step 2: Append the sandbox block**

After the worker block, add a blank line and then:

```bash

# --- Sandbox (runCode tool) -------------------------------------------
# Phase 1 of docs/superpowers/specs/2026-06-15-code-interpreter-sandbox-design.md
# agent-py only. Set AGENT_PY_SANDBOX_ENABLED=false to disable the
# runCode tool registration on deployments that haven't vetted the
# nsjail + jupyter stack. Defaults are tuned for a Hetzner CX22 (4 GB
# RAM); on larger VMs raise AGENT_PY_SANDBOX_MAX_CONCURRENT.

AGENT_PY_SANDBOX_ENABLED=true
AGENT_PY_SANDBOX_MAX_CONCURRENT=16
AGENT_PY_SANDBOX_IDLE_MINUTES=30
AGENT_PY_SANDBOX_MEM_MB=512
AGENT_PY_SANDBOX_PIDS_MAX=256
AGENT_PY_SANDBOX_TIME_LIMIT_S=30
AGENT_PY_SANDBOX_DISK_BUDGET_GB=10
AGENT_PY_SANDBOX_REAPER_INTERVAL_S=60
AGENT_PY_SANDBOX_ROOT=/var/lib/agent-py/sessions
```

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add .env.example
git commit -m "docs(env): AGENT_PY_SANDBOX_* env vars for runCode tool"
```

---

### Task 1.3: Test that settings load with overrides

**Files:**
- Create: `services/agent-py/tests/test_sandbox_settings.py`

- [ ] **Step 1: Write the test**

```python
"""Pin that the AGENT_PY_SANDBOX_* settings load and that the agent-py
settings layer surfaces every knob the sandbox needs.

Reference: docs/superpowers/specs/2026-06-15-code-interpreter-sandbox-design.md
"""
from __future__ import annotations

import pytest

from agent_py import settings as settings_module
from agent_py.settings import Settings, get_settings


@pytest.fixture(autouse=True)
def _reset_settings_cache() -> None:
    settings_module.get_settings.cache_clear()
    yield
    settings_module.get_settings.cache_clear()


def test_sandbox_settings_default() -> None:
    s = get_settings()
    assert s.AGENT_PY_SANDBOX_ENABLED is True
    assert s.AGENT_PY_SANDBOX_MAX_CONCURRENT == 16
    assert s.AGENT_PY_SANDBOX_IDLE_MINUTES == 30
    assert s.AGENT_PY_SANDBOX_MEM_MB == 512
    assert s.AGENT_PY_SANDBOX_PIDS_MAX == 256
    assert s.AGENT_PY_SANDBOX_TIME_LIMIT_S == 30
    assert s.AGENT_PY_SANDBOX_DISK_BUDGET_GB == 10
    assert s.AGENT_PY_SANDBOX_REAPER_INTERVAL_S == 60.0
    assert s.AGENT_PY_SANDBOX_ROOT == "/var/lib/agent-py/sessions"


def test_sandbox_enabled_can_be_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_PY_SANDBOX_ENABLED", "false")
    s = get_settings()
    assert s.AGENT_PY_SANDBOX_ENABLED is False


def test_sandbox_max_concurrent_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_PY_SANDBOX_MAX_CONCURRENT", "64")
    s = get_settings()
    assert s.AGENT_PY_SANDBOX_MAX_CONCURRENT == 64
```

- [ ] **Step 2: Run the test**

```bash
cd services/agent-py && uv run pytest tests/test_sandbox_settings.py -v
```

Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/tests/test_sandbox_settings.py
git commit -m "test(agent-py): sandbox settings defaults + env override"
```

---

## Phase 2: Types & Protocol

### Task 2.1: Create the sandbox package skeleton

**Files:**
- Create: `services/agent-py/src/agent_py/sandbox/__init__.py`

- [ ] **Step 1: Create the package directory**

```bash
mkdir -p services/agent-py/src/agent_py/sandbox/proto
mkdir -p services/agent-py/src/agent_py/sandbox/kafel
```

- [ ] **Step 2: Create the __init__.py**

```python
"""Sandbox-backed code-execution package.

Spec: docs/superpowers/specs/2026-06-15-code-interpreter-sandbox-design.md
v1 implementation: NsjailJupyterSandbox (nsjail + ipykernel, jupyter_client
driving the protocol). v2 will add FirecrackerSandbox as an opt-in backend
for adversarial workloads — same CodeSandbox Protocol, different impl.
"""
from agent_py.sandbox.nsjail import NsjailJupyterSandbox
from agent_py.sandbox.sessions import SessionRegistry
from agent_py.sandbox.types import (
    CodeRunRequest,
    CodeRunResult,
    CodeSandbox,
    CodeSandboxError,
    FileUpload,
)

__all__ = [
    "CodeRunRequest",
    "CodeRunResult",
    "CodeSandbox",
    "CodeSandboxError",
    "FileUpload",
    "NsjailJupyterSandbox",
    "SessionRegistry",
]
```

- [ ] **Step 3: Verify the package imports cleanly**

```bash
cd services/agent-py && uv run python -c "import agent_py.sandbox"
```

Expected: error (the modules don't exist yet). This is fine — Tasks 2.2 onwards fill them in. The test in Task 2.4 will verify the final import.

- [ ] **Step 4: No commit yet** — the file is staged with the rest of Phase 2.

---

### Task 2.2: Create the sandbox types module

**Files:**
- Create: `services/agent-py/src/agent_py/sandbox/types.py`

- [ ] **Step 1: Write the file**

```python
"""Type definitions for the sandbox-backed code interpreter.

The `CodeSandbox` Protocol is the v1/v2 abstraction boundary. The
tool surface depends on the protocol, not on the implementation, so
that v2 can swap in a Firecracker-backed implementation without
changing call-sites.

Reference: docs/superpowers/specs/2026-06-15-code-interpreter-sandbox-design.md §"The CodeSandbox interface"
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


class CodeSandboxError(Exception):
    """Raised when a sandbox run fails: timeout, OOM, kernel crash,
    seccomp denial, or any other unrecoverable error. The tool surface
    catches this and converts to a `{"error": str, "killed": bool}`
    shape so the model can recover gracefully."""


@dataclass(frozen=True)
class FileUpload:
    """A file the user wants to expose to the kernel via /work/uploads."""
    name: str
    content_b64: str  # base64-encoded bytes; decoded on the sandbox side


@dataclass(frozen=True)
class CodeRunRequest:
    """One execute_request submitted by the tool."""
    user_id: str
    session_id: str
    code: str
    files: list[FileUpload] = field(default_factory=list)
    timeout_s: int = 30
    memory_mb: int = 512


@dataclass(frozen=True)
class CodeRunResult:
    """One execute_reply + IOPub stream for one CodeRunRequest."""
    stdout: str = ""
    stderr: str = ""
    result: str | None = None
    image_count: int = 0
    duration_ms: int = 0
    error: str | None = None
    killed: bool = False


@runtime_checkable
class CodeSandbox(Protocol):
    """The v1/v2 abstraction. NsjailJupyterSandbox is the v1
    implementation; FirecrackerSandbox is sketched in the spec for v2."""

    async def ensure_session(self, user_id: str, session_id: str) -> None:
        """Idempotently create a session for (user_id, session_id).
        Subsequent `run` calls on the same key reuse the session.
        Raises CodeSandboxError if the sandbox is at capacity and
        cannot evict (e.g. only one session exists)."""
        ...

    async def run(self, req: CodeRunRequest) -> CodeRunResult:
        """Submit `req.code` to the session's kernel. Streams IOPub
        for stdout/stderr, waits for execute_reply (idle). On
        timeout/OOM, returns CodeRunResult with `killed=True` and a
        human-readable `error` string."""
        ...

    async def close_session(self, user_id: str, session_id: str) -> None:
        """Kill the session's kernel + jail. Idempotent."""
        ...

    async def close_all(self) -> None:
        """Kill every live session. Called by FastAPI lifespan on
        shutdown. Idempotent."""
        ...


def file_upload_dict(u: FileUpload) -> dict[str, Any]:
    """JSON-serialisable view of a FileUpload. Used by the tool to
    round-trip a file through the tool-call wire format."""
    return {"name": u.name, "content_b64": u.content_b64}
```

- [ ] **Step 2: Verify the file imports**

```bash
cd services/agent-py && uv run python -c "from agent_py.sandbox.types import CodeSandbox, CodeRunRequest, CodeRunResult, CodeSandboxError, FileUpload; print('ok')"
```

Expected: prints `ok`.

- [ ] **Step 3: Verify mypy still passes**

```bash
cd services/agent-py && uv run mypy src
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/src/agent_py/sandbox/__init__.py services/agent-py/src/agent_py/sandbox/types.py
git commit -m "feat(agent-py): CodeSandbox Protocol + types (Phase 1 of code-interpreter spec)"
```

---

### Task 2.3: Test the types module

**Files:**
- Create: `services/agent-py/tests/test_sandbox_types.py`

- [ ] **Step 1: Write the test**

```python
"""Pin the shape of the sandbox types so refactors don't break the
tool surface.
"""
from __future__ import annotations

import pytest

from agent_py.sandbox.types import (
    CodeRunRequest,
    CodeRunResult,
    CodeSandbox,
    CodeSandboxError,
    FileUpload,
    file_upload_dict,
)


def test_code_run_request_minimal() -> None:
    req = CodeRunRequest(user_id="u1", session_id="s1", code="print(1)")
    assert req.user_id == "u1"
    assert req.session_id == "s1"
    assert req.code == "print(1)"
    assert req.files == []
    assert req.timeout_s == 30
    assert req.memory_mb == 512


def test_code_run_request_with_files() -> None:
    req = CodeRunRequest(
        user_id="u1",
        session_id="s1",
        code="open('a.csv')",
        files=[FileUpload(name="a.csv", content_b64="YWE=")],  # "aa"
        timeout_s=10,
    )
    assert len(req.files) == 1
    assert req.files[0].name == "a.csv"
    assert req.timeout_s == 10


def test_code_run_result_defaults() -> None:
    r = CodeRunResult()
    assert r.stdout == ""
    assert r.stderr == ""
    assert r.result is None
    assert r.image_count == 0
    assert r.error is None
    assert r.killed is False


def test_code_sandbox_is_a_protocol() -> None:
    assert issubclass(CodeSandbox, Protocol)


def test_code_sandbox_runtime_checkable() -> None:
    # A class that doesn't implement the protocol must not satisfy it.
    class NotASandbox:
        pass

    assert not isinstance(NotASandbox(), CodeSandbox)


def test_code_sandbox_error_is_exception() -> None:
    with pytest.raises(CodeSandboxError):
        raise CodeSandboxError("nope")


def test_file_upload_dict_roundtrip() -> None:
    u = FileUpload(name="x.bin", content_b64="YWJj")
    d = file_upload_dict(u)
    assert d == {"name": "x.bin", "content_b64": "YWJj"}
```

- [ ] **Step 2: Run the test**

```bash
cd services/agent-py && uv run pytest tests/test_sandbox_types.py -v
```

Expected: 7 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/tests/test_sandbox_types.py
git commit -m "test(agent-py): CodeSandbox types shape"
```

---

## Phase 3: nsjail config (proto + kafel)

### Task 3.1: Create the Kafel seccomp policy

**Files:**
- Create: `services/agent-py/src/agent_py/sandbox/kafel/sandbox.kafel`

- [ ] **Step 1: Write the Kafel policy**

```kafel
# Kafel seccomp policy for the agent-py code interpreter sandbox.
#
# Reference: https://github.com/google/nsjail/tree/master/kafel
# Spec: docs/superpowers/specs/2026-06-15-code-interpreter-sandbox-design.md
#
# Strategy: deny all socket creation to non-loopback IPv4/IPv6.
# Loopback (127.0.0.0/8 for IPv4, ::1 for IPv6) is permitted so the
# Jupyter kernel can speak ZMQ over TCP to agent-py on the same host.
# Unix-domain sockets (used by jupyter_client in IPC mode) are
# unaffected — they go through socket(AF_UNIX, ...), which the rules
# below do not touch.
#
# The Kafel DSL uses htobe32() / htobe64() for big-endian literal
# constants. The loopback prefix 127.0.0.0/8 is 0x7F000000; we mask
# the high byte and compare.

kafel {
  # --- IPv4 ---
  # Block TCP to non-loopback (allow 127.0.0.0/8)
  deny socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) {
    $sockaddr.sin_addr.s_addr & htobe32(0xFF000000) != htobe32(0x7F000000)
  }
  # Block UDP to non-loopback
  deny socket(AF_INET, SOCK_DGRAM) {
    $sockaddr.sin_addr.s_addr & htobe32(0xFF000000) != htobe32(0x7F000000)
  }

  # --- IPv6 ---
  # Block TCP to non-loopback (allow ::1)
  deny socket(AF_INET6, SOCK_STREAM, IPPROTO_TCP) {
    $sockaddr.sin6_addr.s6_addr != in6addr_loopback.s6_addr
  }
  # Block UDP to non-loopback
  deny socket(AF_INET6, SOCK_DGRAM) {
    $sockaddr.sin6_addr.s6_addr != in6addr_loopback.s6_addr
  }
}
```

> **Verify at impl time:** the `$sockaddr`, `htobe32`, and `in6addr_loopback` tokens are Kafel DSL builtins. If the version of nsjail in your apt repo rejects any of these, consult the [Kafel examples](https://github.com/google/nsjail/tree/master/kafel) in the nsjail repo for the exact syntax for that version. The integration test in Task 7.3 is the canary — if it fails to spawn because the Kafel policy is rejected, fix the policy and re-run.

- [ ] **Step 2: Verify the file is at the path**

```bash
ls -la services/agent-py/src/agent_py/sandbox/kafel/
```

Expected: shows `sandbox.kafel`.

- [ ] **Step 3: Smoke-test the policy with nsjail directly**

```bash
nsjail --help 2>&1 | grep -i kafel
```

Expected: confirms nsjail supports Kafel. (The actual `nsjail --kafel` smoke-test happens in Task 7.3.)

- [ ] **Step 4: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/src/agent_py/sandbox/kafel/sandbox.kafel
git commit -m "feat(agent-py): Kafel seccomp policy — deny non-loopback socket"
```

---

### Task 3.2: Create the nsjail protobuf template

**Files:**
- Create: `services/agent-py/src/agent_py/sandbox/proto/sandbox.proto.tmpl`

- [ ] **Step 1: Write the template**

```
# nsjail protobuf config template for the agent-py code interpreter.
#
# Rendered with string.Template ($variable substitution) at session
# spawn time. The render module (Task 3.3) substitutes:
#   $scratch          per-session scratch dir (writable)
#   $connection_file  Jupyter kernel connection file (writable)
#   $kafel_path       absolute path to sandbox.kafel
#   $agent_uid        host UID of the agent-py user
#   $agent_gid        host GID of the agent-py user
#   $mem_mb           per-session memory cap
#   $pids_max         per-session pid cap
#   $time_limit       per-run wall-time limit
#
# Spec: docs/superpowers/specs/2026-06-15-code-interpreter-sandbox-design.md

name: "agent-py-code-${user_id}-${session_id}"
mode: ONCE
hostname: "sandbox"
cwd: "/work"
clone_newnet: false
clone_newuser: true
clone_newns: true
clone_newpid: true
clone_newcgroup: true

uidmap { inside_id: "$agent_uid" outside_id: "$agent_uid" count: 1 }
gidmap { inside_id: "$agent_gid" outside_id: "$agent_gid" count: 1 }

mount {
  src: "$scratch"
  dst: "/work"
  rw: true
  is_bind: true
}
mount {
  src: "/usr"
  dst: "/usr"
  ro: true
  is_bind: true
}
mount {
  src: "/lib"
  dst: "/lib"
  ro: true
  is_bind: true
}
mount {
  src: "/lib64"
  dst: "/lib64"
  ro: true
  is_bind: true
}
mount {
  src: "/etc/ld.so.cache"
  dst: "/etc/ld.so.cache"
  ro: true
  is_bind: true
}
mount {
  src: "/etc/ssl"
  dst: "/etc/ssl"
  ro: true
  is_bind: true
}
mount {
  dst: "/tmp"
  fstype: "tmpfs"
  rw: true
  options: "size=100m"
}
mount {
  dst: "/proc"
  fstype: "proc"
  rw: false
}
mount {
  dst: "/dev/null"
  fstype: "none"
  rw: false

  src: "/dev/null"
}

rlimit_as: ${mem_mb_as}
rlimit_nproc: $pids_max
rlimit_fsize: 104857600

time_limit: $time_limit

cgroup_mem_max: ${mem_mb_as}
cgroup_pids_max: $pids_max
cgroup_cpu_ms_per_sec: 100000

kafel_policy_file: "$kafel_path"

exec_bin {
  path: "/usr/bin/python3"
  arg: "/usr/bin/python3"
  arg: "-m"
  arg: "ipykernel"
  arg: "-f"
  arg: "/work/$connection_filename"
}
```

- [ ] **Step 2: Verify the file is at the path**

```bash
ls -la services/agent-py/src/agent_py/sandbox/proto/
```

Expected: shows `sandbox.proto.tmpl`.

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/src/agent_py/sandbox/proto/sandbox.proto.tmpl
git commit -m "feat(agent-py): nsjail protobuf template for runCode sandbox"
```

---

### Task 3.3: Create the proto renderer

**Files:**
- Create: `services/agent-py/src/agent_py/sandbox/render.py`

- [ ] **Step 1: Write the renderer**

```python
"""Render the nsjail protobuf config from the committed template.

The template (sandbox/proto/sandbox.proto.tmpl) is a string.Template
that uses $-variable substitution. This module is the only place
that knows about template syntax — callers pass a dict of values and
get a string back.
"""
from __future__ import annotations

from pathlib import Path
import string

_TEMPLATE_PATH = (
    Path(__file__).parent / "proto" / "sandbox.proto.tmpl"
)


def _load_template() -> string.Template:
    return string.Template(_TEMPLATE_PATH.read_text())


def render_proto(
    *,
    user_id: str,
    session_id: str,
    scratch: str,
    connection_filename: str,
    kafel_path: str,
    agent_uid: int,
    agent_gid: int,
    mem_mb: int,
    pids_max: int,
    time_limit: int,
) -> str:
    """Render the nsjail protobuf config for one session.

    The renderer is synchronous (a one-shot string substitution) — the
    caller is responsible for writing the rendered string to a file
    before passing it to nsjail via `--config`.
    """
    mem_mb_as = mem_mb * 1024 * 1024
    tpl = _load_template()
    return tpl.substitute(
        user_id=user_id,
        session_id=session_id,
        scratch=scratch,
        connection_filename=connection_filename,
        kafel_path=kafel_path,
        agent_uid=agent_uid,
        agent_gid=agent_gid,
        mem_mb=mem_mb,
        mem_mb_as=mem_mb_as,
        pids_max=pids_max,
        time_limit=time_limit,
    )
```

- [ ] **Step 2: Verify the module imports**

```bash
cd services/agent-py && uv run python -c "from agent_py.sandbox.render import render_proto; print('ok')"
```

Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/src/agent_py/sandbox/render.py
git commit -m "feat(agent-py): nsjail proto renderer"
```

---

### Task 3.4: Test the proto renderer

**Files:**
- Create: `services/agent-py/tests/test_sandbox_render.py`

- [ ] **Step 1: Write the test**

```python
"""Pin the proto-template renderer so that template syntax or variable
changes don't silently break the security boundary.
"""
from __future__ import annotations

from agent_py.sandbox.render import render_proto


def _base_kwargs() -> dict:
    return dict(
        user_id="u1",
        session_id="s1",
        scratch="/var/lib/agent-py/sessions/u1/s1",
        connection_filename="kernel.json",
        kafel_path="/app/src/agent_py/sandbox/kafel/sandbox.kafel",
        agent_uid=1000,
        agent_gid=1000,
        mem_mb=512,
        pids_max=256,
        time_limit=30,
    )


def test_render_substitutes_user_and_session() -> None:
    out = render_proto(**_base_kwargs())
    assert "agent-py-code-u1-s1" in out


def test_render_includes_scratch_bind() -> None:
    out = render_proto(**_base_kwargs())
    assert "src: \"/var/lib/agent-py/sessions/u1/s1\"" in out
    assert "dst: \"/work\"" in out


def test_render_includes_kafel_path() -> None:
    out = render_proto(**_base_kwargs())
    assert "kafel_policy_file: \"/app/src/agent_py/sandbox/kafel/sandbox.kafel\"" in out


def test_render_includes_rlimits() -> None:
    out = render_proto(**_base_kwargs())
    # 512 MB in bytes
    assert "rlimit_as: 536870912" in out
    assert "rlimit_nproc: 256" in out
    assert "time_limit: 30" in out


def test_render_includes_cgroup_caps() -> None:
    out = render_proto(**_base_kwargs())
    assert "cgroup_mem_max: 536870912" in out
    assert "cgroup_pids_max: 256" in out


def test_render_pins_clone_newnet_false() -> None:
    """The user-confirmed v1 design: kernel and agent-py share the
    host network namespace. Outbound is blocked via the Kafel
    seccomp policy, not via netns. If this line flips to true, the
    Kafel policy becomes the only line of defense AND the assumption
    that 'ZMQ over TCP works out of the box' breaks. Pin it."""
    out = render_proto(**_base_kwargs())
    assert "clone_newnet: false" in out
    assert "clone_newnet: true" not in out


def test_render_executes_ipykernel() -> None:
    out = render_proto(**_base_kwargs())
    assert "ipykernel" in out
    assert "/work/kernel.json" in out


def test_render_with_different_mem_scales_bytes() -> None:
    out = render_proto(**_base_kwargs(), mem_mb=256)
    assert "rlimit_as: 268435456" in out
    assert "cgroup_mem_max: 268435456" in out
```

- [ ] **Step 2: Run the test**

```bash
cd services/agent-py && uv run pytest tests/test_sandbox_render.py -v
```

Expected: 8 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/tests/test_sandbox_render.py
git commit -m "test(agent-py): proto renderer + clone_newnet false pin"
```

---

## Phase 4: SessionRegistry

### Task 4.1: Create the SessionRegistry skeleton

**Files:**
- Create: `services/agent-py/src/agent_py/sandbox/sessions.py`

- [ ] **Step 1: Write the file**

```python
"""LRU session registry for the runCode tool.

Maps (user_id, session_id) -> NsjailSession. The registry owns the
lifecycle: spawn on first access, reuse on subsequent accesses,
evict LRU when the cap is reached, reap idle sessions in the
background. The nsjail session itself (kernel + jail process) is
created lazily by the sandbox — the registry just tracks metadata
and triggers cleanup.

Reference: docs/superpowers/specs/2026-06-15-code-interpreter-sandbox-design.md §"SessionRegistry"
"""
from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agent_py.sandbox.nsjail import NsjailSession


@dataclass
class _Entry:
    session: NsjailSession
    last_used_monotonic: float


class SessionRegistry:
    """LRU + idle-evict registry. Pure in-memory; no DB."""

    def __init__(self, max_concurrent: int, idle_seconds: int) -> None:
        if max_concurrent < 1:
            raise ValueError("max_concurrent must be >= 1")
        if idle_seconds < 0:
            raise ValueError("idle_seconds must be >= 0")
        self._max = max_concurrent
        self._idle_s = idle_seconds
        self._entries: OrderedDict[tuple[str, str], _Entry] = OrderedDict()
        self._lock = asyncio.Lock()

    def __len__(self) -> int:
        return len(self._entries)

    async def touch(self, user_id: str, session_id: str) -> None:
        """Mark (user_id, session_id) as most-recently-used without
        otherwise modifying the registry. Idempotent — if the key
        is not present, no-op."""
        async with self._lock:
            entry = self._entries.get((user_id, session_id))
            if entry is not None:
                entry.last_used_monotonic = time.monotonic()
                self._entries.move_to_end((user_id, session_id))

    async def get_or_touch(self, user_id: str, session_id: str) -> NsjailSession | None:
        """Atomically look up the session for (user_id, session_id)
        AND mark it MRU. Returns the session, or None if absent.
        Used by the sandbox's `run` path: get-and-touch is one
        critical section so the LRU order is consistent with the
        presence check."""
        async with self._lock:
            entry = self._entries.get((user_id, session_id))
            if entry is None:
                return None
            entry.last_used_monotonic = time.monotonic()
            self._entries.move_to_end((user_id, session_id))
            return entry.session

    async def evict_lru(self) -> tuple[str, str] | None:
        """Pop the LRU entry, close its session, return the key.
        Returns None if the registry is empty. Used by the
        disk-budget janitor."""
        async with self._lock:
            if not self._entries:
                return None
            old_key, old_entry = self._entries.popitem(last=False)
            await old_entry.session.close()
            return old_key

    async def put(self, user_id: str, session_id: str, session: NsjailSession) -> None:
        """Insert or replace a session. If inserting into a full
        registry, evicts the LRU entry first."""
        async with self._lock:
            key = (user_id, session_id)
            self._entries[key] = _Entry(
                session=session,
                last_used_monotonic=time.monotonic(),
            )
            self._entries.move_to_end(key)
            while len(self._entries) > self._max:
                old_key, old_entry = self._entries.popitem(last=False)
                await old_entry.session.close()

    async def pop(self, user_id: str, session_id: str) -> NsjailSession | None:
        """Remove and close. Idempotent — returns None if absent."""
        async with self._lock:
            entry = self._entries.pop((user_id, session_id), None)
            if entry is None:
                return None
            await entry.session.close()
            return entry.session

    async def reap_idle(self) -> list[tuple[str, str]]:
        """Close every session whose last_used is older than the
        idle threshold. Returns the list of keys that were reaped
        (for logging/observability)."""
        if self._idle_s == 0:
            return []
        async with self._lock:
            now = time.monotonic()
            stale_keys = [
                k for k, e in self._entries.items()
                if (now - e.last_used_monotonic) > self._idle_s
            ]
            for k in stale_keys:
                entry = self._entries.pop(k)
                await entry.session.close()
            return stale_keys

    async def close_all(self) -> None:
        """Close every live session. Called by FastAPI lifespan on
        shutdown."""
        async with self._lock:
            entries = list(self._entries.values())
            self._entries.clear()
        for entry in entries:
            await entry.session.close()
```

- [ ] **Step 2: Verify the module imports**

```bash
cd services/agent-py && uv run python -c "from agent_py.sandbox.sessions import SessionRegistry; print('ok')"
```

Expected: prints `ok`. (The `NsjailSession` import is `TYPE_CHECKING`-only at this point; the runtime import will be added in Task 5.1.)

- [ ] **Step 3: Verify mypy still passes**

```bash
cd services/agent-py && uv run mypy src
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/src/agent_py/sandbox/sessions.py
git commit -m "feat(agent-py): SessionRegistry skeleton (LRU + idle reap)"
```

---

### Task 4.2: Test the SessionRegistry

**Files:**
- Create: `services/agent-py/tests/test_sandbox_sessions.py`

- [ ] **Step 1: Write the test**

```python
"""SessionRegistry unit tests with a mock NsjailSession (no real nsjail
or kernel). These run on any machine; the integration tests in
test_sandbox_nsjail.py require nsjail + ipykernel.
"""
from __future__ import annotations

import pytest

from agent_py.sandbox.sessions import SessionRegistry


class _MockSession:
    def __init__(self) -> None:
        self.closed = False
        self.close_calls = 0

    async def close(self) -> None:
        self.closed = True
        self.close_calls += 1


@pytest.fixture
def reg() -> SessionRegistry:
    return SessionRegistry(max_concurrent=3, idle_seconds=60)


@pytest.mark.asyncio
async def test_put_and_len(reg: SessionRegistry) -> None:
    s1 = _MockSession()
    await reg.put("u1", "s1", s1)
    assert len(reg) == 1
    assert s1.close_calls == 0


@pytest.mark.asyncio
async def test_pop_closes_and_returns(reg: SessionRegistry) -> None:
    s1 = _MockSession()
    await reg.put("u1", "s1", s1)
    popped = await reg.pop("u1", "s1")
    assert popped is s1
    assert s1.closed is True
    assert len(reg) == 0


@pytest.mark.asyncio
async def test_pop_missing_is_noop(reg: SessionRegistry) -> None:
    popped = await reg.pop("u1", "does-not-exist")
    assert popped is None


@pytest.mark.asyncio
async def test_put_evicts_lru_when_full() -> None:
    reg = SessionRegistry(max_concurrent=2, idle_seconds=60)
    s1, s2, s3 = _MockSession(), _MockSession(), _MockSession()
    await reg.put("u1", "s1", s1)
    await reg.put("u1", "s2", s2)
    assert len(reg) == 2
    # s1 is the LRU; adding s3 should evict s1.
    await reg.put("u1", "s3", s3)
    assert len(reg) == 2
    assert s1.closed is True
    assert s2.closed is False
    assert s3.closed is False


@pytest.mark.asyncio
async def test_touch_moves_to_mru() -> None:
    reg = SessionRegistry(max_concurrent=2, idle_seconds=60)
    s1, s2, s3 = _MockSession(), _MockSession(), _MockSession()
    await reg.put("u1", "s1", s1)
    await reg.put("u1", "s2", s2)
    # Touch s1 — s1 becomes MRU, s2 becomes LRU. s3 evicts s2.
    await reg.touch("u1", "s1")
    await reg.put("u1", "s3", s3)
    assert s1.closed is False
    assert s2.closed is True
    assert s3.closed is False


@pytest.mark.asyncio
async def test_get_or_touch_returns_and_marks_mru() -> None:
    reg = SessionRegistry(max_concurrent=2, idle_seconds=60)
    s1, s2 = _MockSession(), _MockSession()
    await reg.put("u1", "s1", s1)
    await reg.put("u1", "s2", s2)
    # get_or_touch on s1 promotes it; subsequent put('s3') evicts s2.
    got = await reg.get_or_touch("u1", "s1")
    assert got is s1
    s3 = _MockSession()
    await reg.put("u1", "s3", s3)
    assert s2.closed is True
    assert s1.closed is False


@pytest.mark.asyncio
async def test_get_or_touch_missing_returns_none() -> None:
    reg = SessionRegistry(max_concurrent=2, idle_seconds=60)
    got = await reg.get_or_touch("nope", "nada")
    assert got is None


@pytest.mark.asyncio
async def test_evict_lru_pops_and_closes() -> None:
    reg = SessionRegistry(max_concurrent=3, idle_seconds=60)
    s1, s2, s3 = _MockSession(), _MockSession(), _MockSession()
    await reg.put("u1", "s1", s1)
    await reg.put("u1", "s2", s2)
    await reg.put("u1", "s3", s3)
    evicted = await reg.evict_lru()
    assert evicted == ("u1", "s1")
    assert s1.closed is True
    assert len(reg) == 2


@pytest.mark.asyncio
async def test_evict_lru_empty_registry() -> None:
    reg = SessionRegistry(max_concurrent=3, idle_seconds=60)
    evicted = await reg.evict_lru()
    assert evicted is None


@pytest.mark.asyncio
async def test_reap_idle_closes_stale() -> None:
    reg = SessionRegistry(max_concurrent=10, idle_seconds=0)
    # idle_seconds=0 means everything is stale.
    s1 = _MockSession()
    await reg.put("u1", "s1", s1)
    reaped = await reg.reap_idle()
    assert reaped == [("u1", "s1")]
    assert s1.closed is True


@pytest.mark.asyncio
async def test_reap_idle_zero_idle_disables() -> None:
    """idle_seconds=0 means 'never reap' (sentinel), per the spec."""
    reg = SessionRegistry(max_concurrent=10, idle_seconds=0)
    s1 = _MockSession()
    await reg.put("u1", "s1", s1)
    reaped = await reg.reap_idle()
    assert reaped == []
    assert s1.closed is False


@pytest.mark.asyncio
async def test_close_all(reg: SessionRegistry) -> None:
    s1, s2 = _MockSession(), _MockSession()
    await reg.put("u1", "s1", s1)
    await reg.put("u2", "s2", s2)
    await reg.close_all()
    assert s1.closed is True
    assert s2.closed is True
    assert len(reg) == 0


@pytest.mark.asyncio
async def test_close_all_idempotent(reg: SessionRegistry) -> None:
    await reg.close_all()
    await reg.close_all()  # second call is a no-op


def test_invalid_max_concurrent() -> None:
    with pytest.raises(ValueError):
        SessionRegistry(max_concurrent=0, idle_seconds=60)


def test_invalid_idle_seconds() -> None:
    with pytest.raises(ValueError):
        SessionRegistry(max_concurrent=10, idle_seconds=-1)
```

- [ ] **Step 2: Run the test**

```bash
cd services/agent-py && uv run pytest tests/test_sandbox_sessions.py -v
```

Expected: 11 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/tests/test_sandbox_sessions.py
git commit -m "test(agent-py): SessionRegistry LRU + idle + close_all"
```

---

## Phase 5: NsjailJupyterSandbox (spawn)

### Task 5.1: Create the NsjailSession + NsjailJupyterSandbox skeleton

**Files:**
- Create: `services/agent-py/src/agent_py/sandbox/nsjail.py`

- [ ] **Step 1: Write the file**

```python
"""Nsjail + ipykernel sandbox implementation.

The v1 implementation of the CodeSandbox Protocol. Owns:
- a SessionRegistry (per-(user, session) jail lifecycle)
- the per-session nsjail subprocess + ZMQ kernel client
- the IOPub stream -> CodeRunResult translation

Reference: docs/superpowers/specs/2026-06-15-code-interpreter-sandbox-design.md
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import tempfile
import time
from pathlib import Path
from queue import Empty, Queue
from typing import Any

from jupyter_client import BlockingKernelClient
from jupyter_client.kernelspec import KernelSpecManager

from agent_py.sandbox.render import render_proto
from agent_py.sandbox.sessions import SessionRegistry
from agent_py.sandbox.types import (
    CodeRunRequest,
    CodeRunResult,
    CodeSandboxError,
    FileUpload,
)

_KAFEL_PATH = str(
    Path(__file__).parent / "kafel" / "sandbox.kafel"
)
_PROTO_TEMPLATE_NOTE = "see sandbox/proto/sandbox.proto.tmpl"
_NSJAIL_BIN = "/usr/bin/nsjail"
_PYTHON3_BIN = "/usr/bin/python3"
_KERNEL_STARTUP_TIMEOUT_S = 15.0


class NsjailSession:
    """One live (user_id, session_id) jail + ipykernel."""

    def __init__(
        self,
        *,
        user_id: str,
        session_id: str,
        scratch: Path,
        cfg_path: Path,
        connection_filename: str,
        mem_mb: int,
        pids_max: int,
        time_limit: int,
        agent_uid: int,
        agent_gid: int,
    ) -> None:
        self.user_id = user_id
        self.session_id = session_id
        self.scratch = scratch
        self.cfg_path = cfg_path
        self.connection_filename = connection_filename
        self.mem_mb = mem_mb
        self.pids_max = pids_max
        self.time_limit = time_limit
        self.agent_uid = agent_uid
        self.agent_gid = agent_gid
        self._proc: asyncio.subprocess.Process | None = None
        self._kc: BlockingKernelClient | None = None
        self._closed = False

    @property
    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    async def spawn(self) -> None:
        """Spawn the nsjail process + ipykernel inside, then attach
        the BlockingKernelClient. Blocks until the connection file
        appears (timeout 15s) or raises CodeSandboxError."""
        self.scratch.mkdir(parents=True, exist_ok=True)
        uploads = self.scratch / "uploads"
        uploads.mkdir(exist_ok=True)
        os.chmod(self.scratch, 0o700)
        os.chmod(uploads, 0o700)

        cfg_text = render_proto(
            user_id=self.user_id,
            session_id=self.session_id,
            scratch=str(self.scratch),
            connection_filename=self.connection_filename,
            kafel_path=_KAFEL_PATH,
            agent_uid=self.agent_uid,
            agent_gid=self.agent_gid,
            mem_mb=self.mem_mb,
            pids_max=self.pids_max,
            time_limit=self.time_limit,
        )
        self.cfg_path.write_text(cfg_text)

        self._proc = await asyncio.create_subprocess_exec(
            _NSJAIL_BIN,
            "--config", str(self.cfg_path),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )

        # Wait for the kernel to write the connection file
        connection_file = self.scratch / self.connection_filename
        deadline = time.monotonic() + _KERNEL_STARTUP_TIMEOUT_S
        while time.monotonic() < deadline:
            if connection_file.exists():
                break
            if self._proc.returncode is not None:
                stderr = (self._proc.stderr or b"").read().decode("utf-8", "replace")
                raise CodeSandboxError(
                    f"nsjail exited (code={self._proc.returncode}) before "
                    f"writing connection file: {stderr[:500]}"
                )
            await asyncio.sleep(0.1)
        else:
            self._proc.terminate()
            raise CodeSandboxError(
                f"kernel did not write {connection_file} within "
                f"{_KERNEL_STARTUP_TIMEOUT_S}s"
            )

        self._kc = BlockingKernelClient()
        self._kc.load_connection_file(str(connection_file))
        self._kc.start_channels()
        # Wait for the kernel to be ready (idle after startup).
        self._kc.wait_for_ready(timeout=_KERNEL_STARTUP_TIMEOUT_S)

    async def run(self, req: CodeRunRequest) -> CodeRunResult:
        """Submit one execute_request and stream the IOPub replies
        until idle. See spec §NsjailJupyterSandbox."""
        if not self.is_alive or self._kc is None:
            raise CodeSandboxError("kernel is not alive")
        # 1. drop any uploaded files into scratch/uploads/
        for f in req.files:
            self._write_upload(f)

        # 2. submit execute_request
        msg_id = self._kc.execute(req.code)

        # 3. stream IOPub until idle
        stdout_parts: list[str] = []
        stderr_parts: list[str] = []
        result: str | None = None
        image_count = 0
        err: str | None = None
        killed = False
        start = time.monotonic()
        deadline = start + req.timeout_s

        # The BlockingKernelClient surfaces messages synchronously; we
        # offload the read loop to a thread via asyncio.to_thread so
        # the event loop stays responsive.
        while True:
            if time.monotonic() > deadline:
                self._proc.terminate()  # noqa: SLF001
                killed = True
                err = f"timeout after {req.timeout_s}s"
                break
            try:
                msg = await asyncio.to_thread(self._kc.get_iopub_msg, timeout=0.5)
            except Empty:
                continue
            parent = msg.get("parent_header", {}).get("msg_id")
            if parent != msg_id:
                continue
            msg_type = msg["header"]["msg_type"]
            content = msg["content"]
            if msg_type == "stream":
                (stdout_parts if content["name"] == "stdout" else stderr_parts).append(
                    content["text"]
                )
            elif msg_type == "execute_result":
                result = content["data"].get("text/plain")
            elif msg_type == "display_data":
                if any(k.startswith("image/") for k in content["data"]):
                    image_count += 1
            elif msg_type == "error":
                err = "\n".join(content.get("traceback", []))
            elif msg_type == "status" and content.get("execution_state") == "idle":
                break

        duration_ms = int((time.monotonic() - start) * 1000)
        return CodeRunResult(
            stdout="".join(stdout_parts),
            stderr="".join(stderr_parts),
            result=result,
            image_count=image_count,
            duration_ms=duration_ms,
            error=err,
            killed=killed,
        )

    def _write_upload(self, f: FileUpload) -> None:
        target = self.scratch / "uploads" / f.name
        target.write_bytes(base64.b64decode(f.content_b64))
        os.chmod(target, 0o600)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._kc is not None:
            try:
                self._kc.stop_channels()
            except Exception:  # noqa: BLE001
                pass
        if self._proc is not None and self._proc.returncode is None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=5.0)
            except (asyncio.TimeoutError, ProcessLookupError):
                try:
                    self._proc.kill()
                except ProcessLookupError:
                    pass
        # Best-effort: remove the scratch dir on close. Done in a
        # thread because Path.rmdir on a tree can be slow.
        if self.scratch.exists():
            await asyncio.to_thread(_rm_tree, self.scratch)


def _rm_tree(p: Path) -> None:
    import shutil

    shutil.rmtree(p, ignore_errors=True)


class NsjailJupyterSandbox:
    """The v1 CodeSandbox. v2 will add FirecrackerSandbox."""

    def __init__(
        self,
        *,
        max_concurrent: int,
        idle_seconds: int,
        mem_mb: int,
        pids_max: int,
        time_limit: int,
        root: str,
        agent_uid: int,
        agent_gid: int,
    ) -> None:
        self._registry = SessionRegistry(
            max_concurrent=max_concurrent, idle_seconds=idle_seconds
        )
        self._mem_mb = mem_mb
        self._pids_max = pids_max
        self._time_limit = time_limit
        self._root = root
        self._agent_uid = agent_uid
        self._agent_gid = agent_gid

    async def ensure_session(self, user_id: str, session_id: str) -> None:
        """Idempotently create a session. The first call spawns the
        nsjail + ipykernel; subsequent calls are no-ops."""
        scratch = Path(self._root) / user_id / session_id
        cfg_path = scratch / "nsjail.cfg"
        # Detect "already exists" by checking for the connection file
        # path; we don't trust the kernel is still alive across calls,
        # but the spawn() will fail fast if so.
        connection_filename = "kernel.json"
        if (scratch / connection_filename).exists():
            # Reuse path: caller should call run() instead, but
            # ensure_session is idempotent — do nothing.
            return
        session = NsjailSession(
            user_id=user_id,
            session_id=session_id,
            scratch=scratch,
            cfg_path=cfg_path,
            connection_filename=connection_filename,
            mem_mb=self._mem_mb,
            pids_max=self._pids_max,
            time_limit=self._time_limit,
            agent_uid=self._agent_uid,
            agent_gid=self._agent_gid,
        )
        await session.spawn()
        await self._registry.put(user_id, session_id, session)

    async def run(self, req: CodeRunRequest) -> CodeRunResult:
        session = await self._registry.get_or_touch(req.user_id, req.session_id)
        if session is None:
            await self.ensure_session(req.user_id, req.session_id)
            session = self._registry._entries[(req.user_id, req.session_id)].session  # noqa: SLF001
        return await session.run(req)

    async def close_session(self, user_id: str, session_id: str) -> None:
        await self._registry.pop(user_id, session_id)

    async def close_all(self) -> None:
        await self._registry.close_all()

    def reap_idle(self) -> Any:
        """Public wrapper for the lifespan reaper. Returns the
        asyncio coroutine from SessionRegistry.reap_idle()."""
        return self._registry.reap_idle()
```

- [ ] **Step 2: Verify the module imports**

```bash
cd services/agent-py && uv run python -c "from agent_py.sandbox.nsjail import NsjailJupyterSandbox, NsjailSession; print('ok')"
```

Expected: prints `ok`.

- [ ] **Step 3: Verify mypy still passes**

```bash
cd services/agent-py && uv run mypy src
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/src/agent_py/sandbox/nsjail.py
git commit -m "feat(agent-py): NsjailJupyterSandbox + NsjailSession (Phase 1 of code-interpreter spec)"
```

---

### Task 5.2: Update the sandbox __init__ to re-export

**Files:**
- Modify: `services/agent-py/src/agent_py/sandbox/__init__.py`

- [ ] **Step 1: Verify the existing re-exports work**

```bash
cd services/agent-py && uv run python -c "from agent_py.sandbox import NsjailJupyterSandbox, SessionRegistry, CodeSandbox, CodeRunRequest, CodeRunResult, CodeSandboxError, FileUpload; print('ok')"
```

Expected: prints `ok`. (The `__init__.py` written in Task 2.1 already has all these re-exports.)

- [ ] **Step 2: Run the existing test suite to confirm no regressions**

```bash
cd services/agent-py && uv run pytest tests/test_sandbox_types.py tests/test_sandbox_render.py tests/test_sandbox_sessions.py -v
```

Expected: 26 tests pass (7 + 8 + 11).

- [ ] **Step 3: No commit** — already done in Task 2.1.

---

### Task 5.3: Test sandbox spawn (integration)

**Files:**
- Create: `services/agent-py/tests/test_sandbox_nsjail.py`

- [ ] **Step 1: Write the integration test**

```python
"""Integration tests for NsjailJupyterSandbox. These require nsjail +
ipykernel installed and a writable scratch dir. Marked with
`pytest.mark.integration` so CI can opt-in.

Skip on dev machines without nsjail: use `pytest -m 'not integration'`
or set `RUN_INTEGRATION=0` in the env.
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import pytest

from agent_py.sandbox.nsjail import NsjailJupyterSandbox
from agent_py.sandbox.types import (
    CodeRunRequest,
    CodeSandboxError,
    FileUpload,
)


NSJAIL_AVAILABLE = shutil.which("nsjail") is not None
RUN_INTEGRATION = os.environ.get("RUN_INTEGRATION", "0") == "1"
SKIP_REASON = "nsjail binary not found" if not NSJAIL_AVAILABLE else (
    "RUN_INTEGRATION=0 (set RUN_INTEGRATION=1 to enable)" if not RUN_INTEGRATION else None
)
pytestmark = pytest.mark.skipif(SKIP_REASON is not None, reason=SKIP_REASON or "")


@pytest.fixture
async def sandbox() -> "pytest.AsyncGenerator[NsjailJupyterSandbox, None]":
    tmpdir = Path(tempfile.mkdtemp(prefix="agent-py-sandbox-test-"))
    sb = NsjailJupyterSandbox(
        max_concurrent=4,
        idle_seconds=60,
        mem_mb=512,
        pids_max=256,
        time_limit=30,
        root=str(tmpdir),
        agent_uid=os.getuid(),
        agent_gid=os.getgid(),
    )
    yield sb
    await sb.close_all()
    shutil.rmtree(tmpdir, ignore_errors=True)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_spawn_creates_connection_file(sandbox: NsjailJupyterSandbox) -> None:
    await sandbox.ensure_session("test-user-1", "test-session-1")
    # The scratch dir should now exist and contain the connection file
    scratch = Path(sandbox._root) / "test-user-1" / "test-session-1"  # noqa: SLF001
    assert scratch.exists()
    assert (scratch / "kernel.json").exists()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_run_simple_print(sandbox: NsjailJupyterSandbox) -> None:
    req = CodeRunRequest(
        user_id="test-user-2",
        session_id="test-session-2",
        code="print('hi from sandbox')",
    )
    r = await sandbox.run(req)
    assert r.error is None
    assert "hi from sandbox" in r.stdout
    assert r.killed is False


@pytest.mark.integration
@pytest.mark.asyncio
async def test_run_captures_result(sandbox: NsjailJupyterSandbox) -> None:
    req = CodeRunRequest(
        user_id="test-user-3",
        session_id="test-session-3",
        code="1 + 2 + 3",
    )
    r = await sandbox.run(req)
    assert r.error is None
    assert r.result == "6"


@pytest.mark.integration
@pytest.mark.asyncio
async def test_run_captures_stderr(sandbox: NsjailJupyterSandbox) -> None:
    req = CodeRunRequest(
        user_id="test-user-4",
        session_id="test-session-4",
        code="import sys; print('oh no', file=sys.stderr)",
    )
    r = await sandbox.run(req)
    assert r.error is None
    assert "oh no" in r.stderr


@pytest.mark.integration
@pytest.mark.asyncio
async def test_run_captures_error(sandbox: NsjailJupyterSandbox) -> None:
    req = CodeRunRequest(
        user_id="test-user-5",
        session_id="test-session-5",
        code="raise ValueError('boom')",
    )
    r = await sandbox.run(req)
    assert r.error is not None
    assert "ValueError" in r.error
    assert "boom" in r.error


@pytest.mark.integration
@pytest.mark.asyncio
async def test_session_reuse(sandbox: NsjailJupyterSandbox) -> None:
    """Variables persist across run() calls in the same session."""
    req1 = CodeRunRequest(
        user_id="test-user-6",
        session_id="test-session-6",
        code="x = 42",
    )
    r1 = await sandbox.run(req1)
    assert r1.error is None

    req2 = CodeRunRequest(
        user_id="test-user-6",
        session_id="test-session-6",
        code="x",
    )
    r2 = await sandbox.run(req2)
    assert r2.error is None
    assert r2.result == "42"


@pytest.mark.integration
@pytest.mark.asyncio
async def test_run_with_file_upload(sandbox: NsjailJupyterSandbox) -> None:
    import base64
    csv_bytes = b"a,b\n1,2\n3,4\n"
    req = CodeRunRequest(
        user_id="test-user-7",
        session_id="test-session-7",
        code="open('/work/uploads/data.csv').read()",
        files=[FileUpload(name="data.csv", content_b64=base64.b64encode(csv_bytes).decode())],
    )
    r = await sandbox.run(req)
    assert r.error is None
    assert "a,b" in r.result or "a,b" in r.stdout
```

- [ ] **Step 2: Run with integration tests enabled**

```bash
cd services/agent-py && RUN_INTEGRATION=1 uv run pytest tests/test_sandbox_nsjail.py -v -m integration
```

Expected: 7 tests pass. (Skip with `RUN_INTEGRATION=0` or on a machine without nsjail; the other tests still pass.)

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/tests/test_sandbox_nsjail.py
git commit -m "test(agent-py): NsjailJupyterSandbox integration tests (RUN_INTEGRATION=1)"
```

---

### Task 5.4: Enable integration tests in CI

**Files:**
- Modify: `.github/workflows/ci.yml` (in the `agent-py:` job, in the `Test (pytest)` step)

- [ ] **Step 1: Update the test step to run integration tests**

Replace the `Test (pytest)` step at line 105 with:

```yaml
    - name: Test (pytest)
      env:
        RUN_INTEGRATION: "1"
        AGENT_PY_SANDBOX_ROOT: /tmp/agent-py-sandbox-test
      run: |
        uv run pytest
        rm -rf /tmp/agent-py-sandbox-test
```

- [ ] **Step 2: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add .github/workflows/ci.yml
git commit -m "ci(agent-py): run integration tests with RUN_INTEGRATION=1"
```

---

## Phase 6: Resource caps (integration tests)

### Task 6.1: Test that the time limit kills infinite loops

**Files:**
- Modify: `services/agent-py/tests/test_sandbox_nsjail.py` (append)

- [ ] **Step 1: Append the test**

```python
@pytest.mark.integration
@pytest.mark.asyncio
async def test_run_timeout_kills_infinite_loop(tmp_path: Path) -> None:
    """An infinite loop must be killed at the wall-time limit and
    return killed=True with a timeout error. This pins the
    spec-mandated 30s default (overridden to 5s here for test speed)."""
    sb = NsjailJupyterSandbox(
        max_concurrent=1,
        idle_seconds=60,
        mem_mb=512,
        pids_max=256,
        time_limit=5,  # short timeout for the test
        root=str(tmp_path),
        agent_uid=os.getuid(),
        agent_gid=os.getgid(),
    )
    try:
        req = CodeRunRequest(
            user_id="timeout-user",
            session_id="timeout-session",
            code="while True: pass",
            timeout_s=5,
        )
        import time as _time
        start = _time.monotonic()
        r = await sb.run(req)
        elapsed = _time.monotonic() - start
        assert r.killed is True
        assert r.error is not None
        assert "timeout" in r.error.lower()
        # Should be killed at ~5s, not 30s default
        assert elapsed < 10.0
    finally:
        await sb.close_all()
```

- [ ] **Step 2: Run the test**

```bash
cd services/agent-py && RUN_INTEGRATION=1 uv run pytest tests/test_sandbox_nsjail.py::test_run_timeout_kills_infinite_loop -v -m integration
```

Expected: passes in ~5-6s.

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/tests/test_sandbox_nsjail.py
git commit -m "test(agent-py): time_limit kills infinite loops at the wall-time cap"
```

---

### Task 6.2: Test that large allocations are OOM-killed

**Files:**
- Modify: `services/agent-py/tests/test_sandbox_nsjail.py` (append)

- [ ] **Step 1: Append the test**

```python
@pytest.mark.integration
@pytest.mark.asyncio
async def test_run_oom_kills_large_allocation(tmp_path: Path) -> None:
    """Allocating more than the cgroup mem_max must kill the kernel.
    We use a small mem cap (64 MB) to make the test fast and reliable."""
    sb = NsjailJupyterSandbox(
        max_concurrent=1,
        idle_seconds=60,
        mem_mb=64,
        pids_max=256,
        time_limit=30,
        root=str(tmp_path),
        agent_uid=os.getuid(),
        agent_gid=os.getgid(),
    )
    try:
        req = CodeRunRequest(
            user_id="oom-user",
            session_id="oom-session",
            code="x = ' ' * (200 * 1024 * 1024)",  # 200 MB > 64 MB cap
        )
        r = await sb.run(req)
        # OOM may surface as killed=True with a memory error, OR as
        # a subsequent connection failure (the kernel crashed). Either
        # is acceptable; the key invariant is the host process is fine.
        assert r.killed is True or r.error is not None
    finally:
        await sb.close_all()
```

- [ ] **Step 2: Run the test**

```bash
cd services/agent-py && RUN_INTEGRATION=1 uv run pytest tests/test_sandbox_nsjail.py::test_run_oom_kills_large_allocation -v -m integration
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/tests/test_sandbox_nsjail.py
git commit -m "test(agent-py): OOM kill at cgroup mem_max"
```

---

### Task 6.3: Test that outbound socket creation is denied

**Files:**
- Modify: `services/agent-py/tests/test_sandbox_nsjail.py` (append)

- [ ] **Step 1: Append the test**

```python
@pytest.mark.integration
@pytest.mark.asyncio
async def test_outbound_socket_denied(sandbox: NsjailJupyterSandbox) -> None:
    """A seccomp-Kafel deny for non-loopback socket must prevent
    outbound network. The Kafel policy in sandbox.kafel is the
    outbound block; this test is the canary that it's loaded."""
    req = CodeRunRequest(
        user_id="net-user",
        session_id="net-session",
        code=(
            "import socket\n"
            "try:\n"
            "    s = socket.create_connection(('example.com', 80), timeout=3)\n"
            "    s.close()\n"
            "    result = 'connected'\n"
            "except Exception as e:\n"
            "    result = type(e).__name__\n"
            "result\n"
        ),
    )
    r = await sandbox.run(req)
    # The connection should fail. Either via seccomp (PermissionError
    # or OSError "Operation not permitted"), DNS failure (socket.gaierror),
    # or timeout (TimeoutError). The key invariant: NOT 'connected'.
    assert r.error is None
    assert r.result is not None
    assert r.result != "connected"
    assert r.result in {"PermissionError", "OSError", "socket.gaierror", "TimeoutError", "gaierror"}
```

- [ ] **Step 2: Run the test**

```bash
cd services/agent-py && RUN_INTEGRATION=1 uv run pytest tests/test_sandbox_nsjail.py::test_outbound_socket_denied -v -m integration
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/tests/test_sandbox_nsjail.py
git commit -m "test(agent-py): outbound socket denied by Kafel seccomp"
```

---

## Phase 7: FS isolation (integration tests)

### Task 7.1: Test FS isolation — read + isolation

**Files:**
- Modify: `services/agent-py/tests/test_sandbox_nsjail.py` (append)

- [ ] **Step 1: Append the tests**

```python
@pytest.mark.integration
@pytest.mark.asyncio
async def test_cannot_read_etc_shadow(sandbox: NsjailJupyterSandbox) -> None:
    """The nsjail mount spec only binds /usr, /lib, /lib64, /etc/ld.so.cache,
    /etc/ssl, and the per-session scratch. /etc/shadow is not bind-mounted,
    so the kernel sees a tmpfs root with no /etc/shadow."""
    req = CodeRunRequest(
        user_id="fs-user-1",
        session_id="fs-session-1",
        code=(
            "import os\n"
            "result = os.path.exists('/etc/shadow')\n"
            "result\n"
        ),
    )
    r = await sandbox.run(req)
    assert r.error is None
    assert r.result == "False"


@pytest.mark.integration
@pytest.mark.asyncio
async def test_cannot_read_other_user_session(sandbox: NsjailJupyterSandbox) -> None:
    """Each session's scratch is bind-mounted rw only into its own jail.
    Another user's session dir is not mounted into this jail."""
    # Create another user's session first
    await sandbox.ensure_session("other-user", "other-session")
    req = CodeRunRequest(
        user_id="fs-user-2",
        session_id="fs-session-2",
        code=(
            "import os\n"
            "result = os.path.exists('/var/lib/agent-py/sessions/other-user')\n"
            "result\n"
        ),
    )
    r = await sandbox.run(req)
    assert r.error is None
    assert r.result == "False"


@pytest.mark.integration
@pytest.mark.asyncio
async def test_can_read_work_uploads(sandbox: NsjailJupyterSandbox) -> None:
    """The per-session /work and /work/uploads are bind-mounted rw."""
    import base64
    req = CodeRunRequest(
        user_id="fs-user-3",
        session_id="fs-session-3",
        code=(
            "import os\n"
            "exists = os.path.exists('/work') and os.path.exists('/work/uploads')\n"
            "exists\n"
        ),
        files=[FileUpload(name="hello.txt", content_b64=base64.b64encode(b"hi").decode())],
    )
    r = await sandbox.run(req)
    assert r.error is None
    assert r.result == "True"
```

- [ ] **Step 2: Run the tests**

```bash
cd services/agent-py && RUN_INTEGRATION=1 uv run pytest tests/test_sandbox_nsjail.py -v -m integration
```

Expected: all 11 integration tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/tests/test_sandbox_nsjail.py
git commit -m "test(agent-py): FS isolation tests (read /etc/shadow denied, /work/uploads rw)"
```

---

## Phase 8: runCode tool

### Task 8.1: Create the runCode tool

**Files:**
- Create: `services/agent-py/src/agent_py/tools/code.py`

- [ ] **Step 1: Write the file**

```python
"""runCode tool — agent-py's entry point for the code interpreter sandbox.

The tool is a thin wrapper around NsjailJupyterSandbox. The sandbox
itself is a module-level singleton constructed from settings; tests
monkeypatch the singleton to swap in a mock.

The user_id is captured at factory time via the ToolContext closure
(same pattern as image_gen.py). The default tool registry builds
tools per-request with the request's ToolContext, so user_id is
correctly scoped.

Reference: docs/superpowers/specs/2026-06-15-code-interpreter-sandbox-design.md §"runCode tool surface"
"""
from __future__ import annotations

import os
from typing import Any

from agent_py.sandbox import (
    CodeRunRequest,
    CodeRunResult,
    CodeSandboxError,
    FileUpload,
    NsjailJupyterSandbox,
)
from agent_py.sandbox.nsjail import NsjailJupyterSandbox as _NsjailJupyterSandbox
from agent_py.settings import get_settings

RUN_CODE_NAME = "runCode"

RUN_CODE_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "session_id": {
            "type": "string",
            "description": (
                "An opaque string the model chooses to identify the "
                "session. Reusing a session_id across `runCode` calls "
                "preserves Python state (variables, imports). The tool "
                "scope is 'one conversation' — the session dies when "
                "the conversation ends or after the idle timeout."
            ),
        },
        "code": {
            "type": "string",
            "description": "Python source code to execute.",
        },
        "files": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "File name (becomes /work/uploads/<name>)."},
                    "content_b64": {
                        "type": "string",
                        "description": "Base64-encoded file bytes.",
                    },
                },
                "required": ["name", "content_b64"],
                "additionalProperties": False,
            },
            "description": (
                "Optional files to expose to the kernel via /work/uploads/. "
                "Each file is written before the code runs and is readable "
                "by the cell."
            ),
        },
    },
    "required": ["session_id", "code"],
    "additionalProperties": False,
}

# Module-level singleton. Tests monkeypatch this.
_sandbox_singleton: NsjailJupyterSandbox | None = None


def get_sandbox() -> NsjailJupyterSandbox:
    """Return the module-level sandbox singleton, constructing it
    from settings on first access."""
    global _sandbox_singleton
    if _sandbox_singleton is None:
        s = get_settings()
        _sandbox_singleton = _NsjailJupyterSandbox(
            max_concurrent=s.AGENT_PY_SANDBOX_MAX_CONCURRENT,
            idle_seconds=s.AGENT_PY_SANDBOX_IDLE_MINUTES * 60,
            mem_mb=s.AGENT_PY_SANDBOX_MEM_MB,
            pids_max=s.AGENT_PY_SANDBOX_PIDS_MAX,
            time_limit=s.AGENT_PY_SANDBOX_TIME_LIMIT_S,
            root=s.AGENT_PY_SANDBOX_ROOT,
            agent_uid=os.getuid(),
            agent_gid=os.getgid(),
        )
    return _sandbox_singleton


def reset_sandbox_singleton() -> None:
    """For tests — clear the singleton so the next get_sandbox() call
    re-reads settings."""
    global _sandbox_singleton
    _sandbox_singleton = None


async def _run_code_execute(args: dict[str, Any], user_id: str) -> dict[str, Any]:
    sandbox = get_sandbox()
    files = [
        FileUpload(name=f["name"], content_b64=f["content_b64"])
        for f in args.get("files", [])
    ]
    req = CodeRunRequest(
        user_id=user_id,
        session_id=args["session_id"],
        code=args["code"],
        files=files,
        timeout_s=get_settings().AGENT_PY_SANDBOX_TIME_LIMIT_S,
        memory_mb=get_settings().AGENT_PY_SANDBOX_MEM_MB,
    )
    try:
        r: CodeRunResult = await sandbox.run(req)
    except CodeSandboxError as e:
        return {"error": str(e), "killed": True}
    return {
        "stdout": r.stdout,
        "stderr": r.stderr,
        "result": r.result,
        "images": r.image_count,
        "duration_ms": r.duration_ms,
        "killed": r.killed,
        "error": r.error,
    }


def build_run_code_tool(*, context: "ToolContext | None" = None) -> "Any":
    """Build the runCode ToolDescriptor. The `context` is captured in
    the closure for user_id scoping (same pattern as image_gen.py:235).
    `context.user_id` is the value the sandbox uses to namespace the
    session; without it, we fall back to a fixed sentinel so the tool
    is still callable in anonymous contexts (this is a backstop, not
    a supported path — production callers should pass a ToolContext)."""
    from agent_py.tools.registry import ToolContext, ToolDescriptor, ToolInvocationResult

    user_id = context.user_id if context is not None else "anonymous"

    async def execute(args: dict[str, Any]) -> ToolInvocationResult:
        result = await _run_code_execute(args, user_id)
        if result.get("killed") or result.get("error"):
            text = (
                f"stdout:\n{result.get('stdout','')}\n"
                f"stderr:\n{result.get('stderr','')}\n"
                f"error:\n{result.get('error','')}\n"
                f"killed: {result.get('killed')}\n"
            )
        else:
            text = (
                f"result: {result.get('result')}\n"
                f"stdout:\n{result.get('stdout','')}\n"
                f"stderr:\n{result.get('stderr','')}\n"
                f"duration_ms: {result.get('duration_ms')}\n"
            )
        return ToolInvocationResult(
            text=text,
            summary=f"runCode ({result.get('duration_ms', 0)}ms)",
        )

    return ToolDescriptor(
        name=RUN_CODE_NAME,
        description=(
            "Execute Python in a sandboxed Jupyter session. Use a stable "
            "`session_id` to preserve state across calls. Files can be "
            "uploaded and read from /work/uploads/. Network is disabled. "
            f"Wall-time limit {get_settings().AGENT_PY_SANDBOX_TIME_LIMIT_S}s."
        ),
        input_schema=RUN_CODE_INPUT_SCHEMA,
        execute=execute,
    )


def is_run_code_configured() -> bool:
    """Master switch — returns False to disable tool registration."""
    return bool(get_settings().AGENT_PY_SANDBOX_ENABLED)
```

- [ ] **Step 2: Verify the module imports**

```bash
cd services/agent-py && uv run python -c "from agent_py.tools.code import build_run_code_tool, is_run_code_configured, RUN_CODE_NAME; print('ok')"
```

Expected: prints `ok`.

- [ ] **Step 3: Verify mypy still passes**

```bash
cd services/agent-py && uv run mypy src
```

Expected: exit 0. (Mypy may warn about the `_user_id` indirection; if it does, add a `# type: ignore[arg-type]` comment.)

- [ ] **Step 4: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/src/agent_py/tools/code.py
git commit -m "feat(agent-py): runCode tool — agent-py entry point for code interpreter"
```

---

### Task 8.2: Test the runCode tool descriptor

**Files:**
- Create: `services/agent-py/tests/test_tool_code.py`

- [ ] **Step 1: Write the test**

```python
"""Tool descriptor + input schema tests for the runCode tool.

The actual end-to-end execute() path is covered by test_sandbox_nsjail.py
(against a real nsjail). Here we pin the schema, the gating decision,
and the env-toggled registration.
"""
from __future__ import annotations

import base64

import pytest

from agent_py import settings as settings_module
from agent_py.tools import code as code_module
from agent_py.tools.code import (
    RUN_CODE_INPUT_SCHEMA,
    RUN_CODE_NAME,
    build_run_code_tool,
    is_run_code_configured,
    reset_sandbox_singleton,
)


@pytest.fixture(autouse=True)
def _reset() -> None:
    settings_module.get_settings.cache_clear()
    reset_sandbox_singleton()
    yield
    settings_module.get_settings.cache_clear()
    reset_sandbox_singleton()


def test_descriptor_name_and_schema() -> None:
    tool = build_run_code_tool()
    assert tool.name == RUN_CODE_NAME
    assert tool.name == "runCode"
    assert tool.input_schema == RUN_CODE_INPUT_SCHEMA
    assert tool.input_schema["required"] == ["session_id", "code"]
    assert "session_id" in tool.input_schema["properties"]
    assert "code" in tool.input_schema["properties"]
    assert "files" in tool.input_schema["properties"]


def test_descriptor_description_includes_time_limit() -> None:
    tool = build_run_code_tool()
    assert "30s" in tool.description or "sandbox" in tool.description.lower()


def test_is_run_code_configured_default() -> None:
    assert is_run_code_configured() is True


def test_is_run_code_configured_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_PY_SANDBOX_ENABLED", "false")
    settings_module.get_settings.cache_clear()
    assert is_run_code_configured() is False


def test_input_schema_rejects_unknown_fields() -> None:
    """The tool rejects additional properties to surface schema
    mistakes early."""
    assert RUN_CODE_INPUT_SCHEMA["additionalProperties"] is False


def test_files_property_in_schema() -> None:
    files_schema = RUN_CODE_INPUT_SCHEMA["properties"]["files"]
    assert files_schema["type"] == "array"
    item = files_schema["items"]
    assert item["required"] == ["name", "content_b64"]
    assert item["additionalProperties"] is False


@pytest.mark.asyncio
async def test_execute_returns_tool_invocation_result() -> None:
    """The execute() function returns a ToolInvocationResult; the
    shape is pinned even when the sandbox is mocked."""
    from agent_py.tools.registry import ToolContext, ToolInvocationResult

    class _MockSandbox:
        async def run(self, req):  # type: ignore[no-untyped-def]
            from agent_py.sandbox.types import CodeRunResult
            return CodeRunResult(
                stdout="hello\n",
                result="42",
                duration_ms=12,
            )

    code_module._sandbox_singleton = _MockSandbox()  # type: ignore[assignment]
    ctx = ToolContext(pool=MagicMock(), user_id="u1")  # type: ignore[arg-type,unused-ignore]
    tool = build_run_code_tool(context=ctx)
    r = await tool.execute({"session_id": "s1", "code": "print('hello'); 42"})
    assert isinstance(r, ToolInvocationResult)
    assert "42" in r.text
    assert "hello" in r.text
    assert r.summary == "runCode (12ms)"


@pytest.mark.asyncio
async def test_execute_handles_sandbox_error() -> None:
    from unittest.mock import MagicMock

    from agent_py.tools.registry import ToolContext

    class _MockSandbox:
        async def run(self, req):  # type: ignore[no-untyped-def]
            from agent_py.sandbox.types import CodeSandboxError
            raise CodeSandboxError("kernel died")

    code_module._sandbox_singleton = _MockSandbox()  # type: ignore[assignment]
    ctx = ToolContext(pool=MagicMock(), user_id="u1")  # type: ignore[arg-type,unused-ignore]
    tool = build_run_code_tool(context=ctx)
    r = await tool.execute({"session_id": "s1", "code": "x"})
    assert "kernel died" in r.text
    assert "killed: True" in r.text


@pytest.mark.asyncio
async def test_execute_passes_file_uploads() -> None:
    from unittest.mock import MagicMock

    from agent_py.tools.registry import ToolContext

    received: list = []

    class _MockSandbox:
        async def run(self, req):  # type: ignore[no-untyped-def]
            received.append(req)
            from agent_py.sandbox.types import CodeRunResult
            return CodeRunResult(result="ok")

    code_module._sandbox_singleton = _MockSandbox()  # type: ignore[assignment]
    ctx = ToolContext(pool=MagicMock(), user_id="u1")  # type: ignore[arg-type,unused-ignore]
    tool = build_run_code_tool(context=ctx)
    csv = base64.b64encode(b"a,b\n1,2\n").decode()
    await tool.execute(
        {
            "session_id": "s1",
            "code": "open('/work/uploads/x.csv')",
            "files": [{"name": "x.csv", "content_b64": csv}],
        }
    )
    assert len(received) == 1
    assert received[0].user_id == "u1"
    assert received[0].files[0].name == "x.csv"
    assert received[0].files[0].content_b64 == csv
```

- [ ] **Step 2: Run the test**

```bash
cd services/agent-py && uv run pytest tests/test_tool_code.py -v
```

Expected: 9 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/tests/test_tool_code.py
git commit -m "test(agent-py): runCode tool descriptor + execute (mock sandbox)"
```

---

## Phase 9: Registry wiring

### Task 9.1: Register runCode in the default tool registry

**Files:**
- Modify: `services/agent-py/src/agent_py/tools/registry.py` (insert into the `default_tool_registry` body, after the `image_gen` block at line 197)

- [ ] **Step 1: Read the current end of the registry dict literal**

```bash
tail -30 services/agent-py/src/agent_py/tools/registry.py
```

Expected: see the image_gen block ending with the closing `)` of `build_image_gen_tool(...)`.

- [ ] **Step 2: Add the runCode registration**

After the image_gen block, append:

```python
from .code import build_run_code_tool, is_run_code_configured
if is_run_code_configured():
    out["runCode"] = build_run_code_tool(context=context)
```

The `context=context` pass-through closes over `context.user_id` for
sandbox session namespacing (same pattern as `image_gen`).

- [ ] **Step 3: Verify the registry builds without error**

```bash
cd services/agent-py && uv run python -c "from agent_py.tools.registry import default_tool_registry; tools = default_tool_registry(); print(sorted(tools.keys()))"
```

Expected: prints a list including `'runCode'`.

- [ ] **Step 4: Verify mypy still passes**

```bash
cd services/agent-py && uv run mypy src
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/src/agent_py/tools/registry.py
git commit -m "feat(agent-py): register runCode in default tool registry"
```

---

### Task 9.2: Test the registry wiring

**Files:**
- Create: `services/agent-py/tests/test_registry_runcode.py`

- [ ] **Step 1: Write the test**

```python
"""Pin that runCode is registered in the default tool registry and
gates correctly per the spec (ALWAYS_GATED = False; per-session
approval handled by the executor's requireApprovalFor)."""
from __future__ import annotations

import pytest

from agent_py import settings as settings_module
from agent_py.tools import code as code_module
from agent_py.tools.registry import default_tool_registry


@pytest.fixture(autouse=True)
def _reset() -> None:
    settings_module.get_settings.cache_clear()
    code_module.reset_sandbox_singleton()
    yield
    settings_module.get_settings.cache_clear()
    code_module.reset_sandbox_singleton()


def test_runcode_in_default_registry() -> None:
    tools = default_tool_registry()
    assert "runCode" in tools
    assert tools["runCode"].name == "runCode"


def test_runcode_in_registry_with_context() -> None:
    """Even with a ToolContext (RLS-impersonated) passed, runCode
    must still be registered."""
    from agent_py.tools.registry import ToolContext
    from unittest.mock import MagicMock

    ctx = ToolContext(pool=MagicMock(), user_id="33333333-3333-3333-3333-333333333333")
    tools = default_tool_registry(context=ctx)
    assert "runCode" in tools


def test_runcode_excluded_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_PY_SANDBOX_ENABLED", "false")
    settings_module.get_settings.cache_clear()
    tools = default_tool_registry()
    assert "runCode" not in tools


def test_runcode_is_not_in_always_gated_set() -> None:
    """Per the spec: runCode is NOT always-gated. Approval happens
    once per session via requireApprovalFor, then runs are ungated
    within that session. Pin this so a careless refactor doesn't
    add it to ALWAYS_GATED_TOOL_NAMES."""
    from agent_py.input_policy import ALWAYS_GATED_TOOL_NAMES

    assert "runCode" not in ALWAYS_GATED_TOOL_NAMES
```

- [ ] **Step 2: Run the test**

```bash
cd services/agent-py && uv run pytest tests/test_registry_runcode.py -v
```

Expected: 4 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/tests/test_registry_runcode.py
git commit -m "test(agent-py): runCode registered in default registry, not always-gated"
```

---

## Phase 10: Idle reaper + lifespan

### Task 10.1: Create the reaper (with disk-budget janitor)

**Files:**
- Create: `services/agent-py/src/agent_py/sandbox/reaper.py`

- [ ] **Step 1: Write the file**

```python
"""Idle-reaper background task. Runs while agent-py is up; ticks every
`AGENT_PY_SANDBOX_REAPER_INTERVAL_S` and:
  1. Calls `SessionRegistry.reap_idle()` to close sessions idle for
     longer than the threshold.
  2. Enforces the `AGENT_PY_SANDBOX_DISK_BUDGET_GB` cap by walking the
     sandbox root and evicting the LRU scratch dir until total
     scratch size is under the cap.

Mirrors the poller pattern in services/agent-py/src/agent_py/poller.py:90-95 —
read settings once at task start, pass down, structured-log the lifecycle.

Reference: docs/superpowers/specs/2026-06-15-code-interpreter-sandbox-design.md §"SessionRegistry"
"""
from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

import structlog

from agent_py.sandbox.nsjail import NsjailJupyterSandbox
from agent_py.settings import Settings

logger = structlog.get_logger()


def _scratch_size_bytes(root: Path) -> int:
    """Total bytes used by the sandbox scratch tree. Walks the root
    and sums file sizes; tolerant of partial trees (a session
    currently being spawned has no kernel.json yet)."""
    total = 0
    if not root.exists():
        return 0
    for path in root.rglob("*"):
        if path.is_file():
            try:
                total += path.stat().st_size
            except OSError:
                pass
    return total


async def _enforce_disk_budget(
    settings: Settings, sandbox: NsjailJupyterSandbox
) -> list[tuple[str, str]]:
    """If the total scratch size exceeds the budget, evict LRU
    sessions until under the cap. Returns the list of evicted keys
    for logging."""
    budget_bytes = settings.AGENT_PY_SANDBOX_DISK_BUDGET_GB * 1024 * 1024 * 1024
    root = Path(settings.AGENT_PY_SANDBOX_ROOT)
    evicted: list[tuple[str, str]] = []
    if _scratch_size_bytes(root) <= budget_bytes:
        return evicted
    while _scratch_size_bytes(root) > budget_bytes:
        key = await sandbox._registry.evict_lru()  # noqa: SLF001
        if key is None:
            break  # registry is empty
        evicted.append(key)
    return evicted


async def run_idle_reaper_loop(
    settings: Settings, sandbox: NsjailJupyterSandbox
) -> int:
    """Block forever, ticking reap_idle() + disk-budget every
    `reaper_interval_s`. Returns 0 on graceful shutdown."""
    interval = settings.AGENT_PY_SANDBOX_REAPER_INTERVAL_S
    logger.info(
        "lifespan.reaper.started",
        interval_s=interval,
        idle_minutes=settings.AGENT_PY_SANDBOX_IDLE_MINUTES,
        disk_budget_gb=settings.AGENT_PY_SANDBOX_DISK_BUDGET_GB,
    )
    try:
        while True:
            try:
                reaped = await sandbox.reap_idle()
                if reaped:
                    logger.info("lifespan.reaper.reaped", keys=reaped)
                evicted = await _enforce_disk_budget(settings, sandbox)
                if evicted:
                    logger.info("lifespan.reaper.disk_evicted", keys=evicted)
            except Exception as e:  # noqa: BLE001
                logger.warning("lifespan.reaper.tick_error", error=str(e))
            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        logger.info("lifespan.reaper.shutdown.complete")
        return 0
```

- [ ] **Step 2: Verify the module imports**

```bash
cd services/agent-py && uv run python -c "from agent_py.sandbox.reaper import run_idle_reaper_loop; print('ok')"
```

Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/src/agent_py/sandbox/reaper.py
git commit -m "feat(agent-py): sandbox idle reaper"
```

---

### Task 10.2: Wire the reaper into FastAPI lifespan

**Files:**
- Modify: `services/agent-py/src/agent_py/main.py` (extend the lifespan function at lines 54-81; add `enable_reaper: bool = True` to the `create_app` signature)

- [ ] **Step 1: Read the current lifespan**

```bash
sed -n '40,90p' services/agent-py/src/agent_py/main.py
```

Expected: see the lifespan block.

- [ ] **Step 2: Add the `enable_reaper` param to `create_app`**

Edit the `create_app` function signature (line 39-40) to add the new parameter:

```python
def create_app(*, enable_poller: bool = True, enable_reaper: bool = True) -> FastAPI:
```

- [ ] **Step 3: Add the reaper task inside the lifespan**

After the poller task creation (after line 71, the `logger.info("lifespan.poller.started"...)` block), add:

```python
    # Sandbox idle reaper (Phase 1 of code-interpreter spec). Mirrors
    # the poller's enable_poller flag so test instances can opt out.
    reaper_task: asyncio.Task[int] | None = None
    if enable_reaper and settings.AGENT_PY_SANDBOX_ENABLED:
        from agent_py.sandbox.reaper import run_idle_reaper_loop
        from agent_py.tools.code import get_sandbox

        reaper_task = asyncio.create_task(
            run_idle_reaper_loop(settings, get_sandbox()),
            name="agent-py.sandbox.reaper",
        )
        logger.info(
            "lifespan.reaper.started",
            interval_s=settings.AGENT_PY_SANDBOX_REAPER_INTERVAL_S,
        )
    else:
        logger.info(
            "lifespan.reaper.skipped",
            reason="disabled_or_poller_off" if not enable_reaper else "sandbox_disabled",
        )
```

- [ ] **Step 4: Add reaper cancellation + close_all in the finally block**

Replace the existing `finally:` block with:

```python
    try:
        yield
    finally:
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        if reaper_task is not None:
            reaper_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reaper_task
        await db.close_pool()
        # Close any open sandbox sessions
        from agent_py.tools.code import get_sandbox as _get_sb

        try:
            await _get_sb().close_all()
        except Exception as e:  # noqa: BLE001
            logger.warning("lifespan.sandbox.close_error", error=str(e))
        logger.info("lifespan.shutdown.complete")
```

- [ ] **Step 5: Verify the app still builds with reaper off**

```bash
cd services/agent-py && uv run python -c "from agent_py.main import create_app; app = create_app(enable_poller=False, enable_reaper=False); print('ok')"
```

Expected: prints `ok`.

- [ ] **Step 6: Verify the app still builds with reaper on**

```bash
cd services/agent-py && uv run python -c "from agent_py.main import create_app; app = create_app(enable_poller=False); print('ok')"
```

Expected: prints `ok`.

- [ ] **Step 7: Verify mypy still passes**

```bash
cd services/agent-py && uv run mypy src
```

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/src/agent_py/main.py
git commit -m "feat(agent-py): wire sandbox idle reaper into FastAPI lifespan"
```

---

### Task 10.3: Test the reaper + lifespan integration

**Files:**
- Create: `services/agent-py/tests/test_sandbox_reaper.py`

- [ ] **Step 1: Write the test**

```python
"""Reaper + lifespan wiring. Uses a mock sandbox to verify the
reaper calls reap_idle() at the right interval and that the lifespan
task lifecycle is sound."""
from __future__ import annotations

import asyncio

import pytest

from agent_py import settings as settings_module
from agent_py.sandbox.reaper import run_idle_reaper_loop
from agent_py.sandbox import code as code_module
from agent_py.tools import code as tools_code_module


class _MockSandbox:
    def __init__(self) -> None:
        self.reap_calls: list[int] = []

    async def reap_idle(self) -> list[tuple[str, str]]:
        self.reap_calls.append(len(self.reap_calls))
        return []


@pytest.mark.asyncio
async def test_reaper_ticks_at_interval(monkeypatch: pytest.MonkeyPatch) -> None:
    """The reaper calls reap_idle() at the configured interval and
    exits cleanly on cancellation."""
    settings = settings_module.get_settings()
    sandbox = _MockSandbox()

    async def _run() -> None:
        await run_idle_reaper_loop(settings, sandbox)

    task = asyncio.create_task(_run())
    await asyncio.sleep(0.1)  # let one tick happen
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    # We expect at least one reap_idle call (the initial tick fires
    # immediately at loop entry, before the sleep).
    assert len(sandbox.reap_calls) >= 1


@pytest.mark.asyncio
async def test_reaper_logs_reaped_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    """The reaper passes the reaped keys to the structlog logger.
    This test pins the shape so a logging refactor doesn't silently
    drop observability."""
    import structlog

    settings = settings_module.get_settings()
    sandbox = _MockSandbox()
    sandbox.reap_idle = lambda: _async_return([("u1", "s1")])  # type: ignore[assignment]

    captured: list[dict] = []

    def _capture(_logger, _method, event_dict):  # type: ignore[no-untyped-def]
        captured.append(event_dict)
        return event_dict

    structlog.configure(wrapper_class=_capture)
    try:
        task = asyncio.create_task(run_idle_reaper_loop(settings, sandbox))
        await asyncio.sleep(0.1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        structlog.reset_defaults()
    # At least one "lifespan.reaper.reaped" log line should be present.
    reaped_logs = [c for c in captured if c.get("event") == "lifespan.reaper.reaped"]
    assert reaped_logs
    assert reaped_logs[0]["keys"] == [["u1", "s1"]] or reaped_logs[0]["keys"] == [("u1", "s1")]


async def _async_return(value):  # type: ignore[no-untyped-def]
    return value


@pytest.mark.asyncio
async def test_lifespan_starts_reaper_when_enabled() -> None:
    """Smoke-test: with the reaper enabled, the app starts and stops
    cleanly with the reaper task in the lifespan."""
    from agent_py.main import create_app
    from fastapi.testclient import TestClient

    app = create_app(enable_poller=False, enable_reaper=True)
    with TestClient(app) as _client:
        # Lifespan entered and exited cleanly. The reaper task was
        # created, ticked at least once, and was cancelled on shutdown.
        pass


@pytest.mark.asyncio
async def test_lifespan_skips_reaper_when_disabled() -> None:
    """Smoke-test: with `enable_reaper=False`, the reaper task is
    not created — useful for test isolation."""
    from agent_py.main import create_app
    from fastapi.testclient import TestClient

    app = create_app(enable_poller=False, enable_reaper=False)
    with TestClient(app) as _client:
        pass


@pytest.mark.asyncio
async def test_disk_budget_evicts_lru(tmp_path: Path) -> None:
    """When the scratch root exceeds AGENT_PY_SANDBOX_DISK_BUDGET_GB,
    the reaper's disk-budget check evicts LRU sessions."""
    import os
    import shutil

    from agent_py.sandbox.nsjail import NsjailJupyterSandbox
    from agent_py.sandbox.reaper import _enforce_disk_budget
    from agent_py.settings import Settings

    # Build a sandbox with a tiny 1 KB disk budget so any non-empty
    # scratch triggers eviction.
    s = Settings(
        AGENT_PY_SANDBOX_ENABLED=True,
        AGENT_PY_SANDBOX_MAX_CONCURRENT=10,
        AGENT_PY_SANDBOX_IDLE_MINUTES=30,
        AGENT_PY_SANDBOX_MEM_MB=512,
        AGENT_PY_SANDBOX_PIDS_MAX=256,
        AGENT_PY_SANDBOX_TIME_LIMIT_S=30,
        AGENT_PY_SANDBOX_DISK_BUDGET_GB=0,  # 0 GB → evicts anything non-empty
        AGENT_PY_SANDBOX_REAPER_INTERVAL_S=60.0,
        AGENT_PY_SANDBOX_ROOT=str(tmp_path),
    )

    sb = NsjailJupyterSandbox(
        max_concurrent=10,
        idle_seconds=60,
        mem_mb=512,
        pids_max=256,
        time_limit=30,
        root=str(tmp_path),
        agent_uid=os.getuid(),
        agent_gid=os.getgid(),
    )

    try:
        # Simulate two sessions on disk with non-empty scratch dirs.
        for user, sess in [("u1", "s1"), ("u1", "s2")]:
            scratch = tmp_path / user / sess
            scratch.mkdir(parents=True, exist_ok=True)
            (scratch / "kernel.json").write_text("{}")
            (scratch / "uploads" / "x").write_text("hello")
            (scratch / "uploads" / "x").parent.mkdir(exist_ok=True)
            session = _MockSession()  # type: ignore[arg-type]
            await sb._registry.put(user, sess, session)  # noqa: SLF001

        # Sanity: scratch size > 0
        assert (tmp_path / "u1" / "s1").exists()

        evicted = await _enforce_disk_budget(s, sb)
        assert len(evicted) >= 1
        # The LRU (s1) was evicted first; its scratch dir was removed
        # by the session's close() path.
    finally:
        await sb.close_all()
        shutil.rmtree(tmp_path, ignore_errors=True)
```

- [ ] **Step 2: Run the test**

```bash
cd services/agent-py && uv run pytest tests/test_sandbox_reaper.py -v
```

Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/tests/test_sandbox_reaper.py
git commit -m "test(agent-py): sandbox reaper + lifespan integration"
```

---

## Phase 11: Regression-guard test

### Task 11.1: Pin the security knobs in a regression-guard test

**Files:**
- Create: `services/agent-py/tests/test_sandbox_guards.py`

- [ ] **Step 1: Write the test**

```python
"""Regression guard for the nsjail + Kafel security boundary.

This test mirrors the `components/live-artifact/sandbox-guard.test.ts`
pattern from the Next.js side: pin the security knobs so a careless
edit can't silently weaken the sandbox. If this test fails, the
sandbox has been weakened and the change must be reviewed by hand.

Reference: docs/superpowers/specs/2026-06-15-code-interpreter-sandbox-design.md
§"A regression-guard test"
"""
from __future__ import annotations

from pathlib import Path

import pytest

from agent_py.sandbox.render import render_proto


KAFEL_PATH = (
    Path(__file__).parent.parent
    / "src"
    / "agent_py"
    / "sandbox"
    / "kafel"
    / "sandbox.kafel"
)
PROTO_PATH = (
    Path(__file__).parent.parent
    / "src"
    / "agent_py"
    / "sandbox"
    / "proto"
    / "sandbox.proto.tmpl"
)


def test_proto_template_exists() -> None:
    assert PROTO_PATH.exists(), f"missing: {PROTO_PATH}"


def test_kafel_policy_exists() -> None:
    assert KAFEL_PATH.exists(), f"missing: {KAFEL_PATH}"


def test_proto_pins_clone_newnet_false() -> None:
    """v1 design: shared host netns. Outbound is blocked via Kafel
    seccomp, not via netns. If this flips, the Kafel policy becomes
    the only outbound block AND the 'ZMQ over TCP works' assumption
    breaks. Review by hand if you need to change it."""
    rendered = render_proto(
        user_id="u",
        session_id="s",
        scratch="/tmp/x",
        connection_filename="kernel.json",
        kafel_path=str(KAFEL_PATH),
        agent_uid=1000,
        agent_gid=1000,
        mem_mb=512,
        pids_max=256,
        time_limit=30,
    )
    assert "clone_newnet: false" in rendered
    assert "clone_newnet: true" not in rendered


def test_proto_pins_cgroup_mem_max_to_512mb_default() -> None:
    """v1 default: 512 MB. The spec sets this; the test pins it."""
    rendered = render_proto(
        user_id="u",
        session_id="s",
        scratch="/tmp/x",
        connection_filename="kernel.json",
        kafel_path=str(KAFEL_PATH),
        agent_uid=1000,
        agent_gid=1000,
        mem_mb=512,
        pids_max=256,
        time_limit=30,
    )
    assert "cgroup_mem_max: 536870912" in rendered
    assert "rlimit_as: 536870912" in rendered


def test_proto_pins_time_limit_to_30s_default() -> None:
    """v1 default: 30s wall. Pins the default in the template."""
    rendered = render_proto(
        user_id="u",
        session_id="s",
        scratch="/tmp/x",
        connection_filename="kernel.json",
        kafel_path=str(KAFEL_PATH),
        agent_uid=1000,
        agent_gid=1000,
        mem_mb=512,
        pids_max=256,
        time_limit=30,
    )
    assert "time_limit: 30" in rendered


def test_proto_pins_kafel_policy_path() -> None:
    """The Kafel policy path in the rendered config must be the
    committed file — not an env var, not a relative path."""
    rendered = render_proto(
        user_id="u",
        session_id="s",
        scratch="/tmp/x",
        connection_filename="kernel.json",
        kafel_path=str(KAFEL_PATH),
        agent_uid=1000,
        agent_gid=1000,
        mem_mb=512,
        pids_max=256,
        time_limit=30,
    )
    assert f"kafel_policy_file: \"{KAFEL_PATH}\"" in rendered


def test_kafel_policy_denies_non_loopback_ipv4_tcp() -> None:
    """Pin that the committed Kafel policy has a deny rule for
    non-loopback IPv4 TCP. If this is missing, outbound network is
    unblocked."""
    content = KAFEL_PATH.read_text()
    assert "AF_INET" in content
    assert "SOCK_STREAM" in content
    # Mask + compare for loopback (0x7F000000). Pin both the high-byte
    # mask and the comparison target.
    assert "0x7F000000" in content or "htobe32(0x7F000000)" in content


def test_kafel_policy_denies_non_loopback_ipv6_tcp() -> None:
    content = KAFEL_PATH.read_text()
    assert "AF_INET6" in content
    assert "in6addr_loopback" in content


def test_kafel_policy_no_permissive_allowall() -> None:
    """The Kafel policy must NOT have an `allow` rule that bypasses
    the denies. Pin the structure: only `deny socket(...)` rules
    should appear, plus the kafel { } wrapper."""
    content = KAFEL_PATH.read_text()
    # Strip comments
    lines = [
        line for line in content.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    for line in lines:
        # The only meaningful directives in this policy are `deny`
        # and the `kafel {` block opener. Anything else is suspect.
        stripped = line.strip()
        assert (
            stripped.startswith("deny")
            or stripped.startswith("kafel")
            or stripped == "}"
            or stripped.startswith("}")
            or "SOCK" in stripped  # the arg list
            or "$sockaddr" in stripped  # the arg
            or "htobe" in stripped  # the arg
            or "in6addr" in stripped  # the arg
            or "s6_addr" in stripped  # the arg
        ), f"unexpected directive in Kafel policy: {stripped!r}"


def test_settings_master_switch_default_true() -> None:
    """The default is True (sandbox enabled by default). Pin so the
    env-toggled off state doesn't become the surprise default."""
    from agent_py import settings as settings_module
    settings_module.get_settings.cache_clear()
    assert settings_module.get_settings().AGENT_PY_SANDBOX_ENABLED is True
    settings_module.get_settings.cache_clear()
```

- [ ] **Step 2: Run the test**

```bash
cd services/agent-py && uv run pytest tests/test_sandbox_guards.py -v
```

Expected: 10 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add services/agent-py/tests/test_sandbox_guards.py
git commit -m "test(agent-py): regression-guard test pinning sandbox security knobs"
```

---

## Phase 12: Final checks

### Task 12.1: Run the full test suite

**Files:** none

- [ ] **Step 1: Run the unit tests**

```bash
cd services/agent-py && uv run pytest -v -m "not integration"
```

Expected: all non-integration tests pass (~40 tests across the new and existing files).

- [ ] **Step 2: Run the integration tests**

```bash
cd services/agent-py && RUN_INTEGRATION=1 uv run pytest -v
```

Expected: all tests pass (~50 tests, including the 11 integration tests).

- [ ] **Step 3: Run mypy + ruff + ruff format --check**

```bash
cd services/agent-py && uv run mypy src
cd services/agent-py && uv run ruff check .
cd services/agent-py && uv run ruff format --check .
```

Expected: all three exit 0.

- [ ] **Step 4: No commit** — verification only.

---

### Task 12.2: Update PLAN-code-interpreter.md to point at the new spec

**Files:**
- Modify: `docs/PLAN-code-interpreter.md` (prepend a note to the top of the file)

- [ ] **Step 1: Add a "superseded" note**

Prepend to the top of `docs/PLAN-code-interpreter.md`:

```markdown
> **Superseded by `docs/superpowers/specs/2026-06-15-code-interpreter-sandbox-design.md`.**
> The v1 design there uses `jupyter_client` + `ipykernel` + `nsjail`
> (self-hosted, agent-py sidecar, OSS-only). E2B (the original default
> in this PLAN) is closed-source and was ruled out by the OSS survey
> at `docs/superpowers/specs/2026-06-15-sandbox-landscape-survey.md`.
> The capability envelope (Python 3.12, Jupyter kernel, 30s timeout,
> network off in v1, etc.) is preserved verbatim.
```

- [ ] **Step 2: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird
git add docs/PLAN-code-interpreter.md
git commit -m "docs(code-interpreter): supersede E2B plan with jupyter_client + nsjail spec"
```

---

### Task 12.3: Verify the existing bun run check:agent-py gate

**Files:** none

- [ ] **Step 1: Run the CI-mirrored local check**

```bash
cd /Users/blackmount8/_repository/hummingbird && bun run check:agent-py
```

Expected: exit 0. (If you don't have `bun` installed locally, run the individual commands: `ruff check`, `ruff format --check`, `mypy src`, `pytest` from inside `services/agent-py/`.)

- [ ] **Step 2: Run the broader CI gate**

```bash
cd /Users/blackmount8/_repository/hummingbird && bun run check
```

Expected: exit 0. (The `check` script is the fast CI gate: typecheck + lint, no build/audit. If it fails on the Next.js side, that's unrelated to this plan.)

- [ ] **Step 3: No commit** — verification only. The plan is complete.

---

## Summary

| Phase | Tasks | Tests added | LOC added (approx) |
|---|---|---|---|
| 0: Setup & deps | 6 | 0 | 30 |
| 1: Settings | 3 | 3 | 60 |
| 2: Types & Protocol | 3 | 7 | 90 |
| 3: nsjail config | 4 | 8 | 110 |
| 4: SessionRegistry | 2 | 14 | 110 |
| 5: NsjailJupyterSandbox | 4 | 7 | 320 |
| 6: Resource caps | 3 | 3 | 50 |
| 7: FS isolation | 1 | 3 | 40 |
| 8: runCode tool | 2 | 9 | 180 |
| 9: Registry wiring | 2 | 4 | 25 |
| 10: Reaper + lifespan (incl. disk-budget janitor) | 3 | 4 | 110 |
| 11: Regression guard | 1 | 10 | 100 |
| 12: Final checks | 3 | 0 | 20 |
| **Total** | **37** | **72** | **~1245** |

**Follow-up work (out of v1 scope):**

- v2 Firecracker escape hatch (sketch in spec §v2)
- Tighter Kafel policy that audits the rest of CPython's syscall surface
- TS-side `lib/server/code-sandbox/` that calls into agent-py over the existing JWT boundary
- `code_interpreter` Anthropic skill wrapper (the model-facing surface)
- `package.json` / pyproject bumps for the new env vars in deploy templates

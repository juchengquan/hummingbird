"""The microsandbox adapter against a fake SDK, and the startup check (wave 8,
Q92). A real microVM runs in `test_code_sandbox_live.py` (opt-in)."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any

import pytest
from microsandbox import ExecTimeoutError

from agent_py.code_sandbox import microsandbox_sandbox as adapter
from agent_py.code_sandbox.config import SandboxLimits
from agent_py.code_sandbox.select import Host, sandbox, why_unavailable
from agent_py.code_sandbox.types import CodeRunInput, MountFile
from agent_py.settings import Settings


@dataclass
class Entry:
    path: str
    kind: str
    size: int


@dataclass
class Out:
    stdout_text: str = ""
    stderr_text: str = ""
    exit_code: int = 0


@dataclass
class FakeFs:
    files: dict[str, bytes] = field(default_factory=dict)

    async def mkdir(self, path: str) -> None:
        pass

    async def write(self, path: str, data: bytes) -> None:
        self.files[path] = data

    async def list(self, path: str) -> list[Entry]:
        prefix = path.rstrip("/") + "/"
        out = []
        for p, data in self.files.items():
            rest = p[len(prefix) :] if p.startswith(prefix) else None
            if rest and "/" not in rest:
                out.append(Entry(p, "file", len(data)))
        if not out and path == "/tmp/outputs":
            raise RuntimeError("readdir: No such file or directory")
        return out

    async def read(self, path: str) -> bytes:
        return self.files[path]


class FakeSb:
    def __init__(self, world: World) -> None:
        self.world = world
        self.fs = FakeFs()
        self.stopped = False

    async def exec(self, cmd: str, args: list[str], *, timeout: float) -> Out:
        self.world.execs.append((cmd, args, timeout))
        return await self.world.behave(self)

    async def stop(self, timeout: float | None = None) -> None:
        self.stopped = True
        self.world.stops += 1


@dataclass
class World:
    created: list[dict[str, Any]] = field(default_factory=list)
    execs: list[tuple[str, list[str], float]] = field(default_factory=list)
    boxes: list[FakeSb] = field(default_factory=list)
    stops: int = 0
    behaviour: Any = None
    fail_boot: bool = False

    async def create(self, name: str, **options: Any) -> FakeSb:
        if self.fail_boot:
            raise RuntimeError("image pull failed")
        self.created.append({"name": name, **options})
        sb = FakeSb(self)
        self.boxes.append(sb)
        return sb

    async def behave(self, sb: FakeSb) -> Out:
        if self.behaviour is None:
            return Out(stdout_text="ok\n")
        result: Out = await self.behaviour(sb)
        return result


def _run(world: World, lim: SandboxLimits | None = None, **kw: Any) -> Any:
    box = adapter.MicrosandboxSandbox(lim or SandboxLimits(), create=world.create)
    ri = CodeRunInput(
        code=kw.pop("code", "print(1)"),
        language=kw.pop("language", "python"),
        timeout_ms=5000,
        **kw,
    )
    return box.run(ri)


async def test_a_run_boots_without_network_mounts_execs_reads_back_and_stops() -> None:
    world = World()

    async def behave(sb: FakeSb) -> Out:
        sb.fs.files["/tmp/plot.png"] = b"PNG"
        sb.fs.files["/tmp/t.table.json"] = json.dumps({"columns": ["a"], "rows": [[1]]}).encode()
        sb.fs.files["/tmp/scratch.txt"] = b"not returned"
        sb.fs.files["/tmp/outputs/r.csv"] = b"x\n1\n"
        return Out(stdout_text="hi\n")

    world.behaviour = behave
    r = await _run(world, files=(MountFile("/mnt/files/a.csv", b"a,b"),))
    (opts,) = world.created
    from microsandbox import Network

    assert opts["image"] == "jupyter/scipy-notebook" and opts["ephemeral"] is True
    assert opts["network"] == Network.none() and (opts["cpus"], opts["memory"]) == (1, 512)
    assert world.boxes[0].fs.files["/mnt/files/a.csv"] == b"a,b"
    assert world.execs == [("python3", ["-c", "print(1)"], 5.0)]
    assert r.ok and r.stdout == "hi\n"
    assert {"type": "image", "format": "png", "data": "UE5H"} in r.results
    assert {"type": "table", "columns": ["a"], "rows": [["1"]]} in r.results
    assert [(f.name, f.mime_type, f.size_bytes) for f in r.files] == [("r.csv", "text/csv", 4)]
    assert world.stops == 1


async def test_javascript_runs_node() -> None:
    world = World()
    await _run(world, language="javascript", code="console.log(1)")
    assert world.created[0]["image"] == "node"
    assert world.execs[0][:2] == ("node", ["-e", "console.log(1)"])


async def test_an_exec_timeout_is_a_timeout_result_and_the_vm_stops() -> None:
    world = World()

    async def behave(_sb: FakeSb) -> Out:
        raise ExecTimeoutError("exec timed out")

    world.behaviour = behave
    r = await _run(world)
    assert not r.ok and r.error is not None and r.error.code == "timeout"
    assert world.stops == 1


async def test_a_boot_failure_is_an_upstream_result() -> None:
    r = await _run(World(fail_boot=True))
    assert not r.ok and r.error is not None
    assert (r.error.code, r.error.message) == ("upstream", "image pull failed")


async def test_a_cancelled_run_stops_its_vm_and_frees_its_slot() -> None:
    world = World()
    started = asyncio.Event()

    async def behave(_sb: FakeSb) -> Out:
        started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    world.behaviour = behave
    lim = SandboxLimits(max_concurrent=1)
    task = asyncio.create_task(_run(world, lim))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert world.stops == 1
    world.behaviour = None
    r = await asyncio.wait_for(_run(world, lim), 2)
    assert r.ok


async def test_runs_past_the_limit_wait_for_a_slot() -> None:
    world = World()
    gate = asyncio.Event()

    async def behave(_sb: FakeSb) -> Out:
        await gate.wait()
        return Out()

    world.behaviour = behave
    lim = SandboxLimits(max_concurrent=1)
    first = asyncio.create_task(_run(world, lim))
    second = asyncio.create_task(_run(world, lim))
    await asyncio.sleep(0.05)
    assert len(world.created) == 1
    gate.set()
    await asyncio.gather(first, second)
    assert len(world.created) == 2


async def test_read_back_stops_at_the_file_count_and_skips_what_cannot_fit() -> None:
    world = World()

    async def behave(sb: FakeSb) -> Out:
        sb.fs.files["/tmp/big.png"] = b"x" * 50
        for i in range(5):
            sb.fs.files[f"/tmp/p{i}.png"] = b"P"
        return Out()

    world.behaviour = behave
    r = await _run(world, SandboxLimits(result_file_max=3, result_cap=40))
    assert len([c for c in r.results if c["type"] == "image"]) == 3


# --- the startup check ---------------------------------------------------------------


def _host(**kw: Any) -> Host:
    base: dict[str, Any] = {
        "system": "Linux",
        "machine": "x86_64",
        "env": {},
        "kvm_usable": lambda: False,
        "sdk_installed": lambda: True,
    }
    base.update(kw)
    return Host(**base)


ON = Settings(CODE_SANDBOX_ENABLED="1")


@pytest.mark.parametrize(
    ("settings", "host", "ok"),
    [
        (Settings(CODE_SANDBOX_ENABLED=""), _host(kvm_usable=lambda: True), False),
        (Settings(CODE_SANDBOX_BASE_URL="http://sbx"), _host(kvm_usable=lambda: True), True),
        (ON, _host(kvm_usable=lambda: True), True),
        (ON, _host(), False),
        (ON, _host(system="Darwin", machine="arm64"), True),
        (ON, _host(system="Darwin", machine="x86_64"), False),
        (ON, _host(env={"MSB_BACKEND": "remote", "MSB_API_KEY": "k"}), True),
        (ON, _host(env={"MSB_BACKEND": "remote"}), False),
        (ON, _host(kvm_usable=lambda: True, sdk_installed=lambda: False), False),
    ],
)
def test_the_startup_check(settings: Settings, host: Host, ok: bool) -> None:
    assert (why_unavailable(settings, host) is None) is ok
    assert (sandbox(settings, host) is not None) is ok


@pytest.mark.parametrize("flag", ["1", "true", "YES", "on"])
def test_the_flag_reads_as_on_next(flag: str) -> None:
    assert (
        why_unavailable(Settings(CODE_SANDBOX_ENABLED=flag), _host(kvm_usable=lambda: True)) is None
    )

"""`CodeSandbox` over microsandbox's Python SDK (`microsandbox-client.ts`).

One run: take a slot (at most `max_concurrent` VMs in this process), boot an
ephemeral microVM with no network, write the mounted files, exec the code
under the timeout, read back charts / tables from `/tmp` and files from
`/tmp/outputs` under one count and byte budget, stop the VM. A cancelled run
(`asyncio.CancelledError`, e.g. the run was stopped) stops the VM at once and
frees its slot. Runtime failures become an `upstream` result, never a raise.

The SDK is the `sandbox` extra: imported lazily, so this module loads
without it (`select.sandbox` checks the import first)."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import re
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import structlog

from .config import MOUNT_DIR, OUTPUT_DIR, RESULT_DIR, SandboxLimits
from .marshal import RawRun, to_code_run_result
from .mime import mime_for_name
from .types import CodeRunInput, CodeRunResult

logger = structlog.get_logger(__name__)

_IMAGE = re.compile(r"\.(png|svg)$", re.IGNORECASE)
_TABLE = re.compile(r"\.table\.json$", re.IGNORECASE)
_STOP_TIMEOUT_S = 10.0

#: `create(name, **options)` → a booted sandbox (`fs`, `exec`, `stop`). The
#: SDK's `Sandbox.create` in production; tests pass a fake.
CreateFn = Callable[..., Awaitable[Any]]

_slots: asyncio.Semaphore | None = None
_slots_size = 0


def _slot_limiter(size: int) -> asyncio.Semaphore:
    """The process-wide VM limit (module level on purpose: a sandbox is
    built per run, so a per-instance limiter would bound nothing)."""
    global _slots, _slots_size
    if _slots is None or _slots_size != size:
        _slots, _slots_size = asyncio.Semaphore(max(1, size)), size
    return _slots


def _runtime(language: str, lim: SandboxLimits) -> tuple[str, str, str]:
    """(image, command, inline-code flag), as `runtime.ts`."""
    if language == "javascript":
        return lim.js_image, "node", "-e"
    return lim.python_image, "python3", "-c"


def _sdk_create() -> CreateFn:
    from microsandbox import Sandbox

    return Sandbox.create


def _is_timeout(exc: BaseException) -> bool:
    return type(exc).__name__ == "ExecTimeoutError" or getattr(exc, "code", None) == "exec-timeout"


def _abs(path: str, directory: str) -> str:
    return path if path.startswith("/") else f"{directory}/{path}"


class MicrosandboxSandbox:
    def __init__(self, lim: SandboxLimits, *, create: CreateFn | None = None) -> None:
        self._lim = lim
        self._create = create

    async def run(self, run_input: CodeRunInput) -> CodeRunResult:
        async with _slot_limiter(self._lim.max_concurrent):
            return await self._run(run_input)

    async def _run(self, run_input: CodeRunInput) -> CodeRunResult:
        lim = self._lim
        image, cmd, flag = _runtime(run_input.language, lim)
        sb: Any = None
        try:
            from microsandbox import Network

            create = self._create or _sdk_create()
            timeout_s = run_input.timeout_ms / 1000
            sb = await create(
                f"runcode-{uuid.uuid4().hex[:12]}",
                image=image,
                cpus=lim.cpus,
                memory=lim.mem_mib,
                network=Network.none(),
                ephemeral=True,
                # A VM this process loses track of still dies.
                max_duration=int(timeout_s) + 120,
            )
            if run_input.files:
                with contextlib.suppress(Exception):  # may exist already
                    await sb.fs.mkdir(MOUNT_DIR)
                for f in run_input.files:
                    await sb.fs.write(f.path, f.data)
            stdout = stderr = ""
            exit_code = 0
            timed_out = False
            try:
                out = await sb.exec(cmd, [flag, run_input.code], timeout=timeout_s)
                stdout, stderr, exit_code = out.stdout_text, out.stderr_text, out.exit_code
            except Exception as exc:
                if not _is_timeout(exc):
                    raise
                timed_out, exit_code = True, 124
            images, tables = await self._read_results(sb)
            files = await self._read_outputs(sb)
            return to_code_run_result(
                RawRun(
                    stdout=stdout,
                    stderr=stderr,
                    exit_code=exit_code,
                    images=images,
                    timed_out=timed_out,
                    tables=tables,
                    files=files,
                ),
                lim,
            )
        except Exception as exc:  # not CancelledError: a stopped run stops
            logger.warning("code_sandbox.run_failed", error=str(exc), kind=type(exc).__name__)
            message = str(exc) or "Sandbox failed to run."
            return to_code_run_result(
                RawRun(
                    stdout="",
                    stderr="",
                    exit_code=1,
                    images=[],
                    timed_out=False,
                    upstream_error=message,
                ),
                lim,
            )
        finally:
            if sb is not None:
                # Shielded: a cancelled run must still stop its VM.
                await asyncio.shield(_stop(sb))

    async def _read_results(self, sb: Any) -> tuple[list[tuple[str, str]], list[Any]]:
        """Charts and tables in `/tmp`, bounded before reading: at most
        `result_file_max` files, none whose listed size can't fit."""
        images: list[tuple[str, str]] = []
        tables: list[Any] = []
        try:
            entries = await sb.fs.list(RESULT_DIR)
        except Exception:
            return images, tables
        used = read = 0
        for entry in entries:
            if read >= self._lim.result_file_max:
                break
            if entry.kind != "file":
                continue
            path = _abs(entry.path, RESULT_DIR)
            is_table = bool(_TABLE.search(path))
            if not is_table and not _IMAGE.search(path):
                continue
            if used + entry.size > self._lim.result_cap:
                continue
            try:
                data = await sb.fs.read(path)
            except Exception:
                continue
            used += len(data)
            read += 1
            if is_table:
                with contextlib.suppress(UnicodeDecodeError, ValueError):
                    tables.append(json.loads(data.decode("utf-8")))
            else:
                fmt = "svg" if path.lower().endswith(".svg") else "png"
                images.append((fmt, base64.b64encode(data).decode("ascii")))
        return images, tables

    async def _read_outputs(self, sb: Any) -> list[tuple[str, str, str]]:
        """Whole files in `/tmp/outputs` (usually absent), same budget."""
        files: list[tuple[str, str, str]] = []
        try:
            entries = await sb.fs.list(OUTPUT_DIR)
        except Exception:
            return files
        used = read = 0
        for entry in entries:
            if read >= self._lim.result_file_max:
                break
            if entry.kind != "file":
                continue
            if used + entry.size > self._lim.result_cap:
                continue
            path = _abs(entry.path, OUTPUT_DIR)
            try:
                data = await sb.fs.read(path)
            except Exception:
                continue
            used += len(data)
            read += 1
            name = path.rsplit("/", 1)[-1]
            files.append((name, mime_for_name(name), base64.b64encode(data).decode("ascii")))
        return files


async def _stop(sb: Any) -> None:
    try:
        await sb.stop(timeout=_STOP_TIMEOUT_S)
    except Exception:
        try:
            await sb.kill()
        except Exception as exc:
            logger.warning("code_sandbox.stop_failed", error=str(exc))

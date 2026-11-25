"""Model-named files → guest paths and bytes, by the run's `sandboxFiles`
manifest (`mount-files.ts`). Never raises: every miss is a note the tool
puts in front of stderr, so the model can adapt.

A manifest entry is a cloud file by id (`download` fetches it, checking the
owner — `file_access.download_user_file`) or, for a signed-out caller, inline
base64 (Q44). A background run's manifest never has inline data (Q93)."""

from __future__ import annotations

import base64
import binascii
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field

from .config import MOUNT_DIR, SandboxLimits
from .types import MountFile

Download = Callable[[str], Awaitable[bytes | None]]


@dataclass(frozen=True)
class MountManifestEntry:
    name: str
    file_id: str
    data_base64: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class ResolvedMounts:
    files: list[MountFile]
    notes: list[str]


_UNSAFE = re.compile(r"[^\w.\-]+", re.ASCII)


def safe_mount_path(name: str) -> str:
    """One safe path segment under `MOUNT_DIR`: directory parts stripped,
    anything but `[A-Za-z0-9_.-]` → `_`."""
    base = re.split(r"[\\/]", name)[-1] or "file"
    cleaned = _UNSAFE.sub("_", base)[:200] or "file"
    return f"{MOUNT_DIR}/{cleaned}"


def dedupe_path(path: str, used: set[str]) -> str:
    """`path` made unique against `used` by `-1`, `-2`, … before the extension."""
    slash = path.rfind("/")
    directory, base = path[: slash + 1], path[slash + 1 :]
    dot = base.rfind(".")
    stem, ext = (base[:dot], base[dot:]) if dot > 0 else (base, "")
    i = 1
    while f"{directory}{stem}-{i}{ext}" in used:
        i += 1
    return f"{directory}{stem}-{i}{ext}"


async def resolve_mount_files(
    names: Sequence[str],
    manifest: Sequence[MountManifestEntry],
    download: Download,
    lim: SandboxLimits | None = None,
) -> ResolvedMounts:
    lim = lim or SandboxLimits()
    by_name = {m.name: m for m in manifest}
    files: list[MountFile] = []
    notes: list[str] = []
    used: set[str] = set()
    total = 0
    for name in names:
        if len(files) >= lim.mount_count_max:
            notes.append(f'Skipped "{name}": too many files mounted (max {lim.mount_count_max}).')
            continue
        entry = by_name.get(name)
        if entry is None:
            notes.append(f'"{name}" is not an available attachment; skipped.')
            continue
        data: bytes | None
        if entry.data_base64 is not None:
            try:
                data = base64.b64decode(entry.data_base64)
            except (binascii.Error, ValueError):
                data = None
        else:
            try:
                data = await download(entry.file_id)
            except Exception:
                data = None
        if data is None:  # an empty file mounts, as on Next
            notes.append(f'"{name}" could not be loaded into the sandbox; skipped.')
            continue
        if len(data) > lim.mount_file_max:
            notes.append(
                f'"{name}" is too large to mount (max {lim.mount_file_max} bytes); skipped.'
            )
            continue
        if total + len(data) > lim.mount_total_max:
            notes.append(
                f'"{name}" skipped: total mounted size would exceed {lim.mount_total_max} bytes.'
            )
            continue
        total += len(data)
        wanted = safe_mount_path(name)
        path = dedupe_path(wanted, used) if wanted in used else wanted
        used.add(path)
        if path != wanted:
            notes.append(f'"{name}" mounted at {path} (renamed to avoid a name collision).')
        files.append(MountFile(path=path, data=data))
    return ResolvedMounts(files=files, notes=notes)

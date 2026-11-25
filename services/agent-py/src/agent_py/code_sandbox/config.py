"""`SandboxLimits` from the `CODE_SANDBOX_*` settings (the names and
defaults of Next's `config.ts`)."""

from __future__ import annotations

from dataclasses import dataclass

from ..settings import Settings, get_settings

MOUNT_DIR = "/mnt/files"
RESULT_DIR = "/tmp"
OUTPUT_DIR = "/tmp/outputs"


@dataclass(frozen=True)
class SandboxLimits:
    timeout_ms: int = 30_000
    stdout_cap: int = 256_000
    result_cap: int = 10_000_000
    result_file_max: int = 20
    mem_mib: int = 512
    cpus: int = 1
    max_concurrent: int = 2
    python_image: str = "jupyter/scipy-notebook"
    js_image: str = "node"
    mount_file_max: int = 10_000_000
    mount_total_max: int = 20_000_000
    mount_count_max: int = 10
    table_max_cols: int = 50
    table_max_rows: int = 1000
    table_cell_max: int = 500


def limits(settings: Settings | None = None) -> SandboxLimits:
    s = settings or get_settings()
    return SandboxLimits(
        timeout_ms=s.CODE_SANDBOX_TIMEOUT_MS,
        stdout_cap=s.CODE_SANDBOX_STDOUT_CAP,
        result_cap=s.CODE_SANDBOX_RESULT_CAP,
        result_file_max=s.CODE_SANDBOX_RESULT_FILE_MAX,
        mem_mib=s.CODE_SANDBOX_MEM_MIB,
        cpus=s.CODE_SANDBOX_CPUS,
        max_concurrent=s.CODE_SANDBOX_MAX_CONCURRENT,
        python_image=s.CODE_SANDBOX_PYTHON_IMAGE,
        js_image=s.CODE_SANDBOX_JS_IMAGE,
        mount_file_max=s.CODE_SANDBOX_MOUNT_FILE_MAX,
        mount_total_max=s.CODE_SANDBOX_MOUNT_TOTAL_MAX,
        mount_count_max=s.CODE_SANDBOX_MOUNT_COUNT_MAX,
        table_max_cols=s.CODE_SANDBOX_TABLE_MAX_COLS,
        table_max_rows=s.CODE_SANDBOX_TABLE_MAX_ROWS,
        table_cell_max=s.CODE_SANDBOX_TABLE_CELL_MAX,
    )


def is_enabled(settings: Settings | None = None) -> bool:
    """Next's `hasSandboxConfig`: `CODE_SANDBOX_ENABLED` truthy, or a
    `CODE_SANDBOX_BASE_URL`."""
    s = settings or get_settings()
    flag = s.CODE_SANDBOX_ENABLED.strip().lower() in {"1", "true", "yes", "on"}
    return flag or bool(s.CODE_SANDBOX_BASE_URL.strip())

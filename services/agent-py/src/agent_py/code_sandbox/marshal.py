"""The raw run → `CodeRunResult` (`marshal.ts`). Pure.

stdout / stderr are cut at `stdout_cap`; the whole payload (text, images,
tables) is bounded by `result_cap`, whole items dropped (never half a blob)
with a note so the model knows output went missing."""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from typing import Any

from .config import SandboxLimits
from .types import CodeFile, CodeResult, CodeRunError, CodeRunResult


@dataclass(frozen=True)
class RawRun:
    stdout: str
    stderr: str
    exit_code: int
    images: list[tuple[str, str]]
    """(`png` | `svg`, base64) per chart read back from `/tmp`."""
    timed_out: bool
    upstream_error: str | None = None
    """The runtime failed (boot, exec), not the user's code."""
    tables: list[Any] = field(default_factory=list)
    """Parsed `/tmp/*.table.json` values, interpreted here."""
    files: list[tuple[str, str, str]] = field(default_factory=list)
    """(name, mime, base64) per file in `/tmp/outputs/`."""


def _truncate(s: str, cap: int) -> str:
    if len(s) <= cap:
        return s
    return f"{s[:cap]}\n…[truncated {len(s) - cap} chars]"


def _cell(v: Any) -> str:
    """JS `String(v)` / `JSON.stringify` for an object, as Next renders it."""
    if isinstance(v, str):
        return v
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, (dict, list)):
        try:
            return json.dumps(v, separators=(",", ":"), ensure_ascii=False)
        except (TypeError, ValueError):
            return str(v)
    return str(v)


def normalize_table(parsed: Any) -> dict[str, list[Any]] | None:
    """`{columns, rows}` or pandas `orient="split"` `{columns, data,
    index?}` → a string table; anything else → None."""
    if not isinstance(parsed, dict) or not isinstance(parsed.get("columns"), list):
        return None
    rows_raw = parsed.get("rows")
    if not isinstance(rows_raw, list):
        rows_raw = parsed.get("data")
    if not isinstance(rows_raw, list):
        return None
    columns = [_cell(c) for c in parsed["columns"]]
    rows = [[_cell(c) for c in row] if isinstance(row, list) else [_cell(row)] for row in rows_raw]
    return {"columns": columns, "rows": rows}


def _cap_table(
    table: dict[str, list[Any]], lim: SandboxLimits
) -> tuple[dict[str, list[Any]], bool]:
    truncated = False
    columns: list[str] = table["columns"]
    if len(columns) > lim.table_max_cols:
        columns, truncated = columns[: lim.table_max_cols], True
    rows: list[list[str]] = table["rows"]
    if len(rows) > lim.table_max_rows:
        rows, truncated = rows[: lim.table_max_rows], True
    clipped: list[list[str]] = []
    for row in rows:
        out: list[str] = []
        for c in row[: len(columns)]:
            if len(c) > lim.table_cell_max:
                truncated = True
                c = f"{c[: lim.table_cell_max]}…"
            out.append(c)
        clipped.append(out)
    return {"columns": columns, "rows": clipped}, truncated


def _table_bytes(table: dict[str, list[Any]]) -> int:
    return sum(len(c) for c in table["columns"]) + sum(len(c) for r in table["rows"] for c in r)


def to_code_run_result(raw: RawRun, lim: SandboxLimits | None = None) -> CodeRunResult:
    lim = lim or SandboxLimits()
    stdout = _truncate(raw.stdout, lim.stdout_cap)
    stderr = _truncate(raw.stderr, lim.stdout_cap)
    results: list[CodeResult] = []
    used = 0
    if stdout:
        used += len(stdout)
        results.append({"type": "text", "value": stdout})
    for fmt, data in raw.images:
        if used + len(data) > lim.result_cap:
            continue
        used += len(data)
        results.append({"type": "image", "format": fmt, "data": data})
    tables_truncated = tables_dropped = False
    for parsed in raw.tables:
        norm = normalize_table(parsed)
        if norm is None:
            continue
        table, truncated = _cap_table(norm, lim)
        tables_truncated = tables_truncated or truncated
        size = _table_bytes(table)
        if used + size > lim.result_cap:
            tables_dropped = True
            continue
        used += size
        results.append({"type": "table", **table})
    if tables_truncated:
        results.append(
            {"type": "text", "value": "⚠ A returned table was truncated to fit display limits."}
        )
    if tables_dropped:
        results.append(
            {
                "type": "text",
                "value": "⚠ A returned table was dropped to stay within the result size limit.",
            }
        )
    files = [
        CodeFile(name=name, mime_type=mime, size_bytes=len(base64.b64decode(data)), data=data)
        for name, mime, data in raw.files
    ]

    def failed(code: str, message: str) -> CodeRunResult:
        return CodeRunResult(
            ok=False,
            stdout=stdout,
            stderr=stderr,
            results=results,
            files=files,
            error=CodeRunError(code=code, message=message),  # type: ignore[arg-type]
        )

    if raw.upstream_error is not None:
        return failed("upstream", raw.upstream_error)
    if raw.timed_out:
        return failed("timeout", "Execution exceeded the time limit.")
    if raw.exit_code != 0:
        return failed("runtime", stderr or f"Exited with code {raw.exit_code}.")
    return CodeRunResult(ok=True, stdout=stdout, stderr=stderr, results=results, files=files)

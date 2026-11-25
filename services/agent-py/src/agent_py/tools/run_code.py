"""`runCode` — the code interpreter (wave 8, Q92/Q93): Next's
`lib/server/skills/code-interpreter.ts` plus the chat route's
`maybeEmitCodeResultFrames`, in one tool.

The model names the files to mount (`files`, from the run's `sandboxFiles`
manifest); they land at `/mnt/files/<name>`. The run's output splits three
ways, as on Next:

* charts (`savefig` into `/tmp`) → stored like generated images and emitted
  as one `tool_image` part, mode `code`;
* files in `/tmp/outputs` → stored and emitted as one `tool_file` part;
* stdout / stderr / tables / notes → one `code_result` part.

The model reads stdout, stderr (mount notes first), the tables (a few rows)
and a count of what went to the user — never base64 or a link.

Registered only where `code_sandbox.select` passes (a host that can boot a
microVM); offered to a run that turns on the `codeInterpreter` skill
(`SKILL_TOOLS`). Interactive runs take one unit of the per-IP web-tool budget
per call, as Next; a background run (`execute`) has no budget."""

from __future__ import annotations

import base64
import json
import uuid
from collections.abc import Sequence
from typing import Any

from ..code_sandbox import select
from ..code_sandbox.config import SandboxLimits, limits
from ..code_sandbox.mount_files import MountManifestEntry, resolve_mount_files
from ..code_sandbox.types import CodeRunInput, CodeRunResult, CodeSandbox, Language
from ..file_storage import (
    FileToPersist,
    download_user_file,
    persist_generated_file,
    persist_image_bytes,
)
from ..rate_limit import WEB_TOOL_BUDGET
from .registry import RunToolContext, ToolContext, ToolDescriptor, ToolError, ToolInvocationResult

TOOL_NAME = "runCode"
SKILL_ID = "codeInterpreter"

_GUIDANCE = " ".join(
    [
        "You have a `runCode` tool: it runs Python in a sandboxed microVM and",
        "returns stdout/stderr plus any charts. Prefer it for real computation,",
        "data analysis, and plotting instead of guessing numeric answers.",
        "pandas, numpy, and matplotlib are available. There is no network access.",
        "Print results you want shown (the sandbox is not a notebook — only stdout",
        "is captured). For charts, save figures to /tmp, e.g.",
        "`plt.savefig('/tmp/plot.png')` — saved PNG/SVG files are returned as images.",
        "If you pass `files`, they are mounted at `/mnt/files/<name>` — read them",
        "there (e.g. `pd.read_csv('/mnt/files/data.csv')`).",
        "To return a table, write JSON to a /tmp/<name>.table.json file as",
        '`{"columns": [...], "rows": [[...], ...]}` — or with pandas',
        "`df.to_json('/tmp/out.table.json', orient='split')`. It renders as a grid.",
        "To return a downloadable file (xlsx, csv, zip, pdf, etc.), write it to",
        "the /tmp/outputs/ directory (create it first, e.g. `os.makedirs",
        "('/tmp/outputs', exist_ok=True)`) — every file there is returned to the",
        "user as a downloadable attachment. Use this for deliverables, not for",
        "charts (use savefig) or tables (use /tmp/<name>.table.json).",
        "Set `language: 'javascript'` to run Node.js instead of Python (default).",
        "For JavaScript use `console.log` for output; the file conventions are the",
        "same (mounted files at /mnt/files/<name>, tables to /tmp/<name>.table.json).",
        "Charts via matplotlib `savefig` are Python-only.",
    ]
)

DESCRIPTION = (
    "Run Python or JavaScript (Node.js) in a sandboxed microVM and return "
    "stdout/stderr plus charts/tables. No network. " + _GUIDANCE
)

INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "code": {"type": "string", "minLength": 1, "maxLength": 50_000},
        "language": {"type": "string", "enum": ["python", "javascript"]},
        "files": {
            "type": "array",
            "items": {"type": "string", "maxLength": 500},
            "maxItems": 10,
            "description": "Names of attached files to mount at /mnt/files/<name>.",
        },
    },
    "required": ["code"],
}

#: Table rows the model reads per table (the user sees the whole grid).
_MODEL_TABLE_ROWS = 20


def available_sandbox() -> CodeSandbox | None:
    """The sandbox this process can run, or None (`runCode` is absent)."""
    return select.sandbox()


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _model_text(
    result: CodeRunResult, stderr: str, charts: int, files: Sequence[dict[str, object]]
) -> str:
    lines: list[str] = []
    if result.error is not None:
        lines.append(f"Error ({result.error.code}): {result.error.message}")
    lines.append(f"stdout:\n{result.stdout}" if result.stdout else "stdout: (empty)")
    if stderr:
        lines.append(f"stderr:\n{stderr}")
    for cell in result.results:
        if cell.get("type") == "table":
            rows = list(cell.get("rows") or [])
            shown = json.dumps(
                {"columns": cell.get("columns"), "rows": rows[:_MODEL_TABLE_ROWS]},
                ensure_ascii=False,
            )
            more = (
                f" (first {_MODEL_TABLE_ROWS} of {len(rows)} rows)"
                if len(rows) > _MODEL_TABLE_ROWS
                else ""
            )
            lines.append(f"table{more}: {shown}")
        elif cell.get("type") == "text" and cell.get("value") != result.stdout:
            lines.append(str(cell.get("value")))
    returned = []
    if charts:
        returned.append(_plural(charts, "chart"))
    if files:
        names = ", ".join(str(f.get("name")) for f in files)
        returned.append(f"{_plural(len(files), 'file')} ({names})")
    if returned:
        lines.append(f"Returned to the user (shown above your reply): {', '.join(returned)}.")
    return "\n\n".join(lines)


def build_run_code_tool(
    *,
    sandbox: CodeSandbox,
    manifest: Sequence[MountManifestEntry] = (),
    context: ToolContext | None = None,
    lim: SandboxLimits | None = None,
) -> ToolDescriptor:
    """`manifest`: the run's `sandboxFiles`. `context`: the signed-in run's
    database + user (cloud files, Storage); None for an anonymous run."""
    lim = lim or limits()

    async def download(file_id: str) -> bytes | None:
        if context is None:
            return None
        return await download_user_file(context, file_id, max_bytes=lim.mount_file_max)

    async def run(
        args: dict[str, Any], *, user_id: str | None, local_files_only: bool
    ) -> ToolInvocationResult:
        code = args.get("code")
        if not isinstance(code, str) or not code.strip():
            raise ToolError("runCode needs `code`.")
        language: Language = "javascript" if args.get("language") == "javascript" else "python"
        names = [n for n in args.get("files") or [] if isinstance(n, str)][:10]
        mounts = await resolve_mount_files(names, manifest, download, lim)
        result = await sandbox.run(
            CodeRunInput(
                code=code, language=language, timeout_ms=lim.timeout_ms, files=tuple(mounts.files)
            )
        )
        stderr = "\n".join(s for s in [*mounts.notes, result.stderr] if s)
        call = uuid.uuid4().hex[:12]
        images: list[dict[str, object]] = []
        for i, cell in enumerate(c for c in result.results if c.get("type") == "image"):
            fmt = "svg" if cell.get("format") == "svg" else "png"
            stored = await persist_image_bytes(
                base64.b64decode(str(cell.get("data") or "")),
                fmt=fmt,
                user_id=user_id,
                image_id=f"code-{call}-{i}",
                local_files_only=local_files_only,
            )
            image: dict[str, object] = {
                "url": stored.url,
                "width": 0,
                "height": 0,
                "format": fmt,
                "prompt": "",
            }
            if stored.storage_path:
                image["storagePath"] = stored.storage_path
            images.append(image)
        files: list[dict[str, object]] = []
        for i, f in enumerate(result.files):
            persisted = await persist_generated_file(
                FileToPersist(
                    id=f"code-{call}-file-{i}",
                    name=f.name,
                    mime_type=f.mime_type,
                    data=base64.b64decode(f.data),
                ),
                user_id=user_id,
                local_files_only=local_files_only,
            )
            entry: dict[str, object] = {
                "name": persisted.name,
                "sizeBytes": persisted.size_bytes,
                "mimeType": persisted.mime_type,
                "url": persisted.url,
            }
            if persisted.storage_path:
                entry["storagePath"] = persisted.storage_path
            files.append(entry)
        code_result: dict[str, object] = {
            "stdout": result.stdout,
            "stderr": stderr,
            "results": [c for c in result.results if c.get("type") != "image"],
        }
        status = "ok" if result.ok else (result.error.code if result.error else "failed")
        return ToolInvocationResult(
            text=_model_text(result, stderr, len(images), files),
            summary=f"Ran {language} ({status})",
            images=tuple(images),
            image_mode="code",
            files=tuple(files),
            code_result=code_result,
        )

    async def execute(args: dict[str, Any]) -> ToolInvocationResult:
        return await run(
            args,
            user_id=context.user_id if context else None,
            local_files_only=context.local_files_only if context else False,
        )

    async def run_execute(args: dict[str, Any], ctx: RunToolContext) -> ToolInvocationResult:
        budget = ctx.consume_budget(WEB_TOOL_BUDGET)
        if not budget:
            raise ToolError(f"Rate limited. Retry in {budget.retry_after_sec}s.")
        return await run(args, user_id=ctx.user_id, local_files_only=ctx.local_files_only)

    return ToolDescriptor(
        name=TOOL_NAME,
        description=DESCRIPTION,
        input_schema=INPUT_SCHEMA,
        execute=execute,
        run_execute=run_execute,
    )


__all__ = [
    "DESCRIPTION",
    "INPUT_SCHEMA",
    "SKILL_ID",
    "TOOL_NAME",
    "available_sandbox",
    "build_run_code_tool",
]

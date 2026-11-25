"""The sandbox's types, field for field `lib/server/code-sandbox/types.ts`.

A result cell is a plain dict in its wire shape (`code_result` /
`data-code-result`): `{"type": "text", "value"}`, `{"type": "table",
"columns", "rows"}`, or `{"type": "image", "format", "data"}` (base64; the
tool turns those into images, never sends them as cells)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

Language = Literal["python", "javascript"]
ErrorCode = Literal["timeout", "runtime", "upstream", "budget"]
CodeResult = dict[str, Any]


@dataclass(frozen=True)
class CodeFile:
    """A whole file the run wrote to `/tmp/outputs/`."""

    name: str
    mime_type: str
    size_bytes: int
    data: str = field(repr=False)
    """Base64 of the bytes."""


@dataclass(frozen=True)
class CodeRunError:
    code: ErrorCode
    message: str


@dataclass(frozen=True)
class CodeRunResult:
    ok: bool
    stdout: str
    stderr: str
    results: list[CodeResult]
    files: list[CodeFile] = field(default_factory=list)
    error: CodeRunError | None = None


@dataclass(frozen=True)
class MountFile:
    """A file to write into the guest before the run; `path` is absolute and
    already sanitized (`mount_files.safe_mount_path`)."""

    path: str
    data: bytes = field(repr=False)


@dataclass(frozen=True)
class CodeRunInput:
    code: str
    language: Language
    timeout_ms: int
    files: tuple[MountFile, ...] = ()


class CodeSandbox(Protocol):
    async def run(self, run_input: CodeRunInput) -> CodeRunResult: ...

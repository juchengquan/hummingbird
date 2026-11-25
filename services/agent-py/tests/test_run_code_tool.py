"""The `runCode` tool (wave 8, Q92/Q93): Next's `codeInterpreterSkill` and the
chat route's `maybeEmitCodeResultFrames` in one tool. The model reads stdout,
stderr, the mount notes and what came back — never base64; the user gets the
charts (`tool_image`, mode `code`), the files (`tool_file`) and the
`code_result` part. A fake sandbox runs the code."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Any

import pytest

from agent_py.code_sandbox.mount_files import MountManifestEntry
from agent_py.code_sandbox.types import CodeFile, CodeRunError, CodeRunInput, CodeRunResult
from agent_py.tools import run_code
from agent_py.tools.registry import (
    BudgetVerdict,
    RunToolContext,
    ToolContext,
    ToolError,
    default_tool_registry,
)

CSV = base64.b64encode(b"a,b\n1,2\n").decode()


@dataclass
class FakeSandbox:
    result: CodeRunResult
    seen: list[CodeRunInput] = field(default_factory=list)

    async def run(self, run_input: CodeRunInput) -> CodeRunResult:
        self.seen.append(run_input)
        return self.result


def _result(**kw: Any) -> CodeRunResult:
    base: dict[str, Any] = {
        "ok": True,
        "stdout": "42\n",
        "stderr": "",
        "results": [
            {"type": "text", "value": "42\n"},
            {"type": "image", "format": "png", "data": "UE5H"},
            {"type": "table", "columns": ["a"], "rows": [["1"]]},
        ],
        "files": [CodeFile("out.csv", "text/csv", 8, CSV)],
    }
    base.update(kw)
    return CodeRunResult(**base)


def _tool(sandbox: FakeSandbox, **kw: Any) -> Any:
    return run_code.build_run_code_tool(sandbox=sandbox, **kw)


async def test_the_model_reads_the_output_the_user_gets_the_parts() -> None:
    box = FakeSandbox(_result())
    out = await _tool(box).run_execute({"code": "print(42)"}, RunToolContext())
    assert box.seen[0].code == "print(42)" and box.seen[0].language == "python"
    assert box.seen[0].timeout_ms == 30_000
    # The model: stdout and a count, never the bytes or a link.
    assert "42" in out.text and "1 chart" in out.text and "1 file" in out.text
    assert "UE5H" not in out.text and "data:" not in out.text and CSV not in out.text
    # The user: the chart as a code-mode image, the file, the output part.
    assert out.image_mode == "code"
    assert [i["url"] for i in out.images] == ["data:image/png;base64,UE5H"]
    assert out.images[0]["prompt"] == "" and out.images[0]["format"] == "png"
    assert [(f["name"], f["mimeType"], f["sizeBytes"]) for f in out.files] == [
        ("out.csv", "text/csv", 8)
    ]
    assert out.files[0]["url"] == f"data:text/csv;base64,{CSV}"
    assert out.code_result == {
        "stdout": "42\n",
        "stderr": "",
        "results": [
            {"type": "text", "value": "42\n"},
            {"type": "table", "columns": ["a"], "rows": [["1"]]},
        ],
    }


async def test_javascript_is_passed_through() -> None:
    box = FakeSandbox(_result(results=[], files=[]))
    await _tool(box).run_execute({"code": "1", "language": "javascript"}, RunToolContext())
    assert box.seen[0].language == "javascript"


async def test_a_failed_run_is_still_a_result_with_its_output() -> None:
    box = FakeSandbox(
        _result(
            ok=False,
            stdout="",
            stderr="Traceback: boom",
            results=[],
            files=[],
            error=CodeRunError("runtime", "Traceback: boom"),
        )
    )
    out = await _tool(box).run_execute({"code": "x"}, RunToolContext())
    assert "runtime" in out.text and "Traceback: boom" in out.text
    assert out.code_result is not None and out.code_result["stderr"] == "Traceback: boom"


async def test_over_the_web_tool_budget_the_tool_refuses() -> None:
    box = FakeSandbox(_result())
    spent: list[str] = []

    def deny(kind: str) -> BudgetVerdict:
        spent.append(kind)
        return BudgetVerdict(allowed=False, retry_after_sec=7)

    with pytest.raises(ToolError, match="Retry in 7s"):
        await _tool(box).run_execute({"code": "1"}, RunToolContext(consume_budget=deny))
    assert spent == ["webTool"] and box.seen == []


async def test_inline_files_mount_and_the_misses_are_notes_to_the_model() -> None:
    box = FakeSandbox(_result(stderr="warn", results=[], files=[]))
    manifest = (MountManifestEntry(name="a.csv", file_id="f1", data_base64=CSV),)
    out = await _tool(box, manifest=manifest).run_execute(
        {"code": "1", "files": ["a.csv", "nope.csv"]}, RunToolContext()
    )
    assert [(f.path, f.data) for f in box.seen[0].files] == [("/mnt/files/a.csv", b"a,b\n1,2\n")]
    assert out.code_result is not None
    assert out.code_result["stderr"].startswith('"nope.csv" is not an available attachment')
    assert out.code_result["stderr"].endswith("\nwarn")
    assert "nope.csv" in out.text


async def test_a_cloud_file_is_read_for_the_caller(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, int]] = []

    async def download(context: ToolContext, file_id: str, *, max_bytes: int) -> bytes | None:
        calls.append((context.user_id, file_id, max_bytes))
        return b"cloud"

    monkeypatch.setattr(run_code, "download_user_file", download)
    box = FakeSandbox(_result(results=[], files=[]))
    context = ToolContext(pool=object(), user_id="u1")  # type: ignore[arg-type]
    manifest = (MountManifestEntry(name="c.parquet", file_id="fid"),)
    await _tool(box, manifest=manifest, context=context).run_execute(
        {"code": "1", "files": ["c.parquet"]}, RunToolContext(user_id="u1")
    )
    assert calls == [("u1", "fid", 10_000_000)]
    assert box.seen[0].files[0].data == b"cloud"


async def test_without_a_signed_in_user_a_cloud_file_is_a_note() -> None:
    box = FakeSandbox(_result(results=[], files=[]))
    manifest = (MountManifestEntry(name="c.parquet", file_id="fid"),)
    out = await _tool(box, manifest=manifest).run_execute(
        {"code": "1", "files": ["c.parquet"]}, RunToolContext()
    )
    assert box.seen[0].files == ()
    assert "could not be loaded" in out.text


async def test_charts_and_files_are_stored_for_a_signed_in_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stored: list[tuple[str, str | None, bool]] = []

    async def image(
        data: bytes, *, fmt: str, user_id: str | None, image_id: str, local_files_only: bool
    ) -> Any:
        stored.append(("image", user_id, local_files_only))
        from agent_py.image_storage import PersistedImage

        return PersistedImage(
            url="https://s/c.png", storage_path=f"{user_id}/generated/{image_id}.png"
        )

    async def file(f: Any, *, user_id: str | None, local_files_only: bool) -> Any:
        stored.append(("file", user_id, local_files_only))
        from agent_py.file_storage import PersistedFile

        return PersistedFile(
            f.id, f.name, f.mime_type, len(f.data), "https://s/f", "u1/generated/f"
        )

    monkeypatch.setattr(run_code, "persist_image_bytes", image)
    monkeypatch.setattr(run_code, "persist_generated_file", file)
    out = await _tool(FakeSandbox(_result())).run_execute(
        {"code": "1"}, RunToolContext(user_id="u1", local_files_only=True)
    )
    assert stored == [("image", "u1", True), ("file", "u1", True)]
    assert out.images[0]["storagePath"].startswith("u1/generated/")
    assert out.files[0]["storagePath"] == "u1/generated/f"


async def test_a_background_run_uses_its_context(monkeypatch: pytest.MonkeyPatch) -> None:
    users: list[str | None] = []

    async def image(
        data: bytes, *, fmt: str, user_id: str | None, image_id: str, local_files_only: bool
    ) -> Any:
        users.append(user_id)
        from agent_py.image_storage import PersistedImage

        return PersistedImage(url="data:image/png;base64,UE5H")

    monkeypatch.setattr(run_code, "persist_image_bytes", image)
    context = ToolContext(pool=object(), user_id="u9")  # type: ignore[arg-type]
    out = await _tool(FakeSandbox(_result(files=[])), context=context).execute({"code": "1"})
    assert users == ["u9"] and out.code_result is not None


def test_the_description_carries_next_s_guidance() -> None:
    tool = _tool(FakeSandbox(_result()))
    assert tool.name == "runCode"
    for phrase in ("savefig('/tmp/plot.png')", "/mnt/files/<name>", "/tmp/outputs/", ".table.json"):
        assert phrase in tool.description
    assert tool.input_schema["required"] == ["code"]
    assert tool.input_schema["properties"]["files"]["maxItems"] == 10


def test_the_registry_offers_runcode_only_with_a_sandbox(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(run_code, "available_sandbox", lambda: None)
    assert "runCode" not in default_tool_registry()
    monkeypatch.setattr(run_code, "available_sandbox", lambda: FakeSandbox(_result()))
    assert "runCode" in default_tool_registry()


# --- wiring: options, the skill, the background tool set ------------------------------


def test_sandbox_files_are_parsed_from_forwarded_props() -> None:
    from agent_py.runs.options import parse_run_options

    opts = parse_run_options(
        {
            "sandboxFiles": [
                {"name": "a.csv", "fileId": "f1", "dataBase64": CSV},
                {"name": "b.csv", "fileId": "f2"},
                {"name": "", "fileId": "f3"},
                "junk",
            ]
        }
    )
    assert opts.sandbox_files == (
        MountManifestEntry(name="a.csv", file_id="f1", data_base64=CSV),
        MountManifestEntry(name="b.csv", file_id="f2"),
    )


async def test_the_code_interpreter_skill_offers_runcode_with_the_run_s_files(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agent_py.runs.harness_hooks import SKILL_TOOLS, skill_tools
    from agent_py.runs.hook_types import ToolsetDraft
    from agent_py.runs.options import parse_run_options

    assert SKILL_TOOLS["codeInterpreter"] == "runCode"
    box = FakeSandbox(_result(results=[], files=[]))
    monkeypatch.setattr(run_code, "available_sandbox", lambda: box)
    opts = parse_run_options(
        {
            "skills": [{"id": "codeInterpreter"}],
            "sandboxFiles": [{"name": "a.csv", "fileId": "f", "dataBase64": CSV}],
        }
    )
    draft = ToolsetDraft()
    ctx: Any = type("Ctx", (), {"tool_context": None})()
    skill_tools(None, opts, ctx, draft)  # type: ignore[arg-type]
    assert "runCode" in draft.tools
    await draft.tools["runCode"].run_execute({"code": "1", "files": ["a.csv"]}, RunToolContext())  # type: ignore[misc]
    assert box.seen[0].files[0].data == b"a,b\n1,2\n"
    without = parse_run_options({"skills": [{"id": "webFetch"}]})
    draft = ToolsetDraft()
    skill_tools(None, without, ctx, draft)  # type: ignore[arg-type]
    assert "runCode" not in draft.tools


async def test_a_background_run_offers_runcode_with_its_saved_files(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agent_py.executor import _RunTools, _sandbox_files_from, _skills_from

    box = FakeSandbox(_result(results=[], files=[]))
    monkeypatch.setattr(run_code, "available_sandbox", lambda: box)
    checkpoint = {
        "config": {
            "skills": [{"id": "codeInterpreter"}],
            "sandboxFiles": [
                {"name": "a.csv", "fileId": "f1"},
                {"name": "x", "fileId": "f2", "dataBase64": CSV},
            ],
        }
    }
    names, configs = _skills_from(checkpoint)
    files = _sandbox_files_from(checkpoint)
    # Cloud files only (Q93): inline data never reaches a background run.
    assert files == (MountManifestEntry(name="a.csv", file_id="f1"),)
    tools = _RunTools(
        context=None,
        extra_tools={},
        mcp_gated=set(),
        skill_tool_names=names,
        skill_configs=configs,
        sandbox_files=files,
    ).registry()
    assert "runCode" in tools
    off = _RunTools(context=None, extra_tools={}, mcp_gated=set()).registry()
    assert "runCode" not in off

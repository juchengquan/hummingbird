"""Wave 5b-B — a run's attachments (`runs/context.py`): files (cloud by id,
inline by value), MCP resources, URL bookmarks; the `searchFiles` switch
for RAG-mode files; taint; the API's input check.

The renderer itself is pinned to the TS original in
`test_run_context_render.py`. The model is `test_native_harness`'s fake.
"""

from __future__ import annotations

import asyncio
import base64
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from agent_py import mcp_client
from agent_py.main import create_app
from agent_py.mcp_client import McpResourceContent
from agent_py.runs import context as run_context
from agent_py.runs import wiring
from agent_py.runs.context import check_attachment_input, describe_mcp_failure
from agent_py.runs.credentials import LocalMcpCredential
from agent_py.runs.harness import ResumeAnswer
from agent_py.runs.history import AttachmentRejected, request_taint
from agent_py.runs.hook_types import add_turn_content
from agent_py.runs.model import Interrupted, Succeeded

from .test_harness_hooks import _run
from .test_native_harness import _Call, _Model, call, run_input, text, tool, toolset, user
from .test_runs_route import SECRET, _auth, _body, _services, _start

USER = "user-1"
FILE_ID = "8f14e45f-ceea-4e7a-9b1c-2d3e4f5a6b7c"
OTHER_ID = "c9f0f895-fb98-4b9e-8a1d-0e1f2a3b4c5d"
PNG_B64 = base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode()
PNG_URL = f"data:image/png;base64,{PNG_B64}"


# --- fakes ------------------------------------------------------------------------------


class _Conn:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.executed: list[tuple[str, tuple[Any, ...]]] = []
        self.fetched: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, sql: str, *args: Any) -> None:
        self.executed.append((sql, args))

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        self.fetched.append((sql, args))
        return self.rows

    def transaction(self) -> Any:
        class _Tx:
            async def __aenter__(self) -> None:
                return None

            async def __aexit__(self, *a: Any) -> None:
                return None

        return _Tx()


def _pool(conn: _Conn) -> Any:
    pool = MagicMock()

    class _Acquire:
        async def __aenter__(self) -> _Conn:
            return conn

        async def __aexit__(self, *a: Any) -> None:
            return None

    pool.acquire = MagicMock(side_effect=lambda: _Acquire())
    return pool


def _row(**over: Any) -> dict[str, Any]:
    return {
        "id": FILE_ID,
        "user_id": USER,
        "name": "report.pdf",
        "size": 2048,
        "type": "application/pdf",
        "extracted_text": "Quarterly numbers.",
        "extraction_truncated": False,
        "extracted_kind": "pdf",
        "image_data_url": None,
        **over,
    }


def _system(model: _Model, i: int = 0) -> str:
    return str(model.requests[i].get("system", ""))


# --- inline files, bookmarks, taint -------------------------------------------------------


async def test_inline_file_and_bookmark_render_and_taint_the_turn() -> None:
    model = _Model(_Call([text("ok")]))
    inp = run_input(
        options={
            "systemPrompt": "Base.",
            "attachments": [
                {"kind": "bookmark", "url": "https://b.example/", "title": "B", "text": "page"},
                {
                    "kind": "inlineFile",
                    "name": "notes.txt",
                    "mimeType": "text/plain",
                    "text": "my notes",
                    "truncated": True,
                },
                {"kind": "inlineFile", "name": "blob.bin", "mimeType": "application/octet-stream"},
            ],
        }
    )
    result, _ = await _run(model, inp, build_tools=toolset(), pool_provider=lambda: None)
    system = _system(model)
    assert system.startswith("Base.\n\nThe user has attached these files.")
    # files before bookmarks, whatever the order sent
    assert system.index("--- notes.txt (per-file truncated at extraction) ---\nmy notes") < (
        system.index("--- B (https://b.example/) ---\npage")
    )
    assert "- blob.bin (application/octet-stream, 0 B)" in system
    out = result.outcome
    assert isinstance(out, Succeeded) and out.result.memory_tainted


async def test_inline_image_data_url_goes_on_the_user_message() -> None:
    model = _Model(_Call([text("ok")]))
    inp = run_input(
        [user("what is this?")],
        options={
            "attachments": [
                {"kind": "inlineFile", "name": "p.png", "mimeType": "image/png", "dataUrl": PNG_URL}
            ]
        },
    )
    await _run(model, inp, build_tools=toolset(), pool_provider=lambda: None)
    first = model.requests[0]["messages"][0]
    assert first["role"] == "user"
    assert first["content"][0] == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": PNG_B64},
    }
    assert first["content"][-1] == {"type": "text", "text": "what is this?"}


def test_request_taint_counts_attachment_kinds_first() -> None:
    assert request_taint([], ["bookmark"]) == "an attached URL bookmark"
    assert request_taint([], ["inlineFile"]) == "an attached file"
    assert request_taint([], ["file"]) == "an attached file"
    assert request_taint([], ["mcpResource"]) == "an attached MCP resource"
    image = {"role": "user", "content": [{"type": "image", "source": {}}]}
    assert request_taint([image], ["mcpResource"]) == "an attached MCP resource"
    assert request_taint([image]) == "an uploaded image or file"
    assert request_taint([{"role": "user", "content": "hi"}]) is None


# --- cloud files ---------------------------------------------------------------------------


async def test_cloud_file_reads_the_callers_row_with_its_id_in_the_header() -> None:
    conn = _Conn(
        [
            _row(extraction_truncated=True),
            # A row that is not the caller's never renders, whatever RLS did.
            _row(id=OTHER_ID, user_id="someone-else", name="theirs.txt", extracted_text="SECRET"),
        ]
    )
    model = _Model(_Call([text("ok")]))
    inp = run_input(
        options={
            "skills": [{"id": "searchFiles"}],
            "attachments": [
                {"kind": "file", "fileId": FILE_ID, "name": "report.pdf"},
                {"kind": "file", "fileId": OTHER_ID, "name": "client-name.txt", "sizeBytes": 3},
                {"kind": "file", "fileId": "not-a-uuid", "name": "junk"},
            ],
        }
    )
    await _run(model, inp, pool_provider=lambda: _pool(conn))
    system = _system(model)
    assert (
        f"--- report.pdf (pdf, fileId: {FILE_ID}) (per-file truncated at extraction) ---" in system
    )
    assert "Quarterly numbers." in system
    assert f'call `searchFiles` with fileId "{FILE_ID}"' in system
    assert "SECRET" not in system and "theirs.txt" not in system
    # Unreadable ids fall back to the meta-only footer, by the client's name.
    assert "- client-name.txt (unknown, 3 B)" in system
    assert "- junk (unknown, 0 B)" in system
    # Read as the user (RLS) and filtered on user_id; only valid uuids queried.
    assert any("SET LOCAL ROLE authenticated" in sql for sql, _ in conn.executed)
    (sql, args), *_ = conn.fetched
    assert "user_id = $2::uuid" in sql and "deleted_at IS NULL" in sql
    assert args == (sorted([FILE_ID, OTHER_ID]), USER)
    assert "searchFiles" in {t["name"] for t in model.requests[0]["tools"]}


async def test_cloud_image_comes_from_the_row_not_the_request() -> None:
    conn = _Conn(
        [
            _row(
                name="pic.png",
                type="image/png",
                extracted_kind="image",
                extracted_text=None,
                image_data_url=PNG_URL,
            )
        ]
    )
    model = _Model(_Call([text("ok")]))
    inp = run_input(
        [user("describe")],
        options={"attachments": [{"kind": "file", "fileId": FILE_ID, "name": "pic.png"}]},
    )
    await _run(model, inp, build_tools=toolset(), pool_provider=lambda: _pool(conn))
    content = model.requests[0]["messages"][0]["content"]
    assert content[0]["type"] == "image" and content[0]["source"]["data"] == PNG_B64
    assert content[-1] == {"type": "text", "text": "describe"}
    # Parity with Next: an image without text is listed as meta-only too.
    assert "- pic.png (image/png, 2 KB)" in _system(model)


async def test_rag_file_switches_search_files_on_and_renders_the_note() -> None:
    conn = _Conn([_row()])
    model = _Model(_Call([text("ok")]))
    inp = run_input(
        options={
            "attachments": [
                {"kind": "file", "fileId": FILE_ID, "name": "report.pdf", "retrievalMode": "rag"}
            ]
        }
    )
    await _run(model, inp, pool_provider=lambda: _pool(conn))
    system = _system(model)
    assert "RAG-mode attachment" in system
    assert f'Call `searchFiles` with fileId "{FILE_ID}" and relevant query terms' in system
    assert "Quarterly numbers." not in system
    assert "searchFiles" in {t["name"] for t in model.requests[0]["tools"]}


async def test_without_a_database_no_search_files_and_files_are_meta_only() -> None:
    model = _Model(_Call([text("ok")]))
    inp = run_input(
        options={
            "attachments": [
                {"kind": "file", "fileId": FILE_ID, "name": "r.pdf", "retrievalMode": "rag"}
            ]
        }
    )
    await _run(model, inp, pool_provider=lambda: None)
    assert "searchFiles" not in {t["name"] for t in model.requests[0].get("tools", [])}
    assert "- r.pdf (unknown, 0 B)" in _system(model)


async def test_a_resume_reloads_the_image_and_keeps_it_out_of_the_checkpoint() -> None:
    conn = _Conn(
        [
            _row(
                name="pic.png",
                type="image/png",
                extracted_kind="image",
                extracted_text=None,
                image_data_url=PNG_URL,
            )
        ]
    )
    options = {
        "requireApprovalFor": ["lookup"],
        "attachments": [{"kind": "file", "fileId": FILE_ID, "name": "pic.png"}],
    }
    lookup = tool("lookup", result="FOUND")
    m1 = _Model(_Call(tools=[call("c1", "lookup")]))
    r1, _ = await _run(
        m1,
        run_input(options=options),
        build_tools=toolset(lookup),
        pool_provider=lambda: _pool(conn),
    )
    assert isinstance(r1.outcome, Interrupted)
    assert r1.checkpoint is not None
    turn = r1.checkpoint["turn"]
    assert isinstance(turn, list) and turn[0]["role"] == "assistant"
    assert "base64" not in str(turn)

    m2 = _Model(_Call([text("done")]))
    r2, _ = await _run(
        m2,
        run_input(
            run_id="run-2",
            options=options,
            resume=(ResumeAnswer("c1", "resolved", {"approved": True}),),
            previous_run_id="run-1",
            previous_checkpoint=r1.checkpoint,
        ),
        build_tools=toolset(lookup),
        pool_provider=lambda: _pool(conn),
    )
    assert isinstance(r2.outcome, Succeeded) and r2.outcome.result.memory_tainted
    msgs = m2.requests[0]["messages"]
    assert msgs[0]["content"][0]["type"] == "image"
    assert msgs[1]["role"] == "assistant"


def test_add_turn_content_only_touches_the_user_message() -> None:
    msgs: list[dict[str, Any]] = [{"role": "user", "content": "hi"}]
    block = {"type": "image", "source": {}}
    assert add_turn_content(msgs, 0, [block]) == [
        {"role": "user", "content": [block, {"type": "text", "text": "hi"}]}
    ]
    assert msgs == [{"role": "user", "content": "hi"}]
    assert add_turn_content(msgs, 0, []) is msgs
    assert (
        add_turn_content([{"role": "assistant", "content": "x"}], 0, [block])[0]["content"] == "x"
    )
    assert add_turn_content(msgs, 5, [block]) is msgs


# --- MCP resources ----------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_failures() -> None:
    run_context._failures.clear()


def _local_server(sid: str = "loc") -> dict[str, Any]:
    return {"id": sid, "name": "Local", "url": "https://mcp.example.com/mcp", "transport": "http"}


async def test_local_mcp_resource_is_read_with_its_state_credential(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[tuple[str, Any, str]] = []

    async def fake_read(endpoint: Any, credentials: Any, uri: str) -> McpResourceContent:
        seen.append((endpoint.id, credentials, uri))
        return McpResourceContent(text="# Readme", mime_type="text/markdown")

    monkeypatch.setattr(mcp_client, "read_resource", fake_read)
    model = _Model(_Call([text("ok")]))
    inp = run_input(
        options={
            "localMcpServers": [_local_server()],
            "attachments": [
                {
                    "kind": "mcpResource",
                    "serverId": "loc",
                    "uri": "file:///README.md",
                    "name": "README.md",
                },
                {"kind": "mcpResource", "serverId": "nope", "uri": "x://y", "name": "lost"},
            ],
        },
        local_mcp_credentials={"loc": LocalMcpCredential(headers={"Authorization": "Bearer t"})},
    )
    result, _ = await _run(model, inp, build_tools=toolset(), pool_provider=lambda: None)
    assert seen == [("loc", {"headers": {"Authorization": "Bearer t"}}, "file:///README.md")]
    system = _system(model)
    assert "--- Local: README.md ---\n# Readme" in system
    assert '[MCP resource "lost" unavailable — server not configured or not enabled]' in system
    assert "Bearer t" not in system
    assert isinstance(result.outcome, Succeeded) and result.outcome.result.memory_tainted


async def test_mcp_read_times_out_and_the_failure_is_remembered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def hang(endpoint: Any, credentials: Any, uri: str) -> McpResourceContent:
        nonlocal calls
        calls += 1
        await asyncio.sleep(10)
        return McpResourceContent(text="never")

    monkeypatch.setattr(mcp_client, "read_resource", hang)
    monkeypatch.setattr(run_context, "READ_TIMEOUT_S", 0.01)
    options = {
        "localMcpServers": [_local_server()],
        "attachments": [{"kind": "mcpResource", "serverId": "loc", "uri": "u://1", "name": "r1"}],
    }
    model = _Model(_Call([text("ok")]), _Call([text("ok")]))
    await _run(model, run_input(options=options), build_tools=toolset(), pool_provider=lambda: None)
    assert '[MCP resource "r1" unavailable — timed out]' in _system(model)
    await _run(model, run_input(options=options), build_tools=toolset(), pool_provider=lambda: None)
    assert "timed out (cached from a recent failure; retrying after 30s cooldown)" in _system(
        model, 1
    )
    assert calls == 1


async def test_a_server_outside_allowed_mcp_server_ids_is_not_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail(*_a: Any) -> McpResourceContent:
        raise AssertionError("must not be read")

    monkeypatch.setattr(mcp_client, "read_resource", fail)
    model = _Model(_Call([text("ok")]))
    inp = run_input(
        options={
            "allowedMcpServerIds": [],
            "localMcpServers": [_local_server()],
            "attachments": [{"kind": "mcpResource", "serverId": "loc", "uri": "u", "name": "r"}],
        }
    )
    await _run(model, inp, build_tools=toolset(), pool_provider=lambda: None)
    assert "server not configured or not enabled" in _system(model)


def test_describe_mcp_failure_is_generic() -> None:
    assert describe_mcp_failure(TimeoutError()) == "timed out"
    assert describe_mcp_failure(RuntimeError("HTTP 401 body=secret")) == (
        "authentication failed (HTTP 401)"
    )
    assert describe_mcp_failure(RuntimeError("HTTP 502 <html>secret</html>")) == (
        "upstream returned HTTP 502"
    )
    assert describe_mcp_failure(ExceptionGroup("g", [ConnectionError("connect refused")])) == (
        "connection failed"
    )
    assert describe_mcp_failure(ValueError("weird secret")) == "request failed"


# --- the API's input check ----------------------------------------------------------------------


def test_check_attachment_input() -> None:
    file = {"attachments": [{"kind": "file", "fileId": FILE_ID, "name": "a"}]}
    with pytest.raises(AttachmentRejected, match="signed-in run"):
        check_attachment_input(file, signed_in=False, database=True)
    with pytest.raises(AttachmentRejected, match="no database"):
        check_attachment_input(file, signed_in=True, database=False)
    check_attachment_input(file, signed_in=True, database=True)
    bad = {
        "attachments": [
            {"kind": "inlineFile", "name": "a", "dataUrl": "data:audio/mp3;base64,AA=="}
        ]
    }
    with pytest.raises(AttachmentRejected, match=r"attachments\[0\]\.dataUrl"):
        check_attachment_input(bad, signed_in=False, database=False)
    ok = {"attachments": [{"kind": "inlineFile", "name": "a", "dataUrl": PNG_URL}]}
    check_attachment_input(ok, signed_in=False, database=False)
    check_attachment_input({}, signed_in=False, database=False)


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    app = create_app(enable_poller=False)
    services = _services()
    app.dependency_overrides[wiring.get_run_services] = lambda: services
    with TestClient(app) as c:
        yield c


def test_route_refuses_a_cloud_file_without_sign_in_or_database(client: TestClient) -> None:
    body = _body()
    body["forwardedProps"] = {"attachments": [{"kind": "file", "fileId": FILE_ID, "name": "a.pdf"}]}
    anon = _start(client, body)
    assert anon.status_code == 400 and anon.json()["code"] == "invalid_attachment"
    # No database in these tests: a signed-in caller is refused too.
    signed = _start(client, {**body, "runId": body["runId"][:-1] + "0"}, headers=_auth())
    assert signed.status_code == 400 and signed.json()["code"] == "invalid_attachment"


def test_route_accepts_inline_files_and_bookmarks(client: TestClient) -> None:
    body = _body()
    body["forwardedProps"] = {
        "attachments": [
            {"kind": "inlineFile", "name": "n.txt", "text": "notes"},
            {"kind": "bookmark", "url": "https://e.example/", "title": "E", "text": "page"},
        ]
    }
    assert _start(client, body).status_code == 200

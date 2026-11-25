"""`file_storage` (wave 8, Q92): a code run's output files and charts stored
like Next's `file-storage.ts` / `image-storage.ts`, and a cloud file read for
mounting only when it is the caller's (Q44: agent-py's Storage key bypasses
RLS, so the owner check is ours). Hermetic: `httpx.MockTransport`."""

from __future__ import annotations

import base64
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from agent_py import settings as settings_module
from agent_py.file_storage import (
    FileToPersist,
    download_user_file,
    persist_generated_file,
    persist_image_bytes,
)
from agent_py.tools.registry import ToolContext

from .test_run_context import _Conn, _pool

USER = "7b0c6c2e-0000-4000-8000-000000000001"
FILE_ID = "8f14e45f-ceea-4e7a-9b1c-2d3e4f5a6b7c"


@pytest.fixture(autouse=True)
def _storage(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.test")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-key")
    settings_module.get_settings.cache_clear()


def _mock(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _storage_ok(seen: list[httpx.Request]) -> Callable[[httpx.Request], httpx.Response]:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if "/object/sign/" in request.url.path:
            path = request.url.path.split("/object/sign/user-files/", 1)[1]
            return httpx.Response(
                200, json={"signedURL": f"/object/sign/user-files/{path}?token=t"}
            )
        return httpx.Response(200, json={"Key": "ok"})

    return handler


FILE = FileToPersist(id="tc1-file-0", name="../report 1.csv", mime_type="text/csv", data=b"a\n1\n")


# --- output files ----------------------------------------------------------------------


async def test_a_file_is_uploaded_under_the_users_folder_and_signed() -> None:
    seen: list[httpx.Request] = []
    out = await persist_generated_file(FILE, user_id=USER, client=_mock(_storage_ok(seen)))
    path = f"{USER}/generated/tc1-file-0-report_1.csv"
    assert out.storage_path == path
    assert out.url == f"https://proj.supabase.test/storage/v1/object/sign/user-files/{path}?token=t"
    assert (out.name, out.mime_type, out.size_bytes) == ("../report 1.csv", "text/csv", 4)
    upload = seen[0]
    assert upload.url.path == f"/storage/v1/object/user-files/{path}"
    assert upload.headers["content-type"] == "text/csv" and upload.content == b"a\n1\n"


@pytest.mark.parametrize(
    "kw",
    [{"user_id": None}, {"user_id": USER, "local_files_only": True}],
    ids=["signed out", "store files locally"],
)
async def test_without_a_user_or_with_local_files_only_a_file_is_a_data_url(
    kw: dict[str, Any],
) -> None:
    def never(_r: httpx.Request) -> httpx.Response:
        raise AssertionError("no Storage call")

    out = await persist_generated_file(FILE, client=_mock(never), **kw)
    assert out.url == "data:text/csv;base64," + base64.b64encode(b"a\n1\n").decode()
    assert out.storage_path is None


async def test_a_failed_upload_keeps_the_file_as_a_data_url() -> None:
    out = await persist_generated_file(
        FILE, user_id=USER, client=_mock(lambda _r: httpx.Response(500))
    )
    assert out.url.startswith("data:text/csv;base64,") and out.storage_path is None


async def test_without_storage_configured_a_file_is_a_data_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "")
    settings_module.get_settings.cache_clear()
    out = await persist_generated_file(FILE, user_id=USER)
    assert out.url.startswith("data:text/csv;base64,")


# --- charts ----------------------------------------------------------------------------


async def test_a_chart_is_stored_like_a_generated_image() -> None:
    seen: list[httpx.Request] = []
    out = await persist_image_bytes(
        b"PNG", fmt="png", user_id=USER, image_id="tc1-0", client=_mock(_storage_ok(seen))
    )
    assert out.storage_path == f"{USER}/generated/tc1-0.png" and out.format == "png"
    assert seen[0].headers["content-type"] == "image/png"


async def test_an_svg_chart_keeps_the_svg_extension() -> None:
    seen: list[httpx.Request] = []
    out = await persist_image_bytes(
        b"<svg/>", fmt="svg", user_id=USER, image_id="tc1-0", client=_mock(_storage_ok(seen))
    )
    assert out.storage_path == f"{USER}/generated/tc1-0.svg" and out.format == "svg"
    assert seen[0].headers["content-type"] == "image/svg+xml"


async def test_a_chart_without_a_user_is_a_data_url() -> None:
    out = await persist_image_bytes(b"PNG", fmt="png", user_id=None, image_id="tc1-0")
    assert out.url == "data:image/png;base64,UE5H" and out.storage_path is None


# --- mounting a cloud file ---------------------------------------------------------------


def _context(rows: list[dict[str, Any]]) -> tuple[ToolContext, _Conn]:
    conn = _Conn(rows)
    return ToolContext(pool=_pool(conn), user_id=USER), conn


async def test_the_callers_file_is_read_from_storage() -> None:
    context, conn = _context([{"user_id": USER, "storage_path": f"{USER}/f/data.csv"}])
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=b"x,y\n")

    data = await download_user_file(context, FILE_ID, client=_mock(handler))
    assert data == b"x,y\n"
    assert seen[0].url.path == f"/storage/v1/object/user-files/{USER}/f/data.csv"
    (sql, args), *_ = conn.fetched
    assert "user_id = $2" in sql and "deleted_at IS NULL" in sql
    assert args == (FILE_ID, USER)
    # read as the user (RLS) too
    assert any("request.jwt" in s or "set_config" in s for s, _ in conn.executed)


@pytest.mark.parametrize(
    "rows",
    [
        [],
        [{"user_id": "someone-else", "storage_path": "someone-else/f/data.csv"}],
        [{"user_id": USER, "storage_path": None}],
        [{"user_id": USER, "storage_path": "someone-else/f/data.csv"}],
    ],
    ids=["missing or deleted", "not the caller's", "local-only file", "path outside the folder"],
)
async def test_a_file_that_is_not_the_callers_is_never_read(rows: list[dict[str, Any]]) -> None:
    context, _ = _context(rows)

    def never(_r: httpx.Request) -> httpx.Response:
        raise AssertionError("no Storage read")

    assert await download_user_file(context, FILE_ID, client=_mock(never)) is None


async def test_a_malformed_id_reads_nothing() -> None:
    context, conn = _context([{"user_id": USER, "storage_path": f"{USER}/x"}])
    assert (
        await download_user_file(context, "../../etc", client=_mock(lambda _r: httpx.Response(200)))
        is None
    )
    assert conn.fetched == []


async def test_a_storage_error_reads_as_none() -> None:
    context, _ = _context([{"user_id": USER, "storage_path": f"{USER}/f/data.csv"}])
    assert (
        await download_user_file(context, FILE_ID, client=_mock(lambda _r: httpx.Response(404)))
        is None
    )


async def test_a_file_over_the_cap_is_not_held_in_memory() -> None:
    context, _ = _context([{"user_id": USER, "storage_path": f"{USER}/f/big.bin"}])
    data = await download_user_file(
        context,
        FILE_ID,
        max_bytes=10,
        client=_mock(lambda _r: httpx.Response(200, content=b"x" * 50)),
    )
    # One byte over the cap: enough for the mount check to say "too large".
    assert data is not None and len(data) == 11

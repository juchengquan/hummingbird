"""Wave 8 on a real Postgres (`bun run test:db`): `runCode` in a background
task (Q93) and its output in the task's result (Q94). A fake sandbox runs
the code; the worker, the store and the runs API are real.

* The result carries the task's charts (`images`, mode `code`), files
  (`files`) and code output (`codeResults`), a parent's its sub-agents'
  too; `[]` when none; a list row leaves them out.
* A background run mounts a cloud file by id — the caller's only."""

from __future__ import annotations

import base64
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
import pytest_asyncio

from agent_py import file_storage
from agent_py import settings as settings_module
from agent_py.code_sandbox.types import CodeFile, CodeRunInput, CodeRunResult
from agent_py.tools import run_code

from .task_world import MODEL, World, open_world, pg_only, say, spawn, use

pytestmark = [pg_only, pytest.mark.asyncio]

CSV = base64.b64encode(b"a\n1\n").decode()


@pytest_asyncio.fixture
async def world(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[World]:
    async with open_world(monkeypatch) as w:
        yield w


@dataclass
class Box:
    seen: list[CodeRunInput] = field(default_factory=list)

    async def run(self, run_input: CodeRunInput) -> CodeRunResult:
        self.seen.append(run_input)
        mounted = ",".join(f.path for f in run_input.files)
        return CodeRunResult(
            ok=True,
            stdout=f"42 {mounted}\n",
            stderr="",
            results=[
                {"type": "text", "value": f"42 {mounted}\n"},
                {"type": "image", "format": "png", "data": "UE5H"},
            ],
            files=[CodeFile("out.csv", "text/csv", 4, CSV)],
        )


@pytest.fixture
def box(monkeypatch: pytest.MonkeyPatch) -> Iterator[Box]:
    """A sandbox for every registry; no Storage (charts and files inline)."""
    fake = Box()
    monkeypatch.setattr(run_code, "available_sandbox", lambda: fake)
    monkeypatch.setenv("SUPABASE_URL", "")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "")
    settings_module.get_settings.cache_clear()
    yield fake
    settings_module.get_settings.cache_clear()


def _background(world: World, **props: Any) -> dict[str, Any]:
    return {
        "mode": "background",
        "model": MODEL,
        "goal": "Do it",
        "workspaceId": world.workspace,
        "skills": [{"id": "codeInterpreter"}],
        **props,
    }


async def test_a_task_result_carries_its_charts_files_and_code_output(
    world: World, box: Box
) -> None:
    world.model.script("Do it", [use("c1", "runCode", code="print(42)")], [say("It is 42.")])
    response, run = await world.post_run(_background(world))
    assert response.status_code == 202, response.text
    await world.work()

    assert await world.status(run) == "done"
    # The model read the output, never the bytes.
    tool_result = world.model.calls[1]["messages"][-1]["content"][0]["content"]
    assert "42" in tool_result and "UE5H" not in tool_result and CSV not in tool_result
    result = (await world.run(run))["result"]
    assert [(i["url"], i["mode"]) for i in result["images"]] == [
        ("data:image/png;base64,UE5H", "code")
    ]
    assert [(f["id"], f["name"], f["url"]) for f in result["files"]] == [
        ("c1-file-0", "out.csv", f"data:text/csv;base64,{CSV}")
    ]
    assert result["codeResults"] == [
        {
            "id": "c1",
            "stdout": "42 \n",
            "stderr": "",
            "results": [{"type": "text", "value": "42 \n"}],
        }
    ]
    outcome = (await world.task(run))["outcome"]["result"]
    assert (outcome["files"], outcome["codeResults"]) == (result["files"], result["codeResults"])
    # The parts went out on the stream too, in the Next route's order.
    kinds = [e["kind"] for e in await world.events(run)]
    at = kinds.index("tool_output")
    assert kinds[at : at + 4] == ["tool_output", "tool_image", "tool_file", "code_result"]
    listed = await world.http.get("/v1/runs?mode=background", headers=world.headers())
    [row] = [r for r in listed.json()["runs"] if r["id"] == run]
    assert row["result"] == {"text": result["text"]}


async def test_a_parent_carries_its_sub_agents_files_and_code_output(
    world: World, box: Box
) -> None:
    world.model.script("Do it", [spawn("s", "child-code")], [say("Parent done.")])
    world.model.script("child-code", [use("c1", "runCode", code="1")], [say("Ran it.")])
    response, run = await world.post_run(_background(world))
    assert response.status_code == 202, response.text
    await world.work()

    assert await world.status(run) == "done"
    [child] = await world.children(run)
    child_result = (await world.run(child))["result"]
    parent_result = (await world.run(run))["result"]
    assert child_result["files"] and child_result["codeResults"]
    assert parent_result["files"] == child_result["files"]
    assert parent_result["codeResults"] == child_result["codeResults"]
    assert parent_result["images"] == child_result["images"]


async def test_a_result_without_code_output_says_so(world: World) -> None:
    """`[]`, not absent: absent means a result written before 0.5.2."""
    world.model.script("Do it", [say("Plain.")])
    run = await world.start()
    await world.work()
    result = (await world.run(run))["result"]
    assert (result["files"], result["codeResults"]) == ([], [])


async def _file(world: World, *, owner: str, path: str) -> str:
    file_id = str(uuid.uuid4())
    async with world.pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO public.files (id, user_id, name, size, type, storage_path) "
            "VALUES ($1, $2, 'data.csv', 4, 'text/csv', $3)",
            uuid.UUID(file_id),
            uuid.UUID(owner),
            path,
        )
    return file_id


async def _other_user(world: World) -> str:
    other = str(uuid.uuid4())
    async with world.pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO auth.users (id, email) VALUES ($1, $2)",
            uuid.UUID(other),
            f"{other}@example.test",
        )
    return other


async def test_a_background_task_mounts_the_callers_cloud_file_only(
    world: World, box: Box, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.test")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service")
    settings_module.get_settings.cache_clear()
    fetched: list[str] = []

    def storage(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":  # the mount; uploads of the output go here too
            fetched.append(request.url.path)
        return httpx.Response(200, content=b"a\n1\n")

    real_client = httpx.AsyncClient

    def client(**kw: Any) -> httpx.AsyncClient:
        return real_client(transport=httpx.MockTransport(storage), **kw)

    monkeypatch.setattr(file_storage.httpx, "AsyncClient", client)
    mine = await _file(world, owner=world.user, path=f"{world.user}/f/data.csv")
    other = await _other_user(world)
    theirs = await _file(world, owner=other, path=f"{other}/f/data.csv")
    world.model.script(
        "Do it", [use("c1", "runCode", code="1", files=["mine.csv", "theirs.csv"])], [say("Ok.")]
    )
    response, run = await world.post_run(
        _background(
            world,
            sandboxFiles=[
                {"name": "mine.csv", "fileId": mine},
                {"name": "theirs.csv", "fileId": theirs},
            ],
        )
    )
    assert response.status_code == 202, response.text
    await world.work()

    assert await world.status(run) == "done"
    [ran] = box.seen
    assert [(f.path, f.data) for f in ran.files] == [("/mnt/files/mine.csv", b"a\n1\n")]
    assert fetched == [f"/storage/v1/object/user-files/{world.user}/f/data.csv"]
    [code] = (await world.run(run))["result"]["codeResults"]
    assert '"theirs.csv" could not be loaded' in code["stderr"]

"""Wave 5c — models and honesty (Q55, Q56: B10, B20, B21, B22), Q51, on
a real Postgres with a scripted model (`task_world.py`)."""

from __future__ import annotations

import base64
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio

from agent_py.schedules import PgScheduleStore, dispatch_due_schedules

from .task_world import MODEL, SEND, World, ask, open_world, pg_only, spawn, use

pytestmark = [pg_only, pytest.mark.asyncio]


@pytest_asyncio.fixture
async def world(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[World]:
    async with open_world(monkeypatch) as w:
        yield w


async def test_no_key_fails_a_start(world: World) -> None:
    world.key = False
    task = await world.start()
    await world.work()
    assert await world.status(task) == "failed"
    assert "ANTHROPIC_API_KEY" in await world.error(task)
    assert (await world.jobs(task))[0]["status"] == "failed"


async def test_no_key_fails_a_continue(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    """The start job's chunk ends after its first step, the key goes, and
    the one `continue` fails for it. The chunk ends on that event, not on a
    wall-clock budget, so a slow machine can't yield more than once (Q90)."""
    from agent_py import executor

    from .task_world import READ, Reply

    class AfterFirstCall(float):
        """A chunk deadline that has passed once the model was called.
        `now > deadline` asks this (a float subclass) first."""

        called = False

        def __lt__(self, now: object) -> bool:
            return AfterFirstCall.called

    deadlines = iter([AfterFirstCall(0.0)])

    async def first_call() -> None:
        AfterFirstCall.called = True
        world.key = False

    monkeypatch.setattr(executor, "_chunk_deadline_s", lambda: next(deadlines, None))
    world.model.script("Do it", Reply([use("r", READ)], before=first_call))
    task = await world.start()
    await world.work()
    assert len(await world.jobs(task, "continue")) == 1
    assert await world.status(task) == "failed"
    assert "ANTHROPIC_API_KEY" in await world.error(task)


async def test_no_key_fails_a_respond_before_the_approved_tool_runs(world: World) -> None:
    world.model.script("Do it", [use("q", SEND)])
    task = await world.start()
    await world.work()
    world.key = False
    await world.respond(task, "q", approved=True)
    await world.work()
    assert await world.status(task) == "failed"
    assert "ANTHROPIC_API_KEY" in await world.error(task)
    assert world.count(SEND) == 0


async def test_no_key_fails_a_fan_in(world: World) -> None:
    world.model.script("Do it", [spawn("s", "child")])
    task = await world.start()
    await world.tick()  # the parent spawns
    [child] = await world.children(task)
    await world.tick()  # the child answers
    assert await world.status(child) == "done"
    world.key = False
    await world.work()
    assert await world.status(task) == "failed"
    assert "ANTHROPIC_API_KEY" in await world.error(task)


async def test_no_key_fails_a_runs_resume(world: World) -> None:
    world.model.script("Do it", [use("q", SEND)])
    task = await world.start()
    await world.work()
    response, resume = await world.resume(task, {"q": {"approved": True}})
    assert response.status_code == 202, response.text
    world.key = False
    await world.work()
    assert await world.status(resume) == "failed"
    assert "ANTHROPIC_API_KEY" in await world.error(resume)
    assert world.count(SEND) == 0


async def test_no_model_fails_the_task(world: World) -> None:
    task = await world.start(model="")
    await world.work()
    assert await world.status(task) == "failed"
    assert "no model" in await world.error(task)
    assert world.model.calls == []


async def test_empty_messages_fail_the_task(world: World) -> None:
    task = await world.start(messages=[])
    await world.work()
    assert await world.status(task) == "failed"
    assert "no messages" in await world.error(task)


async def test_the_stub_needs_its_setting(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_py import settings as settings_module

    monkeypatch.setenv("WORKER_STUB_MODEL", "true")
    settings_module.get_settings.cache_clear()
    world.key = False
    task = await world.start()
    await world.work()
    assert await world.status(task) == "done"
    assert world.model.calls == []


async def test_a_schedule_without_a_model_fails_with_no_model(world: World) -> None:
    await world.sql(
        "INSERT INTO public.task_schedules (user_id, workspace_id, name, prompt, cron, "
        "next_run_at) VALUES ($1, $2, 's', 'Report', '0 8 * * *', now() - interval '1 minute')",
        uuid.UUID(world.user),
        uuid.UUID(world.workspace),
    )
    fired = await dispatch_due_schedules(
        PgScheduleStore(world.pool), now=datetime.now(UTC) + timedelta(seconds=1)
    )
    assert fired == 1
    await world.work()
    [row] = await world.sql("SELECT id FROM public.tasks WHERE user_id = $1", uuid.UUID(world.user))
    task = str(row["id"])
    assert await world.status(task) == "failed"
    assert "no model" in await world.error(task)
    assert world.model.calls == []


@pytest.mark.parametrize("model", ["auto", "deepseek/deepseek-v4-flash", "claude-sonnet-4-6"])
async def test_runs_refuse_a_model_the_worker_cannot_run(world: World, model: str) -> None:
    response, run = await world.post_run({"mode": "background", "model": model})
    assert response.status_code == 400 and response.json()["code"] == "unknown_model"
    assert await world.sql("SELECT 1 FROM public.tasks WHERE id = $1", uuid.UUID(run)) == []


async def test_a_resume_refuses_a_saved_model_the_worker_cannot_run(world: World) -> None:
    world.model.script("Do it", [ask("q")])
    task = await world.start()
    await world.work()
    await world.sql(
        "UPDATE public.tasks SET checkpoint = jsonb_set(checkpoint, '{config,model}', "
        "'\"deepseek/deepseek-v4-flash\"') WHERE id = $1",
        uuid.UUID(task),
    )
    response, run = await world.resume(task, {"q": {"value": "x"}})
    assert response.status_code == 400 and response.json()["code"] == "unknown_model"
    assert await world.sql("SELECT 1 FROM public.tasks WHERE id = $1", uuid.UUID(run)) == []


async def test_document_parts_reach_the_model(world: World) -> None:
    text = base64.b64encode(b"The launch is on Friday.").decode()
    pdf = base64.b64encode(b"%PDF-1.4 fake").decode()
    content = [
        {"type": "text", "text": "Read these"},
        {
            "type": "document",
            "source": {"type": "data", "value": text, "mimeType": "text/plain"},
            "metadata": {"name": "notes.txt"},
        },
        {
            "type": "document",
            "source": {"type": "data", "value": pdf, "mimeType": "application/pdf"},
        },
    ]
    response, run = await world.post_run(
        {"mode": "background", "model": MODEL},
        messages=[{"id": "m", "role": "user", "content": content}],
    )
    assert response.status_code == 202, response.text
    await world.work()
    assert await world.status(run) == "done"
    sent = world.model.calls[0]["messages"][0]["content"]
    assert [b["type"] for b in sent] == ["text", "document", "document"]
    assert sent[1]["title"] == "notes.txt"
    assert sent[1]["source"]["data"] == "The launch is on Friday."


async def test_task_route_file_parts_reach_the_model(world: World) -> None:
    text = base64.b64encode(b"hello notes").decode()
    png = base64.b64encode(b"png").decode()
    content = [
        {"type": "text", "text": "Read"},
        {"type": "file", "mediaType": "text/markdown", "data": text},
        {"type": "file", "mediaType": "image/png", "data": png},
    ]
    task = await world.start(messages=[{"role": "user", "content": content}])
    await world.work()
    assert await world.status(task) == "done"
    sent = world.model.calls[0]["messages"][0]["content"]
    assert [b["type"] for b in sent] == ["text", "document", "image"]
    assert sent[1]["source"]["data"] == "hello notes"


async def test_an_unreadable_part_is_never_dropped_silently(world: World) -> None:
    content = [
        {"type": "text", "text": "Listen"},
        {"type": "file", "mediaType": "audio/mpeg", "data": "AAAA"},
    ]
    task = await world.start(messages=[{"role": "user", "content": content}])
    await world.work()
    assert await world.status(task) == "failed"
    assert "audio/mpeg" in await world.error(task)


@pytest.mark.parametrize(
    ("saved", "asked", "effective"),
    [
        (None, ["s2"], ["s2"]),
        (None, None, None),
        (["s1", "s2"], ["s1", "s3"], ["s1"]),
        (["s1"], None, ["s1"]),
        (["s1"], [], []),
        ([], ["s1"], []),
    ],
)
async def test_a_background_resume_narrows_the_allow_list(
    world: World,
    saved: list[str] | None,
    asked: list[str] | None,
    effective: list[str] | None,
) -> None:
    world.model.script("Do it", [ask("q")])
    config = {} if saved is None else {"allowedMcpServerIds": saved}
    task = await world.start(**config)
    await world.work()
    props = {"mode": "background"}
    if asked is not None:
        props["allowedMcpServerIds"] = asked  # type: ignore[assignment]
    response, run = await world.resume(task, {"q": {"value": "x"}}, props)
    assert response.status_code == 202, response.text
    assert (await world.task(run))["checkpoint"]["config"].get("allowedMcpServerIds") == effective
    await world.work()
    offered = {t["name"] for t in world.model.calls[-1]["tools"]}
    assert (SEND in offered) == (effective is None or "s1" in effective)

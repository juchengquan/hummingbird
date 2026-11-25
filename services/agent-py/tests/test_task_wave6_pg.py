"""Wave 6-B: the background executor on a real Postgres.

Real poller, executor, Anthropic provider, SQL and `/v1/runs` routes over
a scripted model (`task_world`). Each test names the brief item it proves.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
import pytest_asyncio

from agent_py import executor, image_storage, runner, schedules, store, verify, verify_client
from agent_py import settings as settings_module
from agent_py.events import TaskEvent, ToolCallResult
from agent_py.image_storage import DownloadedImage, PersistedImage
from agent_py.providers import anthropic_provider
from agent_py.resume_answers import DECLINED_ANSWER, DECLINED_APPROVAL
from agent_py.runs.agui_encoder import AgUiRunEncoder
from agent_py.runs.in_place import respond_job_payload
from agent_py.tools import image_gen as image_gen_module
from agent_py.tools.minimax_image_client import MinimaxImage, MinimaxImageSuccess
from agent_py.tools.registry import ToolDescriptor, ToolInvocationResult

from .task_world import (
    MODEL,
    READ,
    SEND,
    Reply,
    World,
    ask,
    open_world,
    pg_only,
    result_of,
    say,
    spawn,
    use,
)

pytestmark = [pg_only, pytest.mark.asyncio]


@pytest_asyncio.fixture
async def world(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[World]:
    async with open_world(monkeypatch) as w:
        yield w


# --- tasks.outcome at every background settle (survey bug 7) ---------------------------


async def test_a_done_task_writes_its_result_into_the_outcome(world: World) -> None:
    world.model.script("Do it", [say("It is blue.")])
    task = await world.start()
    await world.work()

    row = await world.task(task)
    assert row["status"] == "done"
    assert row["outcome"] == {
        "type": "success",
        "result": {"text": "It is blue.", "images": [], "files": [], "codeResults": []},
    }
    assert (await world.run(task))["result"] == {
        "text": "It is blue.",
        "images": [],
        "files": [],
        "codeResults": [],
    }


async def test_a_failed_task_writes_its_error_into_the_outcome(world: World) -> None:
    world.key = False  # no ANTHROPIC_API_KEY: the run fails before the model (Q55)
    task = await world.start()
    await world.work()

    row = await world.task(task)
    assert row["status"] == "failed"
    assert row["outcome"]["type"] == "error"
    assert row["outcome"]["code"] == "unavailable"
    assert "ANTHROPIC_API_KEY" in row["outcome"]["message"]


async def test_a_cancelled_task_has_the_cancelled_outcome(world: World) -> None:
    world.model.script("Do it", [say("never")])
    task = await world.start()
    await world.cancel(task)
    await world.work()

    row = await world.task(task)
    assert row["status"] == "cancelled"
    assert row["outcome"] == {"type": "cancelled"}


async def test_a_sub_agent_run_settled_by_the_worker_has_its_outcome(world: World) -> None:
    world.model.script("Do it", [spawn("s", "child-a")], [say("Parent done.")])
    world.model.script("child-a", [say("child answer")])
    parent = await world.start()
    await world.work()

    [child] = await world.children(parent)
    assert (await world.task(child))["outcome"] == {
        "type": "success",
        "result": {"text": "child answer", "images": [], "files": [], "codeResults": []},
    }


# --- a cancelled in-place answer is a decline (brief item 7) -----------------------------


async def test_a_cancelled_in_place_answer_declines_a_childs_approval(world: World) -> None:
    world.model.script("Do it", [spawn("s", "child-send")], [say("Parent done.")])
    world.model.script("child-send", [use("c1", SEND, to="x")], [say("Did not send.")])
    parent = await world.start()
    await world.work()
    [child] = await world.children(parent)
    assert await world.status(child) == "paused"

    # What `POST /v1/runs/{child}/answers` queues for `{status: "cancelled"}`.
    await world.respond(
        child, "c1", **respond_job_payload({"interruptId": "c1", "status": "cancelled"})
    )
    await world.work()

    assert world.count(SEND) == 0
    assert await world.status(child) == "done"
    assert await world.status(parent) == "done"
    child_calls = [c for c in world.model.calls if c["messages"][0]["content"] == "child-send"]
    assert result_of(child_calls[-1]["messages"], "c1")["content"] == DECLINED_APPROVAL
    [response] = [e for e in await world.events(child, "approval") if e["phase"] == "response"]
    assert response["approved"] is False


async def test_a_cancelled_in_place_answer_declines_a_childs_question(world: World) -> None:
    world.model.script("Do it", [spawn("s", "child-ask")], [say("Parent done.")])
    world.model.script("child-ask", [ask("q1")], [say("No answer, moving on.")])
    parent = await world.start()
    await world.work()
    [child] = await world.children(parent)

    await world.respond(child, "q1", cancelled=True)
    await world.work()

    assert await world.status(parent) == "done"
    child_calls = [c for c in world.model.calls if c["messages"][0]["content"] == "child-ask"]
    assert result_of(child_calls[-1]["messages"], "q1")["content"] == DECLINED_ANSWER


# --- Q71: inputs ------------------------------------------------------------------------------

PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="


def _background(world: World, **props: Any) -> dict[str, Any]:
    return {
        "mode": "background",
        "model": MODEL,
        "goal": "Do it",
        "workspaceId": world.workspace,
        **props,
    }


async def test_a_background_research_prompt_never_asks_for_searchfiles(world: World) -> None:
    world.model.script("Do it", [say("# Report")])
    skills = [{"id": "searchFiles"}, {"id": "webSearch"}]
    response, run = await world.post_run(_background(world, research=True, skills=skills))
    assert response.status_code == 202, response.text
    await world.work()

    [call] = world.model.calls
    assert "You are a research agent" in call["system"]
    assert "searchFiles" not in call["system"]
    # The tool itself is still offered (its prompt line waits for Q49).
    assert "searchFiles" in [t["name"] for t in call["tools"]]
    assert await world.status(run) == "done"


@pytest.fixture
def images(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, list[Any]]]:
    """Minimax and the image download faked; Storage configured, so a run
    that may upload would."""
    monkeypatch.setenv("MINIMAX_CN_API_KEY", "k")
    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.test")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service")
    settings_module.get_settings.cache_clear()
    calls: dict[str, list[Any]] = {"uploaded": [], "generated": []}

    async def generate(**kwargs: Any) -> MinimaxImageSuccess:
        calls["generated"].append(kwargs)
        return MinimaxImageSuccess(images=[MinimaxImage(url="https://m.test/cat.png")])

    async def download(url: str, **_: Any) -> DownloadedImage:
        return DownloadedImage(body=b"\x89PNG-bytes", mime="image/png")

    async def upload(*args: Any, **kwargs: Any) -> PersistedImage:
        calls["uploaded"].append(kwargs)
        return PersistedImage(url="https://signed.test/cat.png", storage_path="p", format="png")

    monkeypatch.setattr(image_gen_module, "minimax_generate_image", generate)
    monkeypatch.setattr(image_storage, "download_image", download)
    monkeypatch.setattr(image_storage, "_upload_and_sign", upload)
    yield calls
    monkeypatch.undo()
    settings_module.get_settings.cache_clear()


async def test_local_files_only_keeps_a_background_image_out_of_storage(
    world: World, images: dict[str, list[Any]]
) -> None:
    world.model.script(
        "Draw a cat", [use("g1", "generateImage", prompt="a cat")], [say("Here it is.")]
    )
    message = {
        "id": "m",
        "role": "user",
        "content": [
            {"type": "text", "text": "Draw a cat"},
            {
                "type": "image",
                "source": {"type": "data", "value": PNG_B64, "mimeType": "image/png"},
            },
        ],
    }
    response, run = await world.post_run(
        _background(world, localFilesOnly=True, skills=[{"id": "imageGen"}]),
        messages=[message],
    )
    assert response.status_code == 202, response.text
    await world.work()

    assert await world.status(run) == "done"
    assert images["generated"] and images["uploaded"] == []
    assert (await world.task(run))["checkpoint"]["config"]["localFilesOnly"] is True
    [part] = await world.events(run, "tool_image")
    assert part["images"][0]["url"].startswith("data:image/png;base64,")
    # Images in the message still reach the model (Q71).
    first_turn = world.model.calls[0]["messages"][0]["content"]
    assert {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": PNG_B64},
    } in first_turn


# --- output per step (bug 13) ------------------------------------------------------------------


async def test_a_reply_cut_at_max_tokens_is_continued_not_settled(world: World) -> None:
    world.model.script(
        "Do it",
        Reply([say("The long report, part one, cut mid-sen")], stop_reason="max_tokens"),
        [say("tence. Part two.")],
    )
    task = await world.start()
    await world.work()

    assert await world.status(task) == "done"
    assert (await world.task(task))["outcome"]["result"] == {
        "text": "The long report, part one, cut mid-sentence. Part two.",
        "images": [],
        "files": [],
        "codeResults": [],
    }
    first, second = world.model.calls
    assert first["max_tokens"] >= 16_000
    assert second["messages"][-1] == {
        "role": "user",
        "content": [{"type": "text", "text": anthropic_provider.MAX_TOKENS_CONTINUE}],
    }


# --- Q81: the step limit -----------------------------------------------------------------------


async def test_a_task_at_its_step_limit_delivers_what_it_has_and_says_so(world: World) -> None:
    world.model.script(
        "Do it",
        [say("Found part one. "), use("r1", READ, q="1")],
        [say("Found part two. "), use("r2", READ, q="2")],
    )
    task = await world.start(maxSteps=2)
    await world.work()

    assert await world.status(task) == "done"
    result = (await world.task(task))["outcome"]["result"]
    assert result["stoppedAt"] == "max_steps"
    assert result["text"].startswith("Found part one. Found part two. ")
    assert result["text"].endswith(runner.step_limit_note(2))
    assert "step limit" in result["text"]
    assert (await world.run(task))["result"]["stoppedAt"] == "max_steps"
    [entry] = await world.events(task, "result")
    assert entry["stoppedAt"] == "max_steps"


async def test_a_spawn_on_the_last_step_still_uses_its_childrens_results(world: World) -> None:
    world.model.script(
        "Do it",
        [use("r1", READ, q="1")],
        [spawn("s", "child-a")],
        [say("Final answer using: the child's finding.")],
    )
    world.model.script("child-a", [say("the child's finding")])
    task = await world.start(maxSteps=2)
    await world.work()

    assert await world.status(task) == "done"
    result = (await world.task(task))["outcome"]["result"]
    assert result["text"] == "Final answer using: the child's finding."
    assert "stoppedAt" not in result
    parent_calls = [c for c in world.model.calls if c["messages"][0]["content"] == "Do it"]
    assert len(parent_calls) == 3
    assert "the child's finding" in str(result_of(parent_calls[-1]["messages"], "s")["content"])


async def test_the_extra_step_after_a_last_step_spawn_starts_no_more_children(
    world: World,
) -> None:
    world.model.script(
        "Do it",
        [spawn("s1", "child-a")],
        [spawn("s2", "child-b")],
    )
    world.model.script("child-a", [say("a")])
    task = await world.start(maxSteps=1)
    await world.work()

    assert await world.status(task) == "done"
    assert len(await world.children(task)) == 1
    result = (await world.task(task))["outcome"]["result"]
    assert result["stoppedAt"] == "max_steps"


# --- Q78: the whole answer, across the task's runs ---------------------------------------------


async def test_answer_resume_done_gives_the_whole_text_once(world: World) -> None:
    world.model.script(
        "Do it",
        [say("Let me check the colour first. "), ask("q1", "Which colour?")],
        [say("Painted it blue.")],
    )
    response, p0 = await world.post_run(_background(world))
    assert response.status_code == 202, response.text
    await world.work()
    response, r1 = await world.resume(p0, {"q1": {"value": "blue"}})
    assert response.status_code == 202, response.text
    await world.work()

    whole = "Let me check the colour first.\n\nPainted it blue."
    assert (await world.task(r1))["outcome"] == {
        "type": "success",
        "result": {"text": whole, "images": [], "files": [], "codeResults": []},
    }
    assert (await world.run(r1))["result"]["text"] == whole
    [entry] = await world.events(r1, "result")
    assert entry["finalText"] == whole


async def test_a_dead_branch_is_not_part_of_the_whole_text(world: World) -> None:
    world.model.script(
        "Do it",
        [say("Before the question. "), ask("q1")],
        [say("After the answer.")],
    )
    response, p0 = await world.post_run(_background(world))
    await world.work()
    # A resume that fails before applying its answer: a dead branch (Q75).
    world.key = False
    response, dead = await world.resume(p0, {"q1": {"value": "x"}})
    assert response.status_code == 202, response.text
    await world.work()
    assert await world.status(dead) == "failed"
    world.key = True
    response, r2 = await world.resume(p0, {"q1": {"value": "y"}})
    assert response.status_code == 202, response.text
    await world.work()

    assert (await world.run(r2))["result"]["text"] == "Before the question.\n\nAfter the answer."


@pytest.fixture
def verifier(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str]]:
    """A verifier model that finds every claim supported by what it cites."""
    monkeypatch.setenv("VERIFY_MODEL", "verifier-model")
    settings_module.get_settings.cache_clear()
    prompts: list[str] = []

    class Client:
        async def messages_create(self, *, model: str, max_tokens: int, messages: Any) -> str:
            prompt = str(messages[0]["content"])
            prompts.append(prompt)
            claims = verify.extract_cited_claims(prompt.split("CLAIMS:\n", 1)[1].split("\n\n")[0])
            return json.dumps(
                {
                    "checks": [
                        {"claim": i + 1, "status": "supported", "sourceIds": ["x"]}
                        for i in range(len(claims))
                    ]
                }
            )

    monkeypatch.setattr(verify_client, "resolve_verifier_client", lambda **_: Client())
    yield prompts
    monkeypatch.undo()
    settings_module.get_settings.cache_clear()


async def test_a_research_report_is_numbered_and_verified_over_the_whole_text(
    world: World, verifier: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    discover = world.discover

    async def with_search(out: dict[str, ToolDescriptor], **kwargs: Any) -> None:
        await discover(out, **kwargs)

        async def search(args: dict[str, Any]) -> ToolInvocationResult:
            q = str(args["q"])
            return ToolInvocationResult(
                text=f"result {q}",
                summary="1 result",
                source_results=[
                    ToolCallResult(
                        title=f"Source {q}", url=f"https://{q}.test", snippet=f"fact {q}"
                    )
                ],
            )

        out["search"] = ToolDescriptor(
            name="search", description="search", input_schema={"type": "object"}, execute=search
        )

    monkeypatch.setattr(executor, "extend_registry_with_mcp", with_search)
    world.model.script(
        "Do it",
        [use("w1", "search", q="alpha")],
        [say("Alpha is true [1]. "), ask("q1", "Go on?")],
        [use("w2", "search", q="beta")],
        [say("Beta is true [2].")],
    )
    response, p0 = await world.post_run(_background(world, research=True))
    assert response.status_code == 202, response.text
    await world.work()
    response, r1 = await world.resume(p0, {"q1": {"value": "yes"}})
    assert response.status_code == 202, response.text
    await world.work()

    whole = "Alpha is true [1].\n\nBeta is true [2]."
    assert (await world.run(r1))["result"]["text"] == whole
    [prompt] = verifier
    assert "[1] Source alpha (https://alpha.test)" in prompt
    assert "[2] Source beta (https://beta.test)" in prompt
    assert "1. Alpha is true [1]." in prompt and "2. Beta is true [2]." in prompt
    [entry] = await world.events(r1, "result")
    checks = entry["verification"]["checks"]
    assert [c["claim"] for c in checks] == ["Alpha is true [1].", "Beta is true [2]."]
    assert entry["verification"]["summary"]["supported"] == 2
    # And on the result itself, next to the text it checked.
    result = (await world.run(r1))["result"]
    assert result["verification"] == entry["verification"]
    assert (await world.task(r1))["outcome"]["result"]["verification"] == entry["verification"]


# --- Q72: at most 20 sub-agents per task -------------------------------------------------------


async def test_the_21st_sub_agent_is_refused_and_the_task_still_finishes(world: World) -> None:
    rounds = [[spawn(f"s{r}", *(f"child-{r}-{i}" for i in range(5)))] for r in range(4)]
    world.model.script(
        "Do it",
        *rounds,
        [spawn("s4", "child-21")],
        [say("Finished with twenty.")],
    )
    task = await world.start(maxSteps=10)
    await world.work(limit=200)

    assert len(await world.children(task)) == 20
    assert await world.status(task) == "done"
    parent_calls = [c for c in world.model.calls if c["messages"][0]["content"] == "Do it"]
    refused = result_of(parent_calls[-1]["messages"], "s4")
    assert refused["is_error"] is True
    assert "at most 20 sub-agents" in refused["content"]
    assert "started 20" in refused["content"]
    assert (await world.task(task))["outcome"]["result"]["text"] == "Finished with twenty."


async def test_the_cap_holds_under_the_lock_when_the_pre_check_is_passed(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A spawn whose unlocked pre-check read a stale count: the lock decides.
    async def stale(*_: Any, **__: Any) -> int:
        return 0

    monkeypatch.setattr(store, "task_child_count", stale)
    rounds = [[spawn(f"s{r}", *(f"child-{r}-{i}" for i in range(5)))] for r in range(4)]
    world.model.script("Do it", *rounds, [spawn("s4", "child-21")], [say("Done.")])
    task = await world.start(maxSteps=10)
    await world.work(limit=200)

    assert await world.status(task) == "done"
    assert len(await world.children(task)) == 20
    parent_calls = [c for c in world.model.calls if c["messages"][0]["content"] == "Do it"]
    assert "at most 20 sub-agents" in result_of(parent_calls[-1]["messages"], "s4")["content"]


# --- a spawn is visible as it happens (the seam's finding) -------------------------------------


def _agui(run_id: str, entries: list[TaskEvent]) -> list[dict[str, Any]]:
    encoder = AgUiRunEncoder(run_id)
    return [e for entry in entries for e in encoder.encode(entry)]


async def _log(world: World, task_id: str) -> list[TaskEvent]:
    return await store.load_run_events(world.pool, run_id=task_id, user_id=world.user)


async def test_a_spawn_gets_its_result_when_its_children_exist(world: World) -> None:
    world.model.script("Do it", [spawn("s", "child-a", "child-b")], [say("Both done.")])
    parent = await world.start()
    await world.tick()  # the parent's start only: its children are queued

    assert await world.status(parent) == "paused"
    assert [await world.status(c) for c in await world.children(parent)] == ["queued", "queued"]
    events = _agui(parent, await _log(world, parent))
    [result] = [e for e in events if e["type"] == "TOOL_CALL_RESULT"]
    assert result["toolCallId"] == "s"
    assert "Started 2 sub-agents" in result["content"]
    started = [i for i, e in enumerate(events) if e["type"] == "SUBAGENT_STARTED"]
    assert len(started) == 2


async def test_each_childs_end_shows_on_its_parent_when_it_settles(world: World) -> None:
    world.model.script("Do it", [spawn("s", "child-asks", "child-works")], [say("Both done.")])
    world.model.script("child-asks", [ask("q1")], [say("asked")])
    parent = await world.start()
    await world.work()
    asks, works = await world.children(parent)
    # One child done, one waiting on the user: the parent still waits.
    assert await world.status(works) == "done"
    assert await world.status(asks) == "paused"
    assert await world.status(parent) == "paused"

    events = _agui(parent, await _log(world, parent))
    finished = [e["subagentRunId"] for e in events if e["type"] == "SUBAGENT_FINISHED"]
    assert finished == [works]

    # Cancelling the other child alone (Q60) ends it on the parent too.
    await world.cancel(asks)
    events = _agui(parent, await _log(world, parent))
    finished = [e["subagentRunId"] for e in events if e["type"] == "SUBAGENT_FINISHED"]
    assert finished == [works, asks]

    await world.work()
    assert await world.status(parent) == "done"
    # The fan-in seeded past the exit entries: no seq was taken twice.
    seqs = [e["seq"] for e in await world.events(parent)]
    assert seqs == sorted(set(seqs))
    assert (await world.task(parent))["checkpoint"]["seq"] >= max(seqs) - 10


# --- Q73 / Q79 / Q80: schedules ----------------------------------------------------------------


async def _create_schedule(world: World, prompt: str, **body: Any) -> dict[str, Any]:
    response = await world.http.post(
        "/v1/tasks/schedules",
        json={
            "workspaceId": world.workspace,
            "name": "Digest",
            "prompt": prompt,
            "cron": "0 8 * * *",
            **body,
        },
        headers=world.headers(),
    )
    assert response.status_code == 201, response.text
    schedule: dict[str, Any] = response.json()
    return schedule


async def _fire(world: World, schedule_id: str) -> str:
    await world.sql(
        "UPDATE public.task_schedules SET next_run_at = now() - interval '1 minute', "
        "last_run_at = NULL WHERE id = $1",
        uuid.UUID(schedule_id),
    )
    assert await schedules.dispatch_due_schedules(schedules.PgScheduleStore(world.pool)) >= 1
    [row] = await world.sql(
        "SELECT last_run_task_id FROM public.task_schedules WHERE id = $1", uuid.UUID(schedule_id)
    )
    return str(row["last_run_task_id"])


async def test_a_schedule_saved_without_a_model_fires_with_haiku(world: World) -> None:
    schedule = await _create_schedule(world, "Morning news")
    assert schedule["model"] == "anthropic/claude-haiku-4.5"
    world.model.script("Morning news", [say("Here is the news.")])

    task = await _fire(world, schedule["id"])
    await world.work()

    row = await world.task(task)
    assert row["checkpoint"]["config"]["model"] == "anthropic/claude-haiku-4.5"
    assert row["status"] == "done"
    assert row["outcome"]["result"]["text"] == "Here is the news."
    assert world.model.calls[-1]["model"] == "claude-haiku-4-5"
    # One conversation per fire (Q80).
    again = await _fire(world, schedule["id"])
    assert (await world.task(again))["conversation_id"] != row["conversation_id"]


async def test_re_enabling_a_schedule_without_a_model_sets_haiku(world: World) -> None:
    schedule = await _create_schedule(world, "Paused one", enabled=False)
    # As 0047 left the editor's schedules: paused, with no model.
    await world.sql(
        "UPDATE public.task_schedules SET model = NULL WHERE id = $1", uuid.UUID(schedule["id"])
    )
    response = await world.http.patch(
        f"/v1/tasks/schedules/{schedule['id']}", json={"enabled": True}, headers=world.headers()
    )
    assert response.status_code == 200, response.text
    assert response.json()["model"] == "anthropic/claude-haiku-4.5"
    # Clearing the model of an enabled schedule keeps it runnable too.
    response = await world.http.patch(
        f"/v1/tasks/schedules/{schedule['id']}", json={"model": None}, headers=world.headers()
    )
    assert response.json()["model"] == "anthropic/claude-haiku-4.5"


async def test_a_schedule_firing_at_the_task_cap_creates_its_task_failed(world: World) -> None:
    for i in range(5):
        world.model.script(f"busy {i}", [ask(f"q{i}")])
        await world.start(f"busy {i}")
    await world.work()
    schedule = await _create_schedule(world, "One too many")

    task = await _fire(world, schedule["id"])

    row = await world.task(task)
    assert row["status"] == "failed"
    assert row["outcome"]["type"] == "error" and row["outcome"]["code"] == "limit_reached"
    assert await world.jobs(task) == []
    assert (await world.run(task))["error"]["code"] == "limit_reached"
    await world.work()
    assert not any(c["messages"][0]["content"] == "One too many" for c in world.model.calls)


async def test_a_schedule_whose_workspace_has_an_approval_server_pauses_for_it(
    world: World,
) -> None:
    schedule = await _create_schedule(world, "Send the digest")
    world.model.script("Send the digest", [use("c1", SEND, to="team")], [say("Sent.")])

    task = await _fire(world, schedule["id"])
    await world.work()

    assert world.count(SEND) == 0
    row = await world.task(task)
    assert row["status"] == "paused"
    [interrupt] = row["outcome"]["interrupts"]
    assert interrupt["reason"] == "approval" and interrupt["toolCallId"] == "c1"
    await world.respond(task, "c1", approved=True)
    await world.work()
    assert world.count(SEND) == 1
    assert await world.status(task) == "done"


# --- Q87 (wave 7): a run's result lists its images --------------------------------------------


async def test_a_task_result_lists_the_images_of_every_run_on_its_line(
    world: World, images: dict[str, list[Any]]
) -> None:
    world.model.script(
        "Draw a cat",
        [use("g1", "generateImage", prompt="a cat")],
        [ask("q1")],
        [say("Done.")],
    )
    response, run = await world.post_run(
        _background(world, skills=[{"id": "imageGen"}]),
        messages=[{"id": "m", "role": "user", "content": "Draw a cat"}],
    )
    assert response.status_code == 202, response.text
    await world.work()
    assert await world.status(run) == "paused"
    _, resumed = await world.resume(run, {"q1": {"value": "x"}})
    await world.work()

    assert await world.status(resumed) == "done"
    result = (await world.run(resumed))["result"]
    # The image came from the run before the question: the result is the
    # whole task's (Q78), images included.
    assert [i["url"] for i in result["images"]] == ["https://signed.test/cat.png"]
    assert result["images"][0]["storagePath"] == "p"
    outcome = (await world.task(resumed))["outcome"]
    assert outcome["result"]["images"] == result["images"]
    # A list row leaves the images out (a data URL can be megabytes, and the
    # list is polled): a client reads them once, from getRun.
    listed = await world.http.get("/v1/runs?mode=background", headers=world.headers())
    [row] = [r for r in listed.json()["runs"] if r["id"] == resumed]
    assert row["result"] == {"text": result["text"]}


async def test_a_parents_result_gathers_its_sub_agents_images(
    world: World, images: dict[str, list[Any]]
) -> None:
    world.model.script("Do it", [spawn("s", "child-draw")], [say("Parent done.")])
    world.model.script(
        "child-draw", [use("g1", "generateImage", prompt="a cat")], [say("Drew it.")]
    )
    response, run = await world.post_run(_background(world, skills=[{"id": "imageGen"}]))
    assert response.status_code == 202, response.text
    await world.work()

    assert await world.status(run) == "done"
    [child] = await world.children(run)
    child_images = (await world.run(child))["result"]["images"]
    assert [i["url"] for i in child_images] == ["https://signed.test/cat.png"]
    # The parent never generated one itself: it carries its sub-agent's.
    assert (await world.run(run))["result"]["images"] == child_images


async def test_a_result_without_images_says_so(world: World) -> None:
    """`[]`, not absent: absent means a result written before 0.5.1, which
    a client has to read the stream for."""
    world.model.script("Do it", [say("Plain.")])
    run = await world.start()
    await world.work()
    assert (await world.run(run))["result"]["images"] == []
    assert (await world.task(run))["outcome"]["result"]["images"] == []

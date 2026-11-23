"""Wave 6-B: the background executor on a real Postgres.

Real poller, executor, Anthropic provider, SQL and `/v1/runs` routes over
a scripted model (`task_world`). Each test names the brief item it proves.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
import pytest_asyncio

from agent_py import image_storage, runner
from agent_py import settings as settings_module
from agent_py.image_storage import DownloadedImage, PersistedImage
from agent_py.providers import anthropic_provider
from agent_py.resume_answers import DECLINED_ANSWER, DECLINED_APPROVAL
from agent_py.runs.in_place import respond_job_payload
from agent_py.tools import image_gen as image_gen_module
from agent_py.tools.minimax_image_client import MinimaxImage, MinimaxImageSuccess

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
    assert row["outcome"] == {"type": "success", "result": {"text": "It is blue."}}
    assert (await world.run(task))["result"] == {"text": "It is blue."}


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
        "result": {"text": "child answer"},
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
    monkeypatch.setattr(image_gen_module, "persist_generated_image", upload)
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
        "text": "The long report, part one, cut mid-sentence. Part two."
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

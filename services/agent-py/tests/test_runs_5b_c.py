"""Wave 5b-C — memory, citation checks, the reference image, `localFilesOnly`,
the per-IP tool budgets and `auto` routing on interactive runs.

The model is `test_native_harness`'s scripted fake; databases, Minimax and
the verifier are monkeypatched at the module seams.
"""

from __future__ import annotations

import base64
import dataclasses
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from agent_py import image_storage, rate_limit, verify_client
from agent_py import settings as settings_module
from agent_py.events import RoutedModelEvent, ToolCallResult, VerificationEvent
from agent_py.model_allowlist import (
    AUTO_MODEL_ID,
    RoutingPair,
    UnknownModelError,
    get_model_allowlist,
    parse_allowlist,
)
from agent_py.rate_limit import (
    IMAGE_GEN_BUDGET,
    WEB_TOOL_BUDGET,
    ToolBudgets,
    image_gen_per_minute,
)
from agent_py.routing import RouteSignals, route_model
from agent_py.runs.agui_encoder import AgUiRunEncoder
from agent_py.runs.harness import RunInput
from agent_py.runs.harness_hooks import DEFAULT_HOOKS
from agent_py.runs.hook_types import HookContext, ToolsetDraft
from agent_py.runs.model import Succeeded
from agent_py.runs.options import RunOptions, validate_run_options
from agent_py.settings import Settings
from agent_py.tools import image_gen as image_gen_module
from agent_py.tools import memory as memory_module
from agent_py.tools.image_gen import build_image_gen_tool, build_remix_note
from agent_py.tools.memory import (
    MEMORY_TOOLS_NOTE,
    MemoryFact,
    MemoryState,
    forget_refusal,
    match_facts_to_forget,
    remember_refusal,
    render_memory_block,
)
from agent_py.tools.minimax_image_client import MinimaxImage, MinimaxImageSuccess
from agent_py.tools.registry import (
    BudgetVerdict,
    RunToolContext,
    ToolDescriptor,
    ToolError,
    ToolInvocationResult,
)
from agent_py.tools.web_fetch import build_web_fetch_tool
from agent_py.tools.web_search import build_web_search_tool

from .runs_support import assert_valid
from .test_harness_hooks import _run
from .test_native_harness import MODEL, _Call, _Model, call, run_input, text, tool, user

FAKE_POOL = object()


def _pool() -> Any:
    return FAKE_POOL


# --- memory ----------------------------------------------------------------------------


def _memory(monkeypatch: pytest.MonkeyPatch, state: MemoryState) -> dict[str, list[Any]]:
    """Patch the memory module's DB seams; returns what they were called with."""
    calls: dict[str, list[Any]] = {"load": [], "insert": [], "delete": []}

    async def load(pool: Any, user_id: str) -> MemoryState:
        calls["load"].append((pool, user_id))
        return state

    async def insert(pool: Any, user_id: str, fact: str, category: str | None) -> bool:
        calls["insert"].append((user_id, fact, category))
        return True

    async def active(pool: Any, user_id: str) -> list[tuple[str, str]]:
        return [("id-1", "Likes tea"), ("id-2", "Lives in Oslo")]

    async def delete(pool: Any, user_id: str, ids: list[str]) -> bool:
        calls["delete"].append(list(ids))
        return True

    monkeypatch.setattr(memory_module, "load_memory_state", load)
    monkeypatch.setattr(memory_module, "insert_fact", insert)
    monkeypatch.setattr(memory_module, "load_active_facts_for_forget", active)
    monkeypatch.setattr(memory_module, "delete_facts", delete)
    return calls


ON = MemoryState(enabled=True, facts=(MemoryFact("Likes tea"), MemoryFact("Lives in Oslo", "home")))


async def test_memory_facts_and_tools_note_join_the_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _memory(monkeypatch, ON)
    model = _Model(_Call([text("ok")]))
    await _run(model, run_input(options={"systemPrompt": "Base."}), pool_provider=_pool)
    request = model.requests[0]
    assert request["system"] == (
        "Base.\n\n"
        "What you know about this user (they can view/edit/remove these in Settings → Memory):\n"
        "- Likes tea\n- Lives in Oslo\n\n" + MEMORY_TOOLS_NOTE
    )
    assert {"rememberFact", "forgetFact"} <= {t["name"] for t in request["tools"]}
    # One read serves the tools and the prompt.
    assert calls["load"] == [(FAKE_POOL, "user-1")]


async def test_memory_with_no_facts_still_offers_the_tools(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _memory(monkeypatch, MemoryState(enabled=True))
    model = _Model(_Call([text("ok")]))
    await _run(model, run_input(), pool_provider=_pool)
    assert model.requests[0]["system"] == MEMORY_TOOLS_NOTE


@pytest.mark.parametrize(
    "case", ["bypass", "anonymous", "disabled", "no-database"], ids=lambda c: str(c)
)
async def test_memory_off_means_no_facts_and_no_tools(
    monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    calls = _memory(monkeypatch, ON if case != "disabled" else MemoryState(enabled=False))
    inp = run_input(options={"memoryBypass": True} if case == "bypass" else None)
    if case == "anonymous":
        inp = dataclasses.replace(inp, user_id=None)
    model = _Model(_Call([text("ok")]))
    await _run(model, inp, pool_provider=(lambda: None) if case == "no-database" else _pool)
    request = model.requests[0]
    assert "system" not in request
    assert not {"rememberFact", "forgetFact"} & {t["name"] for t in request.get("tools", [])}
    # `memoryBypass` / anonymous / no database: no read at all.
    assert calls["load"] == ([] if case != "disabled" else [(FAKE_POOL, "user-1")])


def _tool_result(model: _Model, index: int, block: int = 0) -> dict[str, Any]:
    content = model.requests[index]["messages"][-1]["content"]
    return json.loads(content[block]["content"])


async def test_remember_and_forget_write_on_a_clean_turn(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _memory(monkeypatch, ON)
    model = _Model(
        _Call(
            tools=[
                call("c1", "rememberFact", fact="Prefers metric", category="units"),
                call("c2", "forgetFact", fact="likes tea"),
                call("c3", "forgetFact", fact="Owns a boat"),
            ]
        ),
        _Call([text("done")]),
    )
    result, events = await _run(model, run_input(), pool_provider=_pool)
    assert isinstance(result.outcome, Succeeded)
    assert calls["insert"] == [("user-1", "Prefers metric", "units")]
    assert calls["delete"] == [["id-1"]]
    assert _tool_result(model, 1, 0) == {"ok": True}
    assert _tool_result(model, 1, 1) == {"ok": True, "removed": 1}
    assert _tool_result(model, 1, 2) == {
        "ok": True,
        "removed": 0,
        "note": "No matching memory found.",
    }
    # Memory tools are trusted: the turn stays untainted.
    assert not result.outcome.result.memory_tainted
    summaries = [e.summary for e in events if e.kind == "tool_output"]  # type: ignore[attr-defined]
    assert summaries == ["done", "done", "done"]


async def test_memory_tools_refuse_once_a_web_tool_ran_mid_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _memory(monkeypatch, ON)

    async def add_fetch(
        ri: RunInput, opts: RunOptions, ctx: HookContext, draft: ToolsetDraft
    ) -> None:
        draft.tools["webFetch"] = tool("webFetch")

    hooks = dataclasses.replace(
        DEFAULT_HOOKS, tool_contributors=(*DEFAULT_HOOKS.tool_contributors, add_fetch)
    )
    model = _Model(
        # Same step: remember runs clean, then webFetch taints, then the
        # next calls refuse.
        _Call(
            tools=[
                call("c0", "rememberFact", fact="First"),
                call("c1", "webFetch", url="https://x"),
                call("c2", "rememberFact", fact="Injected"),
            ]
        ),
        _Call(tools=[call("c3", "forgetFact", fact="Likes tea")]),
        _Call([text("done")]),
    )
    result, events = await _run(model, run_input(), hooks=hooks, pool_provider=_pool)
    assert isinstance(result.outcome, Succeeded) and result.outcome.result.memory_tainted
    assert calls["insert"] == [("user-1", "First", None)]
    assert calls["delete"] == []
    assert _tool_result(model, 1, 2) == remember_refusal("webFetch")
    assert _tool_result(model, 2, 0) == forget_refusal("webFetch")
    refusal = remember_refusal("webFetch")["error"]
    outputs = [e for e in events if e.kind == "tool_output"]
    assert outputs[2].summary == refusal  # type: ignore[attr-defined]
    assert not outputs[2].is_error  # type: ignore[attr-defined]


async def test_memory_tools_refuse_on_a_turn_tainted_by_the_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _memory(monkeypatch, ON)
    messages = [
        user("hi"),
        {"id": "a1", "role": "assistant", "content": "", "toolCalls": []},
        {"id": "t1", "role": "tool", "toolCallId": "x", "content": "page text"},
        user("remember that"),
    ]
    model = _Model(_Call(tools=[call("c1", "rememberFact", fact="x")]), _Call([text("no")]))
    # A tool result after the last user message would taint; here it sits
    # before it, so the turn is clean — and an image upload taints.
    image = {
        "type": "image",
        "source": {
            "type": "data",
            "mimeType": "image/png",
            "value": base64.b64encode(b"\x89PNG").decode(),
        },
    }
    tainted = [user([{"type": "text", "text": "remember this"}, image])]
    await _run(model, run_input(messages), pool_provider=_pool)
    assert calls["insert"] == [("user-1", "x", None)]
    model2 = _Model(_Call(tools=[call("c1", "rememberFact", fact="y")]), _Call([text("no")]))
    await _run(model2, run_input(tainted), pool_provider=_pool)
    assert calls["insert"] == [("user-1", "x", None)]
    assert _tool_result(model2, 1)["refused"] is True


def test_memory_pure_helpers_match_next() -> None:
    assert render_memory_block([]) is None
    facts = [("a", "Likes tea"), ("b", "likes tea and coffee"), ("c", "Oslo")]
    assert match_facts_to_forget(facts, " LIKES TEA ") == ["a"]
    assert match_facts_to_forget(facts, "coffee") == ["b"]
    assert match_facts_to_forget(facts, "I live in Oslo") == ["c"]
    assert match_facts_to_forget(facts, "  ") == []


async def test_memory_tools_without_a_run_context_refuse() -> None:
    from agent_py.tools.registry import ToolContext

    remember, _ = memory_module.build_memory_tools(ToolContext(pool=FAKE_POOL, user_id="u"))  # type: ignore[arg-type]
    with pytest.raises(ToolError):
        await remember.execute({"fact": "x"})


# --- citation checks -------------------------------------------------------------------


def _search_tool(results: list[ToolCallResult]) -> ToolDescriptor:
    async def execute(_args: dict[str, Any]) -> ToolInvocationResult:
        return ToolInvocationResult(text="hits", summary="hits", source_results=list(results))

    return ToolDescriptor(
        name="webSearch", description="s", input_schema={"type": "object"}, execute=execute
    )


async def test_verify_citations_emits_a_verification_part(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, Any] = {}
    payload = {
        "checks": [{"claim": "Sky is blue", "status": "supported", "sourceIds": ["1"]}],
        "summary": {"total": 1, "supported": 1, "partial": 0, "unsupported": 0},
    }

    async def fake_verify(**kwargs: Any) -> dict[str, object]:
        seen.update(kwargs)
        return payload

    monkeypatch.setattr(verify_client, "verify_citations", fake_verify)
    hits = [
        ToolCallResult(title="A", url="https://a", snippet="a"),
        ToolCallResult(title="B", url="https://b", snippet="b"),
    ]

    async def add_search(
        ri: RunInput, opts: RunOptions, ctx: HookContext, draft: ToolsetDraft
    ) -> None:
        draft.tools["webSearch"] = _search_tool(hits)

    hooks = dataclasses.replace(
        DEFAULT_HOOKS,
        tool_contributors=(add_search, *DEFAULT_HOOKS.tool_contributors),
    )

    def model() -> _Model:
        return _Model(
            _Call(tools=[call("c1", "webSearch", query="sky")]),
            _Call(tools=[call("c2", "webSearch", query="sky 2")]),
            _Call([text("The sky is blue [1].")]),
        )

    result, events = await _run(
        model(), run_input(options={"verifyCitations": True}), hooks=hooks, pool_provider=_pool
    )
    assert isinstance(result.outcome, Succeeded)
    (part,) = [e for e in events if isinstance(e, VerificationEvent)]
    assert part.verification == payload
    (activity,) = [
        e for e in AgUiRunEncoder("run-1").encode(part) if e["type"] == "ACTIVITY_SNAPSHOT"
    ]
    assert_valid(activity)
    assert activity["activityType"] == "hummingbird.verification"
    assert activity["content"] == payload
    assert seen["text"] == "The sky is blue [1]."
    # Cumulative across the turn's searches, in call order.
    assert seen["sources"] == [("A", "https://a", "a"), ("B", "https://b", "b")] * 2

    # Off by default: no verifier call, no part.
    seen.clear()
    _, events = await _run(model(), run_input(), hooks=hooks, pool_provider=_pool)
    assert not [e for e in events if isinstance(e, VerificationEvent)] and not seen


async def test_verify_citations_needs_sources_and_skips_a_none_verdict(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    called: list[bool] = []

    async def fake_verify(**_kwargs: Any) -> None:
        called.append(True)
        return None

    monkeypatch.setattr(verify_client, "verify_citations", fake_verify)
    # No web search in the turn → no verifier call.
    _, events = await _run(
        _Model(_Call([text("Answer [1].")])),
        run_input(options={"verifyCitations": True}),
        pool_provider=lambda: None,
    )
    assert called == [] and not [e for e in events if isinstance(e, VerificationEvent)]


# --- reference image ---------------------------------------------------------------------


async def test_remix_note_joins_the_prompt_with_image_gen() -> None:
    ref = "https://storage.test/ref.png"
    note = build_remix_note(ref, True)
    assert note == (
        "The user attached a reference image for image-to-image generation. "
        "When they ask for an image variation, edit, or remix, call "
        '`generateImage` with `referenceImageUrl: "https://storage.test/ref.png"` (i2i mode). '
        "If they ask for an unrelated new image instead, ignore the reference."
    )
    model = _Model(_Call([text("ok")]))
    await _run(
        model,
        run_input(options={"referenceImage": {"url": ref}, "skills": [{"id": "imageGen"}]}),
        pool_provider=lambda: None,
    )
    assert model.requests[0]["system"] == note
    # Without the imageGen skill the reference is left out.
    model = _Model(_Call([text("ok")]))
    await _run(
        model, run_input(options={"referenceImage": {"url": ref}}), pool_provider=lambda: None
    )
    assert "system" not in model.requests[0]


# --- localFilesOnly / data-URL fallback -----------------------------------------------------

PNG = b"\x89PNG\r\n\x1a\nfake"


def _transport(log: list[str], *, upload_status: int = 200) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        log.append(f"{request.method} {request.url.path}")
        if request.method == "GET":
            return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})
        if "/object/sign/" in request.url.path:
            return httpx.Response(200, json={"signedURL": "/object/sign/user-files/p?token=t"})
        return httpx.Response(upload_status, json={})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _storage(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.test")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-key")
    settings_module.get_settings.cache_clear()


DATA_URL = "data:image/png;base64," + base64.b64encode(PNG).decode()


@pytest.mark.parametrize(
    ("user_id", "local_only", "upload_status", "stored"),
    [
        ("u1", False, 200, True),
        ("u1", True, 200, False),  # localFilesOnly: never uploaded
        (None, False, 200, False),  # anonymous
        ("u1", False, 500, False),  # failed upload
    ],
)
async def test_persist_or_inline_image(
    monkeypatch: pytest.MonkeyPatch,
    user_id: str | None,
    local_only: bool,
    upload_status: int,
    stored: bool,
) -> None:
    _storage(monkeypatch)
    log: list[str] = []
    async with _transport(log, upload_status=upload_status) as client:
        out = await image_storage.persist_or_inline_image(
            "https://minimax.test/a.png",
            user_id=user_id,
            image_id="img1",
            local_files_only=local_only,
            client=client,
        )
    assert isinstance(out, image_storage.PersistedImage)
    if stored:
        assert out.storage_path == "u1/generated/img1.png"
        assert out.url.startswith("https://proj.supabase.test/storage/v1/object/sign/")
    else:
        assert out.url == DATA_URL and out.storage_path is None
    uploaded = any(entry.startswith("POST") for entry in log)
    assert uploaded == (user_id is not None and not local_only)


async def test_persist_or_inline_image_download_failure_is_an_error() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        out = await image_storage.persist_or_inline_image(
            "https://minimax.test/a.png", user_id=None, image_id="i", client=client
        )
    assert isinstance(out, image_storage.PersistError) and out.code == "download"


def _minimax(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    monkeypatch.setenv("MINIMAX_CN_API_KEY", "k")
    settings_module.get_settings.cache_clear()
    calls: list[dict[str, Any]] = []

    async def fake_generate(**kwargs: Any) -> MinimaxImageSuccess:
        calls.append(kwargs)
        return MinimaxImageSuccess(images=[MinimaxImage(url="https://minimax.test/a.png")])

    monkeypatch.setattr(image_gen_module, "minimax_generate_image", fake_generate)
    return calls


@pytest.mark.parametrize(
    ("user_id", "local_only"), [(None, False), ("u1", True)], ids=["anonymous", "localFilesOnly"]
)
async def test_generate_image_returns_data_urls_on_runs(
    monkeypatch: pytest.MonkeyPatch, user_id: str | None, local_only: bool
) -> None:
    _minimax(monkeypatch)
    seen: list[dict[str, Any]] = []

    async def fake_persist(url: str, **kwargs: Any) -> image_storage.PersistedImage:
        seen.append({"url": url, **kwargs})
        return image_storage.PersistedImage(url=DATA_URL, format="png")

    monkeypatch.setattr(image_gen_module, "persist_or_inline_image", fake_persist)
    tool_ = build_image_gen_tool()
    assert tool_.run_execute is not None
    out = await tool_.run_execute(
        {"prompt": "a cat"}, RunToolContext(user_id=user_id, local_files_only=local_only)
    )
    assert out.images[0]["url"] == DATA_URL and "storagePath" not in out.images[0]
    # The model reads the Minimax URL, not megabytes of base64.
    assert "[1] https://minimax.test/a.png" in out.text and "data:" not in out.text
    assert seen[0]["user_id"] == user_id and seen[0]["local_files_only"] is local_only


async def test_generate_image_on_runs_keeps_a_stored_url(monkeypatch: pytest.MonkeyPatch) -> None:
    _minimax(monkeypatch)

    async def fake_persist(url: str, **kwargs: Any) -> image_storage.PersistedImage:
        return image_storage.PersistedImage(
            url="https://signed.test/x", storage_path="u1/generated/x.png", format="png"
        )

    monkeypatch.setattr(image_gen_module, "persist_or_inline_image", fake_persist)
    tool_ = build_image_gen_tool()
    assert tool_.run_execute is not None
    out = await tool_.run_execute({"prompt": "a cat"}, RunToolContext(user_id="u1"))
    assert out.images[0]["storagePath"] == "u1/generated/x.png"
    assert "[1] https://signed.test/x" in out.text


async def test_local_files_only_reaches_generate_image_through_the_harness(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _minimax(monkeypatch)
    seen: list[dict[str, Any]] = []

    async def fake_persist(url: str, **kwargs: Any) -> image_storage.PersistedImage:
        seen.append(kwargs)
        return image_storage.PersistedImage(url=DATA_URL, format="png")

    monkeypatch.setattr(image_gen_module, "persist_or_inline_image", fake_persist)
    model = _Model(
        _Call(tools=[call("c1", "generateImage", prompt="a cat")]), _Call([text("here")])
    )
    _, events = await _run(
        model,
        run_input(options={"skills": [{"id": "imageGen"}], "localFilesOnly": True}),
        pool_provider=lambda: None,
    )
    assert seen[0]["local_files_only"] is True and seen[0]["user_id"] == "user-1"
    (images,) = [e for e in events if e.kind == "tool_image"]
    assert images.images[0]["url"] == DATA_URL  # type: ignore[attr-defined]


# --- per-IP budgets ------------------------------------------------------------------------


def test_tool_budgets_limit_after_n_per_kind_and_key() -> None:
    budgets = ToolBudgets(web_tool_per_minute=3, image_gen_per_minute=1)
    assert all(budgets("1.1.1.1", WEB_TOOL_BUDGET) for _ in range(3))
    over = budgets("1.1.1.1", WEB_TOOL_BUDGET)
    assert not over and over.retry_after_sec >= 1
    # Separate per key and per kind.
    assert budgets("2.2.2.2", WEB_TOOL_BUDGET)
    assert budgets("1.1.1.1", IMAGE_GEN_BUDGET)
    assert not budgets("1.1.1.1", IMAGE_GEN_BUDGET)
    assert budgets("1.1.1.1", "somethingElse")


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("", 5), ("abc", 5), ("0", 5), ("-3", 5), ("7.9", 7), ("500", 60), ("12", 12)],
)
def test_image_gen_per_minute_reads_like_next(raw: str, expected: int) -> None:
    assert image_gen_per_minute(raw) == expected


def test_tool_budgets_from_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MINIMAX_IMAGE_RATE_LIMIT_PER_MINUTE", "2")
    monkeypatch.setenv("WEB_TOOL_RATE_LIMIT_PER_MINUTE", "1")
    budgets = ToolBudgets.from_settings(Settings())
    assert budgets("k", IMAGE_GEN_BUDGET) and budgets("k", IMAGE_GEN_BUDGET)
    assert not budgets("k", IMAGE_GEN_BUDGET)
    assert budgets("k", WEB_TOOL_BUDGET) and not budgets("k", WEB_TOOL_BUDGET)


def _over(kind: str) -> Callable[[str], BudgetVerdict]:
    def consume(asked: str) -> BudgetVerdict:
        assert asked == kind
        return BudgetVerdict(allowed=False, retry_after_sec=42)

    return consume


async def test_web_tools_refuse_with_next_text_when_over_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ctx = RunToolContext(consume_budget=_over(WEB_TOOL_BUDGET))
    search, fetch = build_web_search_tool(), build_web_fetch_tool()
    assert search.run_execute is not None and fetch.run_execute is not None
    with pytest.raises(ToolError) as e:
        await search.run_execute({"query": "x"}, ctx)
    assert str(e.value) == (
        "webSearch rate limit exceeded for this IP. Retry in 42s. The chat route caps "
        "outbound web tools (webSearch + webFetch combined) per minute."
    )
    with pytest.raises(ToolError) as e:
        await fetch.run_execute({"url": "https://x"}, ctx)
    assert str(e.value).startswith("webFetch rate limit exceeded for this IP. Retry in 42s.")

    from agent_py.tools.registry import ToolContext
    from agent_py.tools.search_files import build_search_files_tool

    files = build_search_files_tool(ToolContext(pool=FAKE_POOL, user_id="u"))  # type: ignore[arg-type]
    assert files.run_execute is not None
    with pytest.raises(ToolError) as e:
        await files.run_execute({"fileId": "f", "query": "q"}, ctx)
    assert str(e.value) == (
        "searchFiles rate limit exceeded for this IP. Retry in 42s. The chat route shares "
        "this bucket across webSearch, webFetch, and searchFiles."
    )


async def test_generate_image_refuses_when_over_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _minimax(monkeypatch)
    tool_ = build_image_gen_tool()
    assert tool_.run_execute is not None
    with pytest.raises(ToolError) as e:
        await tool_.run_execute(
            {"prompt": "a cat"}, RunToolContext(consume_budget=_over(IMAGE_GEN_BUDGET))
        )
    assert str(e.value) == "Image generation rate limit exceeded for this IP. Retry in 42s."
    assert calls == []


async def test_the_harness_limits_image_generation_per_client_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MINIMAX_IMAGE_RATE_LIMIT_PER_MINUTE", "1")
    _minimax(monkeypatch)

    async def fake_persist(url: str, **kwargs: Any) -> image_storage.PersistedImage:
        return image_storage.PersistedImage(url=DATA_URL, format="png")

    monkeypatch.setattr(image_gen_module, "persist_or_inline_image", fake_persist)
    import asyncio

    from agent_py.emitter import RunEmitter
    from agent_py.runs.native_harness import build_native_harness

    harness = build_native_harness(
        Settings(),
        client=_Model(),
        suggestions=False,
        pool_provider=lambda: None,  # type: ignore[arg-type]
    )
    outputs: list[Any] = []

    async def sink(e: Any) -> None:
        if e.kind == "tool_output":
            outputs.append(e)

    for i in range(2):
        harness._client = _Model(  # type: ignore[assignment]
            _Call(tools=[call(f"c{i}", "generateImage", prompt="a cat")]), _Call([text("ok")])
        )
        inp = dataclasses.replace(
            run_input(run_id=f"r{i}", options={"skills": [{"id": "imageGen"}]}),
            client_key="203.0.113.9",
        )
        await harness.run(inp, RunEmitter(run_id=inp.run_id, sink=sink), asyncio.Event())
    assert not outputs[0].is_error
    assert outputs[1].is_error
    assert outputs[1].summary.startswith("Image generation rate limit exceeded for this IP.")


# --- auto routing ------------------------------------------------------------------------------

PAIR = RoutingPair(strong="anthropic/claude-sonnet-4.6", weak="anthropic/claude-haiku-4.5")


@pytest.mark.parametrize(
    ("signals", "tier", "reason"),
    [
        (RouteSignals("hi there", False, 1), "weak", "simple"),
        (RouteSignals("hi", True, 1), "strong", "attachments"),
        (RouteSignals("hi", False, 13), "strong", "long-thread"),
        (RouteSignals("hi", False, 12), "weak", "simple"),
        (RouteSignals("x" * 601, False, 1), "strong", "long-prompt"),
        (RouteSignals("x" * 600, False, 1), "weak", "simple"),
        (RouteSignals("fix this:\n```py\nx\n```", False, 1), "strong", "code"),
        (RouteSignals("const f = () => 1", False, 1), "strong", "code"),
        (RouteSignals("int x = 1;\nmore", False, 1), "strong", "code"),
        (RouteSignals("Can you REFACTOR it", False, 1), "strong", "complexity-keyword"),
        (RouteSignals("explain the trade-offs", False, 1), "strong", "complexity-keyword"),
        (RouteSignals("the planet", False, 1), "weak", "simple"),
        (RouteSignals("éplan", False, 1), "strong", "complexity-keyword"),
    ],
)
def test_route_model_matches_the_ts_router(signals: RouteSignals, tier: str, reason: str) -> None:
    decision = route_model(signals, PAIR)
    assert (decision.tier, decision.reason) == (tier, reason)
    assert decision.model_id == (PAIR.strong if tier == "strong" else PAIR.weak)


def test_allowlist_keeps_an_anthropic_routing_pair_only() -> None:
    models = [{"id": "anthropic/a"}, {"id": "anthropic/b"}, {"id": "openai/c"}]
    ok = parse_allowlist(
        {"models": models, "routing": {"strong": "anthropic/a", "weak": "anthropic/b"}},
        default_model="anthropic/a",
    )
    assert ok.routing == RoutingPair(strong="anthropic/a", weak="anthropic/b")
    mixed = parse_allowlist(
        {"models": models, "routing": {"strong": "anthropic/a", "weak": "openai/c"}},
        default_model="anthropic/a",
    )
    assert mixed.routing is None
    assert parse_allowlist({"models": models}, default_model="anthropic/a").routing is None
    # The repo catalog's pair is anthropic/* on both sides.
    assert get_model_allowlist().routing is not None


def test_validate_run_options_accepts_auto_when_routing_is_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    validate_run_options({"model": AUTO_MODEL_ID})
    validate_run_options({"model": AUTO_MODEL_ID, "mode": "interactive"})
    with pytest.raises(UnknownModelError):
        validate_run_options({"model": AUTO_MODEL_ID, "mode": "background"})
    allowlist = get_model_allowlist()
    unrouted = dataclasses.replace(allowlist, routing=None)
    monkeypatch.setattr("agent_py.runs.options.get_model_allowlist", lambda: unrouted)
    with pytest.raises(UnknownModelError):
        validate_run_options({"model": AUTO_MODEL_ID})


async def test_auto_routes_and_emits_routed_model() -> None:
    pair = get_model_allowlist().routing
    assert pair is not None
    allowlist = get_model_allowlist()

    model = _Model(_Call([text("hi!")]))
    result, events = await _run(
        model, run_input([user("hello")], options={"model": "auto"}), pool_provider=lambda: None
    )
    assert isinstance(result.outcome, Succeeded)
    assert model.requests[0]["model"] == allowlist.resolve(pair.weak)
    (routed,) = [e for e in events if isinstance(e, RoutedModelEvent)]
    assert routed.model == pair.weak
    assert events[0] is routed  # before the first step
    (activity,) = [
        e for e in AgUiRunEncoder("run-1").encode(routed) if e["type"] == "ACTIVITY_SNAPSHOT"
    ]
    assert_valid(activity)
    assert activity["content"] == {"model": pair.weak}

    model = _Model(_Call([text("ok")]))
    _, events = await _run(
        model,
        run_input([user("Please design the architecture")], options={"model": "auto"}),
        pool_provider=lambda: None,
    )
    assert model.requests[0]["model"] == allowlist.resolve(pair.strong)
    assert [e.model for e in events if isinstance(e, RoutedModelEvent)] == [pair.strong]  # type: ignore[attr-defined]


async def test_a_concrete_model_emits_no_routed_model() -> None:
    _, events = await _run(
        _Model(_Call([text("ok")])), run_input(options={"model": MODEL}), pool_provider=lambda: None
    )
    assert not [e for e in events if isinstance(e, RoutedModelEvent)]


def test_rate_limit_module_exports() -> None:
    assert rate_limit.WEB_TOOL_PER_MINUTE == 20
    assert rate_limit.DEFAULT_IMAGE_GEN_PER_MINUTE == 5

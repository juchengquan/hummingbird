"""Every model call goes to its model's provider (wave 10).

With Anthropic and Minimax both configured: a run, a task and an editor
command on a Minimax model reach the Minimax client with
the id Minimax knows; the follow-up chips and the forced tool calls
(structured output, which Minimax answers in plain text) reach the default
model's client; a model without tools gets none (Q116) and isn't run as a
task (Q117).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agent_py import executor
from agent_py.emitter import RunEmitter
from agent_py.model_allowlist import UnknownModelError, get_model_allowlist
from agent_py.model_routes import ModelTarget
from agent_py.routers import editor_ai
from agent_py.runs.model import Succeeded
from agent_py.runs.native_harness import NativeHarness
from agent_py.runs.options import validate_run_options
from agent_py.settings import get_settings

from .test_native_harness import _Call, _Model, run_input, text, tool, toolset

M31 = "minimax/minimax-m3.1-flash"
HAIKU = "anthropic/claude-haiku-4.5"


@pytest.fixture(autouse=True)
def _two_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "")
    monkeypatch.setenv("MINIMAX_CN_API_KEY", "mm")
    monkeypatch.setenv("MINIMAX_CN_BASE_URL", "https://api.minimaxi.com/anthropic/v1")
    get_settings.cache_clear()
    get_model_allowlist.cache_clear()


class _ByProvider:
    """A client factory with one fake per provider (None → the default's)."""

    def __init__(self, **clients: _Model) -> None:
        self.clients = clients
        self.asked: list[str | None] = []

    def __call__(self, target: ModelTarget | None) -> _Model | None:
        provider = (target or get_model_allowlist().default_target).provider
        self.asked.append(provider)
        return self.clients.get(provider or "")


async def _sink(_e: Any) -> None:
    return None


def test_the_repo_routes_under_test() -> None:
    allowlist = get_model_allowlist()
    assert allowlist.target(M31) == ModelTarget(M31, "MiniMax-M3.1-Flash", "minimax-cn")
    assert allowlist.default_target.provider == "anthropic"


async def test_a_run_on_minimax_calls_minimax_and_its_chips_call_the_default() -> None:
    minimax = _Model(_Call([text("answer from minimax")], final_text="answer from minimax"))
    chips = _Model(_Call([text('["a?", "b?", "c?"]')]))
    factory = _ByProvider(**{"minimax-cn": minimax, "anthropic": chips})
    harness = NativeHarness(client_factory=factory, build_tools=toolset(), suggestions=True)
    inp = run_input(options={"model": M31})
    result = await harness.run(inp, RunEmitter(run_id="r", sink=_sink), asyncio.Event())
    assert isinstance(result.outcome, Succeeded)
    assert [r["model"] for r in minimax.requests] == ["MiniMax-M3.1-Flash"]
    assert [r["model"] for r in chips.requests] == ["claude-haiku-4-5"]


async def test_a_model_without_tools_gets_none(monkeypatch: pytest.MonkeyPatch) -> None:
    allowlist = get_model_allowlist()
    import dataclasses

    no_tools = dataclasses.replace(allowlist, no_tools=frozenset({M31}))
    monkeypatch.setattr("agent_py.runs.native_harness.get_model_allowlist", lambda: no_tools)
    minimax = _Model(_Call([text("hi")], final_text="hi"))
    harness = NativeHarness(
        client_factory=_ByProvider(**{"minimax-cn": minimax}),
        build_tools=toolset(tool("searchWeb")),
        suggestions=False,
    )
    inp = run_input(options={"model": M31})
    await harness.run(inp, RunEmitter(run_id="r", sink=_sink), asyncio.Event())
    assert not minimax.requests[0].get("tools")


def test_a_task_on_a_model_without_tools_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    import dataclasses

    no_tools = dataclasses.replace(get_model_allowlist(), no_tools=frozenset({M31}))
    monkeypatch.setattr("agent_py.runs.options.get_model_allowlist", lambda: no_tools)
    validate_run_options({"model": M31})  # chat is fine
    with pytest.raises(UnknownModelError, match="can't run tasks"):
        validate_run_options({"model": M31, "mode": "background"})


def test_the_executor_resolves_the_tasks_model_on_its_provider() -> None:
    client = executor._resolve_anthropic_client(get_model_allowlist().target(M31))
    assert client is not None
    assert str(client.base_url).rstrip("/") == "https://api.minimaxi.com/anthropic"
    assert client.api_key == "mm"


# --- the editor -------------------------------------------------------------


class _Editor:
    """Records the editor's calls; `messages.create` is the forced tool choice."""

    def __init__(self, name: str, log: list[tuple[str, str, str]]) -> None:
        self.name, self.log = name, log
        editor = self

        class _Messages:
            async def create(self, **kw: Any) -> Any:
                editor.log.append((editor.name, "create", kw["model"]))
                from types import SimpleNamespace

                return SimpleNamespace(
                    content=[
                        SimpleNamespace(type="tool_use", name="json", input={"result": "generate"})
                    ]
                )

            def stream(self, **kw: Any) -> Any:
                editor.log.append((editor.name, "stream", kw["model"]))
                return _Model(_Call([text("GEN")], final_text="GEN")).messages.stream(**kw)

        self.messages = _Messages()


def test_the_editor_runs_on_minimax_and_its_tool_choice_on_the_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agent_py.main import create_app

    log: list[tuple[str, str, str]] = []
    clients = {"minimax-cn": _Editor("minimax", log), "anthropic": _Editor("default", log)}
    monkeypatch.setattr(
        editor_ai,
        "resolve_anthropic_client",
        lambda target=None: clients[
            (target or get_model_allowlist().default_target).provider or ""
        ],
    )
    monkeypatch.setattr(editor_ai, "_text_delay", lambda _ms: 0)
    editor_ai.reset_limits()
    with TestClient(create_app(enable_poller=False)) as client:
        r = client.post(
            "/v1/ai/command",
            json={
                "model": M31,
                "messages": [{"role": "user", "parts": [{"type": "text", "text": "write"}]}],
                "document": {
                    "isSelecting": False,
                    "generateContext": "",
                    "commentContext": "",
                    "edit": None,
                },
            },
        )
    assert r.status_code == 200, r.text
    assert log == [
        ("default", "create", "claude-haiku-4-5"),
        ("minimax", "stream", "MiniMax-M3.1-Flash"),
    ]


def test_a_valid_model_without_a_provider_is_503_not_400(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_py.main import create_app

    editor_ai.reset_limits()
    with TestClient(create_app(enable_poller=False)) as client:
        r = client.post(
            "/v1/ai/complete", json={"blockText": "x", "model": "deepseek/deepseek-v4-flash"}
        )
    assert r.status_code == 503
    body = r.json()
    assert body["code"] == "auth" and "deepseek/deepseek-v4-flash" in body["message"]
    json.dumps(body)

"""`/v1/ai/command` and `/v1/ai/complete` (wave 9, Q101-Q105).

The command route replays the Next route's recorded streams
(`fixtures/editor_ai_streams.json`, written by
`app/api/ai/command/stream.fixture.test.ts`): for the same model output it
asks the model the same prompts and emits the same parts. The model is the
real Anthropic SDK over an in-process transport that answers from each
scenario's script. Two documented differences, normalised away:

* agent-py sends no `tool-input-available` / `tool-output-available` parts
  — the Next route's comment / table tool is a model call with an empty
  prompt whose only effect is those parts; the client ignores them;
* ids (`messageId`, a text block's `id`, each data part's `id`) are fresh.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from anthropic import AsyncAnthropic
from fastapi.testclient import TestClient

from agent_py.editor_ai.prompts import complete_prompt
from agent_py.main import create_app
from agent_py.routers import editor_ai
from agent_py.runs import wiring

STREAMS = json.loads(
    (Path(__file__).parent / "fixtures" / "editor_ai_streams.json").read_text(encoding="utf-8")
)


def _sse(events: list[dict[str, Any]]) -> bytes:
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


def _message_start() -> dict[str, Any]:
    return {
        "type": "message_start",
        "message": {
            "id": "msg",
            "type": "message",
            "role": "assistant",
            "model": "claude-haiku-4-5",
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": 1, "output_tokens": 1},
        },
    }


def _end(stop: str) -> list[dict[str, Any]]:
    return [
        {
            "type": "message_delta",
            "delta": {"stop_reason": stop, "stop_sequence": None},
            "usage": {"output_tokens": 1},
        },
        {"type": "message_stop"},
    ]


def text_stream(deltas: list[str]) -> bytes:
    return _sse(
        [
            _message_start(),
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            },
            *(
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": d},
                }
                for d in deltas
            ),
            {"type": "content_block_stop", "index": 0},
            *_end("end_turn"),
        ]
    )


def tool_stream(chunks: list[str]) -> bytes:
    return _sse(
        [
            _message_start(),
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "tool_use", "id": "toolu_1", "name": "json", "input": {}},
            },
            *(
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "input_json_delta", "partial_json": c},
                }
                for c in chunks
            ),
            {"type": "content_block_stop", "index": 0},
            *_end("tool_use"),
        ]
    )


class FakeAnthropic:
    """Answers from a script; records what each call asked."""

    def __init__(self) -> None:
        self.script: dict[str, Any] = {}
        self.calls: list[dict[str, Any]] = []
        self.fail_with: int | None = None

    def kind(self, body: dict[str, Any]) -> str:
        if (body.get("tool_choice") or {}).get("name") == "json":
            props = body["tools"][0]["input_schema"]["properties"]
            return "choose" if "result" in props else "elements"
        return "text"

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        kind = self.kind(body)
        self.calls.append({"kind": kind, **body})
        if self.fail_with is not None:
            return httpx.Response(
                self.fail_with,
                json={"type": "error", "error": {"type": "api_error", "message": "boom"}},
            )
        headers = {"content-type": "text/event-stream"}
        if kind == "choose":
            message = {
                "id": "msg",
                "type": "message",
                "role": "assistant",
                "model": body["model"],
                "content": [
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "json",
                        "input": {"result": self.script["choice"]},
                    }
                ],
                "stop_reason": "tool_use",
                "stop_sequence": None,
                "usage": {"input_tokens": 1, "output_tokens": 1},
            }
            if body.get("stream"):
                raise AssertionError("the tool choice is not streamed")
            return httpx.Response(200, json=message)
        if kind == "elements":
            return httpx.Response(
                200, content=tool_stream(self.script["elements"]["chunks"]), headers=headers
            )
        return httpx.Response(200, content=text_stream(self.script["text"]), headers=headers)

    def prompts(self) -> list[dict[str, str]]:
        return [{"kind": c["kind"], "prompt": c["messages"][0]["content"]} for c in self.calls]


@pytest.fixture
def model(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeAnthropic]:
    fake = FakeAnthropic()
    client = AsyncAnthropic(
        api_key="test",
        base_url="http://model.test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(fake)),
    )
    monkeypatch.setattr(editor_ai, "resolve_anthropic_client", lambda *_: client)
    monkeypatch.setattr(editor_ai, "_text_delay", lambda _ms: 0.0)
    wiring.reset_run_services()
    editor_ai.reset_limits()
    yield fake
    wiring.reset_run_services()
    editor_ai.reset_limits()


@pytest.fixture
def client(model: FakeAnthropic) -> TestClient:
    return TestClient(create_app())


def parse(raw: str) -> list[Any]:
    out: list[Any] = []
    for frame in raw.split("\n\n"):
        frame = frame.strip()
        if not frame:
            continue
        assert frame.startswith("data: "), frame
        data = frame.removeprefix("data: ")
        out.append("[DONE]" if data == "[DONE]" else json.loads(data))
    return out


def normalise(parts: list[Any]) -> list[Any]:
    out = []
    for part in parts:
        if isinstance(part, dict):
            if part["type"] in ("tool-input-available", "tool-output-available"):
                continue
            part = dict(part)
            if "messageId" in part:
                part["messageId"] = "<id>"
            if part["type"].startswith("data-") and "id" in part:
                part["id"] = "<id>"
            if part["type"].startswith("text-"):
                part["id"] = "t"
        out.append(part)
    return out


# --- the Next route's streams ------------------------------------------------


@pytest.mark.parametrize("scenario", STREAMS, ids=lambda s: s["name"])
def test_a_stream_matches_the_next_routes(
    client: TestClient, model: FakeAnthropic, scenario: dict[str, Any]
) -> None:
    model.script = scenario["script"]
    r = client.post("/v1/ai/command", json=scenario["agentPyRequest"])
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/event-stream")
    assert r.headers["x-vercel-ai-ui-message-stream"] == "v1"
    assert normalise(parse(r.text)) == normalise(scenario["parts"])
    # The same questions the Next route asked its model.
    assert model.prompts() == scenario["prompts"]


def test_each_data_part_has_its_own_id(client: TestClient, model: FakeAnthropic) -> None:
    [scenario] = [s for s in STREAMS if s["name"] == "comment"]
    model.script = scenario["script"]
    parts = parse(client.post("/v1/ai/command", json=scenario["agentPyRequest"]).text)
    ids = [p["id"] for p in parts if isinstance(p, dict) and p["type"] == "data-comment"]
    assert len(ids) == 3 and len(set(ids)) == 3


def _request(name: str) -> dict[str, Any]:
    [scenario] = [s for s in STREAMS if s["name"] == name]
    return dict(scenario["agentPyRequest"])


def test_the_default_model_is_the_services_and_a_catalog_id_maps(
    client: TestClient, model: FakeAnthropic
) -> None:
    model.script = {"text": ["x"]}
    client.post("/v1/ai/command", json=_request("generate, nothing selected"))
    client.post(
        "/v1/ai/command",
        json={**_request("generate, nothing selected"), "model": "anthropic/claude-sonnet-4.6"},
    )
    assert [c["model"] for c in model.calls] == ["claude-haiku-4-5", "claude-sonnet-4-6"]
    assert all(c["stream"] for c in model.calls)


def test_the_tool_choice_offers_edit_only_while_selecting(
    client: TestClient, model: FakeAnthropic
) -> None:
    model.script = {"choice": "generate", "text": ["x"]}
    client.post("/v1/ai/command", json=_request("free text, the model picks generate"))
    client.post("/v1/ai/command", json=_request("free text, the model picks edit"))
    choices = [
        c["tools"][0]["input_schema"]["properties"]["result"]["enum"]
        for c in model.calls
        if c["kind"] == "choose"
    ]
    assert choices == [["generate", "comment"], ["generate", "edit", "comment"]]


def test_a_choice_outside_the_options_is_an_error_part(
    client: TestClient, model: FakeAnthropic
) -> None:
    model.script = {"choice": "edit", "text": ["x"]}  # edit, with nothing selected
    parts = parse(
        client.post("/v1/ai/command", json=_request("free text, the model picks generate")).text
    )
    assert [p["type"] if isinstance(p, dict) else p for p in parts] == ["error", "[DONE]"]
    assert [c["kind"] for c in model.calls] == ["choose"]


def test_a_model_failure_mid_stream_is_an_error_part(
    client: TestClient, model: FakeAnthropic
) -> None:
    model.fail_with = 500
    parts = parse(client.post("/v1/ai/command", json=_request("generate, nothing selected")).text)
    types = [p["type"] if isinstance(p, dict) else p for p in parts]
    assert types[-2:] == ["error", "[DONE]"]
    assert "boom" not in json.dumps(parts)  # the provider's words stay in the log


def test_an_element_that_fails_its_schema_is_skipped(
    client: TestClient, model: FakeAnthropic
) -> None:
    model.script = {
        "elements": {
            "chunks": [
                '{"elements":[{"blockId":"p1","comment":7,"content":"x"},',
                '{"blockId":"p1","comment":"ok","content":"AI"}]}',
            ]
        }
    }
    parts = parse(client.post("/v1/ai/command", json=_request("comment")).text)
    comments = [
        p["data"]["comment"] for p in parts if isinstance(p, dict) and p["type"] == "data-comment"
    ]
    assert comments == [{"blockId": "p1", "comment": "ok", "content": "AI"}, None]


# --- refusals ------------------------------------------------------------------


def test_edit_without_a_selection_is_refused(client: TestClient, model: FakeAnthropic) -> None:
    body = {**_request("generate, nothing selected"), "toolName": "edit"}
    r = client.post("/v1/ai/command", json=body)
    assert r.status_code == 400
    assert r.json()["code"] == "invalid_request"
    assert model.calls == []


def test_an_unknown_model_is_refused(client: TestClient, model: FakeAnthropic) -> None:
    r = client.post("/v1/ai/command", json={**_request("comment"), "model": "google/gemini-9"})
    assert r.status_code == 400
    assert r.json()["code"] == "unknown_model"
    r = client.post("/v1/ai/complete", json={"blockText": "x", "model": "claude-haiku-4-5"})
    assert r.status_code == 400
    assert model.calls == []


def test_without_a_model_key_it_says_so(
    monkeypatch: pytest.MonkeyPatch, client: TestClient, model: FakeAnthropic
) -> None:
    """503 `auth`, as summarize: the editor falls back to its demo stream."""
    monkeypatch.setattr(editor_ai, "resolve_anthropic_client", lambda *_: None)
    for path, body in (
        ("/v1/ai/command", _request("comment")),
        ("/v1/ai/complete", {"blockText": "x"}),
    ):
        r = client.post(path, json=body)
        assert r.status_code == 503
        assert r.json()["code"] == "auth"


def test_a_malformed_body_is_refused(client: TestClient) -> None:
    for body in ({"messages": [], "document": {}}, {"messages": "hi"}, {}):
        assert client.post("/v1/ai/command", json=body).status_code in (400, 422)
    assert client.post("/v1/ai/complete", json={"blockText": "x" * 4001}).status_code in (400, 422)


def test_the_body_cap_is_the_next_routes(client: TestClient) -> None:
    big = "x" * (32 * 1024 * 1024 + 1)
    r = client.post(
        "/v1/ai/command",
        content=big.encode(),
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 413
    r = client.post(
        "/v1/ai/complete",
        content=b"x" * (256 * 1024 + 1),
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 413


SECRET = "test-secret-do-not-use-in-prod-32-bytes!"


def _token() -> str:
    import time

    import jwt

    claims = {
        "sub": "6f1c2a4e-8b3d-4f0a-9c1e-2d3b4a5c6d7e",
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int(time.time()) + 3600,
    }
    return jwt.encode(claims, SECRET, algorithm="HS256")


def test_require_auth_for_ai_refuses_anonymous_callers(
    monkeypatch: pytest.MonkeyPatch, model: FakeAnthropic
) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("REQUIRE_AUTH_FOR_AI", "true")
    client = TestClient(create_app())
    model.script = {"text": ["x"]}
    for path, body in (
        ("/v1/ai/command", _request("generate, nothing selected")),
        ("/v1/ai/complete", {"blockText": "x"}),
    ):
        r = client.post(path, json=body)
        assert r.status_code == 401
        assert r.json()["code"] == "auth_required"
        ok = client.post(path, json=body, headers={"Authorization": f"Bearer {_token()}"})
        assert ok.status_code == 200, ok.text


def test_a_bad_bearer_is_401_never_anonymous(
    monkeypatch: pytest.MonkeyPatch, model: FakeAnthropic
) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    client = TestClient(create_app())
    r = client.post(
        "/v1/ai/command", json=_request("comment"), headers={"Authorization": "Bearer nope"}
    )
    assert r.status_code == 401
    assert r.json()["code"] == "auth"
    assert model.calls == []


def test_anonymous_commands_share_the_runs_anonymous_limits(
    monkeypatch: pytest.MonkeyPatch, model: FakeAnthropic
) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("RUNS_ANONYMOUS_RATE_PER_MINUTE", "2")
    wiring.reset_run_services()
    client = TestClient(create_app())
    model.script = {"text": ["x"]}
    body = _request("generate, nothing selected")
    assert [client.post("/v1/ai/command", json=body).status_code for _ in range(3)] == [
        200,
        200,
        429,
    ]
    refused = client.post("/v1/ai/command", json=body)
    assert refused.json()["code"] == "rate_limit"
    assert int(refused.headers["retry-after"]) >= 1
    # Signed in: not limited (the Next route isn't).
    auth = {"Authorization": f"Bearer {_token()}"}
    assert client.post("/v1/ai/command", json=body, headers=auth).status_code == 200


# --- complete ------------------------------------------------------------------


def test_complete_streams_text_from_the_ported_prompt(
    client: TestClient, model: FakeAnthropic
) -> None:
    model.script = {"text": ["jumps ", "over."]}
    r = client.post(
        "/v1/ai/complete", json={"blockText": "The quick brown fox", "prefix": "# Title"}
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/plain")
    assert r.text == "jumps over."
    [call] = model.calls
    assert call["messages"] == [
        {
            "role": "user",
            "content": complete_prompt(block_text="The quick brown fox", prefix="# Title"),
        }
    ]
    assert (call["max_tokens"], call["temperature"], call["model"]) == (60, 0.2, "claude-haiku-4-5")


def test_complete_is_limited_per_ip_for_everyone(
    monkeypatch: pytest.MonkeyPatch, model: FakeAnthropic
) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    client = TestClient(create_app())
    model.script = {"text": ["x"]}
    auth = {"Authorization": f"Bearer {_token()}"}
    codes = [
        client.post("/v1/ai/complete", json={"blockText": "x"}, headers=auth).status_code
        for _ in range(61)
    ]
    assert codes[:60] == [200] * 60
    assert codes[60] == 429


def test_a_failed_completion_ends_the_text(client: TestClient, model: FakeAnthropic) -> None:
    model.fail_with = 500
    r = client.post("/v1/ai/complete", json={"blockText": "x"})
    assert r.status_code == 200
    assert r.text == ""

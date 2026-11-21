"""`/v1/extract-table` + its helpers — Python port of
`app/api/extract-table/route.ts` and `lib/shared/artifacts/extract-table.ts`.

The Anthropic SDK is faked at the `messages.stream` boundary (as in
`test_summarise.py`); each scripted reply is either a final-message
content list or an exception to raise.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from typing import Any
from unittest.mock import patch

import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py.api_errors import categorize_error, upstream_status
from agent_py.extract_table import (
    STRUCTURED_TOOL_NAME,
    TEXT_PATH_SUFFIX,
    ColumnHint,
    Extraction,
    NumberedSource,
    build_extract_table_prompt,
    extraction_json_schema,
    extraction_to_citation_table,
)
from agent_py.main import create_app
from agent_py.model_allowlist import UnknownModelError
from agent_py.routers import extract_table as extract_table_router

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
PATH = "/v1/extract-table"

EXTRACTION = {
    "columns": [{"id": "name", "label": "Name"}, {"id": "price", "label": "Price"}],
    "rows": [
        {
            "cells": [
                {"columnId": "name", "value": "Alpha", "citations": [{"source": 1, "quote": "A"}]},
                {"columnId": "price", "value": "10", "citations": [{"source": 9, "quote": "x"}]},
                {"columnId": "ghost", "value": "dropped"},
            ]
        }
    ],
}

EXPECTED_TABLE = {
    "columns": [
        {"id": "name", "label": "Name", "type": "text"},
        {"id": "price", "label": "Price", "type": "text"},
    ],
    "rows": [
        {
            "name": {"value": "Alpha", "citations": [{"sourceId": "s1", "quote": "A"}]},
            "price": {"value": "10", "citations": []},
        }
    ],
    "sources": [
        {"id": "s1", "title": "Source A", "url": "https://a.test", "snippet": "about a"},
        {"id": "s2", "title": "https://b.test", "url": "https://b.test", "snippet": ""},
    ],
}

BODY = {
    "reportText": "Alpha costs 10.",
    "sources": [
        {"title": "Source A", "url": "https://a.test", "snippet": "about a"},
        {"title": "", "url": "https://b.test", "snippet": ""},
    ],
}


# --- Anthropic fake ---------------------------------------------------


Reply = list[dict[str, Any]] | BaseException


class _FakeStream:
    def __init__(self, reply: Reply) -> None:
        self._reply = reply

    async def __aenter__(self) -> _FakeStream:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    @property
    def text_stream(self) -> AsyncIterator[str]:
        return self._iter()

    async def _iter(self) -> AsyncIterator[str]:
        if isinstance(self._reply, BaseException):
            raise self._reply
        for block in self._reply:
            if block.get("type") == "text":
                yield block["text"]

    async def get_final_message(self) -> dict[str, Any]:
        assert not isinstance(self._reply, BaseException)
        return {"content": self._reply}


class _FakeMessages:
    def __init__(self, replies: list[Reply]) -> None:
        self._replies = list(replies)
        self.calls: list[dict[str, Any]] = []

    def stream(self, **kwargs: Any) -> _FakeStream:
        self.calls.append(kwargs)
        return _FakeStream(self._replies.pop(0))


class _FakeClient:
    def __init__(self, *replies: Reply) -> None:
        self.messages = _FakeMessages(list(replies))


def _tool(payload: Any) -> list[dict[str, Any]]:
    return [{"type": "tool_use", "id": "t1", "name": STRUCTURED_TOOL_NAME, "input": payload}]


def _text(text: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": text}]


class _StatusError(Exception):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


# --- fixtures -----------------------------------------------------------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    return TestClient(create_app(enable_poller=False))


def _auth() -> dict[str, str]:
    token = jwt.encode(
        {
            "sub": "00000000-0000-4000-8000-0000000000aa",
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 3600,
        },
        SECRET,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def _post(client: TestClient, fake: _FakeClient | None, body: dict[str, Any]) -> Any:
    with patch.object(extract_table_router, "resolve_anthropic_client", return_value=fake):
        return client.post(PATH, json=body, headers=_auth())


# --- route: auth + validation ------------------------------------------


def test_rejects_missing_token(client: TestClient) -> None:
    r = client.post(PATH, json=BODY)
    assert r.status_code == 401


@pytest.mark.parametrize(
    "body",
    [
        {},
        {**BODY, "reportText": ""},
        {**BODY, "sources": []},
        {**BODY, "sources": [{"title": "t", "url": "u"}]},  # snippet required
        {**BODY, "columnHints": [""]},
        {**BODY, "columnHints": [{"label": "x", "type": "currency"}]},
        {**BODY, "columnHints": ["a"] * 9},
        {**BODY, "model": "m" * 101},
    ],
)
def test_invalid_body_is_422(client: TestClient, body: dict[str, Any]) -> None:
    fake = _FakeClient()
    r = _post(client, fake, body)
    assert r.status_code == 422
    assert fake.messages.calls == []


def test_unknown_model_is_400(client: TestClient) -> None:
    fake = _FakeClient()
    r = _post(client, fake, {**BODY, "model": "google/gemini-2.5-flash"})
    assert r.status_code == 400
    assert r.json()["code"] == "unknown_model"
    assert fake.messages.calls == []


def test_no_anthropic_key_is_503(client: TestClient) -> None:
    r = _post(client, None, BODY)
    assert r.status_code == 503
    assert r.json()["code"] == "auth"


# --- route: generation paths -------------------------------------------


def test_structured_happy_path(client: TestClient) -> None:
    """Default model (Haiku 4.5) is flagged `supportsStructuredOutput` →
    one forced-tool call; its input becomes the table."""
    fake = _FakeClient(_tool(EXTRACTION))
    r = _post(client, fake, BODY)
    assert r.status_code == 200, r.text
    assert r.json() == EXPECTED_TABLE
    [call] = fake.messages.calls
    assert call["model"] == "claude-haiku-4-5"
    assert call["max_tokens"] == 4000
    assert call["temperature"] == 0.2
    assert call["tool_choice"] == {"type": "tool", "name": STRUCTURED_TOOL_NAME}
    assert call["tools"][0]["input_schema"] == extraction_json_schema()
    sources = [NumberedSource(id=f"s{i + 1}", **s) for i, s in enumerate(BODY["sources"])]
    assert call["messages"] == [
        {"role": "user", "content": build_extract_table_prompt(BODY["reportText"], sources)}
    ]


def test_explicit_model_and_column_hints_reach_the_prompt(client: TestClient) -> None:
    fake = _FakeClient(_tool(EXTRACTION))
    body = {
        **BODY,
        "model": "anthropic/claude-sonnet-4.6",
        "columnHints": ["Name", {"label": "Price", "type": "number"}],
    }
    r = _post(client, fake, body)
    assert r.status_code == 200
    [call] = fake.messages.calls
    assert call["model"] == "claude-sonnet-4-6"
    prompt = call["messages"][0]["content"]
    assert "Required columns (use these labels and value formats exactly): " in prompt
    assert "`Name` (Text), `Price` (Number)." in prompt


def test_structured_failure_falls_back_to_text(client: TestClient) -> None:
    """A structured-path error (here: off-schema tool input) falls through
    to the text path, whose prompt carries the JSON-only suffix and whose
    fenced JSON is accepted."""
    fake = _FakeClient(
        _tool({"columns": []}),
        _text('```json\n{"columns":[{"id":"name","label":"Name"}],"rows":[]}\n```'),
    )
    r = _post(client, fake, BODY)
    assert r.status_code == 200, r.text
    assert r.json()["columns"] == [{"id": "name", "label": "Name", "type": "text"}]
    structured, text = fake.messages.calls
    assert "tools" not in text
    assert text["messages"][0]["content"] == (
        structured["messages"][0]["content"] + TEXT_PATH_SUFFIX
    )


def test_structured_provider_error_falls_back_to_text(client: TestClient) -> None:
    fake = _FakeClient(RuntimeError("tool use unsupported"), _text(_json(EXTRACTION)))
    r = _post(client, fake, BODY)
    assert r.status_code == 200
    assert r.json() == EXPECTED_TABLE


def test_model_without_structured_flag_uses_text_path_only(client: TestClient) -> None:
    fake = _FakeClient(_text(_json(EXTRACTION)))
    allowlist = extract_table_router.get_model_allowlist()
    with patch.object(type(allowlist), "supports_structured_output", return_value=False):
        r = _post(client, fake, BODY)
    assert r.status_code == 200
    [call] = fake.messages.calls
    assert "tools" not in call


def test_text_path_invalid_json_is_502(client: TestClient) -> None:
    fake = _FakeClient(RuntimeError("no structured"), _text("not json at all"))
    r = _post(client, fake, BODY)
    assert r.status_code == 502
    assert r.json() == {
        "code": "provider",
        "message": "Extraction model did not return valid JSON.",
    }


def test_text_path_off_schema_is_502(client: TestClient) -> None:
    fake = _FakeClient(RuntimeError("no structured"), _text('{"columns": "nope"}'))
    r = _post(client, fake, BODY)
    assert r.status_code == 502
    assert r.json() == {
        "code": "provider",
        "message": "Extraction model output did not match the schema.",
    }


@pytest.mark.parametrize(
    "exc, status, code",
    [
        (_StatusError("Too Many Requests", 429), 429, "rate_limit"),
        (_StatusError("invalid x-api-key", 401), 401, "auth"),
        (_StatusError("prompt is too long: 300000 tokens", 400), 400, "context_window"),
        (_StatusError("Overloaded", 503), 502, "provider"),
        (RuntimeError("something odd"), 500, "unknown"),
    ],
)
def test_provider_error_is_categorized(
    client: TestClient, exc: BaseException, status: int, code: str
) -> None:
    """Both steps fail with the provider error → `categorize_error`
    picks the status + code, as `categorizeError` does in Next."""
    fake = _FakeClient(exc, exc)
    r = _post(client, fake, BODY)
    assert r.status_code == status
    assert r.json() == {"code": code, "message": str(exc)}


# --- helpers --------------------------------------------------------------


def _json(payload: Any) -> str:
    import json

    return json.dumps(payload)


def test_extraction_to_citation_table_maps_sources_and_drops_bad_refs() -> None:
    sources = [NumberedSource(id=f"s{i + 1}", **s) for i, s in enumerate(BODY["sources"])]
    table = extraction_to_citation_table(Extraction.model_validate(EXTRACTION), sources)
    assert table == EXPECTED_TABLE


def test_extraction_to_citation_table_truncates_and_defaults() -> None:
    extraction = Extraction.model_validate(
        {"columns": [{"id": "n", "label": "N", "type": "number"}], "rows": []}
    )
    table = extraction_to_citation_table(
        extraction, [NumberedSource(id="s1", title="t" * 400, url=None, snippet="x" * 1500)]
    )
    assert table["columns"] == [{"id": "n", "label": "N", "type": "number"}]
    [source] = table["sources"]
    assert len(source["title"]) == 300
    assert len(source["snippet"]) == 1000
    assert "url" not in source


def test_extraction_json_schema_has_no_refs() -> None:
    schema = extraction_json_schema()
    assert "$ref" not in _json(schema)
    assert "$defs" not in schema
    assert schema["required"] == ["columns", "rows"]


def test_prompt_free_columns_vs_hints() -> None:
    sources = [NumberedSource(id="s1", title="A", url="https://a", snippet="snip")]
    free = build_extract_table_prompt("R", sources)
    assert "- Choose 3\u20136 columns" in free
    assert "[1] A — https://a\n    snip" in free
    assert "Required columns" not in free
    # Empty hints behave like no hints (regression guard in the TS tests too).
    assert build_extract_table_prompt("R", sources, []) == free

    hinted = build_extract_table_prompt(
        "R", sources, [ColumnHint(label="When", type="date"), "Name"]
    )
    assert "Build a table with EXACTLY these columns" in hinted
    assert "Choose 3\u20136 columns" not in hinted
    assert "Per-type value format:\n- For (Text) columns: emit prose." in hinted
    assert "YYYY-MM-DD" in hinted
    assert "`When` (Date), `Name` (Text)." in hinted


# --- categorize_error -----------------------------------------------------


def test_upstream_status_reads_attribute_then_anchored_message() -> None:
    assert upstream_status(_StatusError("x", 418), "x") == 418
    assert upstream_status(RuntimeError("HTTP 502 bad"), "HTTP 502 bad") == 502
    # A bare 3-digit number mid-message isn't a status.
    assert upstream_status(RuntimeError("used 400 tokens"), "used 400 tokens") is None


def test_categorize_error_unknown_model() -> None:
    cat = categorize_error(UnknownModelError("x/y"))
    assert (cat.status, cat.code) == (400, "unknown_model")

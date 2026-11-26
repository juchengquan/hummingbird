"""`/v1/memory/extract` + `agent_py.memory_extract` (port of
`app/api/memory/extract/route.ts`, `lib/server/memory/{extract,prompt,merge}.ts`).

Parity: `fixtures/memory_parity.json` holds prompts and merge plans
produced by running the TS originals with bun
(`bun run codegen:agent-py-parity`).
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py import settings as settings_module
from agent_py.main import create_app
from agent_py.memory_extract import (
    EXTRACTION_JSON_SCHEMA,
    MEMORY_EXTRACT_MAX_TOKENS,
    FactOp,
    MemoryFact,
    build_memory_extract_prompt,
    extract_facts,
    merge_facts,
    plan_to_json,
    resolve_memory_model,
    resolve_memory_target,
)
from agent_py.model_allowlist import parse_allowlist
from agent_py.model_routes import Provider
from agent_py.routers import memory as memory_router

from .test_embed import Responder, fake_pool, pg_error
from .test_extract_table import _FakeClient, _text, _tool

SECRET = "memory-test-secret-at-least-32-bytes-long"
USER = "00000000-0000-4000-8000-0000000000aa"
CONV = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
PATH = "/v1/memory/extract"

_FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "memory_parity.json").read_text(encoding="utf-8")
)


def _facts(raw: list[dict[str, Any]]) -> list[MemoryFact]:
    return [MemoryFact(id=f["id"], fact=f["fact"], category=f["category"]) for f in raw]


# --- parity -------------------------------------------------------------


@pytest.mark.parametrize("case", _FIXTURE["prompts"], ids=[c["name"] for c in _FIXTURE["prompts"]])
def test_prompt_matches_ts(case: dict[str, Any]) -> None:
    assert build_memory_extract_prompt(case["turn"], _facts(case["existing"])) == case["prompt"]


@pytest.mark.parametrize("case", _FIXTURE["merges"], ids=[c["name"] for c in _FIXTURE["merges"]])
def test_merge_matches_ts(case: dict[str, Any]) -> None:
    ops = [FactOp.model_validate(op) for op in case["ops"]]
    assert plan_to_json(merge_facts(_facts(case["existing"]), ops)) == case["plan"]


def test_fact_op_rejects_what_zod_rejects() -> None:
    for bad in (
        {"op": "add", "fact": ""},
        {"op": "add", "fact": "x" * 501},
        {"op": "add", "fact": "x", "category": "c" * 41},
        {"op": "delete", "fact": "x"},
        {"op": "add", "fact": "x", "category": None},
    ):
        with pytest.raises(ValueError):
            FactOp.model_validate(bad)


# --- model resolution -----------------------------------------------------

_CATALOG = {
    "models": [
        {
            "id": "anthropic/claude-haiku-4.5",
            "anthropicModelId": "claude-haiku-4-5",
            "supportsStructuredOutput": True,
        },
        {"id": "anthropic/claude-sonnet-4.6", "supportsStructuredOutput": True},
        {
            "id": "google/gemini-2.5-flash",
            "supportsStructuredOutput": True,
            "routes": [{"via": "gateway"}],
        },
        {
            "id": "google/gemini-2.5-pro",
            "supportsStructuredOutput": True,
            "routes": [{"via": "gateway"}],
        },
        {"id": "minimax/minimax-m3", "routes": [{"via": "minimax-cn", "upstreamId": "MiniMax-M3"}]},
    ]
}
_PROVIDERS = {
    "anthropic": Provider("anthropic", "https://api.anthropic.com", api_key="k"),
    "gateway": Provider("gateway", "https://ai-gateway.vercel.sh", auth_token="g"),
    "minimax-cn": Provider("minimax-cn", "https://api.minimaxi.com/anthropic", api_key="m"),
}
_ALLOW = parse_allowlist(_CATALOG, default_model="anthropic/claude-haiku-4.5", providers=_PROVIDERS)


def test_memory_model_uses_an_allowed_override_else_the_default() -> None:
    assert resolve_memory_model(_ALLOW, "anthropic/claude-sonnet-4.6") == "claude-sonnet-4.6"
    assert resolve_memory_model(_ALLOW, "") == "claude-haiku-4-5"
    # The Next.js default runs here now, on the Gateway (wave 10).
    assert resolve_memory_model(_ALLOW, "google/gemini-2.5-flash") == "google/gemini-2.5-flash"
    assert resolve_memory_model(_ALLOW, "claude-sonnet-4-6") == "claude-haiku-4-5"


def test_memory_model_needs_structured_output_and_a_provider() -> None:
    """Extraction is a forced tool call: a model without structured output
    (Minimax answers a forced tool in text) or without a provider here falls
    back to the default."""
    assert resolve_memory_model(_ALLOW, "minimax/minimax-m3") == "claude-haiku-4-5"
    no_gateway = parse_allowlist(
        _CATALOG,
        default_model="anthropic/claude-haiku-4.5",
        providers={"anthropic": _PROVIDERS["anthropic"]},
    )
    assert resolve_memory_model(no_gateway, "google/gemini-2.5-pro") == "claude-haiku-4-5"
    target = resolve_memory_target(_ALLOW, "google/gemini-2.5-pro")
    assert (target.provider, target.api_id) == ("gateway", "google/gemini-2.5-pro")


# --- extract_facts ------------------------------------------------------------


def memory_db(
    *,
    enabled: bool = True,
    facts: list[MemoryFact] | None = None,
    insert_error: BaseException | None = None,
) -> Responder:
    rows = [{"id": f.id, "fact": f.fact, "category": f.category} for f in facts or []]

    def respond(method: str, sql: str, args: tuple[Any, ...]) -> Any:
        if sql.startswith("SELECT memory_enabled FROM public.profiles"):
            return enabled
        if sql.startswith("SELECT id::text AS id, fact, category FROM public.user_memories"):
            return rows
        if sql.startswith("INSERT INTO public.user_memories"):
            if insert_error is not None:
                raise insert_error
            return "INSERT 0 1"
        if sql.startswith("UPDATE public.user_memories"):
            return "UPDATE 1"
        raise AssertionError(f"unexpected SQL: {sql}")

    return respond


EXISTING = [
    MemoryFact(id="11111111-1111-4111-8111-111111111111", fact="Writes Rust", category="tech")
]


async def test_extracts_and_writes_as_the_user() -> None:
    pool, log = fake_pool(memory_db(facts=EXISTING))
    client = _FakeClient(
        _tool(
            {
                "facts": [
                    {"op": "add", "fact": "Uses Neovim", "category": "tools"},
                    {"op": "update", "id": EXISTING[0].id, "fact": "Writes Go now"},
                    {"op": "update", "id": "hallucinated", "fact": "dropped"},
                ]
            }
        )
    )
    await extract_facts(
        pool,
        user_id=USER,
        turn_text="User: I moved to Go.",
        conversation_id=CONV,
        client=client,  # type: ignore[arg-type]
        model="claude-haiku-4-5",
    )
    call = client.messages.calls[0]
    assert call["model"] == "claude-haiku-4-5"
    assert call["temperature"] == 0
    assert call["max_tokens"] == MEMORY_EXTRACT_MAX_TOKENS
    assert call["tool_choice"] == {"type": "tool", "name": "json"}
    assert call["tools"][0]["input_schema"] == EXTRACTION_JSON_SCHEMA
    assert call["messages"][0]["content"] == build_memory_extract_prompt(
        "User: I moved to Go.", EXISTING
    )

    assert all(entry[3] for entry in log), "every query runs impersonated"
    insert = next(e for e in log if e[1].startswith("INSERT"))
    assert insert[2] == (USER, ["Uses Neovim"], ["tools"], CONV)
    updates = [e for e in log if e[1].startswith("UPDATE")]
    assert len(updates) == 1
    assert updates[0][2][:3] == (EXISTING[0].id, "Writes Go now", None)
    assert updates[0][2][4] == USER


async def test_memory_disabled_is_a_no_op() -> None:
    pool, log = fake_pool(memory_db(enabled=False))
    client = _FakeClient()
    await extract_facts(
        pool,
        user_id=USER,
        turn_text="t",
        conversation_id=None,
        client=client,
        model="m",  # type: ignore[arg-type]
    )
    assert client.messages.calls == []
    assert [e[1].split()[0] for e in log] == ["SELECT"]


async def test_no_model_client_skips_after_the_gate() -> None:
    pool, log = fake_pool(memory_db())
    await extract_facts(
        pool, user_id=USER, turn_text="t", conversation_id=None, client=None, model="m"
    )
    assert not [e for e in log if not e[1].startswith("SELECT")]


@pytest.mark.parametrize(
    "reply",
    [
        RuntimeError("529 overloaded"),
        _text("not a tool call"),
        _tool({"facts": [{"op": "add", "fact": ""}]}),
        _tool({"facts": [{"op": "add", "fact": "x"}] * 21}),
    ],
)
async def test_model_failures_write_nothing(reply: Any) -> None:
    pool, log = fake_pool(memory_db())
    await extract_facts(
        pool,
        user_id=USER,
        turn_text="t",
        conversation_id=None,
        client=_FakeClient(reply),
        model="m",  # type: ignore[arg-type]
    )
    assert not [e for e in log if not e[1].startswith("SELECT")]


async def test_failed_insert_does_not_stop_updates() -> None:
    pool, log = fake_pool(memory_db(facts=EXISTING, insert_error=pg_error("23503")))
    client = _FakeClient(
        _tool(
            {
                "facts": [
                    {"op": "add", "fact": "new"},
                    {"op": "update", "id": EXISTING[0].id, "fact": "revised", "category": "tech"},
                ]
            }
        )
    )
    await extract_facts(
        pool,
        user_id=USER,
        turn_text="t",
        conversation_id="not-synced",
        client=client,
        model="m",  # type: ignore[arg-type]
    )
    assert [e[1].split()[0] for e in log if not e[1].startswith("SELECT")] == ["INSERT", "UPDATE"]


async def test_absent_conversation_id_stores_null_provenance() -> None:
    pool, log = fake_pool(memory_db())
    client = _FakeClient(_tool({"facts": [{"op": "add", "fact": "x"}]}))
    await extract_facts(
        pool,
        user_id=USER,
        turn_text="t",
        conversation_id=None,
        client=client,
        model="m",  # type: ignore[arg-type]
    )
    assert next(e for e in log if e[1].startswith("INSERT"))[2][3] is None


async def test_db_failure_is_swallowed() -> None:
    def broken(method: str, sql: str, args: tuple[Any, ...]) -> Any:
        raise OSError("connection reset")

    pool, _ = fake_pool(broken)
    await extract_facts(
        pool,
        user_id=USER,
        turn_text="t",
        conversation_id=None,
        client=_FakeClient(),
        model="m",  # type: ignore[arg-type]
    )


# --- route -------------------------------------------------------------------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    return TestClient(create_app(enable_poller=False))


def _auth() -> dict[str, str]:
    token = jwt.encode(
        {
            "sub": USER,
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 3600,
        },
        SECRET,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


BODY = {"turnText": "User: I write Rust.\n\nAssistant: Noted.", "conversationId": CONV}


def test_requires_auth(client: TestClient) -> None:
    assert client.post(PATH, json=BODY).status_code == 401


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"turnText": ""},
        {"turnText": "x" * 50_001},
        {"turnText": "x", "conversationId": "c" * 65},
    ],
)
def test_invalid_body_is_422(client: TestClient, body: dict[str, Any]) -> None:
    assert client.post(PATH, json=body, headers=_auth()).status_code == 422


def test_happy_path_runs_extraction(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MEMORY_EXTRACT_MODEL", "google/gemini-2.5-flash")
    settings_module.get_settings.cache_clear()
    fake = AsyncMock()
    with (
        patch.object(memory_router, "has_pool", return_value=True),
        patch.object(memory_router, "get_pool", return_value="POOL"),
        patch.object(memory_router, "resolve_anthropic_client", return_value="CLIENT"),
        patch.object(memory_router, "extract_facts", fake),
    ):
        r = client.post(PATH, json=BODY, headers=_auth())
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert fake.await_args is not None
    kwargs = fake.await_args.kwargs
    assert fake.await_args.args == ("POOL",)
    assert kwargs["user_id"] == USER
    assert kwargs["turn_text"] == BODY["turnText"]
    assert kwargs["conversation_id"] == CONV
    assert kwargs["client"] == "CLIENT"
    # A non-anthropic MEMORY_EXTRACT_MODEL falls back to the service default.
    from agent_py.model_allowlist import get_model_allowlist

    assert kwargs["model"] == get_model_allowlist().default_api_id


def test_tainted_turn_is_skipped(client: TestClient) -> None:
    fake = AsyncMock()
    with (
        patch.object(memory_router, "has_pool", return_value=True),
        patch.object(memory_router, "extract_facts", fake),
    ):
        r = client.post(PATH, json={**BODY, "tainted": True}, headers=_auth())
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    fake.assert_not_awaited()


def test_no_db_pool_is_ok_without_extracting(client: TestClient) -> None:
    fake = AsyncMock()
    with patch.object(memory_router, "extract_facts", fake):
        r = client.post(PATH, json=BODY, headers=_auth())
    assert r.json() == {"ok": True}
    fake.assert_not_awaited()


def test_memory_disabled_end_to_end_is_ok(client: TestClient) -> None:
    pool, log = fake_pool(memory_db(enabled=False))
    fake_client = _FakeClient()
    with (
        patch.object(memory_router, "has_pool", return_value=True),
        patch.object(memory_router, "get_pool", return_value=pool),
        patch.object(memory_router, "resolve_anthropic_client", return_value=fake_client),
    ):
        r = client.post(PATH, json=BODY, headers=_auth())
    assert r.json() == {"ok": True}
    assert fake_client.messages.calls == []
    assert len(log) == 1

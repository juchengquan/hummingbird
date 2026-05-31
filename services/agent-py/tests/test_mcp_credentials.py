"""Phase 3f tests — `mcp_credentials.fetch_decrypted_credentials`.

The Postgres RPC is patched at the connection boundary so we test the
helper's contract (RLS impersonation order, jsonb decoding, missing
key, short key, RPC failure → None) without a live database.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock

import pytest

from agent_py import settings as settings_module
from agent_py import store
from agent_py.mcp_credentials import fetch_decrypted_credentials

SERVER_ID = "11111111-1111-1111-1111-111111111111"
USER_ID = "22222222-2222-2222-2222-222222222222"
KEY = "this-is-a-test-key-32-bytes-long!"


class _FakeConnection:
    """Captures every SQL call issued inside the with-block so tests
    can assert that the RLS impersonation runs in order and the RPC
    call lands with the right args."""

    def __init__(self, rpc_return: Any = None, rpc_raises: Exception | None = None) -> None:
        self.executed: list[tuple[str, tuple[Any, ...]]] = []
        self.fetched: list[tuple[str, tuple[Any, ...]]] = []
        self._rpc_return = rpc_return
        self._rpc_raises = rpc_raises

    async def execute(self, sql: str, *args: Any) -> None:
        self.executed.append((sql, args))

    async def fetchval(self, sql: str, *args: Any) -> Any:
        self.fetched.append((sql, args))
        if self._rpc_raises is not None:
            raise self._rpc_raises
        return self._rpc_return

    def transaction(self):
        # `async with conn.transaction():` — return self as an async CM.
        # Real asyncpg uses a separate object; we keep it simple.
        return _FakeTransaction()


class _FakeTransaction:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *args: Any) -> None:
        return None


def _fake_pool(conn: _FakeConnection) -> Any:
    """Wrap a fake connection in a fake pool whose `.acquire()` returns
    it as an async context manager."""
    pool = MagicMock()

    class _Acquire:
        async def __aenter__(self) -> _FakeConnection:
            return conn

        async def __aexit__(self, *args: Any) -> None:
            return None

    pool.acquire = MagicMock(return_value=_Acquire())
    return pool


# --- short / missing key ------------------------------------------------


@pytest.mark.asyncio
async def test_missing_encryption_key_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MCP_ENCRYPTION_KEY", raising=False)
    settings_module.get_settings.cache_clear()
    conn = _FakeConnection(rpc_return='{"headers":{}}')
    out = await fetch_decrypted_credentials(_fake_pool(conn), user_id=USER_ID, server_id=SERVER_ID)
    assert out is None
    # Short-circuited before touching the pool — no SQL issued.
    assert conn.fetched == []
    assert conn.executed == []


@pytest.mark.asyncio
async def test_short_encryption_key_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MCP_ENCRYPTION_KEY", "too-short")
    settings_module.get_settings.cache_clear()
    conn = _FakeConnection(rpc_return='{"headers":{}}')
    out = await fetch_decrypted_credentials(_fake_pool(conn), user_id=USER_ID, server_id=SERVER_ID)
    assert out is None
    assert conn.fetched == []


# --- happy path ---------------------------------------------------------


@pytest.mark.asyncio
async def test_happy_path_returns_decoded_credentials() -> None:
    payload = {"headers": {"Authorization": "Bearer xyz", "X-API-Key": "k"}}
    conn = _FakeConnection(rpc_return=json.dumps(payload))
    out = await fetch_decrypted_credentials(
        _fake_pool(conn),
        user_id=USER_ID,
        server_id=SERVER_ID,
        encryption_key=KEY,
    )
    assert out == payload
    # Sanity — the helper issued SET ROLE + set_config (RLS
    # impersonation) before the RPC call.
    assert len(conn.executed) == 2
    assert "SET LOCAL ROLE authenticated" in conn.executed[0][0]
    assert "set_config" in conn.executed[1][0]
    # The RPC call passes server_id + key in that order.
    assert len(conn.fetched) == 1
    _, args = conn.fetched[0]
    assert args[0] == SERVER_ID
    assert args[1] == KEY


@pytest.mark.asyncio
async def test_dict_payload_passes_through() -> None:
    """If asyncpg has a jsonb codec registered (rare in this service
    but defensible), the RPC value comes back as a dict directly — no
    string-decoding step needed."""
    payload = {"headers": {"Authorization": "Bearer xyz"}}
    conn = _FakeConnection(rpc_return=payload)
    out = await fetch_decrypted_credentials(
        _fake_pool(conn),
        user_id=USER_ID,
        server_id=SERVER_ID,
        encryption_key=KEY,
    )
    assert out == payload


# --- failure paths ------------------------------------------------------


@pytest.mark.asyncio
async def test_no_row_returns_none() -> None:
    """RLS hides the row OR decryption fails inside Postgres → RPC
    returns NULL → helper returns None."""
    conn = _FakeConnection(rpc_return=None)
    out = await fetch_decrypted_credentials(
        _fake_pool(conn),
        user_id=USER_ID,
        server_id=SERVER_ID,
        encryption_key=KEY,
    )
    assert out is None


@pytest.mark.asyncio
async def test_rpc_exception_returns_none() -> None:
    """A connection blip / wrong-key decode failure surfaces as a
    raised exception from asyncpg; the helper swallows + logs."""
    conn = _FakeConnection(rpc_raises=RuntimeError("boom"))
    out = await fetch_decrypted_credentials(
        _fake_pool(conn),
        user_id=USER_ID,
        server_id=SERVER_ID,
        encryption_key=KEY,
    )
    assert out is None


@pytest.mark.asyncio
async def test_invalid_json_returns_none() -> None:
    """If the RPC returns a string that doesn't parse as JSON
    (shouldn't happen — pgcrypto-decrypted ciphertext is always
    valid JSON when the original was JSON), bail safely instead of
    raising."""
    conn = _FakeConnection(rpc_return="not-json")
    out = await fetch_decrypted_credentials(
        _fake_pool(conn),
        user_id=USER_ID,
        server_id=SERVER_ID,
        encryption_key=KEY,
    )
    assert out is None


@pytest.mark.asyncio
async def test_non_dict_payload_returns_none() -> None:
    """Decrypted payload is a JSON array → not a credential record → None."""
    conn = _FakeConnection(rpc_return=json.dumps(["headers"]))
    out = await fetch_decrypted_credentials(
        _fake_pool(conn),
        user_id=USER_ID,
        server_id=SERVER_ID,
        encryption_key=KEY,
    )
    assert out is None


# --- RLS impersonation order -----------------------------------------------


@pytest.mark.asyncio
async def test_set_user_context_called_before_rpc(monkeypatch: pytest.MonkeyPatch) -> None:
    """Belt-and-braces — patch `_set_user_context` so we can confirm
    it's invoked with the right user_id before the RPC fires."""
    captured: dict[str, Any] = {}
    real = store._set_user_context

    async def spy(conn: Any, *, user_id: str) -> None:
        captured["user_id"] = user_id
        await real(conn, user_id=user_id)

    monkeypatch.setattr(store, "_set_user_context", spy)
    conn = _FakeConnection(rpc_return=json.dumps({"headers": {}}))
    await fetch_decrypted_credentials(
        _fake_pool(conn),
        user_id=USER_ID,
        server_id=SERVER_ID,
        encryption_key=KEY,
    )
    assert captured["user_id"] == USER_ID

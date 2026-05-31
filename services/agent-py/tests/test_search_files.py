"""Phase 3c-2 tests — `searchFiles` tool + RLS impersonation.

The Postgres RPC is patched at the store boundary (`store.search_file_sections`)
so we test the tool's input validation, error-mapping, and result
formatting without needing a live database. The RLS-impersonation
implementation itself is exercised separately by the integration
test stub (`test_rls_impersonation_smoke`) which only runs if a
real `SUPABASE_DB_URL` is available — pytest skips otherwise.

Registry visibility:
  - context=None → searchFiles is omitted (webFetch still present).
  - context=ToolContext(...) → searchFiles is included.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_py import store
from agent_py.tools.registry import (
    ToolContext,
    ToolError,
    default_tool_registry,
)
from agent_py.tools.search_files import (
    FRAGMENT_DELIMITER,
    build_search_files_tool,
)


def _ctx() -> ToolContext:
    return ToolContext(
        pool=MagicMock(),
        user_id="33333333-3333-3333-3333-333333333333",
    )


# --- Tool execute --------------------------------------------------------


@pytest.mark.asyncio
async def test_descriptor_shape() -> None:
    tool = build_search_files_tool(_ctx())
    assert tool.name == "searchFiles"
    assert tool.input_schema["required"] == ["fileId", "query"]


@pytest.mark.asyncio
async def test_missing_file_id_raises() -> None:
    tool = build_search_files_tool(_ctx())
    with pytest.raises(ToolError, match="fileId"):
        await tool.execute({"query": "x"})
    with pytest.raises(ToolError, match="fileId"):
        await tool.execute({"fileId": "", "query": "x"})


@pytest.mark.asyncio
async def test_missing_query_raises() -> None:
    tool = build_search_files_tool(_ctx())
    with pytest.raises(ToolError, match="query"):
        await tool.execute({"fileId": "f1"})
    with pytest.raises(ToolError, match="query"):
        await tool.execute({"fileId": "f1", "query": "  "})


@pytest.mark.asyncio
async def test_happy_path_returns_numbered_excerpts() -> None:
    tool = build_search_files_tool(_ctx())
    fake_excerpt = (
        f"first «match» here{FRAGMENT_DELIMITER} "
        f"second fragment with «term»{FRAGMENT_DELIMITER}"
        " third one"
    )
    with patch.object(
        store,
        "search_file_sections",
        new=AsyncMock(return_value=[{"excerpt": fake_excerpt, "rank": 0.42}]),
    ):
        out = await tool.execute({"fileId": "f1", "query": "match"})

    assert out.summary == "3 excerpts"
    assert "[1] first «match» here" in out.text
    assert "[2] second fragment with «term»" in out.text
    assert "[3] third one" in out.text


@pytest.mark.asyncio
async def test_rank_zero_treated_as_no_match() -> None:
    """`ts_headline` returns the file's opening words when no FTS
    match is found; ts_rank == 0 distinguishes that from a real hit."""
    tool = build_search_files_tool(_ctx())
    with (
        patch.object(
            store,
            "search_file_sections",
            new=AsyncMock(
                return_value=[{"excerpt": f"opening words{FRAGMENT_DELIMITER}more", "rank": 0.0}]
            ),
        ),
        pytest.raises(ToolError, match="no sections"),
    ):
        await tool.execute({"fileId": "f1", "query": "unrelated"})


@pytest.mark.asyncio
async def test_no_rows_raises_not_found() -> None:
    """RLS hides the file OR full_text is null → empty rows → tool
    reports a not-found / not-indexed error so the model can recover."""
    tool = build_search_files_tool(_ctx())
    with (
        patch.object(store, "search_file_sections", new=AsyncMock(return_value=[])),
        pytest.raises(ToolError, match="not found or not yet indexed"),
    ):
        await tool.execute({"fileId": "f1", "query": "x"})


@pytest.mark.asyncio
async def test_upstream_exception_wrapped_as_tool_error() -> None:
    tool = build_search_files_tool(_ctx())
    with (
        patch.object(
            store,
            "search_file_sections",
            new=AsyncMock(side_effect=RuntimeError("conn pool exhausted")),
        ),
        pytest.raises(ToolError, match="upstream error"),
    ):
        await tool.execute({"fileId": "f1", "query": "x"})


# --- Registry visibility -------------------------------------------------


def test_registry_omits_search_files_without_context() -> None:
    reg = default_tool_registry()
    assert "webFetch" in reg
    assert "searchFiles" not in reg


def test_registry_includes_search_files_with_context() -> None:
    reg = default_tool_registry(context=_ctx())
    assert "searchFiles" in reg
    assert reg["searchFiles"].name == "searchFiles"


# --- RLS impersonation plumbing (helper-level) ---------------------------


@pytest.mark.asyncio
async def test_set_user_context_issues_set_role_and_set_config() -> None:
    """The helper drops to the `authenticated` role and stamps the
    user's id into `request.jwt.claims` so a downstream query runs
    under per-user RLS. We capture the issued SQL to verify both
    commands fire, in order."""
    conn = MagicMock()
    issued: list[Any] = []

    async def execute(sql: str, *args: Any) -> None:
        issued.append((sql, args))

    conn.execute = execute  # type: ignore[assignment]
    await store._set_user_context(conn, user_id="33333333-3333-3333-3333-333333333333")
    assert len(issued) == 2
    assert "SET LOCAL ROLE authenticated" in issued[0][0]
    assert "set_config" in issued[1][0]
    # The claim JSON carries the user id.
    claim_json = issued[1][1][0]
    assert "33333333-3333-3333-3333-333333333333" in claim_json
    assert "authenticated" in claim_json

"""`searchFiles` tool — FTS over the user's attached files.

Phase 3c-2 of PLAN-agent-api. Narrow port of
`lib/server/skills/file-search.ts`: takes `{ fileId, query }`, calls
the `search_file_sections` Postgres RPC under per-user RLS
impersonation, returns up to 3 paragraph-sized excerpts with match
terms wrapped in « » markers.

Two notable differences from the TS port:

  - The TS path goes through Supabase PostgREST with the user's
    session cookie; Python connects directly via asyncpg with the
    service-role pool and impersonates the user via `SET LOCAL ROLE
    authenticated` + `request.jwt.claims` (`store._set_user_context`).
    Same security outcome — RLS on `files` still evaluates against
    `auth.uid()` — but the auth path is plumbed differently.

  - The TS path has a per-turn cap (`DEFAULT_MAX_CALLS = 3`) enforced
    in the tool factory; the Python port omits that for now. The
    Anthropic SDK doesn't expose per-step tool-call counts cleanly,
    and the model is reasonably restrained today. Cap can come back
    when the skill cascade ports for Python (Phase 3+ polish).

Errors map to ToolError with the same codes the TS path uses
(`not_found`, `not_indexed`, `no_match`, `upstream`) so the model
sees a familiar surface.
"""

from __future__ import annotations

from typing import Any

import structlog

from .. import store
from .registry import ToolContext, ToolDescriptor, ToolError, ToolInvocationResult

logger = structlog.get_logger(__name__)


# Fragment delimiter mirrors the TS path / the SQL function — these
# are the markers `ts_headline` was told to emit, so we split on the
# same character to recover per-fragment strings.
FRAGMENT_DELIMITER = "‖"

# Match cap on a single call. The Postgres RPC accepts a parameter
# but the TS path always passes 3; we mirror.
MAX_FRAGMENTS = 3
MAX_WORDS = 120
MIN_WORDS = 30


async def _execute(
    args: dict[str, Any],
    *,
    context: ToolContext,
) -> ToolInvocationResult:
    file_id = args.get("fileId")
    query = args.get("query")
    if not isinstance(file_id, str) or not file_id.strip():
        raise ToolError("searchFiles: missing or empty `fileId`.")
    if not isinstance(query, str) or not query.strip():
        raise ToolError("searchFiles: missing or empty `query`.")
    file_id = file_id.strip()
    query = query.strip()

    try:
        rows = await store.search_file_sections(
            context.pool,
            user_id=context.user_id,
            file_id=file_id,
            query=query,
            max_fragments=MAX_FRAGMENTS,
            max_words=MAX_WORDS,
            min_words=MIN_WORDS,
        )
    except Exception as exc:
        logger.warning(
            "search_files.upstream_failed",
            file_id=file_id,
            error=str(exc),
        )
        raise ToolError(f"searchFiles: upstream error — {exc}") from exc

    if not rows:
        # No row: file doesn't exist for this user (RLS hid it), OR
        # exists but `full_text` is null. We can't distinguish from
        # the call site without a second query; for the model the
        # umbrella message covers both.
        raise ToolError(
            f"searchFiles: file {file_id!r} not found or not yet "
            "indexed. Either the file isn't attached to this chat, "
            "or it was uploaded before full-text indexing was enabled "
            "and needs to be re-uploaded."
        )

    row = rows[0]
    excerpt_raw = row.get("excerpt") or ""
    rank_raw = row.get("rank") or 0
    rank: float = float(rank_raw) if isinstance(rank_raw, int | float) else 0.0
    fragments = [s.strip() for s in str(excerpt_raw).split(FRAGMENT_DELIMITER) if s.strip()]

    # `ts_headline` returns the file's opening words when no FTS match
    # is found — distinguish "real match" from "fallback excerpt" via
    # `ts_rank` == 0. The TS path makes the same distinction.
    if rank == 0 or not fragments:
        raise ToolError(
            f"searchFiles: no sections of file {file_id!r} match {query!r}. "
            "Try a different query or a broader phrasing."
        )

    # The model-facing text lists each fragment as a numbered block so
    # it can quote / cite them.
    text_lines = [f"File excerpts for {query!r}:", ""]
    for i, frag in enumerate(fragments, start=1):
        text_lines.append(f"[{i}] {frag}")
    text = "\n\n".join(text_lines)

    return ToolInvocationResult(
        text=text,
        summary=f"{len(fragments)} excerpt{'s' if len(fragments) != 1 else ''}",
    )


SEARCH_FILES_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "fileId": {
            "type": "string",
            "description": (
                "ID of the attached file to search. Must be one of the "
                "files the user has attached to the current chat."
            ),
        },
        "query": {
            "type": "string",
            "description": (
                "Natural-language search query. Stemmed via Postgres English "
                "full-text search (word forms like run / ran / running match "
                "each other)."
            ),
        },
    },
    "required": ["fileId", "query"],
    "additionalProperties": False,
}


def build_search_files_tool(context: ToolContext) -> ToolDescriptor:
    """Construct the `searchFiles` descriptor, closing over the per-run
    `ToolContext` so the execute function can reach the asyncpg pool
    and impersonate the user via RLS. The registry calls this only
    when context is available."""

    async def execute(args: dict[str, Any]) -> ToolInvocationResult:
        return await _execute(args, context=context)

    return ToolDescriptor(
        name="searchFiles",
        description=(
            "Search the full text of an attached file for sections matching "
            "a query. Returns up to 3 paragraph-sized excerpts ranked by "
            "Postgres full-text search, with matched terms wrapped in « » "
            "markers. Use this when the user's question references content "
            "that may be in the omitted portion of a file (look for "
            "`[truncated]` or `[Additional files omitted]` markers in the "
            "attachment block). Only works on files the user has attached "
            "to the current chat — pick the most likely file rather than "
            "guessing."
        ),
        input_schema=SEARCH_FILES_INPUT_SCHEMA,
        execute=execute,
    )


__all__ = [
    "FRAGMENT_DELIMITER",
    "MAX_FRAGMENTS",
    "MAX_WORDS",
    "MIN_WORDS",
    "SEARCH_FILES_INPUT_SCHEMA",
    "build_search_files_tool",
]

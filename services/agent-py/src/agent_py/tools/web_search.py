"""`webSearch` tool — Tavily backend.

Phase 3c of PLAN-agent-api. Narrow port of `lib/server/skills/web-search.ts`
that ships Tavily as the first provider; Brave + Exa land alongside
when those keys are wired (the TS surface runs all configured providers
in parallel and merges; Python starts with single-provider for
simplicity).

Configured via `TAVILY_API_KEY` in the service env. The tool is
registered in `default_tool_registry()` ONLY when the key is set;
without it the model never sees the tool. Mirrors the TS pattern
of "skill goes invisible when not configured" instead of always-
on-with-error.

`source_results` on the ToolInvocationResult is populated so the
client's Sources rail renders the hits as clickable cards (same as
the TS path).
"""

from __future__ import annotations

from typing import Any

import httpx

from ..events import ToolCallResult
from ..settings import get_settings
from .registry import ToolDescriptor, ToolError, ToolInvocationResult

# Tavily's search endpoint. Stable since 2024; same URL the TS path uses.
TAVILY_ENDPOINT = "https://api.tavily.com/search"

# Reasonable per-call timeout. The TS side caps at 8s and runs
# providers in parallel; for a single provider 12s leaves a bit more
# headroom without bothering the user.
DEFAULT_TIMEOUT_S = 12.0

# Result cap per call. The TS side fetches 5 per provider; we mirror.
MAX_RESULTS = 5

# Trim each result snippet to this length before feeding to the model
# — Tavily's `content` field is sometimes quite long. The TS side
# uses the full snippet; we cap to keep the model's input compact.
MAX_SNIPPET_CHARS = 800


async def _execute_with_client(
    args: dict[str, Any],
    *,
    client: httpx.AsyncClient,
    api_key: str,
) -> ToolInvocationResult:
    query = args.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ToolError("webSearch: missing or empty `query`.")
    query = query.strip()

    try:
        response = await client.post(
            TAVILY_ENDPOINT,
            json={
                "api_key": api_key,
                "query": query,
                "max_results": MAX_RESULTS,
                "search_depth": "basic",
            },
        )
    except httpx.HTTPError as exc:
        raise ToolError(f"webSearch: request failed — {exc}") from exc

    if response.status_code >= 400:
        # Don't leak the raw upstream body — could expose the API key
        # in some error formats. Status + a short reason is enough for
        # the model to recover.
        raise ToolError(f"webSearch: Tavily returned HTTP {response.status_code}.")

    try:
        body = response.json()
    except ValueError as exc:
        raise ToolError("webSearch: malformed JSON from Tavily.") from exc

    raw_results = body.get("results") if isinstance(body, dict) else None
    if not isinstance(raw_results, list):
        return ToolInvocationResult(
            text=f"No results for {query!r}.",
            summary="0 results",
            source_results=[],
        )

    normalised: list[ToolCallResult] = []
    for r in raw_results[:MAX_RESULTS]:
        if not isinstance(r, dict):
            continue
        title = str(r.get("title") or "").strip()
        url = str(r.get("url") or "").strip()
        snippet = str(r.get("content") or r.get("snippet") or "").strip()
        if not url:
            continue
        if len(snippet) > MAX_SNIPPET_CHARS:
            snippet = snippet[:MAX_SNIPPET_CHARS] + "…"
        normalised.append(ToolCallResult(title=title or url, url=url, snippet=snippet))

    if not normalised:
        return ToolInvocationResult(
            text=f"No usable results for {query!r}.",
            summary="0 results",
            source_results=[],
        )

    # Text format mirrors the TS web-search synthesis: numbered list
    # the model can cite via `[N]` markers. Source results separately
    # populate the Sources rail.
    text_lines = [f"Search results for {query!r}:", ""]
    for i, r in enumerate(normalised, start=1):
        text_lines.append(f"[{i}] {r.title} — {r.url}")
        if r.snippet:
            text_lines.append(f"    {r.snippet}")
    text = "\n".join(text_lines)

    return ToolInvocationResult(
        text=text,
        summary=f"{len(normalised)} result{'s' if len(normalised) != 1 else ''}",
        source_results=normalised,
    )


async def _execute(args: dict[str, Any]) -> ToolInvocationResult:
    api_key = get_settings().TAVILY_API_KEY
    if not api_key:
        # Defence in depth — `default_tool_registry()` omits the tool
        # when the key is unset, but if a caller registered it
        # manually the execute still fails cleanly.
        raise ToolError("webSearch: TAVILY_API_KEY is not configured.")
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_S) as client:
        return await _execute_with_client(args, client=client, api_key=api_key)


WEB_SEARCH_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "query": {
            "type": "string",
            "description": (
                "Natural-language search query. Tavily searches the open web; "
                "use it to find recent news, documentation pages, or "
                "knowledge-base answers. Then narrow with `webFetch` to read "
                "the top results in full."
            ),
        },
    },
    "required": ["query"],
    "additionalProperties": False,
}


def build_web_search_tool() -> ToolDescriptor:
    """Construct the `webSearch` descriptor. Caller is responsible for
    only registering it when `TAVILY_API_KEY` is set —
    `default_tool_registry()` does so."""
    return ToolDescriptor(
        name="webSearch",
        description=(
            "Search the open web for a natural-language query. Returns up to "
            f"{MAX_RESULTS} hits (title + URL + snippet). Pair with `webFetch` "
            "to read the most promising result in full. Use this when the "
            "question references recent events or anything outside training "
            "data."
        ),
        input_schema=WEB_SEARCH_INPUT_SCHEMA,
        execute=_execute,
    )


def is_web_search_configured() -> bool:
    """Whether Tavily is configured for this service. The registry
    uses this to decide whether to register the tool. Exposed
    publicly so tests + diagnostics can probe."""
    return bool(get_settings().TAVILY_API_KEY)


__all__ = [
    "MAX_RESULTS",
    "MAX_SNIPPET_CHARS",
    "TAVILY_ENDPOINT",
    "WEB_SEARCH_INPUT_SCHEMA",
    "build_web_search_tool",
    "is_web_search_configured",
]

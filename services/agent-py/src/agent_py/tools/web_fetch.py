"""`webFetch` tool — GET a URL, return cleaned text + a title.

Phase 2b-2 of PLAN-agent-api. Narrow port of
`lib/server/skills/web-fetch.ts`: SSRF-guarded HTTP GET via
`outbound_http.safe_get` (per-hop `validate_outbound_url`, manual
redirects, connect-time address pinning, streamed body cap, overall
deadline — the same path the bookmark fetcher uses), strip HTML
script/style/markup, return the first ~12k chars of text plus the
document's `<title>` for the UI pill. No per-turn budget yet (the TS
side has one). On interactive runs (`run_execute`) each call takes one
unit of the caller's per-IP web-tool window first (the Next route's
`chatWebToolLimit`, shared with webSearch + searchFiles).

Pure-ish: the only side effect is the HTTP call; everything else is
string munging. Tests use httpx's `MockTransport` so they stay
hermetic.
"""

from __future__ import annotations

import re
from typing import Any

import httpx

from ..outbound_http import OutboundFetchError, build_outbound_client, safe_get
from ..rate_limit import WEB_TOOL_BUDGET
from .registry import RunToolContext, ToolDescriptor, ToolError, ToolInvocationResult

# Cap the text we feed back to the model. The TS side caps at ~12k
# chars too; deeper than that and the surrounding context window
# pressure isn't worth it. The model can call again with a different
# URL if needed.
MAX_TEXT_CHARS = 12_000

# Cap raw (decoded) response bytes, enforced while streaming so a huge
# or never-ending body is never buffered. Larger responses are rejected
# with a ToolError — same 5 MB cap and semantics as the TS webFetch,
# which reuses the bookmark fetcher.
MAX_RESPONSE_BYTES = 5 * 1024 * 1024

# Per-operation (connect / read) timeout. The TS side uses ~15s; mirror.
DEFAULT_TIMEOUT_S = 15.0

# Wall-clock budget for the whole fetch including redirects — stops a
# slow-drip body from holding the turn open indefinitely.
TOTAL_TIMEOUT_S = 30.0

MAX_REDIRECTS = 5

# Identifies us to upstream servers — some refuse a missing UA. The
# TS side uses a similar generic agent string; mirror for parity.
USER_AGENT = "HummingbirdAgent/1.0 (+https://github.com/juchengquan/hummingbird)"

_SCRIPT_STYLE_RE = re.compile(
    r"<(script|style)\b[^>]*>.*?</\1>",
    re.DOTALL | re.IGNORECASE,
)
_TAG_RE = re.compile(r"<[^>]+>")
_TITLE_RE = re.compile(r"<title\b[^>]*>(.*?)</title>", re.DOTALL | re.IGNORECASE)
_WHITESPACE_RE = re.compile(r"\s+")


def _extract_title(html: str) -> str | None:
    m = _TITLE_RE.search(html)
    if not m:
        return None
    raw = _WHITESPACE_RE.sub(" ", m.group(1)).strip()
    return raw or None


def _strip_html(html: str) -> str:
    # Strip script + style blocks first so their content doesn't bleed
    # into the visible text. Then drop every remaining tag and collapse
    # whitespace. Good enough for the model to read — anything fancier
    # would need a real HTML parser dep.
    without_blocks = _SCRIPT_STYLE_RE.sub(" ", html)
    plain = _TAG_RE.sub(" ", without_blocks)
    return _WHITESPACE_RE.sub(" ", plain).strip()


async def _execute_with_client(
    args: dict[str, Any],
    *,
    client: httpx.AsyncClient,
) -> ToolInvocationResult:
    url = args.get("url")
    if not isinstance(url, str) or not url.strip():
        raise ToolError("webFetch: missing or empty `url`.")
    url = url.strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        raise ToolError("webFetch: `url` must start with http:// or https://.")

    try:
        response = await safe_get(
            url,
            client=client,
            max_body_bytes=MAX_RESPONSE_BYTES,
            total_timeout_s=TOTAL_TIMEOUT_S,
            on_oversize="error",
            max_redirects=MAX_REDIRECTS,
        )
    except OutboundFetchError as exc:
        if exc.code == "validation":
            raise ToolError(f"webFetch: URL not allowed — {exc.message}") from exc
        if exc.code == "body_too_large":
            raise ToolError(
                f"webFetch: response exceeded {MAX_RESPONSE_BYTES // (1024 * 1024)} MB."
            ) from exc
        raise ToolError(f"webFetch: request failed — {exc.message}") from exc

    if response.status_code >= 300:
        raise ToolError(f"webFetch: {url} returned HTTP {response.status_code}.")

    raw = response.body
    content_type = response.headers.get("content-type", "")

    if "html" in content_type.lower() or raw.lstrip().startswith(b"<"):
        html = raw.decode(response.encoding, errors="replace")
        title = _extract_title(html)
        body_text = _strip_html(html)
    else:
        title = None
        body_text = raw.decode(response.encoding, errors="replace")
        body_text = _WHITESPACE_RE.sub(" ", body_text).strip()

    if len(body_text) > MAX_TEXT_CHARS:
        body_text = body_text[:MAX_TEXT_CHARS] + " …[truncated]"

    summary = f'Fetched "{title}"' if title else f"Fetched {url}"

    return ToolInvocationResult(
        text=body_text or "(no text content extracted)",
        summary=summary,
    )


async def _execute(args: dict[str, Any]) -> ToolInvocationResult:
    # One-shot client per call. The agent loop isn't hot enough that
    # the per-call client construction matters (~1ms); a shared client
    # would need lifecycle wiring we'd rather not own here.
    async with build_outbound_client(
        timeout_s=DEFAULT_TIMEOUT_S,
        headers={"User-Agent": USER_AGENT},
    ) as client:
        return await _execute_with_client(args, client=client)


async def _run_execute(args: dict[str, Any], ctx: RunToolContext) -> ToolInvocationResult:
    """Interactive runs: the per-IP web-tool window first (shared with
    webSearch + searchFiles), with the Next route's refusal text."""
    budget = ctx.consume_budget(WEB_TOOL_BUDGET)
    if not budget:
        raise ToolError(
            f"webFetch rate limit exceeded for this IP. Retry in {budget.retry_after_sec}s. "
            "The chat route caps outbound web tools (webSearch + webFetch combined) per minute."
        )
    return await _execute(args)


WEB_FETCH_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "url": {
            "type": "string",
            "description": "Absolute http:// or https:// URL to fetch.",
        },
    },
    "required": ["url"],
    "additionalProperties": False,
}


def build_web_fetch_tool() -> ToolDescriptor:
    """Construct the `webFetch` descriptor. The registry calls this
    lazily to avoid pulling httpx at import time."""
    return ToolDescriptor(
        name="webFetch",
        description=(
            "Fetch the text content of a single web page. Returns the page's "
            "visible text (HTML stripped) plus its title. Useful for reading "
            "a documentation page, news article, or knowledge-base entry. "
            "Limit: ~12,000 characters returned; cap the fetch by picking the "
            "narrowest URL that answers the question."
        ),
        input_schema=WEB_FETCH_INPUT_SCHEMA,
        execute=_execute,
        run_execute=_run_execute,
    )


__all__ = [
    "MAX_RESPONSE_BYTES",
    "MAX_TEXT_CHARS",
    "WEB_FETCH_INPUT_SCHEMA",
    "build_web_fetch_tool",
]

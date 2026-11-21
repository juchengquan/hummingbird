"""File embeddings — Python port of `lib/server/embeddings/provider.ts` and
`lib/server/embeddings/index-file.ts` (`docs/PLAN-local-rag.md` PR 2).

`index_file_sections` chunks a file's text (`agent_py.chunk`, identical to
the TS chunker), embeds the chunks and writes them to `file_sections` as
the caller: every query runs under `_set_user_context` (the `authenticated`
role + the user's JWT claims), so the table's own-rows RLS applies exactly
as it does to the Next.js route's user-scoped Supabase client.

**Embedder.** An OpenAI-compatible `POST <base>/embeddings`, configured by
the same env vars as the TS provider, first match wins for the base URL:

  - `EMBEDDINGS_BASE_URL` (+ `EMBEDDINGS_API_KEY`) — a dedicated embedder
  - else `OLLAMA_BASE_URL` (+ `OLLAMA_API_KEY`) — reuse the Ollama host
  - `EMBEDDINGS_MODEL` — model id (default `nomic-embed-text`, 768-dim)

No base URL → not configured (the route answers `skipped /
not_configured`). The wire request is the one the AI SDK's
`createOpenAICompatible(...).textEmbeddingModel(...)` sends — `{model,
input, encoding_format: "float"}`, `Authorization: Bearer <key or
"not-needed">` (Ollama ignores auth) — batched at the SDK's 2048 inputs
per call, retried like the SDK's `embedMany` (2 retries, 2 s then 4 s,
honouring `retry-after(-ms)`, on 408/409/429/5xx and network errors).
The base URL is operator configuration, not user input, so — like the
Next.js provider — it is called directly (no SSRF guard), which keeps a
`http://localhost:11434/v1` Ollama working. Each attempt is bounded by
`EMBED_TIMEOUT_S` (the Next.js route relies on its 60 s `maxDuration`).
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Any, Literal

import asyncpg
import httpx
import structlog

from .chunk import chunk_text, to_storable_text
from .settings import Settings, get_settings
from .store import _set_user_context

logger = structlog.get_logger(__name__)

__all__ = [
    "DEFAULT_EMBEDDINGS_MODEL",
    "EMBEDDING_DIM",
    "EmbedFn",
    "EmbeddingConfig",
    "EmbeddingError",
    "IndexFileResult",
    "embed_texts",
    "embedding_config",
    "index_file_sections",
    "result_to_wire",
]

#: Must match the `vector(N)` column in `0023_file_embeddings.sql`
#: (`EMBEDDING_DIM` in the TS provider). Informational here — Postgres
#: rejects a vector of another dimension, which surfaces as `embed_failed`.
EMBEDDING_DIM = 768
DEFAULT_EMBEDDINGS_MODEL = "nomic-embed-text"

#: The AI SDK's `maxEmbeddingsPerCall` for OpenAI-compatible providers.
MAX_EMBEDDINGS_PER_CALL = 2048
MAX_RETRIES = 2
INITIAL_RETRY_DELAY_S = 2.0
EMBED_TIMEOUT_S = 60.0

#: Postgres foreign-key-violation SQLSTATE — the `files` row isn't in
#: Supabase yet (the client's metadata sync hasn't flushed).
FK_VIOLATION = "23503"

EmbedFn = Callable[[list[str]], Awaitable[list[list[float]]]]
IndexFileReason = Literal["empty", "already_indexed", "file_not_found"]


@dataclass(frozen=True)
class EmbeddingConfig:
    base_url: str
    api_key: str
    model: str

    @property
    def endpoint(self) -> str:
        # `withoutTrailingSlash` (one slash) + `/embeddings`, as the SDK does.
        base = self.base_url[:-1] if self.base_url.endswith("/") else self.base_url
        return f"{base}/embeddings"


def embedding_config(settings: Settings | None = None) -> EmbeddingConfig | None:
    """The configured embedder, or `None` (`isEmbeddingConfigured()` false).
    Same `||` fallbacks as the TS provider: an empty value falls through."""
    s = settings or get_settings()
    base_url = s.EMBEDDINGS_BASE_URL or s.OLLAMA_BASE_URL
    if not base_url:
        return None
    return EmbeddingConfig(
        base_url=base_url,
        api_key=s.EMBEDDINGS_API_KEY or s.OLLAMA_API_KEY,
        model=s.EMBEDDINGS_MODEL or DEFAULT_EMBEDDINGS_MODEL,
    )


class EmbeddingError(Exception):
    """The embedder call failed (after retries) or answered off-shape."""


class _RetryableError(EmbeddingError):
    def __init__(self, message: str, headers: httpx.Headers | None = None) -> None:
        super().__init__(message)
        self.headers = headers


def _is_retryable_status(status: int) -> bool:
    return status in (408, 409, 429) or status >= 500


def _retry_delay_s(headers: httpx.Headers | None, backoff_s: float) -> float:
    """Port of the AI SDK's `getRetryDelayInMs`: a `retry-after-ms` /
    `retry-after` (seconds or HTTP date) under 60 s — or under the backoff —
    wins; else the exponential backoff."""
    if headers is None:
        return backoff_s
    ms: float | None = None
    raw_ms = headers.get("retry-after-ms")
    if raw_ms:
        try:
            ms = float(raw_ms)
        except ValueError:
            ms = None
    raw = headers.get("retry-after")
    if raw and ms is None:
        try:
            ms = float(raw) * 1000
        except ValueError:
            try:
                ms = parsedate_to_datetime(raw).timestamp() * 1000 - time.time() * 1000
            except (TypeError, ValueError):
                ms = None
    if ms is not None and ms >= 0 and (ms < 60_000 or ms < backoff_s * 1000):
        return ms / 1000
    return backoff_s


def _error_message(response: httpx.Response) -> str:
    """`{error: {message}}` (the OpenAI-compatible error shape), else the
    status line."""
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict) and isinstance(err.get("message"), str):
            return str(err["message"])
    return f"{response.status_code} {response.reason_phrase}".strip()


async def _embed_batch(
    client: httpx.AsyncClient, config: EmbeddingConfig, values: list[str]
) -> list[list[float]]:
    try:
        response = await client.post(
            config.endpoint,
            json={"model": config.model, "input": values, "encoding_format": "float"},
            headers={"Authorization": f"Bearer {config.api_key or 'not-needed'}"},
        )
    except httpx.HTTPError as exc:
        raise _RetryableError(f"Cannot connect to the embedder: {exc}") from exc
    if response.status_code >= 400:
        message = _error_message(response)
        if _is_retryable_status(response.status_code):
            raise _RetryableError(message, response.headers)
        raise EmbeddingError(message)
    try:
        payload = response.json()
        data = payload["data"]
        vectors = [list(item["embedding"]) for item in data]
    except (ValueError, KeyError, TypeError) as exc:
        raise EmbeddingError("Embedder response did not match the expected shape.") from exc
    for vec in vectors:
        if not all(isinstance(v, int | float) and not isinstance(v, bool) for v in vec):
            raise EmbeddingError("Embedder response did not match the expected shape.")
    return [[float(v) for v in vec] for vec in vectors]


async def _embed_batch_with_retries(
    client: httpx.AsyncClient, config: EmbeddingConfig, values: list[str]
) -> list[list[float]]:
    backoff = INITIAL_RETRY_DELAY_S
    attempt = 0
    while True:
        attempt += 1
        try:
            return await _embed_batch(client, config, values)
        except _RetryableError as exc:
            if attempt > MAX_RETRIES:
                raise EmbeddingError(f"Failed after {attempt} attempts. Last error: {exc}") from exc
            await asyncio.sleep(_retry_delay_s(exc.headers, backoff))
            backoff *= 2


async def embed_texts(
    texts: Sequence[str],
    *,
    config: EmbeddingConfig,
    client: httpx.AsyncClient | None = None,
) -> list[list[float]]:
    """One vector per input, in order. Empty input → `[]` (no call)."""
    if not texts:
        return []
    owned = client is None
    http = client or httpx.AsyncClient(timeout=httpx.Timeout(EMBED_TIMEOUT_S, connect=10.0))
    try:
        out: list[list[float]] = []
        values = list(texts)
        for start in range(0, len(values), MAX_EMBEDDINGS_PER_CALL):
            batch = values[start : start + MAX_EMBEDDINGS_PER_CALL]
            out.extend(await _embed_batch_with_retries(http, config, batch))
        return out
    finally:
        if owned:
            await http.aclose()


# --- Indexing -------------------------------------------------------------


@dataclass(frozen=True)
class IndexFileResult:
    status: Literal["indexed", "skipped"]
    sections: int
    reason: IndexFileReason | None = None


async def index_file_sections(
    pool: asyncpg.Pool,
    *,
    user_id: str,
    file_id: str,
    text: str,
    embed: EmbedFn,
    force: bool = False,
) -> IndexFileResult:
    """Chunk → embed → write one file's text into `file_sections`
    (`indexFileSections`). Same outcomes as the TS original:

      - no chunks → `skipped / empty`;
      - the caller can't see a live `files` row with this id (RLS, soft
        delete) → `skipped / file_not_found`, before any paid embed call;
      - `force` → delete the file's sections first (a failure there is
        ignored, as in TS); otherwise sections already present →
        `skipped / already_indexed` with the existing count (a failed
        count is ignored and indexing proceeds, as in TS);
      - the insert hits the `files` FK → `skipped / file_not_found`.

    Any other DB / embedder failure raises (the route answers 500
    `embed_failed`). The DB connection is not held across the embed call.
    """
    chunks = chunk_text(text)
    if not chunks:
        return IndexFileResult("skipped", 0, "empty")

    async with pool.acquire() as conn, conn.transaction():
        await _set_user_context(conn, user_id=user_id)
        try:
            row = await conn.fetchrow(
                "SELECT id FROM public.files WHERE id = $1::text::uuid AND deleted_at IS NULL",
                file_id,
            )
        except asyncpg.PostgresError as exc:
            raise RuntimeError(f"files lookup failed: {exc}") from exc
    if row is None:
        return IndexFileResult("skipped", 0, "file_not_found")

    if force:
        try:
            async with pool.acquire() as conn, conn.transaction():
                await _set_user_context(conn, user_id=user_id)
                await conn.execute(
                    "DELETE FROM public.file_sections WHERE file_id = $1::text::uuid", file_id
                )
        except asyncpg.PostgresError as exc:
            logger.warning("embed.force_delete_failed", file_id=file_id, error=str(exc)[:300])
    else:
        try:
            async with pool.acquire() as conn, conn.transaction():
                await _set_user_context(conn, user_id=user_id)
                count = await conn.fetchval(
                    "SELECT count(*) FROM public.file_sections WHERE file_id = $1::text::uuid",
                    file_id,
                )
        except asyncpg.PostgresError as exc:
            logger.warning("embed.count_failed", file_id=file_id, error=str(exc)[:300])
            count = 0
        if (count or 0) > 0:
            return IndexFileResult("skipped", int(count), "already_indexed")

    storable = [to_storable_text(c) for c in chunks]
    embeddings = await embed(storable)

    # pgvector parses its text form (`[0.1,0.2,…]`); a missing vector (a
    # short batch) stays NULL — `match_file_sections` skips NULL rows.
    rows = [
        {
            "user_id": user_id,
            "file_id": file_id,
            "section_index": i,
            "content": content,
            "embedding": json.dumps(embeddings[i], separators=(",", ":"))
            if i < len(embeddings) and embeddings[i] is not None
            else None,
        }
        for i, content in enumerate(storable)
    ]
    try:
        async with pool.acquire() as conn, conn.transaction():
            await _set_user_context(conn, user_id=user_id)
            # The rows go in the way PostgREST writes a bulk insert: one
            # statement (all-or-nothing) over `json_populate_recordset`, so
            # each value is parsed by its column's own input function —
            # including `vector`, whatever schema pgvector lives in.
            await conn.execute(
                "INSERT INTO public.file_sections "
                "(user_id, file_id, section_index, content, embedding) "
                "SELECT user_id, file_id, section_index, content, embedding "
                "FROM json_populate_recordset(NULL::public.file_sections, $1::json)",
                json.dumps(rows),
            )
    except asyncpg.PostgresError as exc:
        if getattr(exc, "sqlstate", None) == FK_VIOLATION:
            return IndexFileResult("skipped", 0, "file_not_found")
        raise RuntimeError(f"file_sections insert failed: {exc}") from exc

    return IndexFileResult("indexed", len(storable))


def result_to_wire(result: IndexFileResult) -> dict[str, Any]:
    """`IndexFileResult` → the `EmbedResponse` JSON (`reason` absent when
    unset, as in TS)."""
    out: dict[str, Any] = {"status": result.status, "sections": result.sections}
    if result.reason is not None:
        out["reason"] = result.reason
    return out

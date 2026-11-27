"""In-process response cache for the deterministic non-chat calls
(summaries, file extraction) — the Python port of
`lib/server/cache/response-cache.ts` (+ `caller-scope.ts`,
`summarize-similarity.ts`), so `/v1/summarize` and `/v1/extract` cache as
the Next routes do (wave 12, Q134).

* **Exact key**: a SHA-256 of the canonicalised request (object keys
  sorted, array order kept), the call kind, the resolved model and, when
  given, a caller scope. A hit is what a miss would have produced.
* **Near match** (summaries only): an entry may carry the embedding of
  its input and a similarity scope; a later input whose embedding is at
  least `SIMILARITY_THRESHOLD` cosine-close, in the same scope, is served
  that entry's value.
* **Caller scope**: `user:<id>` signed in, `anon:<sha256(client IP)[:32]>`
  anonymous — so a near match (another input's answer) never crosses
  callers, and anonymous callers behind one IP share one scope, as on
  Next.

Bounded LRU + TTL in memory (1 h, 500 entries, ~64 MB, 8 MB per value).
Never used for a chat or run stream.
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

__all__ = [
    "SIMILARITY_THRESHOLD",
    "TTL_MS",
    "ResponseCache",
    "caller_scope",
    "cosine",
    "get_response_cache",
    "reset_response_cache",
    "response_cache_key",
    "summarize_similarity_target",
]

#: Bump to invalidate every entry (e.g. after a prompt change).
CACHE_VERSION = "v1"
TTL_MS = 60 * 60 * 1000
MAX_ENTRIES = 500
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_ENTRY_BYTES = 8 * 1024 * 1024
#: Cosine floor for a near-match hit. Tight on purpose.
SIMILARITY_THRESHOLD = 0.97


def _now_ms() -> float:
    return time.time() * 1000.0


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _stable(value: Any) -> str:
    """Deterministic JSON: mapping keys sorted recursively, sequences in order."""
    if isinstance(value, Mapping):
        return (
            "{"
            + ",".join(f"{_json(str(k))}:{_stable(value[k])}" for k in sorted(value, key=str))
            + "}"
        )
    if isinstance(value, list | tuple):
        return "[" + ",".join(_stable(v) for v in value) + "]"
    return _json(value)


def response_cache_key(*, kind: str, model: str, input: Any, scope: str | None = None) -> str:
    """The cache key for `input` (volatile noise stripped by the caller)."""
    parts: list[str] = [CACHE_VERSION, kind, model, _stable(input)]
    if scope is not None:
        parts.append(scope)
    return hashlib.sha256(_json(parts).encode("utf-8")).hexdigest()


def caller_scope(*, user_id: str | None, client_key: str) -> str:
    """`callerScopeFrom`: the signed-in user, else a hash of the client IP."""
    if user_id:
        return f"user:{user_id}"
    digest = hashlib.sha256(client_key.encode("utf-8")).hexdigest()[:32]
    return f"anon:{digest}"


def summarize_similarity_target(
    body: Mapping[str, Any], model_id: str, scope: str
) -> tuple[str, str] | None:
    """`similarityTargetFor`: `(similarity scope, text to embed)` for a
    summarize request eligible for a near match, else None — `file` (its
    text), `project-breakdown` without `existingTitles` (its goal)."""
    mode = body.get("mode")
    if mode == "file" and isinstance(body.get("text"), str):
        return f"summarize|{scope}|file|{model_id}", body["text"]
    if (
        mode == "project-breakdown"
        and isinstance(body.get("goal"), str)
        and not body.get("existingTitles")
    ):
        return f"summarize|{scope}|project-breakdown|{model_id}", body["goal"]
    return None


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity; -1 ("no match") on a length mismatch or a zero vector."""
    if not a or len(a) != len(b):
        return -1.0
    dot = na = nb = 0.0
    for x, y in zip(a, b, strict=True):
        dot += x * y
        na += x * x
        nb += y * y
    if na == 0 or nb == 0:
        return -1.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


@dataclass
class _Entry:
    value: Any
    expires: float
    bytes: int
    embedding: list[float] | None = None
    scope: str | None = None


def _approx_bytes(value: Any, embedding: Sequence[float] | None) -> float:
    try:
        text = _json(value)
    except (TypeError, ValueError):
        return math.inf
    return len(text) * 2 + (len(embedding) if embedding else 0) * 8


class ResponseCache:
    """Bounded LRU + TTL. Dict insertion order is the LRU order."""

    def __init__(
        self,
        *,
        max_entries: int = MAX_ENTRIES,
        max_total_bytes: int = MAX_TOTAL_BYTES,
        max_entry_bytes: int = MAX_ENTRY_BYTES,
    ) -> None:
        self.max_entries = max_entries
        self.max_total_bytes = max_total_bytes
        self.max_entry_bytes = max_entry_bytes
        self._store: dict[str, _Entry] = {}
        self._total = 0

    def _drop(self, key: str) -> None:
        entry = self._store.pop(key, None)
        if entry is not None:
            self._total -= entry.bytes

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        if entry.expires <= _now_ms():
            self._drop(key)
            return None
        del self._store[key]
        self._store[key] = entry
        return entry.value

    def set(
        self,
        key: str,
        value: Any,
        *,
        embedding: list[float] | None = None,
        scope: str | None = None,
    ) -> None:
        self._drop(key)
        size = _approx_bytes(value, embedding)
        if size > self.max_entry_bytes:
            return
        self._store[key] = _Entry(
            value=value,
            expires=_now_ms() + TTL_MS,
            bytes=int(size),
            embedding=embedding,
            scope=scope,
        )
        self._total += int(size)
        while len(self._store) > self.max_entries or self._total > self.max_total_bytes:
            oldest = next(iter(self._store), None)
            if oldest is None:
                break
            self._drop(oldest)

    def find_similar(
        self, *, scope: str, embedding: Sequence[float], threshold: float = SIMILARITY_THRESHOLD
    ) -> Any | None:
        now = _now_ms()
        best_key: str | None = None
        best_score = threshold
        for key, entry in list(self._store.items()):
            if entry.expires <= now:
                self._drop(key)
                continue
            if entry.scope != scope or not entry.embedding:
                continue
            score = cosine(embedding, entry.embedding)
            if score >= best_score:
                best_score = score
                best_key = key
        if best_key is None:
            return None
        entry = self._store.pop(best_key)
        self._store[best_key] = entry
        return entry.value

    def clear(self) -> None:
        self._store.clear()
        self._total = 0

    def stats(self) -> tuple[int, int]:
        """(entries, approximate bytes) — tests."""
        return len(self._store), self._total


_cache = ResponseCache()


def get_response_cache() -> ResponseCache:
    """The process-wide cache the routes share."""
    return _cache


def reset_response_cache() -> None:
    """Drop every entry (tests)."""
    _cache.clear()

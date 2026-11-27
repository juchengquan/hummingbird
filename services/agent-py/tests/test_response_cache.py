"""`response_cache` — port of `lib/server/cache/response-cache.ts`,
`caller-scope.ts` and `summarize-similarity.ts` (wave 12: the summarize
and extract caches, Q134)."""

from __future__ import annotations

import re

import pytest

from agent_py import response_cache as rc
from agent_py.response_cache import (
    ResponseCache,
    caller_scope,
    cosine,
    response_cache_key,
    summarize_similarity_target,
)


@pytest.fixture
def cache() -> ResponseCache:
    return ResponseCache()


# --- keys ------------------------------------------------------------------


def test_same_logical_input_same_key_whatever_the_key_order() -> None:
    a = response_cache_key(kind="summarize", model="m", input={"a": 1, "b": {"x": 1, "y": 2}})
    b = response_cache_key(kind="summarize", model="m", input={"b": {"y": 2, "x": 1}, "a": 1})
    assert a == b


def test_array_order_is_significant() -> None:
    a = response_cache_key(kind="k", model="m", input={"m": [1, 2]})
    assert a != response_cache_key(kind="k", model="m", input={"m": [2, 1]})


def test_model_kind_input_and_scope_each_change_the_key() -> None:
    base = response_cache_key(kind="k", model="m", input={"a": 1})
    assert base != response_cache_key(kind="k2", model="m", input={"a": 1})
    assert base != response_cache_key(kind="k", model="m2", input={"a": 1})
    assert base != response_cache_key(kind="k", model="m", input={"a": 2})
    assert base != response_cache_key(kind="k", model="m", input={"a": 1}, scope="user:x")


def test_keys_are_the_ts_keys() -> None:
    """Same canonical JSON and hash as the TS module (so a key computed
    by either for the same input names the same entry)."""
    key = response_cache_key(kind="summarize", model="m", input={"b": [1, "x"], "a": None})
    assert re.fullmatch(r"[0-9a-f]{64}", key)
    # sha256('["v1","summarize","m","{\"a\":null,\"b\":[1,\"x\"]}"]')
    import hashlib

    payload = '["v1","summarize","m","{\\"a\\":null,\\"b\\":[1,\\"x\\"]}"]'
    assert key == hashlib.sha256(payload.encode()).hexdigest()


# --- caller scope ------------------------------------------------------------


def test_signed_in_scope_is_the_user() -> None:
    assert caller_scope(user_id="u1", client_key="203.0.113.1") == "user:u1"


def test_anonymous_scope_is_a_hash_of_the_ip_never_the_ip() -> None:
    scope = caller_scope(user_id=None, client_key="203.0.113.1")
    assert scope.startswith("anon:")
    assert "203.0.113.1" not in scope
    assert re.fullmatch(r"anon:[0-9a-f]{32}", scope)
    assert scope == caller_scope(user_id=None, client_key="203.0.113.1")
    assert scope != caller_scope(user_id=None, client_key="203.0.113.2")


# --- store -------------------------------------------------------------------


def test_round_trip_overwrite_and_miss(cache: ResponseCache) -> None:
    assert cache.get("k") is None
    cache.set("k", {"v": 1})
    assert cache.get("k") == {"v": 1}
    cache.set("k", {"v": 2})
    assert cache.get("k") == {"v": 2}
    assert cache.get("other") is None


def test_expired_entries_miss(cache: ResponseCache, monkeypatch: pytest.MonkeyPatch) -> None:
    now = [1000.0]
    monkeypatch.setattr(rc, "_now_ms", lambda: now[0])
    cache.set("k", {"v": 1})
    now[0] += rc.TTL_MS + 1
    assert cache.get("k") is None
    assert cache.stats() == (0, 0)


def test_lru_beyond_the_entry_cap() -> None:
    cache = ResponseCache(max_entries=2)
    cache.set("a", 1)
    cache.set("b", 2)
    assert cache.get("a") == 1  # a is now most recent
    cache.set("c", 3)
    assert cache.get("b") is None
    assert cache.get("a") == 1
    assert cache.get("c") == 3


def test_byte_budget_and_per_entry_cap() -> None:
    cache = ResponseCache(max_total_bytes=100, max_entry_bytes=60)
    cache.set("a", "x" * 20)  # ~44 bytes
    cache.set("b", "y" * 20)
    cache.set("c", "z" * 20)
    _entries, total = cache.stats()
    assert total <= 100
    assert cache.get("a") is None and cache.get("c") is not None
    cache.set("c", "w" * 100)  # over the entry cap: not stored, old value dropped
    assert cache.get("c") is None


# --- similarity ----------------------------------------------------------------


def test_cosine() -> None:
    assert cosine([1, 0], [1, 0]) == pytest.approx(1)
    assert cosine([1, 0], [0, 1]) == pytest.approx(0)
    assert cosine([1, 0], [1, 0, 0]) == -1
    assert cosine([0, 0], [1, 0]) == -1


def test_near_match_within_scope_only(cache: ResponseCache) -> None:
    cache.set("a", {"v": "A"}, embedding=[1.0, 0.0], scope="s1")
    cache.set("plain", {"v": "P"})
    assert cache.find_similar(scope="s1", embedding=[0.999, 0.01]) == {"v": "A"}
    assert cache.find_similar(scope="s2", embedding=[1.0, 0.0]) is None
    assert cache.find_similar(scope="s1", embedding=[0.7, 0.7]) is None


def test_near_match_picks_the_best(cache: ResponseCache) -> None:
    cache.set("a", "A", embedding=[1.0, 0.05], scope="s")
    cache.set("b", "B", embedding=[1.0, 0.0], scope="s")
    assert cache.find_similar(scope="s", embedding=[1.0, 0.0]) == "B"


def test_similarity_targets() -> None:
    assert summarize_similarity_target({"mode": "file", "text": "t"}, "m", "user:u") == (
        "summarize|user:u|file|m",
        "t",
    )
    assert summarize_similarity_target(
        {"mode": "project-breakdown", "goal": "g"}, "m", "anon:x"
    ) == (
        "summarize|anon:x|project-breakdown|m",
        "g",
    )
    assert (
        summarize_similarity_target(
            {"mode": "project-breakdown", "goal": "g", "existingTitles": ["a"]}, "m", "s"
        )
        is None
    )
    assert summarize_similarity_target(
        {"mode": "project-breakdown", "goal": "g", "existingTitles": []}, "m", "s"
    ) == ("summarize|s|project-breakdown|m", "g")
    assert summarize_similarity_target({"mode": "conversation"}, "m", "s") is None
    assert summarize_similarity_target({"mode": "compress"}, "m", "s") is None

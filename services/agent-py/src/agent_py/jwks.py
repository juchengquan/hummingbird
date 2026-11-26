"""The project's public signing keys (wave 9, Q106).

A Supabase project on the newer signing keys signs access tokens with
ES256 or RS256 and publishes the public halves at
`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`. `auth.get_current_user`
looks a token's `kid` up here.

* Only asymmetric `ES256` / `RS256` keys are kept; a symmetric (`oct`)
  entry is never used (HS256 goes to the project secret).
* Keys are cached for `TTL_SECONDS`. An unknown `kid` reads the JWKS
  again, at most once per `MIN_REFETCH_SECONDS`, so random kids can't
  turn agent-py into a JWKS hammer.
* A failed read keeps the keys already cached; with none, it raises
  `JwksUnavailable` (the caller answers 503, not 401) until a read
  succeeds — retried after the same floor, so an outage isn't hammered.

Called from synchronous FastAPI dependencies (run in the threadpool), so
the read is a blocking `httpx.get`."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
import structlog
from jwt import PyJWK
from jwt.exceptions import PyJWKError

from .settings import Settings

logger = structlog.get_logger(__name__)

#: The algorithms a JWKS entry may carry.
ASYMMETRIC_ALGORITHMS = ("ES256", "RS256")

TTL_SECONDS = 600.0
MIN_REFETCH_SECONDS = 30.0
_FETCH_TIMEOUT_SECONDS = 5.0


class JwksUnavailable(Exception):
    """The JWKS couldn't be read and nothing is cached."""


def jwks_url(settings: Settings) -> str:
    """`SUPABASE_JWKS_URL`, else derived from `SUPABASE_URL`; "" when neither."""
    if settings.SUPABASE_JWKS_URL:
        return settings.SUPABASE_JWKS_URL
    if settings.SUPABASE_URL:
        return f"{settings.SUPABASE_URL.rstrip('/')}/auth/v1/.well-known/jwks.json"
    return ""


def fetch_jwks(url: str) -> dict[str, Any]:
    """The JWKS document at `url` (replaced in tests)."""
    response = httpx.get(url, timeout=_FETCH_TIMEOUT_SECONDS, follow_redirects=False)
    response.raise_for_status()
    document = response.json()
    if not isinstance(document, dict):
        raise ValueError("JWKS is not an object")
    return document


@dataclass(frozen=True)
class SigningKey:
    alg: str
    key: Any


def _parse(document: dict[str, Any]) -> dict[str, SigningKey]:
    keys: dict[str, SigningKey] = {}
    for entry in document.get("keys") or []:
        if not isinstance(entry, dict):
            continue
        kid = entry.get("kid")
        if not isinstance(kid, str) or not kid:
            continue
        if entry.get("use") not in (None, "sig"):
            continue
        try:
            jwk = PyJWK(entry)
        except PyJWKError as exc:
            logger.info("auth.jwks_entry_skipped", kid=kid, error=str(exc))
            continue
        if jwk.algorithm_name not in ASYMMETRIC_ALGORITHMS:
            continue
        keys[kid] = SigningKey(alg=jwk.algorithm_name, key=jwk.key)
    return keys


@dataclass
class JwksCache:
    url: str
    _keys: dict[str, SigningKey] = field(default_factory=dict)
    _fetched_at: float | None = None
    """When the keys were last read successfully (freshness)."""
    _tried_at: float | None = None
    """When a read was last tried (the refetch floor)."""
    _unavailable: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def key_for(self, kid: str) -> SigningKey | None:
        with self._lock:
            now = time.monotonic()
            fresh = self._fetched_at is not None and now - self._fetched_at < TTL_SECONDS
            if fresh and kid in self._keys:
                return self._keys[kid]
            if self._tried_at is None or now - self._tried_at >= MIN_REFETCH_SECONDS:
                self._tried_at = now
                self._refresh(now)
            elif self._unavailable:
                raise JwksUnavailable("the last JWKS read failed")
            return self._keys.get(kid)

    def _refresh(self, now: float) -> None:
        try:
            keys = _parse(fetch_jwks(self.url))
        except Exception as exc:  # any read / parse failure
            logger.warning("auth.jwks_unavailable", url=self.url, error=str(exc))
            if not self._keys:
                self._unavailable = True
                raise JwksUnavailable(str(exc)) from exc
            return  # keep the stale keys; retry after the floor
        self._keys = keys
        self._fetched_at = now
        self._unavailable = False


_caches: dict[str, JwksCache] = {}
_caches_lock = threading.Lock()


def cache_for(url: str) -> JwksCache:
    with _caches_lock:
        cache = _caches.get(url)
        if cache is None:
            cache = _caches[url] = JwksCache(url)
        return cache


def reset() -> None:
    """Forget every cached key (tests)."""
    with _caches_lock:
        _caches.clear()


__all__ = [
    "ASYMMETRIC_ALGORITHMS",
    "MIN_REFETCH_SECONDS",
    "TTL_SECONDS",
    "JwksCache",
    "JwksUnavailable",
    "SigningKey",
    "cache_for",
    "fetch_jwks",
    "jwks_url",
    "reset",
]

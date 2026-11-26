"""Asymmetric Supabase tokens (wave 9, Q106 — Q61's check).

A Supabase project on the newer signing keys issues ES256 (or RS256)
access tokens and publishes the public keys at
`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`. agent-py verifies those
beside the legacy HS256 secret; every claim check of `test_auth.py`
applies to them too. A fake JWKS stands in for the endpoint."""

from __future__ import annotations

import base64
import json
import time
from collections.abc import Iterator
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from fastapi.testclient import TestClient
from jwt.algorithms import ECAlgorithm, RSAAlgorithm

from agent_py import jwks
from agent_py.main import create_app

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
USER_ID = "6f1c2a4e-8b3d-4f0a-9c1e-2d3b4a5c6d7e"
SUPABASE_URL = "https://proj.supabase.test"
JWKS_URL = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json"

EC_KEY = ec.generate_private_key(ec.SECP256R1())
RSA_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_EC_KEY = ec.generate_private_key(ec.SECP256R1())


def _jwk(public: Any, kid: str, alg: str) -> dict[str, Any]:
    algorithm = ECAlgorithm if alg == "ES256" else RSAAlgorithm
    out: dict[str, Any] = algorithm.to_jwk(public, as_dict=True)  # type: ignore[attr-defined]
    return {**out, "kid": kid, "alg": alg, "use": "sig", "key_ops": ["verify"]}


KEYS = {
    "keys": [
        _jwk(EC_KEY.public_key(), "ec-1", "ES256"),
        _jwk(RSA_KEY.public_key(), "rsa-1", "RS256"),
    ]
}


class FakeJwks:
    def __init__(self) -> None:
        self.document: dict[str, Any] | Exception = KEYS
        self.fetched: list[str] = []

    def __call__(self, url: str) -> dict[str, Any]:
        self.fetched.append(url)
        if isinstance(self.document, Exception):
            raise self.document
        return self.document


@pytest.fixture
def fake_jwks(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeJwks]:
    fake = FakeJwks()
    monkeypatch.setattr(jwks, "fetch_jwks", fake)
    jwks.reset()
    yield fake
    jwks.reset()


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, fake_jwks: FakeJwks) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("SUPABASE_URL", SUPABASE_URL)
    return TestClient(create_app())


def _claims(**over: object) -> dict[str, object]:
    base: dict[str, object] = {
        "sub": USER_ID,
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int(time.time()) + 3600,
        "iat": int(time.time()),
    }
    return {k: v for k, v in {**base, **over}.items() if v is not None}


def _es256(kid: str | None = "ec-1", key: Any = EC_KEY, **over: object) -> str:
    headers = {"kid": kid} if kid is not None else {}
    return jwt.encode(_claims(**over), key, algorithm="ES256", headers=headers)


def _rs256(kid: str = "rsa-1", **over: object) -> str:
    return jwt.encode(_claims(**over), RSA_KEY, algorithm="RS256", headers={"kid": kid})


def _get(client: TestClient, token: str):  # type: ignore[no-untyped-def]
    return client.get("/v1/whoami", headers={"Authorization": f"Bearer {token}"})


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _forged(header: dict[str, object], claims: dict[str, object], sig: bytes = b"") -> str:
    head = _b64(json.dumps(header).encode())
    body = _b64(json.dumps(claims).encode())
    return f"{head}.{body}.{_b64(sig)}"


# --- accepted --------------------------------------------------------------


def test_an_es256_token_from_the_projects_jwks_is_accepted(
    client: TestClient, fake_jwks: FakeJwks
) -> None:
    r = _get(client, _es256())
    assert r.status_code == 200, r.text
    assert r.json() == {"user_id": USER_ID, "role": "authenticated"}
    assert fake_jwks.fetched == [JWKS_URL]


def test_an_rs256_token_is_accepted(client: TestClient) -> None:
    assert _get(client, _rs256()).status_code == 200


def test_the_legacy_hs256_secret_still_works(client: TestClient, fake_jwks: FakeJwks) -> None:
    token = jwt.encode(_claims(), SECRET, algorithm="HS256")
    assert _get(client, token).status_code == 200
    assert fake_jwks.fetched == []  # an HS256 token never reads the JWKS


def test_the_keys_are_cached(client: TestClient, fake_jwks: FakeJwks) -> None:
    for _ in range(3):
        assert _get(client, _es256()).status_code == 200
    assert _get(client, _rs256()).status_code == 200
    assert fake_jwks.fetched == [JWKS_URL]


def test_a_rotated_key_is_fetched_when_its_kid_is_new(
    client: TestClient, fake_jwks: FakeJwks, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert _get(client, _es256()).status_code == 200
    fake_jwks.document = {"keys": [_jwk(OTHER_EC_KEY.public_key(), "ec-2", "ES256")]}
    # Past the refetch floor, an unknown kid reads the JWKS again.
    clock = time.monotonic() + jwks.MIN_REFETCH_SECONDS + 1
    monkeypatch.setattr(jwks.time, "monotonic", lambda: clock)
    assert _get(client, _es256(kid="ec-2", key=OTHER_EC_KEY)).status_code == 200
    assert len(fake_jwks.fetched) == 2


def test_the_jwks_url_can_be_set_explicitly(
    monkeypatch: pytest.MonkeyPatch, fake_jwks: FakeJwks
) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "")
    monkeypatch.setenv("SUPABASE_URL", "")
    monkeypatch.setenv("SUPABASE_JWKS_URL", "https://auth.example.test/jwks")
    r = _get(TestClient(create_app()), _es256())
    assert r.status_code == 200, r.text
    assert fake_jwks.fetched == ["https://auth.example.test/jwks"]


def test_jwks_alone_configures_auth(monkeypatch: pytest.MonkeyPatch, fake_jwks: FakeJwks) -> None:
    """No HS256 secret: an ES256 token passes, an HS256 one is a 401 (not
    the 503 of "auth not configured")."""
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "")
    monkeypatch.setenv("SUPABASE_URL", SUPABASE_URL)
    client = TestClient(create_app())
    assert _get(client, _es256()).status_code == 200
    hs = jwt.encode(_claims(), SECRET, algorithm="HS256")
    assert _get(client, hs).status_code == 401


def test_neither_secret_nor_jwks_is_still_503(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "")
    monkeypatch.setenv("SUPABASE_URL", "")
    monkeypatch.setenv("SUPABASE_JWKS_URL", "")
    r = _get(TestClient(create_app()), _es256())
    assert r.status_code == 503


# --- refused ---------------------------------------------------------------


def test_a_token_signed_by_another_key_under_a_known_kid_is_refused(client: TestClient) -> None:
    assert _get(client, _es256(key=OTHER_EC_KEY)).status_code == 401


def test_an_unknown_kid_is_refused(client: TestClient, fake_jwks: FakeJwks) -> None:
    assert _get(client, _es256(kid="nope")).status_code == 401


def test_an_unknown_kid_does_not_refetch_on_every_request(
    client: TestClient, fake_jwks: FakeJwks
) -> None:
    """Random kids can't turn agent-py into a JWKS hammer."""
    for i in range(5):
        assert _get(client, _es256(kid=f"nope-{i}")).status_code == 401
    assert len(fake_jwks.fetched) == 1


def test_a_token_without_a_kid_is_refused(client: TestClient, fake_jwks: FakeJwks) -> None:
    assert _get(client, _es256(kid=None)).status_code == 401
    assert fake_jwks.fetched == []  # refused before any JWKS read


def test_alg_none_is_refused(client: TestClient) -> None:
    token = _forged({"alg": "none", "typ": "JWT", "kid": "ec-1"}, _claims())
    assert _get(client, token).status_code == 401


def test_hs256_signed_with_the_public_key_is_refused(client: TestClient) -> None:
    """Algorithm confusion: the public key as an HMAC secret."""
    pem = EC_KEY.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    import hashlib
    import hmac

    header = {"alg": "HS256", "typ": "JWT", "kid": "ec-1"}
    head = _b64(json.dumps(header).encode())
    body = _b64(json.dumps(_claims()).encode())
    sig = hmac.new(pem, f"{head}.{body}".encode(), hashlib.sha256).digest()
    assert _get(client, f"{head}.{body}.{_b64(sig)}").status_code == 401


def test_an_alg_that_does_not_match_the_keys_is_refused(client: TestClient) -> None:
    """`ec-1` is an ES256 key; a token claiming RS256 under it fails."""
    token = jwt.encode(_claims(), RSA_KEY, algorithm="RS256", headers={"kid": "ec-1"})
    assert _get(client, token).status_code == 401


def test_other_algorithms_are_refused(client: TestClient) -> None:
    es384 = ec.generate_private_key(ec.SECP384R1())
    token = jwt.encode(_claims(), es384, algorithm="ES384", headers={"kid": "ec-1"})
    assert _get(client, token).status_code == 401


def test_a_symmetric_key_in_the_jwks_is_never_used(client: TestClient, fake_jwks: FakeJwks) -> None:
    oct_key = {"kty": "oct", "kid": "oct-1", "k": _b64(b"x" * 32), "alg": "HS256"}
    fake_jwks.document = {"keys": [oct_key]}
    token = jwt.encode(_claims(), b"x" * 32, algorithm="HS256", headers={"kid": "oct-1"})
    # HS256 goes to the project secret, never to a JWKS entry.
    assert _get(client, token).status_code == 401


@pytest.mark.parametrize(
    "over",
    [
        {"role": "anon"},
        {"role": "service_role"},
        {"sub": None},
        {"sub": "not-a-uuid"},
        {"aud": "other"},
        {"exp": int(time.time()) - 10},
        {"exp": None},
    ],
)
def test_the_claim_checks_apply_to_es256(client: TestClient, over: dict[str, object]) -> None:
    assert _get(client, _es256(**over)).status_code == 401


def test_an_unreachable_jwks_is_503_and_retried_after_the_floor(
    client: TestClient, fake_jwks: FakeJwks, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_jwks.document = OSError("connection refused")
    r = _get(client, _es256())
    assert r.status_code == 503
    assert r.json()["code"] == "unavailable"
    fake_jwks.document = KEYS
    # Within the floor: still 503, and the JWKS isn't read again.
    assert _get(client, _es256()).status_code == 503
    assert len(fake_jwks.fetched) == 1
    clock = time.monotonic() + jwks.MIN_REFETCH_SECONDS + 1
    monkeypatch.setattr(jwks.time, "monotonic", lambda: clock)
    assert _get(client, _es256()).status_code == 200


def test_cached_keys_outlive_a_failed_refresh(
    client: TestClient, fake_jwks: FakeJwks, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert _get(client, _es256()).status_code == 200
    fake_jwks.document = OSError("down")
    clock = time.monotonic() + jwks.TTL_SECONDS + 1
    monkeypatch.setattr(jwks.time, "monotonic", lambda: clock)
    assert _get(client, _es256()).status_code == 200
    assert _get(client, _es256()).status_code == 200
    assert len(fake_jwks.fetched) == 2  # one failed refresh, not one per request


def test_require_auth_for_ai_is_live_with_jwks_alone(
    monkeypatch: pytest.MonkeyPatch, fake_jwks: FakeJwks
) -> None:
    from agent_py.runs.access import require_auth_for_ai
    from agent_py.settings import Settings

    settings = Settings(
        SUPABASE_JWT_SECRET="", SUPABASE_URL=SUPABASE_URL, REQUIRE_AUTH_FOR_AI="true"
    )
    assert require_auth_for_ai(settings) is True
    off = Settings(SUPABASE_JWT_SECRET="", SUPABASE_URL="", REQUIRE_AUTH_FOR_AI="true")
    assert require_auth_for_ai(off) is False

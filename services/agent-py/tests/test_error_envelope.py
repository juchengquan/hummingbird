"""The flat error envelope (`error_envelope.py`).

Pins that every non-streaming error answers `{code, message, ...}`
instead of FastAPI's `{detail}`, with the status code unchanged:
  - `HTTPException(detail={code, message, ...})` — the agent-py
    convention — passes through flat, extra keys kept;
  - a string `detail` gets its `code` from the status table;
  - exception headers (`Retry-After`, `WWW-Authenticate`) survive;
  - request validation → 422 `invalid_request` with sanitised `issues`;
  - routing 404 / 405 and uncaught exceptions are flat too;
  - the real app: auth 401, misconfigured-auth 503, body-limit 413.
"""

from __future__ import annotations

import time
from typing import Any

import jwt
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from agent_py.error_envelope import (
    INTERNAL_ERROR_MESSAGE,
    code_for_status,
    flatten_detail,
    install_error_handlers,
    validation_error_body,
)
from agent_py.main import create_app

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
USER = "00000000-0000-4000-8000-000000000123"


class _Body(BaseModel):
    name: str = Field(min_length=1)
    count: int


def _toy_app() -> FastAPI:
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/dict")
    def dict_detail() -> None:
        raise HTTPException(
            status_code=409,
            detail={"code": "mcp_server_id_conflict", "message": "In use.", "reason": "dup"},
        )

    @app.get("/string")
    def string_detail() -> None:
        raise HTTPException(status_code=413, detail="File too large.")

    @app.get("/starlette")
    def starlette_detail() -> None:
        raise StarletteHTTPException(status_code=403, detail="Nope.")

    @app.get("/headers")
    def with_headers() -> None:
        raise HTTPException(
            status_code=429,
            detail={"code": "rate_limit", "message": "Slow down."},
            headers={"Retry-After": "7"},
        )

    @app.get("/no-detail")
    def no_detail() -> None:
        raise HTTPException(status_code=404)

    @app.get("/boom")
    def boom() -> None:
        raise RuntimeError("secret internal text")

    @app.post("/validate")
    def validate(body: _Body) -> dict[str, str]:
        return {"ok": body.name}

    return app


@pytest.fixture
def toy() -> TestClient:
    return TestClient(_toy_app())


def test_dict_detail_is_returned_flat_with_extra_keys(toy: TestClient) -> None:
    r = toy.get("/dict")
    assert r.status_code == 409
    assert r.json() == {"code": "mcp_server_id_conflict", "message": "In use.", "reason": "dup"}


def test_string_detail_gets_code_from_status(toy: TestClient) -> None:
    r = toy.get("/string")
    assert r.status_code == 413
    assert r.json() == {"code": "payload_too_large", "message": "File too large."}


def test_starlette_http_exception_is_flattened(toy: TestClient) -> None:
    r = toy.get("/starlette")
    assert r.status_code == 403
    assert r.json() == {"code": "forbidden", "message": "Nope."}


def test_exception_headers_are_preserved(toy: TestClient) -> None:
    r = toy.get("/headers")
    assert r.status_code == 429
    assert r.headers["retry-after"] == "7"
    assert r.json() == {"code": "rate_limit", "message": "Slow down."}


def test_missing_detail_uses_status_phrase(toy: TestClient) -> None:
    r = toy.get("/no-detail")
    assert r.status_code == 404
    assert r.json() == {"code": "not_found", "message": "Not Found"}


def test_routing_404_and_405_are_flat(toy: TestClient) -> None:
    r = toy.get("/does-not-exist")
    assert r.status_code == 404
    assert r.json()["code"] == "not_found"
    r = toy.post("/dict")
    assert r.status_code == 405
    assert r.json()["code"] == "method_not_allowed"
    assert "allow" in r.headers


def test_validation_error_is_422_invalid_request_with_issues(toy: TestClient) -> None:
    r = toy.post("/validate", json={"name": "", "secret": "do-not-echo"})
    assert r.status_code == 422
    body = r.json()
    assert body["code"] == "invalid_request"
    assert body["message"] == "body.name: String should have at least 1 character (+1 more)"
    assert body["issues"] == [
        {
            "loc": ["body", "name"],
            "msg": "String should have at least 1 character",
            "type": "string_too_short",
        },
        {"loc": ["body", "count"], "msg": "Field required", "type": "missing"},
    ]
    # Pydantic's `input` echo of the caller's data is dropped.
    assert "do-not-echo" not in r.text


def test_validation_error_for_non_json_body(toy: TestClient) -> None:
    r = toy.post("/validate", content=b"{not json", headers={"content-type": "application/json"})
    assert r.status_code == 422
    assert r.json()["code"] == "invalid_request"
    assert r.json()["issues"][0]["type"] == "json_invalid"


def test_uncaught_exception_is_flat_500_without_leaking() -> None:
    client = TestClient(_toy_app(), raise_server_exceptions=False)
    r = client.get("/boom")
    assert r.status_code == 500
    assert r.json() == {"code": "unknown", "message": INTERNAL_ERROR_MESSAGE}
    assert "secret internal text" not in r.text


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (400, "invalid_request"),
        (401, "auth"),
        (403, "forbidden"),
        (404, "not_found"),
        (413, "payload_too_large"),
        (422, "invalid_request"),
        (429, "rate_limit"),
        (500, "unknown"),
        (502, "provider"),
        (503, "unavailable"),
        (418, "invalid_request"),  # unlisted 4xx
        (599, "unknown"),  # unlisted 5xx
    ],
)
def test_code_for_status(status: int, code: str) -> None:
    assert code_for_status(status) == code


@pytest.mark.parametrize(
    ("detail", "expected"),
    [
        ({"message": "m"}, {"code": "forbidden", "message": "m"}),
        ({"code": "x"}, {"code": "x", "message": "Forbidden"}),
        (
            [{"loc": ["a"]}],
            {"code": "forbidden", "message": "Forbidden", "issues": [{"loc": ["a"]}]},
        ),
        ("", {"code": "forbidden", "message": "Forbidden"}),
    ],
)
def test_flatten_detail_fills_gaps(detail: Any, expected: dict[str, Any]) -> None:
    assert flatten_detail(403, detail) == expected


def test_validation_error_body_with_no_issues() -> None:
    assert validation_error_body([]) == {
        "code": "invalid_request",
        "message": "Invalid request.",
        "issues": [],
    }


# --- the real app -----------------------------------------------------------


@pytest.fixture
def app_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    return TestClient(create_app(enable_poller=False))


def _token() -> str:
    return jwt.encode(
        {
            "sub": USER,
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 60,
        },
        SECRET,
        algorithm="HS256",
    )


def test_auth_401_is_flat_with_www_authenticate(app_client: TestClient) -> None:
    r = app_client.get("/v1/whoami")
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == "Bearer"
    assert r.json() == {"code": "auth", "message": "Missing or malformed Authorization header."}


def test_auth_503_when_secret_unset_is_flat(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "")
    r = TestClient(create_app(enable_poller=False)).get(
        "/v1/whoami", headers={"Authorization": "Bearer x"}
    )
    assert r.status_code == 503
    assert r.json()["code"] == "unavailable"


def test_body_limit_413_is_flat(app_client: TestClient) -> None:
    r = app_client.post(
        "/v1/files/refresh-url",
        content=b"x" * 10,
        headers={"content-type": "application/json", "content-length": str(10 * 1024 * 1024)},
    )
    assert r.status_code == 413
    assert r.json() == {"code": "payload_too_large", "message": "Request body too large."}


def test_route_validation_422_is_flat(app_client: TestClient) -> None:
    r = app_client.post(
        "/v1/files/refresh-url", json={}, headers={"Authorization": f"Bearer {_token()}"}
    )
    assert r.status_code == 422
    body = r.json()
    assert body["code"] == "invalid_request"
    assert body["issues"][0]["loc"] == ["body", "storagePath"]
    assert "detail" not in body


def test_openapi_documents_the_flat_422_body(app_client: TestClient) -> None:
    schema = app_client.get("/openapi.json").json()["components"]["schemas"]
    validation = schema["HTTPValidationError"]
    assert validation["required"] == ["code", "message"]
    assert "detail" not in validation["properties"]
    assert validation["properties"]["issues"]["items"] == {
        "$ref": "#/components/schemas/ValidationError"
    }

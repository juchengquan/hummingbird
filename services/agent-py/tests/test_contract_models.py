"""The Pydantic models generated from `packages/contract/openapi.yaml`
(`agent_py.contract.models`) parse what agent-py actually serves.

An in-process smoke check beside the HTTP conformance suite
(`packages/contract/conformance/`): it proves the generated module is
importable and usable, and catches drift on the probes without a live
server. Routers still declare their own response models; switching them
to the generated ones is a later wave.
"""

from __future__ import annotations

import time

import jwt
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from agent_py.contract import models
from agent_py.main import create_app


def test_probes_match_the_contract() -> None:
    client = TestClient(create_app(enable_poller=False))
    health = models.HealthResponse.model_validate(client.get("/healthz").json())
    assert health.status == "ok"
    ready = models.ReadinessResponse.model_validate(client.get("/readyz").json())
    assert ready.status in ("ok", "degraded")


def test_error_response_is_the_flat_envelope_only() -> None:
    err = models.ErrorResponse.model_validate({"code": "auth", "message": "x", "reason": "r"})
    assert isinstance(err, models.ApiError)
    with pytest.raises(ValidationError):
        models.ErrorResponse.model_validate({"detail": "Invalid token."})


def test_served_errors_match_the_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    """What agent-py actually answers on 401 / 404 / 422 parses as the
    contract's error models."""
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "contract-models-secret")
    client = TestClient(create_app(enable_poller=False))
    for r in (client.get("/v1/whoami"), client.get("/nope")):
        assert r.status_code in (401, 404)
        models.ErrorResponse.model_validate(r.json())
    token = jwt.encode(
        {
            "sub": "00000000-0000-4000-8000-000000000001",
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 60,
        },
        "contract-models-secret",
        algorithm="HS256",
    )
    r = client.post("/v1/files/refresh-url", json={}, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 422
    body = models.ValidationErrorResponse.model_validate(r.json())
    assert body.code == "invalid_request"
    assert body.issues


def test_request_models_enforce_spec_constraints() -> None:
    req = models.ExtractTableRequest.model_validate(
        {
            "reportText": "r",
            "sources": [{"title": "t", "url": "u", "snippet": "s"}],
            "columnHints": ["Claim", {"label": "Year", "type": "number"}],
        }
    )
    assert req.columnHints is not None and len(req.columnHints) == 2
    table = models.CitationTable.model_validate(
        {"columns": [{"id": "a", "label": "A"}], "rows": [{"a": {"value": "1"}}], "sources": []}
    )
    assert table.rows[0]["a"].citations == []

"""The Pydantic models generated from `packages/contract/openapi.yaml`
(`agent_py.contract.models`) parse what agent-py actually serves.

An in-process smoke check beside the HTTP conformance suite
(`packages/contract/conformance/`): it proves the generated module is
importable and usable, and catches drift on the probes without a live
server. Routers still declare their own response models; switching them
to the generated ones is a later wave.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from pydantic import TypeAdapter

from agent_py.contract import models
from agent_py.main import create_app


def test_probes_match_the_contract() -> None:
    client = TestClient(create_app(enable_poller=False))
    health = models.HealthResponse.model_validate(client.get("/healthz").json())
    assert health.status == "ok"
    ready = models.ReadinessResponse.model_validate(client.get("/readyz").json())
    assert ready.status in ("ok", "degraded")


def test_error_response_accepts_today_s_envelopes() -> None:
    adapter: TypeAdapter[models.ErrorResponse] = TypeAdapter(models.ErrorResponse)
    assert isinstance(adapter.validate_python({"code": "auth", "message": "x"}), models.ApiError)
    legacy = adapter.validate_python({"detail": "Invalid token."})
    assert isinstance(legacy, models.LegacyFastApiError)


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

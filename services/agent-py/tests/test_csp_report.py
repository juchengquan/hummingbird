"""`/v1/csp-report` + `agent_py.csp_report`.

Parity: `fixtures/csp_report_parity.json` holds `sanitizeReportedUrl` /
`parseCspReports` outputs produced by running the TS module with bun
(`bun run codegen:agent-py-parity`); the port must match them exactly.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import structlog
from fastapi.testclient import TestClient

from agent_py.csp_report import (
    CSP_REPORT_MAX_BYTES,
    decode_report_body,
    parse_csp_reports,
    sanitize_reported_url,
)
from agent_py.main import create_app
from agent_py.routers import csp_report as csp_router

_FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "csp_report_parity.json").read_text(encoding="utf-8")
)
PATH = "/v1/csp-report"

LEGACY = {
    "csp-report": {
        "document-uri": "https://app.example.com/dashboard?tab=secret",
        "effective-directive": "script-src-elem",
        "blocked-uri": "https://cdn.example.com/x.js?sig=abc",
        "script-sample": "alert(document.cookie)",
        "disposition": "report",
    }
}


# --- parity -------------------------------------------------------------


@pytest.mark.parametrize(
    "case", _FIXTURE["urls"], ids=[repr(c["raw"])[:60] for c in _FIXTURE["urls"]]
)
def test_sanitize_matches_ts(case: dict[str, str]) -> None:
    assert sanitize_reported_url(case["raw"]) == case["sanitized"]


@pytest.mark.parametrize(
    "case", _FIXTURE["payloads"], ids=[c["name"] for c in _FIXTURE["payloads"]]
)
def test_parse_matches_ts(case: dict[str, Any]) -> None:
    got = parse_csp_reports(case["payload"])
    assert got == case["logs"]
    # Same key order as the TS object, so the log lines read the same.
    assert [list(g) for g in got] == [list(e) for e in case["logs"]]


def test_decode_matches_json_parse() -> None:
    assert decode_report_body(b'\xef\xbb\xbf{"a": 1}') == {"a": 1}
    assert decode_report_body(b'{"a": "\xff"}') == {"a": "\ufffd"}
    for bad in (b"", b"{not json", b"NaN", b'{"a": Infinity}'):
        with pytest.raises(ValueError):
            decode_report_body(bad)


# --- route ----------------------------------------------------------------


@pytest.fixture
def client() -> TestClient:
    csp_router._csp_limit.reset()
    return TestClient(create_app(enable_poller=False))


def _post(client: TestClient, body: Any, content_type: str = "application/csp-report") -> Any:
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    return client.post(PATH, content=raw, headers={"content-type": content_type})


def test_needs_no_auth_and_answers_204_empty(client: TestClient) -> None:
    with structlog.testing.capture_logs() as logs:
        r = _post(client, LEGACY)
    assert r.status_code == 204
    assert r.content == b""
    violations = [e for e in logs if e["event"] == "csp_violation"]
    assert len(violations) == 1
    v = violations[0]
    assert v["via"] == "report-uri"
    assert v["directive"] == "script-src-elem"
    # Sanitised: no query strings, no script sample.
    assert v["document"] == "https://app.example.com/dashboard"
    assert v["blocked"] == "https://cdn.example.com/x.js"
    assert "secret" not in json.dumps(logs)
    assert "cookie" not in json.dumps(logs)


@pytest.mark.parametrize(
    "content_type",
    ["application/reports+json", "application/json; charset=utf-8", "APPLICATION/JSON"],
)
def test_accepts_every_report_media_type(client: TestClient, content_type: str) -> None:
    batch = [{"type": "csp-violation", "body": {"effectiveDirective": "img-src"}}]
    with structlog.testing.capture_logs() as logs:
        r = _post(client, batch, content_type)
    assert r.status_code == 204
    assert sum(e["event"] == "csp_violation" for e in logs) == 1


def test_unknown_shapes_are_accepted_and_ignored(client: TestClient) -> None:
    with structlog.testing.capture_logs() as logs:
        r = _post(client, {"hello": "world"})
    assert r.status_code == 204
    assert not [e for e in logs if e["event"] == "csp_violation"]


def test_reporting_batch_is_capped(client: TestClient) -> None:
    batch = [{"type": "csp-violation", "body": {"effectiveDirective": "img-src"}}] * 50
    with structlog.testing.capture_logs() as logs:
        r = _post(client, batch, "application/reports+json")
    assert r.status_code == 204
    assert sum(e["event"] == "csp_violation" for e in logs) == 20


def test_unsupported_media_type_is_415_empty(client: TestClient) -> None:
    r = _post(client, LEGACY, "text/plain")
    assert r.status_code == 415
    assert r.json()["code"] == "unsupported_content_type"


def test_malformed_json_is_400_empty(client: TestClient) -> None:
    r = _post(client, b"{not json")
    assert r.status_code == 400
    assert r.json()["code"] == "invalid_request"
    assert "not json" not in r.text  # input is never echoed


def test_oversized_body_is_413(client: TestClient) -> None:
    r = _post(client, b"[" + b" " * CSP_REPORT_MAX_BYTES + b"]")
    assert r.status_code == 413


def test_rate_limited_per_ip_with_retry_after(client: TestClient) -> None:
    for _ in range(60):
        assert _post(client, LEGACY).status_code == 204
    r = _post(client, LEGACY)
    assert r.status_code == 429
    assert r.json()["code"] == "rate_limit"
    assert int(r.headers["retry-after"]) >= 1
    # The limit is per client IP: another address is unaffected.
    other = client.post(
        PATH,
        content=json.dumps(LEGACY).encode(),
        headers={"content-type": "application/csp-report", "x-forwarded-for": "203.0.113.9"},
    )
    assert other.status_code == 204


def test_rate_limit_runs_before_body_checks(client: TestClient) -> None:
    for _ in range(60):
        _post(client, LEGACY)
    # Even a bad media type is answered 429 once the IP is over its limit.
    assert _post(client, LEGACY, "text/plain").status_code == 429

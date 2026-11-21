"""`/v1/csp-report` — CSP violation-report intake. Mirrors
`app/api/csp-report/route.ts` (`createCspReportHandler`).
"""

from __future__ import annotations

import structlog
from fastapi import APIRouter, Request, Response
from starlette.requests import ClientDisconnect

from ..csp_report import ACCEPTED_TYPES, decode_report_body, parse_csp_reports
from ..rate_limit import SlidingWindow, rate_limit_key

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["security"])

#: 60 report POSTs / minute / client IP, as on the Next.js route. A page
#: with a broken policy can fire many violations at once; beyond this
#: they're dropped.
_csp_limit = SlidingWindow(window_ms=60_000, max=60)


@router.post("/v1/csp-report", status_code=204, response_class=Response)
async def csp_report(request: Request) -> Response:
    """Public by nature (browsers send no credentials). Same answers as the
    Next.js route, all with an empty body — input is never echoed:
    429 + `Retry-After` over the per-IP limit (checked first), 415 for an
    unsupported `Content-Type`, 400 for a body that isn't JSON, else 204
    after logging one `csp_violation` line per violation found.

    The 16 KiB body cap is enforced by `BodySizeLimitMiddleware` ahead of
    routing, so an oversized body gets that middleware's 413 (JSON
    `{detail}` body) before the rate limit is consulted — the Next.js
    route answers an empty-bodied 413 after it.
    """
    verdict = _csp_limit.consume(rate_limit_key(request))
    if not verdict.allowed:
        return Response(status_code=429, headers={"Retry-After": str(verdict.retry_after_sec)})

    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if content_type not in ACCEPTED_TYPES:
        return Response(status_code=415)

    try:
        raw = await request.body()
    except ClientDisconnect:
        return Response(status_code=400)
    try:
        payload = decode_report_body(raw)
    except ValueError:
        return Response(status_code=400)

    for violation in parse_csp_reports(payload):
        fields = {k: v for k, v in violation.items() if k != "evt"}
        logger.warning("csp_violation", **fields)
    return Response(status_code=204)

"""`/v1/tasks/schedules` — schedule CRUD.

Mirrors `app/api/tasks/schedules/route.ts` + `[id]/route.ts`: same
request / response shapes (`ScheduleCreateSchema`, `ScheduleUpdateSchema`,
`rowToSchedule`), same validation (the Zod rules with their first-issue
message, then `validateScheduleCron`), same statuses and `code`s.

Every query runs **as the caller**: inside a transaction,
`store._set_user_context` does `SET LOCAL ROLE authenticated` and stamps
`request.jwt.claims` (so `auth.uid()` is the caller). `current_user` is
then `authenticated`, which is what the Next route's user-bound Supabase
client gets through PostgREST — so the own-your-rows RLS policies, 0031's
workspace-ownership check, 0035's column grants (`last_run_at` /
`last_run_task_id` are not user-writable) and 0035's guard trigger
(coarse cron floor → 22023, 20 enabled schedules per user → 54000) all
apply exactly as they do for the Next route.

Error mapping follows the Next routes: on create / update the deliberate
SQLSTATEs map like `taskWriteErrorResponse` (42501 → 403 `forbidden`,
P0002 → 404, 22023 → 400 `invalid_request`, 55000 → 409 `invalid_state`,
54000 → 409 `limit_reached`); anything else — and every list / delete
failure — is what `categorizeError` makes of a PostgREST error object:
500 `unknown` "Unknown error".
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Annotated, Any, NoReturn

import asyncpg
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse

from .. import db, store
from ..auth import get_current_user
from ..contract import models
from ..schedules import (
    ScheduleBodyError,
    parse_schedule_body,
    row_to_schedule,
    truncate_to_ms,
    validate_schedule_cron,
)

router = APIRouter(tags=["schedules"])
logger = structlog.get_logger(__name__)

# 0034 / 0035's deliberate SQLSTATEs → `(status, code)`; the
# `SQLSTATE_RESPONSES` table in lib/server/agent/task-writes.ts.
_SQLSTATE_RESPONSES: dict[str, tuple[int, str]] = {
    "42501": (403, "forbidden"),
    "P0002": (404, "not_found"),
    "22023": (400, "invalid_request"),
    "55000": (409, "invalid_state"),
    "54000": (409, "limit_reached"),
}

_ACQUIRE_TIMEOUT_S = 10.0


def _error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _unknown() -> HTTPException:
    # `categorizeError` of a PostgREST error object (not an `Error`).
    return _error(500, "unknown", "Unknown error")


def _write_error(exc: BaseException) -> HTTPException:
    """`taskWriteErrorResponse(error) ?? categorizeError(error)`."""
    sqlstate = getattr(exc, "sqlstate", None)
    mapped = _SQLSTATE_RESPONSES.get(sqlstate) if isinstance(sqlstate, str) else None
    if mapped is None:
        logger.warning("schedules.write_failed", sqlstate=sqlstate, error=str(exc))
        return _unknown()
    message = getattr(exc, "message", None) or str(exc) or "Request rejected."
    return _error(mapped[0], mapped[1], message)


def _user_id(claims: dict[str, object]) -> str:
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        raise _error(status.HTTP_401_UNAUTHORIZED, "auth", "Token has no subject.")
    return sub


def _pool() -> asyncpg.Pool:
    if not db.has_pool():
        raise _error(503, "unavailable", "Supabase is not configured.")
    return db.get_pool()


@asynccontextmanager
async def _as_user(user_id: str) -> AsyncIterator[asyncpg.Connection]:
    """A connection inside a transaction, impersonating the caller."""
    pool = _pool()
    async with pool.acquire(timeout=_ACQUIRE_TIMEOUT_S) as conn, conn.transaction():
        await store._set_user_context(conn, user_id=user_id)
        yield conn


async def _read_body(request: Request, *, partial: bool) -> dict[str, Any]:
    """`readJsonCapped` + Zod `safeParse`. The byte cap (256 KB, the Next
    route's `SCHEDULE_BODY_MAX`) is enforced by `BodySizeLimitMiddleware`."""
    raw = await request.body()
    text = raw.decode("utf-8", errors="replace").removeprefix("﻿")
    try:
        value = json.loads(text, parse_constant=_reject_constant)
    except ValueError:
        raise _error(400, "invalid_request", "Body must be JSON.") from None
    try:
        return parse_schedule_body(value, partial=partial)
    except ScheduleBodyError as exc:
        raise _error(400, "invalid_request", str(exc)) from None


def _reject_constant(name: str) -> NoReturn:
    # `NaN` / `Infinity` are not JSON (`JSON.parse` rejects them).
    raise ValueError(name)


def _now() -> datetime:
    return truncate_to_ms(datetime.now(UTC))


def _skills_json(skills: object) -> str | None:
    return None if skills is None else json.dumps(skills)


# --- GET / POST /v1/tasks/schedules ------------------------------------------

_LIST_SQL = """
SELECT * FROM public.task_schedules
WHERE user_id = $1
ORDER BY created_at DESC;
"""

_INSERT_SQL = """
INSERT INTO public.task_schedules (
  user_id, workspace_id, name, prompt, cron, timezone, enabled,
  model, system_prompt, skills, max_steps, next_run_at
)
VALUES ($1, $2::text::uuid, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
RETURNING *;
"""


@router.get(
    "/v1/tasks/schedules",
    response_model=models.ScheduleListResponse,
    responses={401: {}, 500: {}, 503: {}},
)
async def list_schedules(
    claims: Annotated[dict[str, object], Depends(get_current_user)],
) -> JSONResponse:
    user_id = _user_id(claims)
    try:
        async with _as_user(user_id) as conn:
            rows = await conn.fetch(_LIST_SQL, uuid.UUID(user_id))
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("schedules.list_failed", error=str(exc))
        raise _unknown() from None
    return JSONResponse({"schedules": [row_to_schedule(r) for r in rows]})


@router.post(
    "/v1/tasks/schedules",
    status_code=201,
    response_model=models.ScheduleResponse,
    responses={400: {}, 401: {}, 403: {}, 409: {}, 413: {}, 500: {}, 503: {}},
)
async def create_schedule(
    request: Request,
    claims: Annotated[dict[str, object], Depends(get_current_user)],
) -> JSONResponse:
    user_id = _user_id(claims)
    _pool()
    body = await _read_body(request, partial=False)
    timezone = body.get("timezone", "UTC")
    check = validate_schedule_cron(body["cron"], timezone, _now())
    if not check.ok or check.next is None:
        raise _error(400, "invalid_request", check.message)
    try:
        async with _as_user(user_id) as conn:
            row = await conn.fetchrow(
                _INSERT_SQL,
                uuid.UUID(user_id),
                body["workspaceId"],
                body["name"],
                body["prompt"],
                body["cron"],
                timezone,
                body.get("enabled", True),
                body.get("model"),
                body.get("systemPrompt"),
                _skills_json(body.get("skills")),
                body.get("maxSteps"),
                check.next,
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise _write_error(exc) from None
    if row is None:  # pragma: no cover - INSERT … RETURNING always yields a row
        raise _unknown()
    return JSONResponse(row_to_schedule(row), status_code=201)


# --- PATCH / DELETE /v1/tasks/schedules/{id} ----------------------------------

_GET_SQL = """
SELECT * FROM public.task_schedules
WHERE id = $1::text::uuid AND user_id = $2;
"""

_DELETE_SQL = """
DELETE FROM public.task_schedules
WHERE id = $1::text::uuid AND user_id = $2;
"""

# PATCH body key → (column, SQL cast for the bound value).
_PATCH_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("name", "name", ""),
    ("prompt", "prompt", ""),
    ("workspaceId", "workspace_id", "::text::uuid"),
    ("enabled", "enabled", ""),
    ("model", "model", ""),
    ("systemPrompt", "system_prompt", ""),
    ("skills", "skills", "::jsonb"),
    ("maxSteps", "max_steps", ""),
)


@router.patch(
    "/v1/tasks/schedules/{schedule_id}",
    response_model=models.ScheduleResponse,
    responses={400: {}, 401: {}, 403: {}, 404: {}, 409: {}, 413: {}, 500: {}, 503: {}},
)
async def update_schedule(
    schedule_id: str,
    request: Request,
    claims: Annotated[dict[str, object], Depends(get_current_user)],
) -> JSONResponse:
    user_id = _user_id(claims)
    user = uuid.UUID(user_id)
    _pool()
    patch = await _read_body(request, partial=True)

    # The current row's cron / timezone decide whether `next_run_at` is
    # recomputed (and prove the row exists and is the caller's).
    try:
        async with _as_user(user_id) as conn:
            current = await conn.fetchrow(_GET_SQL, schedule_id, user)
    except HTTPException:
        raise
    except Exception:
        current = None
    if current is None:
        raise _error(404, "not_found", "Schedule not found.")

    sets: list[str] = []
    args: list[object] = [schedule_id, user]

    def assign(column: str, value: object, cast: str = "") -> None:
        args.append(value)
        sets.append(f"{column} = ${len(args)}{cast}")

    assign("updated_at", _now())
    for key, column, cast in _PATCH_COLUMNS:
        if key in patch:
            value = _skills_json(patch[key]) if key == "skills" else patch[key]
            assign(column, value, cast)

    # Recompute `next_run_at` only when cron / timezone actually change, so
    # an edit never pulls the next fire earlier.
    cron_changed = "cron" in patch and patch["cron"] != current["cron"]
    tz_changed = "timezone" in patch and patch["timezone"] != current["timezone"]
    if cron_changed or tz_changed:
        cron = patch.get("cron", current["cron"])
        timezone = patch.get("timezone", current["timezone"])
        check = validate_schedule_cron(cron, timezone, _now())
        if not check.ok or check.next is None:
            raise _error(400, "invalid_request", check.message)
        assign("cron", cron)
        assign("timezone", timezone)
        assign("next_run_at", check.next)

    sql = (
        f"UPDATE public.task_schedules SET {', '.join(sets)} "
        "WHERE id = $1::text::uuid AND user_id = $2 RETURNING *;"
    )
    try:
        async with _as_user(user_id) as conn:
            row = await conn.fetchrow(sql, *args)
    except HTTPException:
        raise
    except Exception as exc:
        raise _write_error(exc) from None
    if row is None:
        # Gone between the read and the update: PostgREST's `.single()`
        # error (PGRST116), which the Next route answers with a 500.
        raise _unknown()
    return JSONResponse(row_to_schedule(row))


@router.delete(
    "/v1/tasks/schedules/{schedule_id}",
    response_model=models.DeleteScheduleResponse,
    responses={401: {}, 500: {}, 503: {}},
)
async def delete_schedule(
    schedule_id: str,
    claims: Annotated[dict[str, object], Depends(get_current_user)],
) -> JSONResponse:
    user_id = _user_id(claims)
    try:
        async with _as_user(user_id) as conn:
            await conn.execute(_DELETE_SQL, schedule_id, uuid.UUID(user_id))
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("schedules.delete_failed", error=str(exc))
        raise _unknown() from None
    return JSONResponse({"ok": True})

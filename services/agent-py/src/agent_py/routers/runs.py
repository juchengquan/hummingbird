"""`/v1/runs` — the runs API (PLAN-frontend-backend-split Phase 2, Q7).

The five operations of `packages/contract/openapi.yaml` (tag `runs`):
`startRun`, `listRuns`, `getRun`, `streamRunEvents`, `cancelRun`. Events
are AG-UI 1.0 per `packages/contract/RUN_EVENTS.md`. Every service this
router uses comes from `runs.wiring.RunServices` (the wiring seam).

**Credentials.** A bearer token (a Supabase user JWT, `auth.py`) or, for
an anonymous run, its `X-Run-Token`:

* `startRun` takes a bearer token or nothing (anonymous, interactive
  only; refused with `401 auth_required` under `REQUIRE_AUTH_FOR_AI`).
  An anonymous start presenting `X-Run-Token` is recognised as an
  idempotent retry of the run that token owns, or — for a resume (Q24)
  — as the owner of the interrupted run it answers, and the new run
  stays under that token; otherwise a new token is minted. The token is
  returned in the `X-Run-Token` response header either way.
* `getRun` / `streamRunEvents` / `cancelRun` take a bearer token, else a
  run token; neither → 401. A present `Authorization` header always
  wins and is verified (an invalid one is 401, never anonymous); a
  malformed run token is 401. A run that is missing, someone else's or
  not this token's → the same `404 not_found`.
* `listRuns` takes a bearer token only.

**Idempotent `runId`.** The client mints it. A repeat from the run's
owner with the same `threadId` and `mode` replays (interactive: the
stream from cursor `0`; background: `202` with the current status)
without validating or applying anything in the body. Any other use of a
taken id — in any store — is `409 run_id_conflict`, one body for every
case.

**Interactive streams** are readers of the run's event log (the run
itself executes detached, `runs.driver`): a start answers exactly what
`streamRunEvents?after=0` would. Every stream pulls its first frame
before committing to `200` (`_sse_response`): `stream_run_events`
validates the cursor and the run there, so a cursor beyond the log is
`400 invalid_request` and a run that vanished is `404`.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, NoReturn

import structlog
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .. import db
from ..auth import get_current_user
from ..contract import models
from ..events import StatusEvent
from ..model_allowlist import UnknownModelError
from ..rate_limit import rate_limit_key
from ..runs.access import (
    RUN_TOKEN_HEADER,
    RequireAuthConfigError,
    is_run_token,
    mint_run_token,
    require_auth_for_ai,
)
from ..runs.context import check_attachment_input
from ..runs.history import AttachmentRejected, check_attachments, last_user_text
from ..runs.model import ContractStatus, RunCursor, RunMode, RunOwner, RunRecord, run_to_contract
from ..runs.native_harness import validate_run_options
from ..runs.repository import (
    InvalidPageToken,
    PreviousRunAlreadyResumed,
    PreviousRunNotFound,
    RunFilter,
    RunIdConflict,
    RunSpec,
    ThreadNotFound,
)
from ..runs.repository_memory import MemoryStoreFull
from ..runs.repository_pg import RunWriteError
from ..runs.run_input import (
    DEFAULT_BACKGROUND_MAX_STEPS,
    ResumeInvalid,
    ResumeMismatch,
    background_checkpoint,
    build_run_input,
    check_resume,
    forwarded_props,
)
from ..runs.stream import CursorOutOfRange
from ..runs.wiring import RunServices, get_run_services
from ..settings import Settings, get_settings

router = APIRouter(tags=["runs"])
logger = structlog.get_logger(__name__)

AUTH_REQUIRED_MESSAGE = "Sign in to use AI features on this server."
"""`AUTH_REQUIRED_MESSAGE` in `lib/shared/api-errors.ts`."""

_RUN_NOT_FOUND = "Run not found."
_RUN_ID_CONFLICT = "This runId is already in use."
_RUN_ALREADY_RESUMED = "Another run already answers this run's interrupts."

_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def _raise(
    status: int, code: str, message: str, *, headers: dict[str, str] | None = None
) -> NoReturn:
    raise HTTPException(
        status_code=status, detail={"code": code, "message": message}, headers=headers
    )


def _not_found() -> NoReturn:
    _raise(404, "not_found", _RUN_NOT_FOUND)


def _run_id_conflict() -> NoReturn:
    _raise(409, "run_id_conflict", _RUN_ID_CONFLICT)


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


# --- Credentials -------------------------------------------------------------------


@dataclass(frozen=True)
class StartCaller:
    user_id: str | None
    """None for an anonymous caller."""
    presented_token: str | None = None
    """An anonymous caller's `X-Run-Token`, when well-formed."""


def start_caller(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[str | None, Header()] = None,
    x_run_token: Annotated[str | None, Header(alias=RUN_TOKEN_HEADER)] = None,
) -> StartCaller:
    if authorization is not None:
        claims = get_current_user(authorization, settings)
        return StartCaller(user_id=str(claims["sub"]))
    try:
        gated = require_auth_for_ai(settings)
    except RequireAuthConfigError as exc:
        logger.error("runs.require_auth_config", error=str(exc))
        _raise(500, "unknown", "Server misconfigured.")
    if gated:
        _raise(401, "auth_required", AUTH_REQUIRED_MESSAGE)
    token = x_run_token if x_run_token is not None and is_run_token(x_run_token) else None
    return StartCaller(user_id=None, presented_token=token)


def run_owner(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[str | None, Header()] = None,
    x_run_token: Annotated[str | None, Header(alias=RUN_TOKEN_HEADER)] = None,
) -> RunOwner:
    """The owner a request on one run speaks for (bearer, else run token)."""
    if authorization is not None:
        claims = get_current_user(authorization, settings)
        return RunOwner.user(str(claims["sub"]))
    if x_run_token is not None:
        if not is_run_token(x_run_token):
            _raise(401, "auth", "Invalid run token.")
        return RunOwner.anonymous(x_run_token)
    _raise(
        401,
        "auth",
        "Missing credentials: a bearer token or the run's X-Run-Token.",
        headers={"WWW-Authenticate": "Bearer"},
    )


# --- Helpers -------------------------------------------------------------------------


async def _owned_run(services: RunServices, owner: RunOwner, run_id: str) -> RunRecord:
    if not _is_uuid(run_id):
        _not_found()
    run = await services.repo_for(owner).get(owner, run_id)
    if run is None:
        _not_found()
    return run


async def _run_json(services: RunServices, owner: RunOwner, run: RunRecord) -> dict[str, object]:
    last_seq = await services.log_for(owner).last_seq(run.id)
    return run_to_contract(run, last_seq=last_seq)


def _event_stream(
    services: RunServices, owner: RunOwner, run: RunRecord, after: RunCursor | None
) -> AsyncIterator[str]:
    repo = services.repo_for(owner)

    async def load_run() -> RunRecord | None:
        return await repo.get(owner, run.id)

    return services.stream(
        run_id=run.id,
        after=after,
        log=services.log_for(owner),
        encoder=services.encoder_factory(run),
        load_run=load_run,
    )


async def _sse_response(
    frames: AsyncIterator[str], *, headers: dict[str, str] | None = None
) -> StreamingResponse:
    """A `200` SSE response over `frames`, after pulling the first frame:
    `stream_run_events` raises before sending anything for a cursor
    beyond the log (→ 400) or a missing run (→ 404)."""
    try:
        first: str | None = await anext(frames)
    except CursorOutOfRange:
        await _aclose(frames)
        _raise(400, "invalid_request", "The cursor is beyond the run's log.")
    except LookupError:
        await _aclose(frames)
        _not_found()
    except StopAsyncIteration:
        first = None

    async def body() -> AsyncIterator[str]:
        try:
            if first is not None:
                yield first
            async for frame in frames:
                yield frame
        finally:
            await _aclose(frames)

    return StreamingResponse(
        body(), media_type="text/event-stream", headers={**(headers or {}), **_SSE_HEADERS}
    )


async def _aclose(frames: AsyncIterator[str]) -> None:
    aclose = getattr(frames, "aclose", None)
    if aclose is not None:
        await aclose()


def _location(run_id: str) -> str:
    return f"/v1/runs/{run_id}"


async def _id_taken(services: RunServices, run_id: str) -> bool:
    if services.memory_repo.contains(run_id):
        return True
    return services.pg_repo is not None and await services.pg_repo.exists(run_id)


# --- POST /v1/runs -----------------------------------------------------------------

_START_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {
        "description": "Interactive run: its AG-UI event stream.",
        "content": {"text/event-stream": {"schema": {"type": "string"}}},
    },
    202: {"description": "Background run accepted.", "model": models.RunAccepted},
}


@router.post("/v1/runs", responses=_START_RESPONSES, response_class=Response)
async def start_run(
    request: Request,
    body: models.StartRunRequest,
    caller: Annotated[StartCaller, Depends(start_caller)],
    services: Annotated[RunServices, Depends(get_run_services)],
) -> Response:
    settings = services.settings
    fp = forwarded_props(body)
    mode: RunMode = fp.mode or "interactive"
    anonymous = caller.user_id is None
    if anonymous and mode == "background":
        _raise(401, "auth_required", "Sign in to start background runs.")
    # TODO(5b-D): Q42 — a background run refuses local MCP, as the Next
    # task routes do: `forwardedProps.localMcpServers` non-empty (or
    # credentials in `state["hummingbird.localMcp"]`) with
    # `mode: background` → 400 `invalid_request`, before anything is
    # created. (Credentials never reach a background run anyway:
    # `background_checkpoint` reads only `messages` + `forwardedProps`.)

    client_key = rate_limit_key(request)
    refusal = services.limits.check_start(
        client_key,
        anonymous=anonymous,
        live_anonymous_runs=services.memory_repo.live_runs_for_client(client_key)
        if anonymous
        else 0,
    )
    if refusal is not None:
        _raise(
            429,
            "rate_limit",
            refusal.message,
            headers={"Retry-After": str(refusal.retry_after_sec)},
        )

    resume = body.resume or []
    if resume and fp.previousRunId is None:
        _raise(400, "invalid_request", "resume[] needs forwardedProps.previousRunId.")
    # Before anything is created, as `/v1/chat` does: an unknown model is
    # `400 unknown_model` with no row (the harness re-checks).
    try:
        validate_run_options(fp.model_dump(mode="json", exclude_none=True))
    except UnknownModelError as exc:
        raise HTTPException(status_code=400, detail=exc.to_detail()) from exc
    # Likewise an attachment the model cannot be given (an unsupported
    # type, over a size or count limit): `400 invalid_attachment`.
    try:
        check_attachments([m.model_dump(mode="json", exclude_none=True) for m in body.messages])
        # `forwardedProps.attachments`: a cloud file needs a signed-in run
        # with a database; an inline file's bytes follow the media rules.
        check_attachment_input(
            fp.model_dump(mode="json", exclude_none=True),
            signed_in=not anonymous,
            database=db.has_pool(),
        )
    except AttachmentRejected as exc:
        _raise(400, exc.code, str(exc))

    # Who owns the run. An anonymous caller's presented token counts only
    # when it owns this run (an idempotent retry) or the interrupted run a
    # resume answers (the answer continues that run's thread, so it stays
    # under the same token); any other new run gets a fresh token.
    token: str | None = None
    existing: RunRecord | None = None
    if caller.user_id is not None:
        owner = RunOwner.user(caller.user_id)
        existing = await services.repo_for(owner).get(owner, body.runId)
    else:
        if caller.presented_token is not None:
            presented = RunOwner.anonymous(caller.presented_token)
            existing = await services.memory_repo.get(presented, body.runId)
            if existing is not None or (
                resume
                and await services.memory_repo.get(presented, str(fp.previousRunId)) is not None
            ):
                token, owner = caller.presented_token, presented
        if token is None:
            token = mint_run_token()
            owner = RunOwner.anonymous(token)
    repo = services.repo_for(owner)
    log = services.log_for(owner)

    retry = existing is not None and existing.thread_id == body.threadId and existing.mode == mode
    if not retry and (existing is not None or await _id_taken(services, body.runId)):
        _run_id_conflict()
    if mode == "background" and services.pg_repo is None:
        _raise(503, "unavailable", "Supabase is not configured.")

    previous_run_id: str | None = None
    created = False
    if retry:
        assert existing is not None
        run = existing
    else:
        if resume:
            previous_run_id = str(fp.previousRunId)
            # TODO(5b-A): Q41 — a background resume must start from the
            # paused run's checkpoint plus the `resume[]` answers (today
            # it gets a fresh `background_checkpoint` from the browser's
            # history, below), and the old `/api/tasks/:id/respond` must
            # refuse a run answered here (0043 mutual exclusion).
            # TODO(5b-D): a resume re-sends the local MCP credentials in
            # `state` (Q45) — `build_run_input` takes them out again.
            try:
                check_resume(await repo.get(owner, previous_run_id), body)
            except ResumeMismatch as exc:
                _raise(409, "invalid_state", str(exc))
            except ResumeInvalid as exc:
                _raise(400, "invalid_request", str(exc))
        if mode == "background":
            max_steps = fp.maxSteps or DEFAULT_BACKGROUND_MAX_STEPS
            model = fp.model or settings.AGENT_DEFAULT_MODEL
            messages = [m.model_dump(mode="json") for m in body.messages]
            spec = RunSpec(
                run_id=body.runId,
                thread_id=body.threadId,
                mode="background",
                goal=(fp.goal or last_user_text(messages))[:2000],
                previous_run_id=previous_run_id,
                max_steps=max_steps,
                checkpoint=background_checkpoint(body, model=model, max_steps=max_steps),
            )
        else:
            spec = RunSpec(
                run_id=body.runId,
                thread_id=body.threadId,
                mode="interactive",
                previous_run_id=previous_run_id,
                max_steps=fp.maxSteps,
                lease_seconds=settings.RUNS_LEASE_SECONDS,
            )
        try:
            result = await repo.create(owner, spec)
        except RunIdConflict:
            _run_id_conflict()
        except ThreadNotFound:
            _raise(404, "not_found", "Thread not found.")
        except PreviousRunNotFound:
            _raise(409, "invalid_state", "The previous run is not one of yours on this thread.")
        except PreviousRunAlreadyResumed:
            _raise(409, "run_already_resumed", _RUN_ALREADY_RESUMED)
        except MemoryStoreFull:
            _raise(503, "unavailable", "Too many runs in progress on this server. Retry shortly.")
        except ValueError as exc:
            _raise(400, "invalid_request", str(exc))
        run, created = result.run, result.created

    headers = {"Location": _location(run.id)}
    if mode == "background":
        if run.internal_status == "queued":
            await _queue_background(services, owner, run)
        return JSONResponse(
            {"runId": run.id, "status": run.status}, status_code=202, headers=headers
        )

    if created:
        if anonymous:
            services.memory_repo.tag_client(run.id, client_key)
        services.driver.start(
            run=run,
            run_input=build_run_input(
                body,
                mode="interactive",
                user_id=caller.user_id,
                previous_run_id=previous_run_id,
                client_key=client_key,
            ),
            repo=repo,
            log=log,
            harness=services.harness,
        )
    if token is not None:
        headers[RUN_TOKEN_HEADER] = token
    return await _sse_response(_event_stream(services, owner, run, None), headers=headers)


async def _queue_background(services: RunServices, owner: RunOwner, run: RunRecord) -> None:
    """What the Next task route does after `create_task_run`: a
    `status: queued` entry as seq 1 (the worker continues at seq 2), then
    the `start` job. Re-done on an idempotent retry of a still-queued run
    (both steps are idempotent: the entry by seq, the job by
    `enqueue_task_job` refusing a second `start` with 55000), so a first
    request that died between create and enqueue does not strand it."""
    assert services.pg_repo is not None
    try:
        await services.log_for(owner).append(
            StatusEvent(
                run_id=run.id,
                seq=1,
                step=0,
                created_at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                status="queued",
            )
        )
    except Exception as exc:
        logger.warning("runs.queued_event_failed", run_id=run.id, error=str(exc))
    try:
        await services.pg_repo.enqueue_start(owner, run.id)
    except RunWriteError as exc:
        if exc.sqlstate == "55000":
            return  # already has its start job, or no longer queued
        _raise(exc.status, exc.code, exc.message)


# --- GET /v1/runs ------------------------------------------------------------------


@router.get("/v1/runs", responses={200: {"model": models.RunList}}, response_class=JSONResponse)
async def list_runs(
    claims: Annotated[dict[str, object], Depends(get_current_user)],
    services: Annotated[RunServices, Depends(get_run_services)],
    thread_id: Annotated[uuid.UUID | None, Query(alias="threadId")] = None,
    status: Annotated[list[ContractStatus] | None, Query()] = None,
    parent_run_id: Annotated[uuid.UUID | None, Query(alias="parentRunId")] = None,
    mode: Annotated[Literal["interactive", "background"] | None, Query()] = None,
    page_size: Annotated[int, Query(alias="pageSize", ge=1, le=100)] = 20,
    page_token: Annotated[
        str | None, Query(alias="pageToken", min_length=1, max_length=512)
    ] = None,
) -> JSONResponse:
    owner = RunOwner.user(str(claims["sub"]))
    filt = RunFilter(
        thread_id=None if thread_id is None else str(thread_id),
        statuses=frozenset(status or ()),
        parent_run_id=None if parent_run_id is None else str(parent_run_id),
        mode=mode,
    )
    try:
        page = await services.repo_for(owner).list_runs(
            owner, filt, page_size=page_size, page_token=page_token
        )
    except InvalidPageToken:
        _raise(400, "invalid_request", "Invalid pageToken for these filters.")
    runs = [await _run_json(services, owner, run) for run in page.runs]
    return JSONResponse({"runs": runs, "nextPageToken": page.next_page_token})


# --- GET /v1/runs/{runId} ----------------------------------------------------------


@router.get(
    "/v1/runs/{run_id}", responses={200: {"model": models.Run}}, response_class=JSONResponse
)
async def get_run(
    run_id: str,
    owner: Annotated[RunOwner, Depends(run_owner)],
    services: Annotated[RunServices, Depends(get_run_services)],
) -> JSONResponse:
    run = await _owned_run(services, owner, run_id)
    return JSONResponse(await _run_json(services, owner, run))


# --- GET /v1/runs/{runId}/events ---------------------------------------------------


@router.get(
    "/v1/runs/{run_id}/events",
    responses={
        200: {
            "description": "The run's AG-UI event stream.",
            "content": {"text/event-stream": {"schema": {"type": "string"}}},
        }
    },
    response_class=StreamingResponse,
)
async def stream_run_events(
    run_id: str,
    owner: Annotated[RunOwner, Depends(run_owner)],
    services: Annotated[RunServices, Depends(get_run_services)],
    after: Annotated[str | None, Query()] = None,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
) -> StreamingResponse:
    raw = after if after is not None else last_event_id
    cursor: RunCursor | None = None
    if raw is not None:
        try:
            cursor = RunCursor.parse(raw)
        except ValueError:
            _raise(400, "invalid_request", "Invalid cursor.")
    run = await _owned_run(services, owner, run_id)
    return await _sse_response(_event_stream(services, owner, run, cursor))


# --- POST /v1/runs/{runId}/cancel --------------------------------------------------


@router.post(
    "/v1/runs/{run_id}/cancel",
    responses={200: {"model": models.Run}},
    response_class=JSONResponse,
)
async def cancel_run(
    run_id: str,
    owner: Annotated[RunOwner, Depends(run_owner)],
    services: Annotated[RunServices, Depends(get_run_services)],
) -> JSONResponse:
    await _owned_run(services, owner, run_id)
    run = await services.repo_for(owner).cancel(owner, run_id)
    if run is None:
        _not_found()
    if run.internal_status == "cancelled":
        # This process: stop it now. Elsewhere: its heartbeat finds out.
        services.driver.signal_cancel(run.id)
    return JSONResponse(await _run_json(services, owner, run))

"""`/v1/runs` — the runs API (PLAN-frontend-backend-split Phase 2, Q7).

The operations of `packages/contract/openapi.yaml` (tag `runs`):
`startRun`, `listRuns`, `getRun`, `streamRunEvents`, `cancelRun`, and —
contract 0.5.0, wave 6 — `answerRun` (a sub-agent run's question
answered in place, Q59) and `markRunDelivered` (Q77), with `listRuns`'
task filters `topLevel` / `current` / `rootRunId` / `delivered`. Events
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
* `listRuns`, `answerRun` and `markRunDelivered` take a bearer token
  only.

**Ephemeral runs** (`forwardedProps.ephemeral`, contract 0.8.0, Q136 —
the Explain popover): interactive only and never a resume (`400
invalid_request`); kept in the in-memory store and log even for a
signed-in caller (`RunServices.stores_for` / `stores_of_run`), so never a
`tasks` row and never listed, while the bearer still reads and cancels
them and the signed-in start limit applies. The harness offers them no
tools (`native_harness`).

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
from ..model_allowlist import UnknownModelError, resolve_api_model_id
from ..rate_limit import rate_limit_key
from ..runs.access import (
    RUN_TOKEN_HEADER,
    RequireAuthConfigError,
    is_run_token,
    mint_run_token,
    require_auth_for_ai,
)
from ..runs.context import check_attachment_input
from ..runs.credentials import split_state
from ..runs.history import AttachmentRejected, check_attachments, last_user_text
from ..runs.model import ContractStatus, RunCursor, RunMode, RunOwner, RunRecord, run_to_contract
from ..runs.native_harness import validate_run_options
from ..runs.repository import (
    AnswerInvalid,
    InvalidPageToken,
    PreviousRunAlreadyAnswered,
    PreviousRunAlreadyResumed,
    PreviousRunAnswerApplied,
    PreviousRunNotFound,
    PreviousRunNotWaiting,
    QuestionAlreadyAnswered,
    RunFilter,
    RunIdConflict,
    RunNotAnswerable,
    RunNotDeliverable,
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
    background_max_steps,
    build_run_input,
    check_resume,
    forwarded_props,
    resume_checkpoint,
)
from ..runs.stream import CursorOutOfRange
from ..runs.wiring import RunServices, get_run_services
from ..settings import Settings, get_settings

#: Q42 — the Next task route's message, verbatim (`app/api/tasks/route.ts`;
#: "async task mode" is a background run, "the chat route" an interactive one).
LOCAL_MCP_BACKGROUND_REFUSAL = (
    "Local-mode MCP servers aren't supported in async task mode. "
    "Connect the server as a cloud-mode workspace MCP, or use the "
    "chat route for this workflow."
)

router = APIRouter(tags=["runs"])
logger = structlog.get_logger(__name__)

AUTH_REQUIRED_MESSAGE = "Sign in to use AI features on this server."
"""`AUTH_REQUIRED_MESSAGE` in `lib/shared/api-errors.ts`."""

_RUN_NOT_FOUND = "Run not found."
_RUN_ID_CONFLICT = "This runId is already in use."
_RUN_ALREADY_RESUMED = "Another run already answers this run's interrupts."
_RUN_ALREADY_ANSWERED = "This question was already answered through the task respond route."
_RUN_ANSWER_APPLIED = (
    "An earlier answer to this question was already acted on before its run ended, "
    "so it can't be answered again. Send the message again instead."
)
_RUN_NOT_WAITING = "The previous run is no longer waiting on these answers."
_QUESTION_ALREADY_ANSWERED = "This question was already answered."

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
    repo, _log = services.stores_of_run(owner, run_id)
    run = await repo.get(owner, run_id)
    if run is None:
        _not_found()
    return run


async def _run_json(services: RunServices, owner: RunOwner, run: RunRecord) -> dict[str, object]:
    """The contract `Run`. `lastSeq` comes with the record when the
    repository read it with the row (Postgres: no query per row, survey
    bug 9); otherwise the event log answers."""
    last_seq = run.last_seq
    if last_seq is None:
        _repo, log = services.stores_of_run(owner, run.id)
        last_seq = await log.last_seq(run.id)
    return run_to_contract(run, last_seq=last_seq)


def _event_stream(
    services: RunServices, owner: RunOwner, run: RunRecord, after: RunCursor | None
) -> AsyncIterator[str]:
    repo, log = services.stores_of_run(owner, run.id)

    async def load_run() -> RunRecord | None:
        return await repo.get(owner, run.id)

    return services.stream(
        run_id=run.id,
        after=after,
        log=log,
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
    # Q42: a background run refuses local MCP, as the Next task route
    # does — the worker has no way to use browser-held credentials. Before
    # anything is created. (Credentials would never reach it anyway:
    # `background_checkpoint` reads only `messages` + `forwardedProps`.)
    if mode == "background" and (fp.localMcpServers or split_state(body.state)[1]):
        _raise(400, "invalid_request", LOCAL_MCP_BACKGROUND_REFUSAL)
    # Q49: nor attachments — the Next task routes take none, so a
    # background run refuses them rather than silently dropping them.
    if mode == "background" and fp.attachments:
        _raise(400, "invalid_request", "Background runs do not take attachments.")
    # Q136: an ephemeral run (Explain) lives in memory, so it is
    # interactive and never a resume (it has no tools to pause on).
    ephemeral = fp.ephemeral is True
    if ephemeral and mode == "background":
        _raise(400, "invalid_request", "An ephemeral run is interactive only.")
    if ephemeral and (fp.previousRunId is not None or body.resume):
        _raise(400, "invalid_request", "An ephemeral run cannot resume another run.")
    # Q93: `runCode` mounts a background run's cloud files by id only.
    if mode == "background" and any(f.dataBase64 is not None for f in fp.sandboxFiles or ()):
        _raise(
            400,
            "invalid_request",
            "Background runs mount cloud files only: send sandboxFiles by fileId, without dataBase64.",
        )

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
    # Before anything is created: an unknown model is
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
        existing = await services.stores_for(owner, ephemeral=ephemeral)[0].get(owner, body.runId)
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
    repo, log = services.stores_for(owner, ephemeral=ephemeral)

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
        previous: RunRecord | None = None
        if resume:
            previous_run_id = str(fp.previousRunId)
            previous = await repo.get(owner, previous_run_id)
            try:
                check_resume(previous, body)
            except ResumeMismatch as exc:
                _raise(409, "invalid_state", str(exc))
            except ResumeInvalid as exc:
                _raise(400, "invalid_request", str(exc))
        if mode == "background":
            model = fp.model or settings.AGENT_DEFAULT_MODEL
            messages = [m.model_dump(mode="json") for m in body.messages]
            if previous is not None:
                # Q41: the new run starts from the paused run's checkpoint
                # plus the answers; the paused run stays `interrupted`.
                checkpoint, max_steps = await _background_resume(
                    services, owner, previous, body, fp.maxSteps
                )
            else:
                max_steps = background_max_steps(fp)
                checkpoint = background_checkpoint(body, model=model, max_steps=max_steps)
            spec = RunSpec(
                run_id=body.runId,
                thread_id=body.threadId,
                mode="background",
                goal=(fp.goal or (previous.goal if previous else None) or last_user_text(messages))[
                    :2000
                ],
                previous_run_id=previous_run_id,
                max_steps=max_steps,
                checkpoint=checkpoint,
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
        except PreviousRunAlreadyAnswered:
            _raise(409, "run_already_answered", _RUN_ALREADY_ANSWERED)
        except PreviousRunAnswerApplied:
            _raise(409, "run_answer_applied", _RUN_ANSWER_APPLIED)
        except PreviousRunNotWaiting:
            _raise(409, "invalid_state", _RUN_NOT_WAITING)
        except RunWriteError as exc:
            # A refused enqueue: the create rolled back with it.
            _raise(exc.status, exc.code, exc.message)
        except MemoryStoreFull:
            _raise(503, "unavailable", "Too many runs in progress on this server. Retry shortly.")
        except ValueError as exc:
            _raise(400, "invalid_request", str(exc))
        run, created = result.run, result.created

    headers = {"Location": _location(run.id)}
    if mode == "background":
        if not created and run.internal_status == "queued":
            await _queue_background(services, owner, run)
        return JSONResponse(
            {"runId": run.id, "status": run.status}, status_code=202, headers=headers
        )

    if created:
        if anonymous:
            services.memory_repo.tag_client(run.id, client_key)
        if ephemeral:
            services.memory_repo.mark_unlisted(run.id)
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


async def _background_resume(
    services: RunServices,
    owner: RunOwner,
    previous: RunRecord,
    body: models.StartRunRequest,
    max_steps: int | None,
) -> tuple[dict[str, object], int]:
    """A background resume's checkpoint and step budget (Q41): the paused
    run's saved checkpoint plus the answers (`resume_checkpoint`); the
    budget is `maxSteps`, else the paused run's. `check_resume` let only
    a top-level background run through. Its saved model must be one the
    worker can run: `400 unknown_model` before anything is created (Q55)."""
    saved = await services.repo_for(owner).load_checkpoint(owner, previous.id)
    try:
        checkpoint = resume_checkpoint(saved, body, previous_run_id=previous.id)
    except ResumeMismatch as exc:
        _raise(409, "invalid_state", str(exc))
    cfg = checkpoint.get("config")
    model = cfg.get("model") if isinstance(cfg, dict) else None
    try:
        resolve_api_model_id(model if isinstance(model, str) else "")
    except UnknownModelError as exc:
        raise HTTPException(status_code=400, detail=exc.to_detail()) from exc
    if max_steps is not None:
        return checkpoint, max_steps
    raw = cfg.get("maxSteps") if isinstance(cfg, dict) else None
    if isinstance(raw, int) and not isinstance(raw, bool) and 1 <= raw <= 50:
        return checkpoint, raw
    return checkpoint, previous.max_steps or DEFAULT_BACKGROUND_MAX_STEPS


async def _queue_background(services: RunServices, owner: RunOwner, run: RunRecord) -> None:
    """An idempotent retry of a still-queued run re-does what creating it
    did (`PgRunRepository.create`: the `status: queued` entry as seq 1
    and the `start` job) — both idempotent: the entry by seq, the job by
    `enqueue_task_job` refusing a second `start` with 55000 — so a run
    created before that was one transaction is not left stranded."""
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
    top_level: Annotated[bool | None, Query(alias="topLevel")] = None,
    current: Annotated[bool | None, Query()] = None,
    root_run_id: Annotated[uuid.UUID | None, Query(alias="rootRunId")] = None,
    delivered: Annotated[bool | None, Query()] = None,
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
        top_level=top_level,
        current=current,
        root_run_id=None if root_run_id is None else str(root_run_id),
        delivered=delivered,
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
    repo, _log = services.stores_of_run(owner, run_id)
    run = await repo.cancel(owner, run_id)
    if run is None:
        _not_found()
    if run.internal_status == "cancelled":
        # This process: stop it now. Elsewhere: its heartbeat finds out.
        services.driver.signal_cancel(run.id)
    return JSONResponse(await _run_json(services, owner, run))


# --- POST /v1/runs/{runId}/answers (0.5.0) ----------------------------------------


@router.post(
    "/v1/runs/{run_id}/answers",
    status_code=202,
    responses={202: {"model": models.Run}},
    response_class=JSONResponse,
)
async def answer_run(
    run_id: str,
    body: models.AnswerRunRequest,
    claims: Annotated[dict[str, object], Depends(get_current_user)],
    services: Annotated[RunServices, Depends(get_run_services)],
) -> JSONResponse:
    """`answerRun` — a sub-agent run's question answered in place (Q59,
    RUN_EVENTS.md § 4.4): the answer is queued as the run's `respond` job
    (`RunRepository.answer_in_place`) and the run comes back still
    `interrupted`, `answerPending: true`, until a worker picks it up."""
    owner = RunOwner.user(str(claims["sub"]))
    if not _is_uuid(run_id):
        _not_found()
    entries = [e.model_dump(mode="json", exclude_none=True) for e in body.resume]
    try:
        run = await services.repo_for(owner).answer_in_place(owner, run_id, entries)
    except AnswerInvalid as exc:
        _raise(400, "invalid_request", str(exc))
    except RunNotAnswerable as exc:
        _raise(409, "invalid_state", str(exc))
    except QuestionAlreadyAnswered:
        _raise(409, "run_already_answered", _QUESTION_ALREADY_ANSWERED)
    except RunWriteError as exc:
        _raise(exc.status, exc.code, exc.message)
    if run is None:
        _not_found()
    return JSONResponse(await _run_json(services, owner, run), status_code=202)


# --- POST /v1/runs/{runId}/delivered (0.5.0) --------------------------------------


@router.post(
    "/v1/runs/{run_id}/delivered",
    responses={200: {"model": models.Run}},
    response_class=JSONResponse,
)
async def mark_run_delivered(
    run_id: str,
    claims: Annotated[dict[str, object], Depends(get_current_user)],
    services: Annotated[RunServices, Depends(get_run_services)],
) -> JSONResponse:
    """`markRunDelivered` — a finished task's result was written into its
    conversation (Q70, Q77): `RunRepository.mark_delivered` on the task's
    root, idempotent."""
    owner = RunOwner.user(str(claims["sub"]))
    if not _is_uuid(run_id):
        _not_found()
    try:
        run = await services.repo_for(owner).mark_delivered(owner, run_id)
    except RunNotDeliverable as exc:
        _raise(409, "invalid_state", str(exc))
    if run is None:
        _not_found()
    return JSONResponse(await _run_json(services, owner, run))

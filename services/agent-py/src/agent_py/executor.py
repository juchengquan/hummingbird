"""Executor — wires claim → run_agent_loop → settle.

Phase 2a-2b of PLAN-agent-api. The poller hands a claimed `start` job
here; this module:

  1. Stamps `tasks.metadata.handler = 'python'` for postmortem audit.
  2. Loads the run's checkpoint (model / system / messages) and
     builds the step fn — Anthropic streaming.
  3. Builds a `RunEmitter` whose sink persists into `task_events`.
  4. Calls `run_agent_loop` with the step fn.
  5. Updates the `tasks` row to terminal status when the loop settles.

Phase 2a shipped the executor pattern with a stub step fn that emits
two canned tokens. Phase 2b-1 (this PR) wires `make_anthropic_step_fn`
in as the default — text-only streaming, no tools yet. Tools land in Phase 2b-2; HITL pause /
resume land in Phase 3.

Wave 5c: start, continue, respond and a runs resume share one loop
(`_drive`) over one rule per tool turn (`tool_turn`): every call gets
exactly one result. The stub is gone as a fallback (Q55): no key, no
model or no messages fails the task; only `WORKER_STUB_MODEL` runs it.
Every write that ends a chunk is one transaction that refuses an ended
run, with the entries announcing it (terminal is final).

The seam is `make_step_fn` — a `Callable[[StartActionPayload, dict],
RunStepFn]` so tests can swap a fake without touching the live
Anthropic SDK or the checkpoint loader.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import dataclasses
import json
import os
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, cast
from urllib.parse import unquote_to_bytes

import asyncpg
import structlog

from . import (
    events,
    jobs,
    lease,
    resume_answers,
    store,
    tool_ledger,
    tool_turn,
    verify,
    verify_client,
)
from .aggregate import aggregate_child_results
from .barrier import settle_task_terminal
from .code_sandbox.mount_files import MountManifestEntry
from .emitter import EventSink, RunEmitter, _now_iso
from .events import (
    ApprovalEvent,
    ResultEvent,
    RunStatus,
    StatusEvent,
    StepEndEvent,
    TaskEvent,
    TokenEvent,
    ToolOutputEvent,
    is_terminal_status,
)
from .input_policy import (
    ALWAYS_GATED_TOOL_NAMES,
    request_kind_for,
)
from .mcp_tools import extend_registry_with_mcp
from .model_allowlist import UnknownModelError, resolve_api_model_id
from .providers.anthropic_provider import (
    AnthropicStepConfig,
    AsyncAnthropicClient,
    execute_tool_call,
    make_anthropic_step_fn,
)
from .reasoning_effort import parse_reasoning_effort, thinking_params
from .runner import (
    AgentLoopResult,
    FinalImagesFn,
    FinalizeFn,
    FinalTextFn,
    PendingInputDescriptor,
    RunStepContext,
    RunStepFn,
    RunStepOutcome,
    SpawnSpec,
    run_agent_loop,
)
from .runs.harness_hooks import SKILL_TOOLS
from .runs.history import IMAGE_MEDIA_TYPES
from .runs.model import Interrupted, PendingInterrupt, outcome_to_json
from .settings import get_settings
from .task_prompt import RESEARCH_MODE, build_research_system_prompt
from .tool_turn import ToolCall
from .tools import ToolContext, default_tool_registry
from .tools.registry import SkillConfigs, ToolDescriptor
from .tools.spawn_subagent import (
    MAX_CHILDREN,
    MAX_TASK_CHILDREN,
    SPAWN_ARGS_ERROR,
    SPAWN_SUBAGENT_TOOL_NAME,
    parse_spawn_specs,
    task_child_cap_error,
)

logger = structlog.get_logger(__name__)


# Step-fn factory signature: the executor loads the run's checkpoint
# (model + system + messages from `tasks.checkpoint`) and hands both
# the payload and the loaded checkpoint to the factory. Tests pass a
# fake that ignores the args and returns a canned `RunStepFn`.
MakeStepFn = Callable[
    [
        "StartActionPayload",
        dict[str, Any],
        list[dict[str, Any]],
        "ToolContext | None",
    ],
    RunStepFn,
]


@dataclass(frozen=True)
class StartActionPayload:
    """Minimum the executor needs to run a `start` action. The real
    run state — model, system prompt, message history, max_steps —
    lives on `tasks.checkpoint` and is read by the executor before
    building the step fn (Phase 2b)."""

    run_id: str
    user_id: str
    # Fallback max_steps when the checkpoint doesn't carry one. The
    # TS route always writes `maxSteps` so the fallback effectively
    # only fires in tests / dev seeds.
    max_steps: int = 25


@dataclass(frozen=True)
class ExecutorOutcome:
    """Result of executing one `start` action. Used by the poller to
    decide whether to `mark_job_done` or `mark_job_failed`."""

    settled: bool
    error: str | None = None


async def execute_start(
    pool: asyncpg.Pool,
    payload: StartActionPayload,
    *,
    make_step_fn: MakeStepFn | None = None,
    reclaimed: bool = False,
) -> ExecutorOutcome:
    """Run a `start` action end-to-end. See `_run_chunk` for the
    settle / cancel / yield contract — `start` is just the chunk-run
    path with `start_seq=0` / `start_step=0` (the runner auto-emits
    `status: running` at step==0).

    `reclaimed=True` re-runs a `start` whose previous worker died
    mid-run. The event log already holds that attempt's partial output,
    so a blind re-run would append a second copy after it. Instead:
      - the attempt saved a checkpoint past the initial one (`step > 0`:
        it got as far as a chunk yield but died before enqueueing the
        `continue`) → resume from it, like a reclaimed `continue`;
      - otherwise → start over from the initial checkpoint.
    Either way the run first emits a resume marker (`status: running`
    with `resumedFromSeq` = the checkpoint's seq) so consumers drop the
    dead attempt's events written past that checkpoint."""
    return await _run_chunk(
        pool,
        payload=payload,
        make_step_fn=make_step_fn,
        resume=False,
        reclaimed=reclaimed,
    )


@dataclass(frozen=True)
class RespondActionPayload:
    """User's answer to a HITL pending input. Mirrors the TS shape
    written by `POST /api/tasks/:id/respond` (`requestId`, optional
    `approved` / `selection` / `value` / `uiAnswer`, optional `args`
    edit).

    One of `approved` / `selection` / `value` / `ui_answer` is set
    based on the pending input's request kind (approval / choice /
    input / ui-part). All fields besides `request_id` are optional so
    a malformed job payload doesn't crash the executor: a question
    falls back to a "no answer" message, and an approval without a
    boolean `approved` is refused before the claim (never approved).

    `ui_answer` carries the structured answer from the generative-UI
    resolver (commit 3b of PLAN-generative-ui-parts). The back-compat
    `value` / `selection` are populated alongside by the wire shim
    (`respondBodyForUiAnswer` on the client) so the runner can stay
    `ui_answer`-agnostic for the actual tool result text — it just
    reads the formatted text out of `value`."""

    run_id: str
    user_id: str
    request_id: str
    approved: bool | None = None
    selection: list[str] | None = None
    value: str | None = None
    ui_answer: dict[str, Any] | None = None
    args: dict[str, Any] | None = None
    cancelled: bool = False
    """`cancelled: true` (an in-place answer's cancelled resume entry,
    `runs/in_place.py`): a decline — an approval is not approved, any
    other question reads "the user declined to answer" — exactly as a
    cancelled entry of a runs resume."""


async def execute_respond(
    pool: asyncpg.Pool,
    payload: RespondActionPayload,
    *,
    make_step_fn: MakeStepFn | None = None,
    resume_interrupted: bool = False,
) -> ExecutorOutcome:
    """Run a `respond` action — resume a suspended run with the user's
    answer to a HITL approval / choice / input request.

    Loads the checkpoint, finds the pending tool_use block matching
    `request_id`, builds a `tool_result` block from the answer, appends
    it as a user turn, emits an `input_response` event so the client
    clears its pending-input state, then runs a chunk (same yield /
    settle / re-suspend semantics as `continue`).

    Settle / cancel / yield / re-suspend semantics are identical to
    `continue` after the result message is appended.

    `resume_interrupted=True` re-runs a respond job reclaimed from a
    worker that died AFTER the atomic paused → running flip. The answer
    lives on the job payload, but the dead attempt may or may not have
    persisted it (the tool_result append + checkpoint save follow the
    flip, and an approved tool executes in between):
      - the checkpoint already carries the tool_result → plain
        `continue` from it (re-applying would run the tool twice);
      - it doesn't → re-apply the answer from the payload, skipping the
        paused gate (the task is already `running` on this job's
        account; `poller.reclaim_decision` checked nothing else drives
        it) — unless the checkpoint's execution record says the dead
        attempt already STARTED the approved tool: then it is not run
        again and the model is told its outcome is unknown
        (`tool_ledger`).

    Any resume through the checkpoint (here, or `_run_chunk` for a
    reclaimed start / continue) also finishes a tool turn the dead
    attempt was executing, and re-pauses on an approval-gated call
    nobody answered, instead of letting the model step past it."""
    return await _run_respond(pool, payload, make_step_fn, resume_interrupted)


async def execute_continue(
    pool: asyncpg.Pool,
    payload: StartActionPayload,
    *,
    make_step_fn: MakeStepFn | None = None,
    reclaimed: bool = False,
) -> ExecutorOutcome:
    """Run a `continue` action — pick up after a chunk-break yield.

    Same shape as `execute_start` but seeds the emitter at the
    checkpoint's saved `seq` / `step`, so the resumed events follow
    the originals monotonically. The runner skips the
    `status: running` emit since `start` already wrote it on the
    original chunk.

    Settle / cancel / failure semantics are identical to `start`. A
    yielded chunk re-saves the checkpoint with the latest messages +
    step + seq and enqueues yet another `continue` job.

    `reclaimed=True` re-runs a `continue` whose previous worker died
    mid-chunk: whatever that attempt wrote past the checkpoint is still
    in the event log, so the run first emits a resume marker
    (`status: running` with `resumedFromSeq` = the checkpoint's seq)
    telling consumers to drop it. A normal `continue` (chunk boundary)
    emits no marker."""
    return await _run_chunk(
        pool,
        payload=payload,
        make_step_fn=make_step_fn,
        resume=True,
        reclaimed=reclaimed,
    )


class RunSetupError(Exception):
    """The run can't be executed as it is (no key, no model, no messages,
    an input the model can't take): it fails with this message — success
    is never faked (Q55)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class _RunOver(BaseException):
    """The run ended under this worker (cancelled, reconciled, deleted):
    terminal is final, so it stops without another write or side effect.
    A `BaseException`, like `LeaseLostError`, so the tool loop's broad
    handlers can't turn it into a tool error."""


@dataclass
class _RunGuard:
    """Mutable breadcrumbs the `_run_*_inner` bodies leave for their
    outer guard: the emitter once it exists (so a failure event follows
    the run's seq) and whether the run's task row has been taken over
    by this job (so an escaped error settles it failed instead of
    stranding it). `claiming`: the paused → running claim was sent and
    its answer never came back."""

    emitter: RunEmitter | None = None
    owns_task: bool = True
    claiming: bool = False


async def _run_chunk(
    pool: asyncpg.Pool,
    *,
    payload: StartActionPayload,
    make_step_fn: MakeStepFn | None,
    resume: bool,
    reclaimed: bool = False,
) -> ExecutorOutcome:
    """Outer guard for `_run_chunk_inner`: anything raised — checkpoint
    load, seq probe, fan-in child-result load, setup, the loop — settles
    the run failed with a terminal event instead of leaving the task
    `running` behind a failed job. A run that ended under the worker
    (`_RunOver`) is a clean stop. `CancelledError` is deliberately not
    caught: the poller hands a cancelled job back to the queue and the
    task stays live."""
    guard = _RunGuard()
    try:
        return await _run_chunk_inner(
            pool,
            payload=payload,
            make_step_fn=make_step_fn,
            resume=resume,
            reclaimed=reclaimed,
            guard=guard,
        )
    except _RunOver:
        await _stop_ended_run(pool, payload.run_id, payload.user_id, guard.emitter)
        return ExecutorOutcome(settled=True)
    except Exception as exc:
        logger.error(
            "executor.failed",
            run_id=payload.run_id,
            user_id=payload.user_id,
            error=str(exc),
        )
        await _fail_run(
            pool,
            run_id=payload.run_id,
            user_id=payload.user_id,
            emitter=guard.emitter,
            error=str(exc),
            error_code=_error_code(exc),
        )
        return ExecutorOutcome(settled=False, error=str(exc))


def _error_code(exc: BaseException) -> str | None:
    if isinstance(exc, RunSetupError | UnknownModelError):
        return exc.code
    return None


async def _stop_ended_run(
    pool: asyncpg.Pool, run_id: str, user_id: str, emitter: RunEmitter | None
) -> None:
    """The run ended under this worker. A cancel gets its `status:
    cancelled` entry (the cancel itself writes none); nothing else is
    written."""
    if emitter is None:
        return
    try:
        if await store.load_owned_task_status(pool, task_id=run_id, user_id=user_id) != "cancelled":
            return
        await store.append_event(
            pool,
            StatusEvent(
                run_id=run_id,
                seq=emitter.seq + 1,
                step=emitter.step,
                created_at=_now_iso(),
                status="cancelled",
            ),
            user_id=user_id,
        )
    except Exception as exc:
        logger.warning("executor.cancelled_event_failed", run_id=run_id, error=str(exc))


async def _fail_run(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
    emitter: RunEmitter | None,
    error: str,
    error_code: str | None = None,
) -> None:
    """Best-effort: settle the task failed, with its `result: failed` in
    the same transaction — so a run that already ended (a cancel won)
    gets neither. With no emitter yet the event is seeded past the run's
    highest seq so it can't collide with (and be dropped as) an existing
    one. A worker whose job lease is gone settles nothing
    (`LeaseLostError` propagates)."""
    lease.check_current()
    seq = step = 0
    if emitter is not None:
        seq, step = emitter.seq, emitter.step
    else:
        try:
            seq = await store.max_event_seq(pool, run_id=run_id, user_id=user_id)
        except Exception as exc:
            logger.warning("executor.fail_seq_failed", run_id=run_id, error=str(exc))
    event = ResultEvent(
        run_id=run_id,
        seq=seq + 1,
        step=step,
        created_at=_now_iso(),
        status="failed",
        error=error,
        error_code=error_code,
    )
    try:
        await settle_task_terminal(
            pool, task_id=run_id, user_id=user_id, status="failed", event=event
        )
    except Exception as exc:
        # The job is still marked failed by the poller; the TS stale-run
        # reconciler fails a task with no live job as a last resort.
        logger.warning("executor.fail_settle_failed", run_id=run_id, error=str(exc))


_SETTLEABLE_STRANDED = ("queued", "running")


async def settle_stranded_task(
    pool: asyncpg.Pool,
    *,
    task_id: str,
    user_id: str,
    job_id: str | None,
    error: str,
) -> bool:
    """Fail a task whose job died for good (reaped after its lease ran
    out on the last attempt, or failed by the poller after an error
    escaped the executor) — but only when nothing else will drive it:

      - the task is still `queued` / `running` (a `paused` run is
        legitimately waiting on the user / its children; a terminal one
        is already settled), and
      - no OTHER job for the task is queued or holds a live lease.

    The terminal `result: failed` goes at the run's next seq in the
    settle's own transaction, so a run that settled concurrently never
    gets a stray second result. Returns True iff the task was settled
    here."""
    state = await jobs.load_job_task_state(pool, task_id=task_id, user_id=user_id, job_id=job_id)
    if state is None or state.task_status not in _SETTLEABLE_STRANDED:
        return False
    if state.has_other_live_job:
        return False
    seq = await store.max_event_seq(pool, run_id=task_id, user_id=user_id)
    event = ResultEvent(
        run_id=task_id,
        seq=seq + 1,
        step=state.step,
        created_at=_now_iso(),
        status="failed",
        error=error,
    )
    settled = await settle_task_terminal(
        pool, task_id=task_id, user_id=user_id, status="failed", event=event
    )
    return settled.transitioned


async def recover_stranded_paused_run(
    pool: asyncpg.Pool,
    *,
    task_id: str,
    user_id: str,
) -> bool:
    """Flip a `paused` run that is waiting on nothing back to `running`
    so a reclaimed `continue` can resume it (`poller.reclaim_decision`
    → `"recover"`). Returns True iff it was flipped.

    Before the fan-in flipped its parent back to `running`, a parent
    resumed from its subagents kept running while still `paused`; its
    first yield saved a checkpoint without `awaiting_children`, so a
    worker death in a later chunk left it paused with nothing to resume
    it. It is recoverable only when the checkpoint confirms it is not
    waiting on anyone: no `awaiting_children` (the barrier owns that)
    and no unanswered tool call in the last turn (a pending approval /
    question — only a `respond` may resume that)."""
    checkpoint = await store.load_checkpoint(pool, run_id=task_id, user_id=user_id)
    if checkpoint is None or isinstance(checkpoint.get("awaiting_children"), dict):
        return False
    messages = _messages_from(checkpoint)
    tool_turn.take_partial_results(messages)
    if tool_turn.open_turn(messages):
        return False
    lease.check_current()
    return await store.claim_paused_for_fan_in(pool, run_id=task_id, user_id=user_id)


@dataclass(frozen=True)
class _RunTools:
    """The per-run tool set, built identically for every action so an
    approved tool on the respond path resolves against the same
    registry the model saw when it called it."""

    context: ToolContext | None
    extra_tools: dict[str, ToolDescriptor]
    mcp_gated: set[str]
    skill_tool_names: frozenset[str] = frozenset()
    """The skill tools the run chose (`config.skills`, see `_skills_from`)."""
    skill_configs: SkillConfigs | None = None
    sandbox_files: tuple[MountManifestEntry, ...] = ()
    """The cloud files `runCode` may mount (`config.sandboxFiles`, Q93)."""

    def registry(self) -> dict[str, ToolDescriptor]:
        out = {
            name: d
            for name, d in default_tool_registry(
                context=self.context,
                skill_configs=self.skill_configs,
                sandbox_files=self.sandbox_files,
            ).items()
            if name not in _ALL_SKILL_TOOL_NAMES or name in self.skill_tool_names
        }
        out.update(self.extra_tools)
        return out


_ALL_SKILL_TOOL_NAMES: frozenset[str] = frozenset(SKILL_TOOLS.values())
"""Registry tools a run offers only when it chose their skill; every
other built-in (`askUser`, `renderUI`, `spawnSubagent`) is always on."""


def _skills_from(checkpoint: dict[str, Any]) -> tuple[frozenset[str], SkillConfigs]:
    """`config.skills` → (the skill tools the run offers, their per-skill
    settings). As Next's task worker did: only the chosen skills
    (`[{id, webSearchConfig?, …}]`, the chat body's `skills`) — absent or
    malformed means none. Unknown ids are ignored."""
    cfg = checkpoint.get("config")
    raw = cfg.get("skills") if isinstance(cfg, dict) else None
    names: set[str] = set()
    configs: dict[str, dict[str, Any]] = {}
    for entry in raw if isinstance(raw, list) else []:
        if not isinstance(entry, dict):
            continue
        tool = SKILL_TOOLS.get(str(entry.get("id")))
        if tool is not None:
            names.add(tool)
        for key in ("webSearchConfig", "webFetchConfig", "imageGenConfig"):
            value = entry.get(key)
            if isinstance(value, dict) and value:
                configs[key] = value
    return frozenset(names), SkillConfigs(
        web_search=configs.get("webSearchConfig"),
        web_fetch=configs.get("webFetchConfig"),
        image_gen=configs.get("imageGenConfig"),
    )


def _sandbox_files_from(checkpoint: dict[str, Any]) -> tuple[MountManifestEntry, ...]:
    """`config.sandboxFiles` → the cloud files `runCode` may mount, by id
    only (Q93: a background run never mounts inline data, whatever the
    checkpoint holds)."""
    cfg = checkpoint.get("config")
    raw = cfg.get("sandboxFiles") if isinstance(cfg, dict) else None
    out: list[MountManifestEntry] = []
    for entry in raw if isinstance(raw, list) else []:
        if not isinstance(entry, dict) or "dataBase64" in entry:
            continue
        name, file_id = entry.get("name"), entry.get("fileId")
        if isinstance(name, str) and name and isinstance(file_id, str) and file_id:
            out.append(MountManifestEntry(name=name, file_id=file_id))
    return tuple(out[:10])


def _allowed_mcp_server_ids_from(checkpoint: dict[str, Any]) -> tuple[str, ...] | None:
    """`config.allowedMcpServerIds` (Q48): None (absent) → every enabled
    cloud server of the workspace; a list → only those (`[]` → none)."""
    cfg = checkpoint.get("config")
    raw = cfg.get("allowedMcpServerIds") if isinstance(cfg, dict) else None
    if not isinstance(raw, list):
        return None
    return tuple(dict.fromkeys(s for s in raw if isinstance(s, str) and s))


async def _build_run_tools(
    pool: asyncpg.Pool,
    *,
    user_id: str,
    checkpoint: dict[str, Any],
    discover_mcp: bool,
) -> _RunTools:
    """Phase 3f-2: pull `workspaceId` off the checkpoint config so
    `ToolContext` carries it (workspace-scoped tools such as
    `searchFiles`) and cloud-mode MCP discovery (`extend_registry_with_mcp`)
    knows which workspace to enumerate. Absent → `workspace_id` stays
    None and MCP tools are skipped entirely. The TS checkpoint always
    writes `workspaceId`; a missing field is the test/dev path.

    The skill tools are the ones `config.skills` chose (`_skills_from`),
    and the cloud MCP servers those `config.allowedMcpServerIds` allows
    (Q48, `_allowed_mcp_server_ids_from`)."""
    cfg = checkpoint.get("config")
    workspace_id = _str_or_none(cfg.get("workspaceId")) if isinstance(cfg, dict) else None
    context = ToolContext(
        pool=pool,
        user_id=user_id,
        workspace_id=workspace_id,
        local_files_only=isinstance(cfg, dict) and cfg.get("localFilesOnly") is True,
    )
    skill_tool_names, skill_configs = _skills_from(checkpoint)
    extra_tools: dict[str, ToolDescriptor] = {}
    mcp_gated: set[str] = set()
    if discover_mcp and workspace_id:
        await extend_registry_with_mcp(
            extra_tools,
            pool=pool,
            user_id=user_id,
            workspace_id=workspace_id,
            gated_out=mcp_gated,
            allowed_server_ids=_allowed_mcp_server_ids_from(checkpoint),
        )
    return _RunTools(
        context=context,
        extra_tools=extra_tools,
        mcp_gated=mcp_gated,
        skill_tool_names=skill_tool_names,
        skill_configs=skill_configs,
        sandbox_files=_sandbox_files_from(checkpoint),
    )


class _RunSink:
    """Where a run's events go. Progress is appended as it is emitted.
    The entries that end a chunk commit with the row instead, so a chunk
    that loses to a cancel announces nothing: the terminal one is kept in
    `terminal` for the settle, a pause's and a spawn's are collected by
    `holding()` for their commit.

    Also taps what the citation finalize hook needs: the assembled report
    text + web-search sources, in the cumulative order the model cites by
    (`[1]`, `[2]`, …). Per chunk, so only complete when the run settles in
    its first chunk; a later one re-reads the log."""

    def __init__(self, pool: asyncpg.Pool, *, user_id: str) -> None:
        self._pool = pool
        self._user_id = user_id
        self._db = _make_db_sink(pool, user_id=user_id)
        self._held: list[TaskEvent] | None = None
        self.terminal: TaskEvent | None = None
        self.text: list[str] = []
        self.sources: list[tuple[str, str, str]] = []

    @contextmanager
    def holding(self) -> Iterator[list[TaskEvent]]:
        self._held = []
        try:
            yield self._held
        finally:
            self._held = None

    async def __call__(self, event: TaskEvent) -> None:
        # No event may be written once this worker's job lease is gone.
        lease.check_current()
        if isinstance(event, TokenEvent) and event.channel == "text":
            self.text.append(event.text)
        elif isinstance(event, ToolOutputEvent) and event.results:
            self.sources.extend((r.title, r.url, r.snippet) for r in event.results)
        if isinstance(event, ResultEvent) or (
            isinstance(event, StatusEvent) and event.status == "cancelled"
        ):
            self.terminal = event
        elif self._held is not None:
            self._held.append(event)
        else:
            await self._db(event)
            await _record_progress(self._pool, event, user_id=self._user_id)


class _Run:
    """One job's execution of a run — what start, continue, respond and a
    runs resume share once their own opening is done."""

    def __init__(
        self,
        pool: asyncpg.Pool,
        *,
        payload: StartActionPayload,
        checkpoint: dict[str, Any],
        messages: list[dict[str, Any]],
        emitter: RunEmitter,
        sink: _RunSink,
        tools: _RunTools,
        resume: bool,
        resumed_from_seq: int | None,
    ) -> None:
        self.pool = pool
        self.payload = payload
        self.checkpoint = checkpoint
        self.messages = messages
        self.emitter = emitter
        self.sink = sink
        self.tools = tools
        self.resume = resume
        self.resumed_from_seq = resumed_from_seq
        self.max_steps: int | None = None
        """The run's step limit, once `_drive` read it."""
        self.gated = frozenset(_gated_tools_from(checkpoint) | tools.mcp_gated)
        self.registry = tools.registry()
        # Execution record for the tool turn (see `tool_ledger`): each save
        # is a checkpoint at the run's current position plus the record, so
        # a reclaim resumes mid-turn instead of re-asking the model (which
        # could re-issue — and re-run — the same call).
        self.ledger = tool_ledger.ToolLedger(save=self._save_record, gated_tool_names=self.gated)

    async def _save_record(self, _record: dict[str, Any]) -> None:
        await self.save()

    def build_checkpoint(self) -> dict[str, object]:
        out = _build_checkpoint(self.checkpoint, self.messages, self.emitter)
        if not self.ledger.empty:
            out[tool_ledger.INFLIGHT_KEY] = self.ledger.payload()
        return out

    async def save(self) -> None:
        lease.check_current()
        saved = await store.save_checkpoint(
            self.pool,
            run_id=self.payload.run_id,
            user_id=self.payload.user_id,
            checkpoint=self.build_checkpoint(),
        )
        if saved is False:
            raise _RunOver

    async def open_marker(self) -> None:
        """A reclaimed run's resume marker, before anything else it emits."""
        if self.resumed_from_seq is None:
            return
        await self.emitter.status(
            "running", resumed_from_seq=self.resumed_from_seq, restarted=self.emitter.step == 0
        )
        self.resumed_from_seq = None

    async def close_step(self) -> None:
        if self.ledger.step_open:
            await self.emitter.end_step()
            self.ledger.step_open = False


async def _run_chunk_inner(
    pool: asyncpg.Pool,
    *,
    payload: StartActionPayload,
    make_step_fn: MakeStepFn | None,
    resume: bool,
    guard: _RunGuard,
    reclaimed: bool = False,
) -> ExecutorOutcome:
    """Shared body for `execute_start` + `execute_continue`.

    The contract the poller depends on:
      - On settle (`done`) → returns `ExecutorOutcome(settled=True)`.
        The `tasks` row is `status='done'`, `finished_at` set.
      - The run ended under the worker (cancel) → same outcome (the
        cancel landed cleanly, no need to mark the job failed), nothing
        written over it.
      - On yield (time budget exhausted) → returns
        `ExecutorOutcome(settled=True)` too, BUT the `tasks` row is
        left `running`; the executor has already saved the
        checkpoint and enqueued a `continue` job that picks up.
      - On setup / model / tool / DB error → raises; `_run_chunk` settles
        the run failed and the poller marks the job failed.

    `resume=True` seeds the emitter at the checkpoint's saved
    `seq` / `step` so a re-tail picks up monotonically. `resume=False`
    seeds at zero, and the runner auto-emits `status: running`."""
    checkpoint = await store.load_checkpoint(
        pool,
        run_id=payload.run_id,
        user_id=payload.user_id,
    )
    if checkpoint is None:
        logger.warning(
            "executor.no_checkpoint",
            run_id=payload.run_id,
            user_id=payload.user_id,
            resume=resume,
        )
        checkpoint = {}

    # Reclaimed run (see `execute_start` / `execute_continue`): a
    # `start` resumes from a checkpoint the dead attempt saved, else
    # restarts from the initial one; either way the run opens with a
    # resume marker covering the dead attempt's post-checkpoint events.
    resumed_from_seq: int | None = None
    if reclaimed:
        if not resume:
            resume = _int_or(checkpoint.get("step"), 0) > 0
        resumed_from_seq = _int_or(checkpoint.get("seq"), 0)
        if resume and isinstance(checkpoint.get("awaiting_children"), dict):
            # A fan-in that died before its claim moved the checkpoint past
            # the sub-agents' exit entries (0049): they are not the dead
            # attempt's, so the marker must not rewind them.
            try:
                resumed_from_seq = max(
                    resumed_from_seq,
                    await store.max_exit_handoff_seq(
                        pool, run_id=payload.run_id, user_id=payload.user_id
                    ),
                )
            except Exception:
                lease.abandon_current("exit_seq_probe_failed_on_reclaim")
                raise
        logger.warning(
            "executor.reclaimed_run",
            run_id=payload.run_id,
            mode="resume_checkpoint" if resume else "restart",
            checkpoint_step=_int_or(checkpoint.get("step"), 0),
            resumed_from_seq=resumed_from_seq,
        )

    # Seed past every seq already written for this run — the TS route's
    # `status: queued` (seq=1) on a fresh start, and anything emitted
    # after the last checkpoint save on a resume. `append_event` is
    # `ON CONFLICT DO NOTHING`, so a reused seq silently drops an event.
    start_seq = await _seed_seq(
        pool,
        run_id=payload.run_id,
        user_id=payload.user_id,
        checkpoint=checkpoint,
        # A fan-in's log holds its sub-agents' `handoff` `exit` entries past
        # the checkpoint (0049): the checkpoint's seq would collide with them.
        reclaimed=reclaimed or (resume and isinstance(checkpoint.get("awaiting_children"), dict)),
    )
    sink = _RunSink(pool, user_id=payload.user_id)
    emitter = RunEmitter(
        run_id=payload.run_id,
        sink=sink,
        start_seq=start_seq,
        start_step=_int_or(checkpoint.get("step"), 0) if resume else 0,
    )
    guard.emitter = emitter

    awaiting = checkpoint.get("awaiting_children") if resume else None
    lease.check_current()
    status = await store.start_running(pool, run_id=payload.run_id, user_id=payload.user_id)
    if status is None or is_terminal_status(cast("RunStatus", status)):
        raise _RunOver
    if status == "paused" and not isinstance(awaiting, dict):
        # Waiting on the user: only their answer resumes it.
        logger.warning("executor.paused_on_question", run_id=payload.run_id)
        return ExecutorOutcome(settled=True)

    # Track the mutable message history the step fn appends to —
    # `_default_make_step_fn` builds it from the checkpoint and hands
    # the SAME list to `AnthropicStepConfig.messages`, which the step
    # mutates in place when tools are called. On yield we need to read
    # the current state to persist; the closure captures it here so we
    # don't have to plumb a getter through the step-fn factory.
    messages = _messages_from(checkpoint)
    answers = None if resume else resume_answers.parse_resume(checkpoint)
    # A resumed checkpoint can end in an assistant turn whose calls wait
    # for results (a pause, a spawn, a turn a dead attempt was executing);
    # so does a runs-API resume's, the paused run's.
    in_turn = resume or answers is not None
    partial = tool_turn.take_partial_results(messages) if in_turn else []

    # Fan-in resume: when the checkpoint carries `awaiting_children`
    # (written with the spawn), this is the parent's `continue` job fired
    # by the barrier after all children settled. Load + aggregate that
    # round's results as the spawn call's `tool_result`, and drop the
    # marker so it doesn't re-trigger on a later chunk.
    fan_in: dict[str, Any] | None = None
    if isinstance(awaiting, dict):
        # The parent is `paused` on its children: flip it back to
        # `running` (only once they all settled) BEFORE resuming. Left
        # `paused` while it runs, a worker death in any later chunk
        # would be reclaimed as "waiting on the user / children" and
        # skipped — stranding the task `paused` forever, since the
        # checkpoint below no longer carries `awaiting_children`.
        lease.check_current()
        if not await store.claim_paused_for_fan_in(
            pool, run_id=payload.run_id, user_id=payload.user_id
        ):
            status = await store.load_owned_task_status(
                pool, task_id=payload.run_id, user_id=payload.user_id
            )
            if status != "running":
                # Children still pending (a stray `continue`), or the
                # run settled / was cancelled meanwhile: nothing to do.
                # `running` means a dead attempt already flipped it.
                logger.warning(
                    "executor.fan_in_not_ready",
                    run_id=payload.run_id,
                    task_status=status,
                )
                return ExecutorOutcome(settled=True)
        named = awaiting.get("children")
        child_results = await store.load_child_results(
            pool,
            parent_task_id=payload.run_id,
            user_id=payload.user_id,
            children=[c for c in named if isinstance(c, dict)] if isinstance(named, list) else None,
        )
        fan_in = {
            "type": "tool_result",
            "tool_use_id": str(awaiting.get("tool_call_id") or ""),
            "content": aggregate_child_results(child_results),
        }
        checkpoint = {k: v for k, v in checkpoint.items() if k != "awaiting_children"}

    await _stamp_handler(pool, run_id=payload.run_id, user_id=payload.user_id)

    # Custom `make_step_fn` overrides (tests) skip MCP discovery —
    # they don't go through `_default_make_step_fn`, so injecting
    # extra tools wouldn't reach them anyway.
    tools = await _build_run_tools(
        pool,
        user_id=payload.user_id,
        checkpoint=checkpoint,
        discover_mcp=make_step_fn is None,
    )
    # Before any effect: a run that can't call its model fails here, so a
    # resume that fails this way never applied its answers (Q57).
    if make_step_fn is None:
        step_fn = _default_make_step_fn(
            payload, checkpoint, messages, tools.context, run_tools=tools
        )
    else:
        step_fn = make_step_fn(payload, checkpoint, messages, tools.context)

    run = _Run(
        pool,
        payload=payload,
        checkpoint=checkpoint,
        messages=messages,
        emitter=emitter,
        sink=sink,
        tools=tools,
        resume=resume,
        resumed_from_seq=resumed_from_seq,
    )
    if in_turn:
        run.ledger.reset(tool_ledger.read_record(checkpoint))
        for block in partial:
            run.ledger.answer(block)
    if fan_in is not None:
        calls = tool_turn.open_turn(messages)
        if any(call.id == fan_in["tool_use_id"] for call in calls):
            if not run.ledger.classified:
                # Saved before 5c: the turn's other calls never ran, and
                # none of its other spawns exists.
                run.ledger.ask, run.ledger.spawn = tool_turn.classify(
                    [c for c in calls if c.id not in run.ledger.results], run.gated
                )
            run.ledger.answer(fan_in)
        else:
            messages.append({"role": "user", "content": [fan_in]})

    with tool_ledger.bound(run.ledger):
        deadline_s = _chunk_deadline_s()
        # A runs-API resume (Q41): this run's checkpoint is the paused
        # run's plus the answers (`resume_answers.RESUME_KEY`). Answer the
        # interrupts in a step of their own, then carry on from there. A
        # reclaimed attempt that got past an approved tool's start saved a
        # checkpoint without the answers (`step > 0` → `resume`), so the
        # turn resolution finishes it instead.
        if answers is not None:
            pairs = _resume_calls(run, answers)
            lease.check_current()
            if not await store.mark_answers_applied(
                pool, run_id=payload.run_id, user_id=payload.user_id
            ):
                raise _RunOver
            if run.resumed_from_seq is not None:
                await emitter.status(
                    "running", resumed_from_seq=run.resumed_from_seq, restarted=True
                )
                run.resumed_from_seq = None
            else:
                await emitter.status("running")
            await emitter.start_step()
            run.ledger.step_open = True
            for call, answer in pairs:
                await _apply_answer(run, call, answer)
            await run.close_step()
            checkpoint.pop(resume_answers.RESUME_KEY, None)
            await run.save()

        # A fan-in brings results the model asked for and hasn't seen:
        # a spawn on the last step still gets them used (Q81).
        return await _drive(run, step_fn, deadline_s, resolve=in_turn, grace=fan_in is not None)


async def _drive(
    run: _Run,
    step_fn: RunStepFn,
    deadline_s: float | None,
    *,
    resolve: bool,
    grace: bool = False,
) -> ExecutorOutcome:
    """The loop every action shares: finish the open tool turn (pause on
    its next question, fan out its next spawn, or complete it), call the
    model, and end the chunk one of the five ways (`AgentLoopResult`).

    `grace`: this chunk resumes with results the model waited for — its
    sub-agents' (a fan-in) or the user's answer (a respond). Asked for on
    the run's last step, they would otherwise never be read: the run gets
    one model call past its limit to use them (Q81). A spawn on that extra
    step is refused (`_spawn`), so it never chains."""
    pool, emitter = run.pool, run.emitter
    run_id, user_id = run.payload.run_id, run.payload.user_id
    max_steps = _max_steps_from(run.checkpoint, run.payload.max_steps)
    run.max_steps = max_steps

    async def is_cancelled() -> bool:
        return await store.is_run_cancelled(pool, run_id=run_id, user_id=user_id)

    def should_yield() -> bool:
        return deadline_s is not None and asyncio.get_event_loop().time() > deadline_s

    finalize, final_text, final_images = _settle_hooks(run)

    while True:
        if resolve:
            stop = await _resolve_turn(run)
            if stop is not None:
                if stop.id in run.ledger.ask:
                    # Suspend path (Phase 3b): the call waits for the user.
                    # A `respond` action, or a runs resume, answers it.
                    await _pause(run, stop)
                    return ExecutorOutcome(settled=True)
                # Spawn path (PR-2 fan-out). Refused (depth) → the call got
                # its error result: carry on with the rest of the turn.
                if await _spawn(run, stop):
                    return ExecutorOutcome(settled=True)
                continue

        limit = max(max_steps, emitter.step + 1) if grace else max_steps
        grace = False
        result: AgentLoopResult = await run_agent_loop(
            emitter=emitter,
            max_steps=limit,
            step_limit=max_steps,
            run_step=step_fn,
            is_cancelled=is_cancelled,
            should_yield=should_yield,
            finalize=finalize,
            final_text=final_text,
            final_images=final_images,
            resumed_from_seq=run.resumed_from_seq,
        )
        run.resumed_from_seq = None
        # The loop closes the step it opened.
        run.ledger.step_open = False
        # Every branch below writes run state (checkpoint, task status,
        # follow-up jobs) — none of it may happen without the lease.
        lease.check_current()

        if result.kind == "suspended":
            assert result.pending_input is not None
            pending = result.pending_input
            _ensure_open_call(run, pending.tool_call_id, pending.tool, dict(pending.args or {}))
            run.ledger.ask.add(pending.tool_call_id)
            resolve = True
            continue

        if result.kind == "spawned":
            assert result.spawn is not None
            spec_args = {
                "tasks": [
                    {"personaSlug": t.persona_slug, "subgoal": t.subgoal}
                    for t in result.spawn.tasks
                ]
            }
            call_id = result.spawn.tool_call_id
            _ensure_open_call(run, call_id, SPAWN_SUBAGENT_TOOL_NAME, spec_args)
            run.ledger.spawn[call_id] = spec_args
            resolve = True
            continue

        # Yield path: persist the latest state + enqueue a continue
        # job so another chunk picks up. The task row stays `running`
        # (no terminal event emitted). The poller marks THIS job done
        # because the chunk completed cleanly — there's just more work
        # to do on a later one.
        if result.kind == "yielded":
            if not await store.commit_yield(
                pool, run_id=run_id, user_id=user_id, checkpoint=run.build_checkpoint()
            ):
                raise _RunOver
            logger.info(
                "executor.yielded",
                run_id=run_id,
                step=emitter.step,
                seq=emitter.seq,
            )
            return ExecutorOutcome(settled=True)

        if result.kind == "cancelled":
            raise _RunOver

        # Reflect terminal status into the `tasks` row, with the terminal
        # event, through the join barrier so a child settling wakes its
        # parent. Persist the final step count before the terminal settle
        # (settle_task_terminal does not write `step`).
        await store.update_run(pool, run_id=run_id, user_id=user_id, step=emitter.step)
        settled = await settle_task_terminal(
            pool, task_id=run_id, user_id=user_id, status="done", event=run.sink.terminal
        )
        if not settled.transitioned:
            raise _RunOver
        return ExecutorOutcome(settled=True)


def _settle_hooks(run: _Run) -> tuple[FinalizeFn, FinalTextFn, FinalImagesFn]:
    """The pre-settle hooks: citation verification (research runs only,
    advisory + non-blocking) and the final text.

    Both are over the **whole task** (Q78): the text of every run on the
    task's line (`store.load_task_line` — the root and each resume that
    holds its question, dead branches excluded) before this one, then
    this run's, so the text before a question is not lost; and the
    sources in that same order, so the `[N]` the model cites across the
    runs — it saw every earlier run's tool results — are numbered once
    and verified against the whole text. The result is this run's
    `result.finalText` (`tasks.outcome.result.text`, `Run.result.text`,
    a parent's fan-in).

    A resumed run (`continue`, respond) re-aggregates its own text +
    sources from the full `task_events` log: the per-chunk in-memory
    accumulators only hold THIS chunk's slice. The DB is the source of
    truth for a multi-chunk run; one read of it per settle, shared.

    The images (Q87) are every `tool_image` image of the same runs, then
    their sub-agents' results' — so a parent's answer carries what its
    sub-agents drew."""
    cache: verify.AggregatedInputs | None = None
    line_cache: tuple[list[str], list[list[events.TaskEvent]]] | None = None
    own_cache: list[events.TaskEvent] | None = None

    async def own_events() -> list[events.TaskEvent]:
        """This run's whole log, read once per settle."""
        nonlocal own_cache
        if own_cache is None:
            own_cache = await store.load_run_events(run.pool, run_id=run_id, user_id=user_id)
        return own_cache

    cfg = run.checkpoint.get("config")
    run_mode = _str_or_none(cfg.get("mode")) if isinstance(cfg, dict) else None
    # Answerer provider is "anthropic" for every agent-py run today
    # (the only model family the executor wires). When agent-ts goes
    # live, read this from `cfg.get("provider", "anthropic")` so the
    # cross-family verifier picks a genuinely different family.
    answerer_provider = "anthropic"
    run_id, user_id = run.payload.run_id, run.payload.user_id

    async def own_inputs() -> verify.AggregatedInputs:
        if not run.resume:
            # Fast path: single-chunk run, the in-memory accumulators
            # are complete, so skip the DB round-trip.
            return verify.AggregatedInputs(
                text="".join(run.sink.text),
                sources=[
                    verify.RetrievedSource(id=str(i + 1), title=t, url=u, snippet=sn)
                    for i, (t, u, sn) in enumerate(run.sink.sources)
                ],
            )
        return verify.aggregate_from_events(await own_events())

    async def earlier_runs() -> tuple[list[str], list[list[events.TaskEvent]]]:
        """The runs before this one on the task's line, and their logs."""
        nonlocal line_cache
        if line_cache is None:
            line = await store.load_task_line(run.pool, run_id=run_id, user_id=user_id)
            logs = [
                await store.load_run_events(run.pool, run_id=earlier, user_id=user_id)
                for earlier in line
            ]
            line_cache = (line, logs)
        return line_cache

    async def whole() -> verify.AggregatedInputs:
        nonlocal cache
        if cache is None:
            _, logs = await earlier_runs()
            parts = [verify.aggregate_from_events(log) for log in logs]
            cache = _join_inputs([*parts, await own_inputs()])
        return cache

    async def text_and_sources() -> tuple[str, list[tuple[str, str, str]]]:
        inputs = await whole()
        return inputs.text, [(s.title, s.url or "", s.snippet) for s in inputs.sources]

    async def finalize() -> dict[str, object] | None:
        # Verification is advisory — an event-log read failure skips
        # it rather than failing an otherwise-finished run.
        try:
            text, sources = await text_and_sources()
        except Exception as exc:
            logger.warning("executor.verify_inputs_failed", run_id=run_id, error=str(exc))
            return None
        return await _maybe_verify(
            mode=run_mode,
            text=text,
            sources=sources,
            answerer_provider=answerer_provider,
        )

    async def final_text() -> str | None:
        # The task's accumulated assistant text → `result.finalText`,
        # which the subagent fan-in reads off each child's result row.
        try:
            text, _ = await text_and_sources()
        except Exception as exc:
            logger.warning("executor.final_text_failed", run_id=run_id, error=str(exc))
            return None
        return text or None

    async def final_images() -> tuple[dict[str, object], ...] | None:
        try:
            line, logs = await earlier_runs()
            own = await own_events()
            drawn = [
                dict(image)
                for log in [*logs, own]
                for event in log
                if isinstance(event, events.ToolImageEvent)
                for image in event.images
            ]
            children = await store.load_child_images(
                run.pool, parent_ids=[*line, run_id], user_id=user_id
            )
        except Exception as exc:
            logger.warning("executor.final_images_failed", run_id=run_id, error=str(exc))
            return None
        return _unique_images([*drawn, *children])

    return finalize, final_text, final_images


def _unique_images(images: list[dict[str, object]]) -> tuple[dict[str, object], ...]:
    """Each image once, first seen kept (by id, else url)."""
    seen: set[object] = set()
    out: list[dict[str, object]] = []
    for image in images:
        key = image.get("id") or image.get("url")
        if key in seen:
            continue
        seen.add(key)
        out.append(image)
    return tuple(out)


def _join_inputs(parts: list[verify.AggregatedInputs]) -> verify.AggregatedInputs:
    """The runs of a task's line as one answer (Q78): their texts in order
    — a lone run's verbatim, several joined by a blank line where a
    question came between them — and their sources numbered on, as the
    model cites them."""
    texts = [p.text for p in parts if p.text.strip()]
    text = texts[0] if len(texts) == 1 else "\n\n".join(t.strip() for t in texts)
    sources = [
        dataclasses.replace(source, id=str(i + 1))
        for i, source in enumerate(s for p in parts for s in p.sources)
    ]
    return verify.AggregatedInputs(text=text, sources=sources)


def _ensure_open_call(run: _Run, call_id: str, name: str, args: dict[str, Any]) -> None:
    """A step fn that stopped on a call leaves it in the history's last
    assistant turn; one that didn't record it there gets it added, so the
    result has a call to pair with."""
    if any(call.id == call_id for call in tool_turn.open_turn(run.messages)):
        return
    run.messages.append(
        {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": call_id, "name": name, "input": args}],
        }
    )


async def _resolve_turn(run: _Run) -> ToolCall | None:
    """Finish the open tool turn as far as it goes without the user or
    sub-agents (`tool_turn`):

      - a call with a result → reuse it (it already ran);
      - a call recorded as started without a result (a side-effecting
        tool cut off mid-execution) → NOT re-run; the model gets
        `interrupted_tool_result` and decides how to verify;
      - a spawn of a record saved before 5c (children may already
        exist) → same;
      - a call that waits for the user, or a spawn → left for the caller;
      - anything else → run it now, under the bound ledger like any call.

    Returns the next question, else the next spawn, else None once the
    results are one user turn and the model may be called again."""
    calls = tool_turn.open_turn(run.messages)
    if not calls:
        return None
    ledger = run.ledger
    await run.open_marker()
    unanswered = [call for call in calls if call.id not in ledger.results]
    # A gate only ever adds a question: what was asked stays asked.
    gated_now, _ = tool_turn.classify(unanswered, run.gated)
    for call in unanswered:
        if call.id in gated_now and call.id not in ledger.started and call.id not in ledger.spawn:
            ledger.ask.add(call.id)

    for call in unanswered:
        if call.id in ledger.started or (
            not ledger.classified
            and call.name == SPAWN_SUBAGENT_TOOL_NAME
            and call.id not in ledger.ask
            and call.id not in ledger.spawn
        ):
            await _answer_interrupted(run, call)
            continue
        if call.id in ledger.ask or call.id in ledger.spawn:
            continue
        if not ledger.classified:
            # Saved before 5c: its `tool_input` may never have been written.
            await run.emitter.tool_input(
                tool_call_id=call.id, tool_name=call.name, args=dict(call.args)
            )
        await execute_tool_call(
            run.emitter,
            run.registry.get(call.name),
            tool_call_id=call.id,
            tool_name=call.name,
            args=call.args,
            results=[],
        )

    for call in calls:
        if call.id in ledger.ask:
            return call
    for call in calls:
        if call.id in ledger.spawn:
            # An approval may have edited the arguments.
            return ToolCall(call.id, call.name, ledger.spawn[call.id])

    await run.close_step()
    run.messages.append(
        {"role": "user", "content": tool_turn.ordered_results(calls, ledger.results)}
    )
    ledger.reset()
    await run.save()
    return None


async def _answer_interrupted(run: _Run, call: ToolCall) -> None:
    logger.warning("executor.reclaimed_tool_interrupted", tool=call.name, tool_call_id=call.id)
    await run.emitter.step_error(
        f'"{call.name}" was interrupted while running and its outcome is '
        "unknown; it was not run again.",
        will_retry=False,
    )
    await run.emitter.tool_output(
        tool_call_id=call.id,
        tool_name=call.name,
        summary=tool_ledger.INTERRUPTED_TOOL_SUMMARY,
    )
    await run.ledger.record_finished(tool_ledger.interrupted_tool_result(call.id))


async def _pause(run: _Run, call: ToolCall) -> None:
    """Pause on one question, atomically: the request + `status: paused`
    entries, the checkpoint (the turn's results so far with it, its `seq`
    covering the entries) and the row with its open interrupt and
    `finished_at`. Losing to a cancel leaves no answerable question."""
    await run.close_step()
    with run.sink.holding() as held:
        await _emit_pending_input_request(
            run.emitter,
            PendingInputDescriptor(tool_call_id=call.id, tool=call.name, args=dict(call.args)),
        )
        await run.emitter.status("paused")
    interrupts = tuple(
        PendingInterrupt.from_approval(e) for e in held if isinstance(e, ApprovalEvent)
    )
    lease.check_current()
    if not await store.commit_pause(
        run.pool,
        run_id=run.payload.run_id,
        user_id=run.payload.user_id,
        checkpoint=run.build_checkpoint(),
        outcome=outcome_to_json(Interrupted(interrupts)),
        pause_events=held,
    ):
        raise _RunOver
    logger.info(
        "executor.suspended",
        run_id=run.payload.run_id,
        tool=call.name,
        tool_call_id=call.id,
    )


async def _spawn(run: _Run, call: ToolCall) -> bool:
    """Fan out one `spawnSubagent` call: the child rows, the barrier
    counter, the parent checkpointed as awaiting, all in one transaction.
    False: refused — the call got an error result instead."""
    pool, run_id, user_id = run.pool, run.payload.run_id, run.payload.user_id
    # Breadth clamp: never create more than MAX_CHILDREN.
    specs = parse_spawn_specs(call.args)[:MAX_CHILDREN]
    refusal: dict[str, Any] | None = None
    if not specs:
        # Nothing to wait on: a parent must never pause on zero children.
        refusal = {
            "type": "tool_result",
            "tool_use_id": call.id,
            "content": SPAWN_ARGS_ERROR,
            "is_error": True,
        }
    elif run.max_steps is not None and run.emitter.step > run.max_steps:
        # The extra step a fan-in or an answer gets past the limit (Q81,
        # `_drive`) uses results; it never starts more sub-agents.
        refusal = {
            "type": "tool_result",
            "tool_use_id": call.id,
            "content": SPAWN_STEP_LIMIT_ERROR,
            "is_error": True,
        }
    elif await store.load_parent_task_id(pool, run_id=run_id, user_id=user_id) is not None:
        # Depth cap: only top-level tasks may spawn children. A child task
        # (parent_task_id non-null) receives a rejection tool_result so
        # the model can continue without subagents.
        refusal = _spawn_rejection_tool_result(call.id)
    else:
        # Q72's 20 per task, checked here so the refusal lands in the step;
        # `commit_spawn` checks it again under the lock.
        started = await store.task_child_count(pool, task_id=run_id)
        if started + len(specs) > MAX_TASK_CHILDREN:
            refusal = _child_cap_refusal(call.id, started)
    if refusal is not None:
        await _refuse_spawn(run, call, refusal)
        return False

    await run.close_step()
    conversation_id = await store.load_conversation_id(pool, run_id=run_id, user_id=user_id)
    # Child ids are minted here so the handoff events can name
    # them; the rows themselves are written by `commit_spawn`
    # below, in one transaction with the parent's barrier state.
    children: list[store.ChildSpawn] = []
    children_meta: list[dict[str, str]] = []
    with run.sink.holding() as held:
        for spec in specs:
            child_id = str(uuid.uuid4())
            children.append(
                store.ChildSpawn(
                    id=child_id,
                    goal=spec.subgoal,
                    checkpoint=_child_checkpoint(run.checkpoint, spec),
                )
            )
            await run.emitter.handoff(
                agent=spec.persona_slug,
                phase="enter",
                child_task_id=child_id,
                subgoal=spec.subgoal,
            )
            children_meta.append(
                {"id": child_id, "personaSlug": spec.persona_slug, "subgoal": spec.subgoal}
            )
        # The call's result as the user sees it, once its children exist
        # (committed with them): the pill stops spinning; each child's end
        # follows as its own `handoff` `exit` (0049). The model's result is
        # the fan-in, when they have all ended.
        await run.emitter.tool_output(
            tool_call_id=call.id,
            tool_name=call.name,
            summary=_spawned_summary(specs),
        )

    # Built after the handoffs so its `seq` covers them.
    next_checkpoint = run.build_checkpoint()
    next_checkpoint["awaiting_children"] = {"tool_call_id": call.id, "children": children_meta}
    lease.check_current()
    # Counter + checkpoint + `paused` + children + their start
    # jobs in ONE transaction: no child can run (let alone
    # settle and hit the barrier) before the parent is ready.
    try:
        committed = await store.commit_spawn(
            pool,
            parent_task_id=run_id,
            user_id=user_id,
            conversation_id=conversation_id,
            children=children,
            checkpoint=next_checkpoint,
            spawn_events=held,
            max_task_children=MAX_TASK_CHILDREN,
        )
    except store.ChildCapReached as exc:
        # Passed between the check above and the lock: nothing was written.
        await _refuse_spawn(run, call, _child_cap_refusal(call.id, exc.started))
        return False
    if not committed:
        logger.warning("executor.spawn_parent_settled", run_id=run_id)
        raise _RunOver
    logger.info("executor.spawned", run_id=run_id, children=len(specs))
    return True


# --- internals -------------------------------------------------------------


async def _seed_seq(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
    checkpoint: dict[str, Any],
    reclaimed: bool = False,
) -> int:
    """Seq to seed the emitter at: the larger of the checkpoint's saved
    `seq` and the highest seq already in `task_events` for this run.

    A failed probe falls back to the checkpoint value on a normal run
    (only the route's / this worker's own events can follow it). On a
    reclaim, or a fan-in (its sub-agents' exit entries follow it), it
    does NOT: the dead attempt wrote past the checkpoint, so
    seeding there would reuse its seqs — the resume marker itself would
    collide and be dropped (`ON CONFLICT DO NOTHING`), leaving its
    partial output un-superseded. The attempt is abandoned instead
    (`lease.abandon_current`): the job is retried once its lease lapses,
    and only spends an attempt."""
    from_checkpoint = _int_or(checkpoint.get("seq"), 0)
    try:
        from_log = await store.max_event_seq(pool, run_id=run_id, user_id=user_id)
    except Exception as exc:
        logger.warning(
            "executor.max_seq_probe_failed", run_id=run_id, reclaimed=reclaimed, error=str(exc)
        )
        if reclaimed:
            lease.abandon_current("seq_probe_failed_on_reclaim")
            raise
        return from_checkpoint
    return max(from_checkpoint, from_log)


async def _stamp_handler(pool: asyncpg.Pool, *, run_id: str, user_id: str) -> None:
    """Best-effort `tasks.metadata.handler = 'python'` audit stamp. Never
    fails the run — it's for postmortems, not run state (and a DB
    without migration 0030 would otherwise fail every run)."""
    try:
        await store.set_task_handler(pool, run_id=run_id, user_id=user_id, handler="python")
    except Exception as exc:
        logger.warning("executor.set_task_handler_failed", run_id=run_id, error=str(exc))


def _make_db_sink(pool: asyncpg.Pool, *, user_id: str) -> EventSink:
    """Build an event sink that persists each event into task_events.

    Phase 2b can wrap this to also fan out to a Realtime stream so
    the chat panel sees events as they happen rather than via the
    DB Realtime publication. For now, the publication does the
    fan-out work.
    """

    async def sink(event: TaskEvent) -> None:
        await store.append_event(pool, event, user_id=user_id)

    return sink


# Lazy import + memo for the Anthropic client. Pulled in once per
# process, never if the API key is unset. Keeping the import lazy
# also avoids paying anthropic's import cost in test runs that use
# only the stub or a fake client.
_anthropic_client: AsyncAnthropicClient | None = None


def _resolve_anthropic_client() -> AsyncAnthropicClient | None:
    global _anthropic_client
    if _anthropic_client is not None:
        return _anthropic_client
    settings = get_settings()
    api_key = settings.ANTHROPIC_API_KEY.strip()
    if not api_key:
        return None
    # Real SDK import — only paid for when configured. Tests that
    # need a step fn bypass this via the `make_step_fn` injection
    # point, so this branch never runs under pytest.
    from anthropic import AsyncAnthropic

    # Optional `ANTHROPIC_BASE_URL` override lets a deploy point at
    # any Anthropic-compatible endpoint (proxy, self-hosted gateway,
    # Minimax's `/anthropic/v1` host, …). Only pass the kwarg when set
    # so the SDK falls back to its own default otherwise. mypy doesn't
    # see the SDK satisfies our Protocol via structural subtyping —
    # the Protocol's `messages.stream` signature is intentionally
    # narrower than the SDK's full overload set.
    base_url = settings.ANTHROPIC_BASE_URL.strip()
    if base_url:
        _anthropic_client = AsyncAnthropic(  # type: ignore[assignment]
            api_key=api_key,
            base_url=base_url,
        )
    else:
        _anthropic_client = AsyncAnthropic(api_key=api_key)  # type: ignore[assignment]
    return _anthropic_client


async def _maybe_verify(
    *,
    mode: str | None,
    text: str,
    sources: list[tuple[str, str, str]],
    answerer_provider: str = "anthropic",
) -> dict[str, object] | None:
    """Run the citation verifier for a research run, returning the wire
    payload for the `result` event (or None). Gated on research mode;
    the rest (`VERIFY_MODEL`, the cross-family client) is
    `verify_client.verify_citations`, falling back to the run's own
    Anthropic client."""
    if mode != "research":
        return None
    return await verify_client.verify_citations(
        text=text,
        sources=sources,
        answerer_provider=answerer_provider,
        anthropic_client=_resolve_anthropic_client,
    )


SPAWN_STEP_LIMIT_ERROR = (
    "No sub-agent was started: this task is at its step limit. Answer with what you have."
)
NO_KEY_ERROR = "ANTHROPIC_API_KEY is not configured on the agent service, so this task can't run."
NO_MODEL_ERROR = "This task has no model. Choose a model and run it again."
NO_MESSAGES_ERROR = "This task has no messages to send to the model."


def _default_make_step_fn(
    payload: StartActionPayload,
    checkpoint: dict[str, Any],
    messages: list[dict[str, Any]],
    context: ToolContext | None = None,
    *,
    run_tools: _RunTools | None = None,
) -> RunStepFn:
    """The run's step fn: Anthropic streaming. Raises (the run fails, Q55)
    without a model the worker can run, without messages, with an input
    the model can't be given, or without a key — checked before any tool
    runs. The stub only runs under `WORKER_STUB_MODEL` (tests).

    `messages` is the live, mutable list the chunk-runner owns — the
    Anthropic step appends assistant + tool_result turns to it as it
    runs, and the runner's yield path reads from it to persist the
    checkpoint. Passing it in keeps the chunk-runner authoritative.

    `run_tools` is the run's tool set (`_build_run_tools`): the skill
    tools `config.skills` chose, the always-on built-ins and the allowed
    cloud MCP tools, plus the MCP tools their server gates. Without it
    (tests) the tools are built from `checkpoint` and `context`, with no
    MCP discovery.

    The system prompt is the workspace prompt (`workspaceSystemPrompt`),
    or — for a research run (`config.mode == "research"`, Q46) — the
    research task prompt after it (`task_prompt`). `config.reasoningEffort`
    turns on extended thinking as the native harness does
    (`reasoning_effort.thinking_params`; a model without tiers ignores it).
    """
    cfg = checkpoint.get("config")
    cfg = cfg if isinstance(cfg, dict) else {}
    catalog_model = _str_or_none(cfg.get("model"))
    if not catalog_model:
        raise RunSetupError("invalid_request", NO_MODEL_ERROR)
    # Allowlist re-check: `tasks.checkpoint` is owner-writable under
    # RLS. Catalog id → Anthropic API id; unknown → UnknownModelError,
    # which fails the run (both call sites are inside the run guard).
    model = resolve_api_model_id(catalog_model)
    if not messages:
        raise RunSetupError("invalid_request", NO_MESSAGES_ERROR)
    unusable = _unusable_part(checkpoint)
    if unusable is not None:
        raise RunSetupError(
            "invalid_attachment",
            f"An attached {unusable} part can't be given to the model, so the task was not run.",
        )
    if get_settings().WORKER_STUB_MODEL:
        logger.warning("executor.using_stub_step_fn", run_id=payload.run_id)
        return _stub_step_fn
    client = _resolve_anthropic_client()
    if client is None:
        raise RunSetupError("unavailable", NO_KEY_ERROR)
    workspace_prompt = _str_or_none(cfg.get("workspaceSystemPrompt"))

    if run_tools is None:
        skill_tool_names, skill_configs = _skills_from(checkpoint)
        run_tools = _RunTools(
            context=context,
            extra_tools={},
            mcp_gated=set(),
            skill_tool_names=skill_tool_names,
            skill_configs=skill_configs,
            sandbox_files=_sandbox_files_from(checkpoint),
        )
    tools_dict = run_tools.registry()
    tools = list(tools_dict.values())

    system = workspace_prompt
    if _str_or_none(cfg.get("mode")) == RESEARCH_MODE:
        # Q71: no background run carries a file id, so the prompt never
        # tells the model to call `searchFiles({fileId})` — until Q49 is
        # lifted for cloud files. The tool itself stays offered.
        system = build_research_system_prompt(workspace_prompt, files_enabled=False)

    # Phase 3b: read the run's gated-tool allow-list. Names match
    # `tools[].name` (skill names + prefixed MCP tool names). When
    # the model calls one of these the step fn captures it as a
    # `pending_input` instead of executing — the runner suspends and
    # the executor emits an approval request.
    gated = _gated_tools_from(checkpoint) | run_tools.mcp_gated

    return make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model=model,
            system=system,
            messages=messages,
            tools=tools,
            gated_tool_names=gated,
            thinking=thinking_params(
                catalog_model, parse_reasoning_effort(cfg.get("reasoningEffort"))
            ),
        )
    )


def _gated_tools_from(checkpoint: dict[str, Any]) -> set[str]:
    """Pull `config.requireApprovalFor` from the checkpoint and union
    with `ALWAYS_GATED_TOOL_NAMES` (the no-execute HITL tools —
    `askUser` + `renderUI`). Matches the TS path's union of the
    explicit allow-list with the always-gated names — both runners
    agree on which tools suspend instead of executing."""
    explicit: set[str] = set()
    cfg = checkpoint.get("config")
    if isinstance(cfg, dict):
        raw = cfg.get("requireApprovalFor")
        if isinstance(raw, list):
            explicit = {item for item in raw if isinstance(item, str) and item}
    return explicit | ALWAYS_GATED_TOOL_NAMES


async def _run_respond(
    pool: asyncpg.Pool,
    payload: RespondActionPayload,
    make_step_fn: MakeStepFn | None,
    resume_interrupted: bool = False,
) -> ExecutorOutcome:
    """Outer guard for `_run_respond_inner` — same contract as
    `_run_chunk`'s, except that a failure BEFORE the atomic
    paused → running claim leaves the task alone: it is still paused
    on the user, who can respond again (the answer was never applied). A
    resumed interrupted respond owns the (already `running`) task from
    the start."""
    guard = _RunGuard(owns_task=resume_interrupted)
    try:
        return await _run_respond_inner(pool, payload, make_step_fn, guard, resume_interrupted)
    except _RunOver:
        await _stop_ended_run(pool, payload.run_id, payload.user_id, guard.emitter)
        return ExecutorOutcome(settled=True)
    except Exception as exc:
        logger.error(
            "executor.respond.failed",
            run_id=payload.run_id,
            user_id=payload.user_id,
            claimed=guard.owns_task,
            error=str(exc),
        )
        if guard.owns_task:
            await _fail_run(
                pool,
                run_id=payload.run_id,
                user_id=payload.user_id,
                emitter=guard.emitter,
                error=str(exc),
                error_code=_error_code(exc),
            )
        elif guard.claiming:
            # The claim may have committed before its answer was lost: a
            # task left `running` is settled, a still paused one is left.
            job_lease = lease.current()
            if job_lease is not None:
                await settle_stranded_task(
                    pool,
                    task_id=payload.run_id,
                    user_id=payload.user_id,
                    job_id=job_lease.job_id,
                    error=str(exc),
                )
        return ExecutorOutcome(settled=False, error=str(exc))


async def _run_respond_inner(
    pool: asyncpg.Pool,
    payload: RespondActionPayload,
    make_step_fn: MakeStepFn | None,
    guard: _RunGuard,
    resume_interrupted: bool = False,
) -> ExecutorOutcome:
    """Implementation of `execute_respond`: find the question, claim it,
    apply the answer, then the loop every action shares (`_drive`)."""

    async def reject(error: str) -> ExecutorOutcome:
        # Before the paused claim the task is still waiting on the user
        # and stays untouched; a resumed interrupted respond already owns
        # the `running` task, which would strand without a settle.
        if guard.owns_task:
            await _fail_run(
                pool,
                run_id=payload.run_id,
                user_id=payload.user_id,
                emitter=guard.emitter,
                error=error,
            )
        return ExecutorOutcome(settled=False, error=error)

    start_payload = StartActionPayload(run_id=payload.run_id, user_id=payload.user_id)
    checkpoint = await store.load_checkpoint(
        pool,
        run_id=payload.run_id,
        user_id=payload.user_id,
    )
    if checkpoint is None:
        logger.error(
            "executor.respond.no_checkpoint",
            run_id=payload.run_id,
            user_id=payload.user_id,
        )
        return await reject("respond: no checkpoint for run")

    question = payload.request_id
    messages = _messages_from(checkpoint)
    partial = tool_turn.take_partial_results(messages)
    record = tool_ledger.read_record(checkpoint)
    settled_calls = set(record.results) | set(record.spawn)  # answered, or an approved spawn
    settled_calls.update(str(block.get("tool_use_id")) for block in partial)
    call = next(
        (
            c
            for c in tool_turn.open_turn(messages)
            if c.id == question and c.id not in settled_calls
        ),
        None,
    )
    if call is None and (question in settled_calls or _tool_call_answered(messages, question)):
        if resume_interrupted:
            # The dead attempt persisted the answer before dying — the run
            # just needs to carry on from its checkpoint.
            logger.warning(
                "executor.respond.resume_from_checkpoint",
                run_id=payload.run_id,
                request_id=question,
            )
            return await _run_chunk(
                pool,
                payload=start_payload,
                make_step_fn=make_step_fn,
                resume=True,
                reclaimed=True,
            )
        # Duplicate respond for a call that already has its tool_result
        # (double-click, retried POST, or a run that has since
        # re-suspended on a different call). Re-running it would
        # re-execute an approved tool — settle the job as a no-op.
        logger.warning(
            "executor.respond.already_answered",
            run_id=payload.run_id,
            request_id=question,
        )
        return ExecutorOutcome(settled=True)

    # A parent paused on its subagents is `paused` too, and its pending
    # `spawnSubagent` tool_use has no tool_result until the fan-in — so
    # without this a user could "respond" to it with that call's id,
    # flip the parent to running and break the join barrier. Only the
    # barrier's `continue` may resume it.
    if isinstance(checkpoint.get("awaiting_children"), dict):
        logger.error(
            "executor.respond.awaiting_children",
            run_id=payload.run_id,
            request_id=question,
        )
        return await reject("respond: run is waiting on its subagents, not on user input")

    if call is None:
        logger.error(
            "executor.respond.pending_not_found",
            run_id=payload.run_id,
            request_id=question,
        )
        return await reject(f"respond: pending tool call {question} not found")

    # The request kind, from the tool name + args: the classifier the
    # suspend path uses, so the respond side never disagrees with what
    # the user actually saw.
    request_kind = request_kind_for(call.name, call.args)
    if (
        request_kind == "approval"
        and not resume_interrupted
        and not payload.cancelled
        and not isinstance(payload.approved, bool)
    ):
        # Absent never approves (and is no decline either): still answerable.
        return await reject("respond: an approval needs `approved`: true or false")

    # Same tool set (workspace-scoped context + cloud-mode MCP tools) the
    # start/continue path gave the model, so an approved MCP tool or
    # `searchFiles` actually executes instead of reporting "not
    # registered", and so we know which MCP tools the server gates.
    run_tools = await _build_run_tools(
        pool,
        user_id=payload.user_id,
        checkpoint=checkpoint,
        discover_mcp=True,
    )

    # Only a call the run actually suspended on may be answered. An
    # unanswered tool_use for a tool that isn't approval-gated (e.g.
    # `spawnSubagent`, or a sibling call in the same assistant turn) is
    # not awaiting the user — "approving" it would execute a tool the
    # run never asked permission for. What was asked is on record — the
    # checkpoint's, or the log's for a run paused before 5c — because the
    # gates may have changed since (a Decline must still work).
    if (
        not resume_interrupted
        and question not in record.ask
        and call.name not in (_gated_tools_from(checkpoint) | run_tools.mcp_gated)
        and (
            record.classified
            or question
            != await store.load_open_question(pool, run_id=payload.run_id, user_id=payload.user_id)
        )
    ):
        logger.error(
            "executor.respond.not_gated",
            run_id=payload.run_id,
            request_id=question,
            tool=call.name,
        )
        return await reject(
            f"respond: tool call {question} ({call.name}) is not awaiting user input"
        )

    # Seeded before the gate and before an approved tool runs: on a
    # reclaim a failed probe abandons the attempt (`_seed_seq`), which
    # must happen before the tool has acted, not after.
    start_seq = await _seed_seq(
        pool,
        run_id=payload.run_id,
        user_id=payload.user_id,
        checkpoint=checkpoint,
        reclaimed=resume_interrupted,
    )

    # Atomic paused → running gate, and the durable record that this
    # answer is being applied, before any side effect: the task stops
    # waiting on the question (0045). Only one respond per question gets
    # past this; a duplicate racing us (or a run cancelled while paused)
    # sees no row and settles as a no-op — before any tool executes. A
    # resumed interrupted respond already went through it on the dead
    # attempt.
    lease.check_current()
    if resume_interrupted:
        logger.warning(
            "executor.respond.reapply_answer",
            run_id=payload.run_id,
            request_id=question,
        )
    else:
        guard.claiming = True
        claimed = await store.claim_paused_for_respond(
            pool, run_id=payload.run_id, user_id=payload.user_id, question=question
        )
        guard.claiming = False
        if not claimed:
            logger.warning(
                "executor.respond.not_paused",
                run_id=payload.run_id,
                request_id=question,
            )
            return ExecutorOutcome(settled=True)
    # From here the task is `running` on our account — any escaped error
    # must settle it (see `_run_respond`).
    guard.owns_task = True

    sink = _RunSink(pool, user_id=payload.user_id)
    emitter = RunEmitter(
        run_id=payload.run_id,
        sink=sink,
        start_seq=start_seq,
        start_step=_int_or(checkpoint.get("step"), 0),
    )
    guard.emitter = emitter

    # Before the approved tool runs: no key / model fails the task (Q55).
    if make_step_fn is None:
        step_fn = _default_make_step_fn(
            start_payload, checkpoint, messages, run_tools.context, run_tools=run_tools
        )
    else:
        step_fn = make_step_fn(start_payload, checkpoint, messages, run_tools.context)

    run = _Run(
        pool,
        payload=start_payload,
        checkpoint=checkpoint,
        messages=messages,
        emitter=emitter,
        sink=sink,
        tools=run_tools,
        resume=True,
        resumed_from_seq=None,
    )
    run.ledger.reset(record)
    for block in partial:
        run.ledger.answer(block)
    run.ledger.ask.add(question)

    # An approved tool is side-effecting by definition (the user gated
    # it). The execution record is saved before it runs; a reclaimed
    # respond that finds it — the dead attempt started the tool but never
    # persisted its result — must not run it again (`tool_ledger`).
    interrupted = resume_interrupted and request_kind == "approval" and question in record.started

    if resume_interrupted:
        # Reclaimed: open with a resume marker so consumers drop
        # anything the dead attempt wrote past the paused checkpoint.
        # Emitted BEFORE the first checkpoint save so the saved
        # `seq` covers it: were this attempt to die after the save but
        # before the marker, the next reclaim would resume from the
        # saved checkpoint (answer already applied) with a marker
        # at ITS seq — and the first dead attempt's events between
        # the paused checkpoint and that seq would never be dropped.
        await emitter.status("running", resumed_from_seq=_int_or(checkpoint.get("seq"), 0))
    await _stamp_handler(pool, run_id=payload.run_id, user_id=payload.user_id)
    # input_response clears pending_input on the projection. Before the
    # first save, so a checkpoint that holds the answer covers the entry.
    await emitter.input_response(
        approval_id=question,
        approved=False if payload.cancelled and request_kind == "approval" else payload.approved,
        selection=payload.selection,
        value=payload.value,
        ui_answer=payload.ui_answer,
    )
    await emitter.status("running")

    with tool_ledger.bound(run.ledger):
        deadline_s = _chunk_deadline_s()
        if interrupted:
            await _answer_interrupted(run, call)
        else:
            await _apply_answer(run, call, _answer_of(payload))
        return await _drive(run, step_fn, deadline_s, resolve=True, grace=True)


def _answer_of(payload: RespondActionPayload) -> resume_answers.StoredAnswer:
    """A respond's answer in the runs resume's shape, so both ways tell
    the model the same thing. Not `uiAnswer`: the old route's clients send
    its formatted text as `value` / `selection`. `cancelled` is a decline
    whatever else the payload says."""
    if payload.cancelled:
        return resume_answers.StoredAnswer(
            interrupt_id=payload.request_id, status="cancelled", payload=None
        )
    fields: dict[str, Any] = {
        "approved": payload.approved,
        "args": payload.args,
        "selection": payload.selection,
        "value": payload.value,
    }
    return resume_answers.StoredAnswer(
        interrupt_id=payload.request_id,
        status="resolved",
        payload={key: value for key, value in fields.items() if value is not None},
    )


def _tool_call_answered(messages: list[dict[str, Any]], tool_call_id: str) -> bool:
    """True when some user turn already carries a `tool_result` for
    `tool_call_id` (Anthropic-shaped — `_messages_from` has already
    translated any AI-SDK `role: tool` turns)."""
    for entry in messages:
        if entry.get("role") != "user":
            continue
        content = entry.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if (
                isinstance(block, dict)
                and block.get("type") == "tool_result"
                and block.get("tool_use_id") == tool_call_id
            ):
                return True
    return False


def _resume_calls(
    run: _Run, answers: tuple[resume_answers.StoredAnswer, ...]
) -> list[tuple[ToolCall, resume_answers.StoredAnswer]]:
    """Pair each stored answer with the tool call it answers. Raises
    `ValueError` (the run fails before applying anything, freeing the
    question) when a call is not open in the checkpoint or not one the
    paused run asked — an "approval" of a call the run never paused on
    would run a tool on the client's say-so alone (the respond path's
    same check). Asked: on record (`resume_checkpoint` records the
    validated questions), or gated here (older checkpoints)."""
    by_id = {c.id: c for c in tool_turn.open_turn(run.messages) if c.id not in run.ledger.results}
    pairs: list[tuple[ToolCall, resume_answers.StoredAnswer]] = []
    for answer in answers:
        call = by_id.get(answer.interrupt_id)
        if call is None:
            raise ValueError(
                f"resume: tool call {answer.interrupt_id} is not open in the paused run"
            )
        if call.id not in run.ledger.ask and call.name not in run.gated:
            raise ValueError(
                f"resume: tool call {answer.interrupt_id} ({call.name}) is not awaiting user input"
            )
        pairs.append((call, answer))
    return pairs


async def _apply_answer(run: _Run, call: ToolCall, answer: resume_answers.StoredAnswer) -> None:
    """One answered question (RUN_EVENTS.md § 4.2, as the native harness's
    resume): the approved tool's result (run through `execute_tool_call`,
    recorded as the side effect it is; one that is gone answers with a
    clear error), an approved spawn (fanned out by `_drive`), or the
    declined / answer text — which runs nothing, so it works whatever
    changed while paused. Only a boolean `approved: true` approves."""
    kind = request_kind_for(call.name, call.args)
    args = resume_answers.approved_args(kind, answer, call.args)
    if args is not None:
        if call.name == SPAWN_SUBAGENT_TOOL_NAME and parse_spawn_specs(args):
            run.ledger.ask.discard(call.id)
            run.ledger.spawn[call.id] = args
            await run.save()
            return
        await execute_tool_call(
            run.emitter,
            run.registry.get(call.name),
            tool_call_id=call.id,
            tool_name=call.name,
            args=args,
            results=[],
            approved=True,
        )
        return
    text = resume_answers.answer_text(kind, answer)
    await run.emitter.tool_output(
        tool_call_id=call.id,
        tool_name=call.name,
        summary="Declined by the user" if kind == "approval" else text[:200],
        output=text,
    )
    await run.ledger.record_finished(
        {"type": "tool_result", "tool_use_id": call.id, "content": text}
    )


async def _record_progress(pool: asyncpg.Pool, event: TaskEvent, *, user_id: str) -> None:
    """Keep `tasks.step` current (the runs API's `Run.step`): written at
    each step's end. Best-effort — progress, not run state."""
    if not isinstance(event, StepEndEvent):
        return
    try:
        await store.update_run(pool, run_id=event.run_id, user_id=user_id, step=event.step)
    except Exception as exc:
        logger.warning("executor.step_progress_failed", run_id=event.run_id, error=str(exc))


async def _emit_pending_input_request(
    emitter: RunEmitter,
    pending: Any,
) -> None:
    """Shared suspend emit. Classifies `request_kind` from the
    pending tool name + args (single source of truth via
    `request_kind_for`), and pulls out the kind-specific fields:

    - `askUser` → `prompt` / `options` / `multi` come from args.
    - `renderUI` → `ui_kind` + `ui_props` come from args.
    - approval (anything else gated) → just tool + args.

    Used by both the original suspend path in `_run_chunk` and the
    re-suspend path in `_run_respond` so they emit identical shapes."""
    args = pending.args if isinstance(pending.args, dict) else {}
    kind = request_kind_for(pending.tool, args)

    prompt: str | None = None
    options: list[Any] | None = None
    multi: bool | None = None
    ui_kind: str | None = None
    ui_props: dict[str, Any] | None = None

    if kind in ("choice", "input"):
        raw_prompt = args.get("prompt")
        if isinstance(raw_prompt, str):
            prompt = raw_prompt
        raw_multi = args.get("multi")
        if isinstance(raw_multi, bool):
            multi = raw_multi
        if kind == "choice":
            from .events import InputRequestOption  # local import — avoid cycle

            raw_options = args.get("options")
            if isinstance(raw_options, list):
                built: list[InputRequestOption] = []
                for opt in raw_options:
                    if not isinstance(opt, dict):
                        continue
                    opt_id = opt.get("id")
                    opt_label = opt.get("label")
                    if isinstance(opt_id, str) and isinstance(opt_label, str):
                        built.append(InputRequestOption(id=opt_id, label=opt_label))
                if built:
                    options = built
    elif kind == "ui-part":
        raw_kind = args.get("kind")
        raw_props = args.get("props")
        if isinstance(raw_kind, str):
            ui_kind = raw_kind
        if isinstance(raw_props, dict):
            ui_props = raw_props

    await emitter.input_request(
        approval_id=pending.tool_call_id,
        request_kind=kind,
        tool=pending.tool,
        tool_call_id=pending.tool_call_id,
        args=args,
        prompt=prompt,
        options=options,
        multi=multi,
        ui_kind=ui_kind,
        ui_props=ui_props,
    )


async def _stub_step_fn(ctx: RunStepContext) -> RunStepOutcome:
    """Canned step — emits two tokens of placeholder text and declares
    the step done. Only under `WORKER_STUB_MODEL` (tests), never as a
    fallback: success is never faked (Q55)."""
    await ctx.emitter.token("Stub model: ")
    await ctx.emitter.token("(WORKER_STUB_MODEL is on; no model was called)")
    return RunStepOutcome(done=True)


# --- checkpoint coercion ----------------------------------------------------


# Upper bound on `config.maxSteps` — same cap the TS route's Zod schema
# enforces (`maxSteps: z.number().int().min(1).max(50)` in
# lib/shared/api-schemas.ts). The checkpoint is user-writable jsonb, so
# the executor re-applies it rather than trusting the stored value.
MAX_STEPS_CAP = 50


def _max_steps_from(checkpoint: dict[str, Any], fallback: int) -> int:
    """Pull `config.maxSteps` from the checkpoint, falling back to the
    payload's value when missing. Bounded to `[1, MAX_STEPS_CAP]` to
    defend against a malformed / hostile jsonb."""
    cfg = checkpoint.get("config") if isinstance(checkpoint, dict) else None
    raw = cfg.get("maxSteps") if isinstance(cfg, dict) else None
    # `bool` is an `int` subclass — `True` is not a step count.
    value = raw if isinstance(raw, int) and not isinstance(raw, bool) and raw > 0 else fallback
    return max(1, min(value, MAX_STEPS_CAP))


def _messages_from(checkpoint: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract `messages` from the checkpoint as Anthropic-shaped
    dicts.

    The checkpoint stores a list of `{role, content}` entries where
    `content` is either a string OR a list of content blocks
    (`text`, `tool_use`, `tool_result`, …). Phase 3b preserves the
    block list verbatim when it's Anthropic-shaped so a suspended +
    resumed run keeps its tool_use ↔ tool_result chain intact.

    A run started TS-side stores AI-SDK-shaped content blocks
    (`type: 'tool-call'`, `'tool-result'`, `'image'`, `'file'`,
    `'reasoning'` and `role: 'tool'` messages). The
    `_translate_block` / `_translate_ai_sdk_message` helpers below
    convert those to Anthropic shapes before this function returns
    its output. Runs that mix TS-suspend with Python-respond keep
    their tool context as of this change. Same-worker Python flows
    (start → suspend → respond, all Python) work today because
    Python writes Anthropic-shaped blocks both ways."""
    raw = checkpoint.get("messages")
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        if entry.get("role") == "tool":
            # AI SDK v5 ToolModelMessage → Anthropic user + tool_result blocks.
            # See _translate_ai_sdk_message for the role-remap + block translation.
            translated = _translate_ai_sdk_message(entry)
            if translated is not None:
                out.append(translated)
            continue
        role = entry.get("role")
        if role not in ("user", "assistant"):
            # `system` is hoisted out (Anthropic takes it as a separate
            # `system=` arg); `developer` is not used by AI SDK v5 by default.
            continue
        content = entry.get("content")
        if isinstance(content, str):
            if content:
                out.append({"role": role, "content": content})
            continue
        if isinstance(content, list):
            blocks = _normalise_content_blocks(content)
            if blocks:
                out.append({"role": role, "content": blocks})
            continue
    return out


# Sentinel for redacted_thinking blocks. Anthropic accepts the `data` field
# as opaque — the actual reasoning text is intentionally lost in the
# AI SDK → Anthropic translation.
_REDACTED_THINKING_SENTINEL = "redacted-by-translator"

# Process-local set tracking which unknown block kinds we've already
# warned about. Mirrors the `_warn_once` pattern at verify.py (per-block-kind).
_warned_unknown_block_kinds: set[str] = set()


def _warn_unknown_block_kind(block_type: object) -> None:
    key = str(block_type)
    if key in _warned_unknown_block_kinds:
        return
    _warned_unknown_block_kinds.add(key)
    structlog.get_logger().warning(
        "executor.unknown_ai_sdk_block_kind",
        block_type=key,
    )


def _normalise_content_blocks(content: list[Any]) -> list[dict[str, Any]]:
    """Translate a content array (any source: Anthropic-shape or AI-SDK-shape)
    into Anthropic-shape blocks. Pure; drops unknown block kinds. Replaces
    the old pass-through filter — the AI SDK translator is the canonical
    path. A pass-through-only path would silently drop tool-call/tool-result
    blocks when a TS-suspended run is resumed by Python."""
    return [b for b in (_translate_block(c) for c in content) if b is not None]


def _translate_block(block: Any) -> dict[str, Any] | None:
    """One content block (any source: AI-SDK v5 or Anthropic) → one
    Anthropic content block (or None when the block is dropped). Pure;
    no I/O. The single source of truth for the wire translation. Drops
    unknown block kinds silently; a per-kind warn-once fires so a new
    AI SDK release that adds a block type we don't translate becomes
    visible without crashing the run.

    Pass-through: blocks already in Anthropic shape (detected by their
    field set, not the `type` string) are copied as-is. This is what
    makes same-stack Python resumes (Anthropic in, Anthropic out)
    byte-identical to the pre-translator behaviour, and what keeps
    the response flow working while a TS-suspended run is being
    resumed — Python writes Anthropic-shape blocks, and the
    translator must not corrupt them on the way back to the model.
    """
    if not isinstance(block, dict):
        return None
    block_type = block.get("type")

    if block_type == "text":
        text = block.get("text")
        return {"type": "text", "text": text} if isinstance(text, str) else None

    if block_type == "image":
        if "source" in block:
            return dict(block)
        return _translate_image_block(block)

    if block_type == "file":
        return _translate_file_block(block)

    # Already Anthropic's (`runs.history`, or a checkpoint this saved).
    if block_type == "document" and isinstance(block.get("source"), dict):
        return dict(block)

    if block_type == "tool-call":
        return _translate_tool_call_block(block)

    if block_type == "tool-result":
        return _translate_tool_result_block(block)

    if block_type == "tool_use":
        if "id" in block and "name" in block:
            return dict(block)
        _warn_unknown_block_kind("tool_use:missing-fields")
        return None

    if block_type == "tool_result":
        if "tool_use_id" in block:
            return dict(block)
        _warn_unknown_block_kind("tool_result:missing-tool_use_id")
        return None

    if block_type == "reasoning":
        return {"type": "redacted_thinking", "data": _REDACTED_THINKING_SENTINEL}

    # Extended-thinking blocks this executor saved (a run with a
    # reasoning tier): kept verbatim, signature included — Anthropic
    # needs them back to continue a tool-use turn with thinking on.
    if block_type == "thinking" and isinstance(block.get("signature"), str):
        return {
            "type": "thinking",
            "thinking": block.get("thinking", ""),
            "signature": block["signature"],
        }
    if block_type == "redacted_thinking" and isinstance(block.get("data"), str):
        return {"type": "redacted_thinking", "data": block["data"]}

    _warn_unknown_block_kind(block_type)
    return None


def _translate_image_block(block: dict[str, Any]) -> dict[str, Any] | None:
    """AI SDK {type:'image', image:...} → Anthropic {type:'image', source:...}.
    Supports URL strings and `data:<media>;base64,<data>` URIs. Other
    shapes (binary buffers) drop with a warn-once."""
    image = block.get("image")
    if isinstance(image, str):
        if image.startswith("data:"):
            head, _, data = image.partition(",")
            media_type = head.split(";", 1)[0].removeprefix("data:") or "application/octet-stream"
            return {
                "type": "image",
                "source": {"type": "base64", "media_type": media_type, "data": data},
            }
        return {"type": "image", "source": {"type": "url", "url": image}}
    _warn_unknown_block_kind("image:non-string")
    return None


def _translate_file_block(block: dict[str, Any]) -> dict[str, Any] | None:
    """AI SDK {type:'file', ...} → Anthropic: a PDF (base64, `data:` or
    URL) or `text/*` (inline; sent as a text source) → `document`, an
    image type → `image`. Anything else drops with a warn-once; a task
    that starts with such a part fails instead (`_unusable_part`)."""
    media_type = block.get("mediaType")
    data = block.get("data")
    if not isinstance(media_type, str) or not (
        media_type == "application/pdf"
        or media_type in IMAGE_MEDIA_TYPES
        or media_type.startswith("text/")
    ):
        _warn_unknown_block_kind(f"file:mediaType={media_type}")
        return None
    if not isinstance(data, str) or not data:
        _warn_unknown_block_kind("file:non-string-data")
        return None
    inline = not data.startswith(("https://", "http://"))
    payload, encoded = data, True
    mt = media_type
    if data.startswith("data:"):
        head, _, payload = data.partition(",")
        mt = head.split(";", 1)[0].removeprefix("data:") or media_type
        encoded = head.endswith(";base64")
    if media_type.startswith("text/"):
        if not inline:
            _warn_unknown_block_kind("file:text-url")
            return None
        try:
            raw = base64.b64decode(payload, validate=True) if encoded else unquote_to_bytes(payload)
            text = raw.decode("utf-8")
        except (binascii.Error, ValueError):
            _warn_unknown_block_kind("file:text-undecodable")
            return None
        if not text:
            return None
        return {
            "type": "document",
            "source": {"type": "text", "media_type": "text/plain", "data": text},
        }
    kind = "document" if media_type == "application/pdf" else "image"
    if not inline:
        return {"type": kind, "source": {"type": "url", "url": data}}
    return {"type": kind, "source": {"type": "base64", "media_type": mt, "data": payload}}


def _unusable_part(checkpoint: dict[str, Any]) -> str | None:
    """An attachment the history holds that can't reach the model (its
    media type, else its kind) — never dropped silently (B20)."""
    raw = checkpoint.get("messages")
    for message in raw if isinstance(raw, list) else []:
        content = message.get("content") if isinstance(message, dict) else None
        for part in content if isinstance(content, list) else []:
            if (
                isinstance(part, dict)
                and part.get("type") in ("file", "image", "document")
                and _translate_block(part) is None
            ):
                return str(part.get("mediaType") or part["type"])
    return None


def _translate_tool_call_block(block: dict[str, Any]) -> dict[str, Any]:
    """AI SDK {type:'tool-call', toolCallId, toolName, input}
    → Anthropic {type:'tool_use', id, name, input}."""
    tool_call_id = block.get("toolCallId")
    if not isinstance(tool_call_id, str) or not tool_call_id:
        _warn_unknown_block_kind("tool-call:empty-id")
        tool_call_id = "unknown"
    return {
        "type": "tool_use",
        "id": tool_call_id,
        "name": block.get("toolName", ""),
        "input": block.get("input", {}),
    }


def _translate_tool_result_block(block: dict[str, Any]) -> dict[str, Any] | None:
    """AI SDK {type:'tool-result', toolCallId, output:{type, value}}
    → Anthropic {type:'tool_result', tool_use_id, content, is_error}.
    Five `output.type` variants: 'text', 'json', 'error-text', 'error-json',
    'content'. Anything else drops with a warn-once."""
    tool_call_id = block.get("toolCallId")
    if not isinstance(tool_call_id, str) or not tool_call_id:
        tool_call_id = "unknown"
    output = block.get("output")
    if not isinstance(output, dict):
        _warn_unknown_block_kind("tool-result:no-output")
        return None
    out_type = output.get("type")
    if out_type == "text":
        return {
            "type": "tool_result",
            "tool_use_id": tool_call_id,
            "content": output.get("value", ""),
            "is_error": False,
        }
    if out_type == "json":
        return {
            "type": "tool_result",
            "tool_use_id": tool_call_id,
            "content": json.dumps(output.get("value")),
            "is_error": False,
        }
    if out_type == "error-text":
        return {
            "type": "tool_result",
            "tool_use_id": tool_call_id,
            "content": output.get("value", ""),
            "is_error": True,
        }
    if out_type == "error-json":
        return {
            "type": "tool_result",
            "tool_use_id": tool_call_id,
            "content": json.dumps(output.get("value")),
            "is_error": True,
        }
    if out_type == "content":
        inner = output.get("value")
        if not isinstance(inner, list):
            return None
        translated: list[dict[str, Any]] = []
        for ib in inner:
            if not isinstance(ib, dict) or ib.get("type") != "text":
                _warn_unknown_block_kind("tool-result:content:non-text-inner")
                continue
            translated.append({"type": "text", "text": ib.get("text", "")})
        if not translated:
            return None
        return {
            "type": "tool_result",
            "tool_use_id": tool_call_id,
            "content": translated,
            "is_error": False,
        }
    _warn_unknown_block_kind(f"tool-result:output-type={out_type}")
    return None


def _translate_ai_sdk_message(message: dict[str, Any]) -> dict[str, Any] | None:
    """Convert one AI SDK v5 ModelMessage to an Anthropic-shaped
    `{role, content}`. Returns None when the message carries no usable
    content after translation. Handles the `role: 'tool'` →
    `role: 'user'` remap (Anthropic has no 'tool' role) and delegates
    block-level translation to _translate_block."""
    role = message.get("role")
    content = message.get("content")
    if isinstance(content, str):
        if not content:
            return None
        if role in ("user", "assistant"):
            return {"role": role, "content": content}
        return None
    if not isinstance(content, list):
        return None
    blocks = [b for b in (_translate_block(b) for b in content) if b is not None]
    if not blocks:
        return None
    if role == "tool":
        return {"role": "user", "content": blocks}
    if role in ("user", "assistant"):
        return {"role": role, "content": blocks}
    return None


def _str_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _int_or(value: Any, fallback: int) -> int:
    """Coerce a checkpoint jsonb number to int, falling back when the
    field is missing / non-numeric. Both `seq` and `step` are read
    through this on resume."""
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return fallback


def _build_checkpoint(
    original: dict[str, Any],
    messages: list[dict[str, Any]],
    emitter: RunEmitter,
) -> dict[str, object]:
    """Build the jsonb body for `tasks.checkpoint` on a yield save.

    Shape matches `RunCheckpoint` on the TS side:
    `{messages, step, seq, config}`. `config` is the original loaded
    block (model / system / skills / maxSteps / mode / …); on a yield
    we keep it identical — the next chunk runs with the same setup."""
    cfg = original.get("config")
    out: dict[str, object] = {
        "messages": list(messages),
        "step": emitter.step,
        "seq": emitter.seq,
        "config": cfg if isinstance(cfg, dict) else {},
    }
    if isinstance(original.get("subagent"), dict):
        # A child's label: the parent's fan-in reads it.
        out["subagent"] = original["subagent"]
    return out


def _spawned_summary(specs: list[SpawnSpec]) -> str:
    n = len(specs)
    text = f"Started {n} sub-agent{'s' if n != 1 else ''}: " + "; ".join(s.subgoal for s in specs)
    return text if len(text) <= 300 else text[:299] + "…"


async def _refuse_spawn(run: _Run, call: ToolCall, refusal: dict[str, Any]) -> None:
    """A refused spawn's result: the model reads why and carries on."""
    await run.emitter.tool_output(
        tool_call_id=call.id, tool_name=call.name, summary=refusal["content"]
    )
    await run.ledger.record_finished(refusal)


def _child_cap_refusal(tool_call_id: str, started: int) -> dict[str, Any]:
    return {
        "type": "tool_result",
        "tool_use_id": tool_call_id,
        "content": task_child_cap_error(started),
        "is_error": True,
    }


def _spawn_rejection_tool_result(tool_call_id: str) -> dict[str, Any]:
    """The `tool_result` that tells the model spawning was rejected
    (depth limit). The model continues the run without subagents."""
    return {
        "type": "tool_result",
        "tool_use_id": tool_call_id,
        "content": (
            "Subagent spawning is not available here (depth limit reached). "
            "Continue without subagents."
        ),
    }


def _child_checkpoint(parent_checkpoint: dict[str, Any], spec: SpawnSpec) -> dict[str, Any]:
    """Build the initial checkpoint for a child task. Inherits the
    parent's `config` (model, system prompt, etc.) and pins the
    subagent metadata under the `subagent` key so the child can be
    identified in the tasks table."""
    parent_cfg = parent_checkpoint.get("config")
    cfg = dict(parent_cfg) if isinstance(parent_cfg, dict) else {}
    return {
        "messages": [{"role": "user", "content": spec.subgoal}],
        "step": 0,
        "seq": 0,
        "config": cfg,
        "subagent": {"personaSlug": spec.persona_slug, "subgoal": spec.subgoal},
    }


# Time budget for one chunk before the runner voluntarily yields. The
# TS side uses 45s as a default (Vercel Hobby cap is 60s; 15s headroom
# leaves room for the current step to finish + the checkpoint write +
# the enqueue). For self-host VMs there's no hard cap; we still chunk
# so a long run can't monopolise a worker process.
_DEFAULT_CHUNK_BUDGET_S = 45.0


def _chunk_deadline_s() -> float | None:
    """Compute an event-loop monotonic timestamp past which the runner
    should yield. None disables chunking entirely (set
    `WORKER_CHUNK_BUDGET_S=0` to opt out — useful in tests + when the
    deploy target has no execution cap and a single big chunk is
    fine). Reads the env var directly rather than threading it
    through `get_settings()` so test invocations don't have to clear
    the cached Settings singleton."""
    raw = os.environ.get("WORKER_CHUNK_BUDGET_S")
    if raw is not None:
        try:
            budget = float(raw)
        except ValueError:
            budget = _DEFAULT_CHUNK_BUDGET_S
    else:
        budget = _DEFAULT_CHUNK_BUDGET_S
    if budget <= 0:
        return None
    return asyncio.get_event_loop().time() + budget


# Re-export so callers (and the poller) can wire a custom step fn
# without depending on private internals.
__all__ = [
    "ExecutorOutcome",
    "MakeStepFn",
    "RespondActionPayload",
    "StartActionPayload",
    "execute_continue",
    "execute_respond",
    "execute_start",
    "settle_stranded_task",
]

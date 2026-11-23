"""RunRepository — runs as rows (Q27), the store the runs API is built on.

Over migration 0041's `tasks` columns for signed-in runs; in memory for
anonymous runs. Wave 3b-B implements the Postgres version and builds the
runs API on this interface; `InMemoryRunRepository` below is the
reference fake (and accepts anonymous owners, so it can also back the
anonymous store once given a TTL).

Two kinds of method:

  * **owner-scoped** (`create`, `get`, `list_runs`, `cancel`) — what a caller
    of the API may do with *their* runs. A run that is not the owner's is
    indistinguishable from one that does not exist (`get` / `cancel`
    return None, `list_runs` omits it). Postgres: `create` calls the
    `create_run` RPC as the user (`store._set_user_context`); the reads
    and `cancel` filter on `user_id` (RLS on top).
  * **system** (`mark_running`, `settle`, `heartbeat`, `reap_expired`) —
    what the process executing a run does, by run id alone. Postgres: the
    DSN role, like the workers today (0034: users cannot write these
    columns).

Status transitions (`tasks.status`; the contract status is derived, see
`model.contract_status`) — anything else is refused:

    create:       → queued (background) | running (interactive)
    mark_running: queued → running                          (background worker)
    settle:       queued | running → done | failed | cancelled | paused
                  (paused = Interrupted; writes `outcome`, `finished_at`)
    cancel:       queued | running | paused → cancelled     (owner; idempotent;
                                                              background: the whole task, Q60)
    reap_expired: running (interactive, lease lapsed) → failed `worker_lost`

`mark_answers_applied` changes no status: it stamps a live interactive
resume as having applied its answers (Q63), which keeps the question it
answers closed whatever becomes of the run.

Wave 6 (contract 0.5.0, migration 0047) adds two owner-scoped writes,
specified here and implemented by wave 6-A (they raise
`NotImplementedError` until then): `answer_in_place` (a sub-agent run's
question, Q59) and `mark_delivered` (a finished task's result, Q77). The
`RunFilter` task filters (`top_level`, `current`, `root_run_id`,
`delivered`) are likewise 6-A's: a repository raises
`NotImplementedError` for a filter it does not implement yet.

The background-only transitions the existing executor makes (paused →
running for a legacy respond or a fan-in; the barrier's counters) stay
in `store.py` / `barrier.py` and are not part of this interface.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Protocol

from .model import (
    Cancelled,
    ContractStatus,
    Failed,
    Interrupted,
    RunMode,
    RunOutcome,
    RunOwner,
    RunRecord,
    Succeeded,
    outcome_to_json,
)

__all__ = [
    "AnswerInvalid",
    "CreateResult",
    "InMemoryRunRepository",
    "InvalidPageToken",
    "PreviousRunAlreadyAnswered",
    "PreviousRunAlreadyResumed",
    "PreviousRunAnswerApplied",
    "PreviousRunNotFound",
    "PreviousRunNotWaiting",
    "QuestionAlreadyAnswered",
    "RunFilter",
    "RunIdConflict",
    "RunNotAnswerable",
    "RunNotDeliverable",
    "RunPage",
    "RunRepository",
    "RunSpec",
    "ThreadNotFound",
]

DEFAULT_LEASE_SECONDS = 120.0
"""Interactive lease when `RunSpec.lease_seconds` is None (0041's default)."""


class RunIdConflict(Exception):
    """The run id is taken and this create is not an idempotent retry of
    it — another owner's run, or the owner's run on another thread / in
    another mode. Carries nothing about the existing run (API: 409
    `run_id_conflict`, the same body in every case)."""


class ThreadNotFound(Exception):
    """Background create on a thread that is not one of the owner's synced
    conversations (API: 404 `not_found`)."""


class PreviousRunNotFound(Exception):
    """`previous_run_id` is not one of the owner's runs on the same thread
    (API: 409 `invalid_state`)."""


class PreviousRunNotWaiting(Exception):
    """`previous_run_id` can't be resumed by this run, re-checked with the
    insert: it isn't paused (cancelled meanwhile, Q60), doesn't wait on
    these questions, has the other mode or is a sub-agent run (Q59)
    (API: 409 `invalid_state`)."""


class PreviousRunAlreadyResumed(Exception):
    """Another run already answers `previous_run_id`: one that has not
    failed or been cancelled (0042's `tasks_one_live_resume`), or — a
    background run — one that applied the answer before it failed (Q57,
    0045) — so an approved tool cannot run twice
    (API: 409 `run_already_resumed`)."""


class PreviousRunAnswerApplied(Exception):
    """An interactive resume of `previous_run_id` applied its answers (an
    approved tool may have run) and then failed or was cancelled (Q63,
    0046): the question can't be answered again — the turn is sent again
    as a new message instead (API: 409 `run_answer_applied`)."""


class PreviousRunAlreadyAnswered(Exception):
    """One of the questions is being answered through the old
    `/api/tasks/:id/respond` (a queued or running `respond` job for it,
    0045) — each question is answered once, Q58
    (API: 409 `run_already_answered`)."""


class RunNotAnswerable(Exception):
    """`answer_in_place` on a run that can't be answered in place: not a
    sub-agent run (Q59 — a top-level run is answered by a resume), or no
    longer waiting on that question (cancelled, ended, another question)
    (API: 409 `invalid_state`)."""


class QuestionAlreadyAnswered(Exception):
    """`answer_in_place` on a question an accepted answer already holds —
    a queued or running `respond` job for it (0045's "answered once", Q58)
    (API: 409 `run_already_answered`)."""


class AnswerInvalid(Exception):
    """`answer_in_place` answers that don't fit the run's open interrupts:
    not exactly one entry per open interrupt, or a payload the interrupt
    can't take (an approval without a boolean `approved`)
    (API: 400 `invalid_request`)."""


class RunNotDeliverable(Exception):
    """`mark_delivered` on a run that is not a task's root (a resume, a
    sub-agent run, an interactive run), or whose task has not ended
    (`mark_task_delivered` 55000, 0047) (API: 409 `invalid_state`)."""


class InvalidPageToken(Exception):
    """A `page_token` this repository did not issue for these filters
    (API: 400 `invalid_request`)."""


@dataclass(frozen=True)
class RunSpec:
    """A run to create. Mirrors `create_run`'s parameters (0041)."""

    run_id: str
    thread_id: str
    mode: RunMode
    goal: str | None = None
    previous_run_id: str | None = None
    max_steps: int | None = None
    """1..50. Required for background runs."""
    checkpoint: dict[str, object] | None = None
    """Background: required, `{messages: [...], config: {...}}` (the
    worker's start state). Interactive: optional harness state."""
    lease_seconds: float | None = None
    """Interactive: initial lease (clamped to 10..3600; None → 120)."""


@dataclass(frozen=True)
class CreateResult:
    run: RunRecord
    created: bool
    """False for an idempotent retry: `run` is the existing run, unchanged."""


@dataclass(frozen=True)
class RunFilter:
    """`listRuns` filters; every set field must match."""

    thread_id: str | None = None
    statuses: frozenset[ContractStatus] = frozenset()
    """Contract statuses; empty = any."""
    parent_run_id: str | None = None
    mode: RunMode | None = None
    # --- Task filters (contract 0.5.0; RUN_EVENTS.md § 4.5). None = no
    # filter; False selects the opposite set.
    top_level: bool | None = None
    """True: `parent_run_id` is None; False: sub-agent runs only."""
    current: bool | None = None
    """True: runs that are their task's current run
    (`public.task_run_is_current`); False: the others."""
    root_run_id: str | None = None
    """Only the runs of this task (`tasks.root_run_id`)."""
    delivered: bool | None = None
    """True / False: the task's root has / hasn't `result_delivered_at`."""

    @property
    def has_task_filters(self) -> bool:
        return (
            self.top_level is not None
            or self.current is not None
            or self.root_run_id is not None
            or self.delivered is not None
        )

    def fingerprint(self) -> str:
        parts: list[object] = [self.thread_id, sorted(self.statuses), self.parent_run_id, self.mode]
        if self.has_task_filters:
            # Appended only when set, so a page token issued before 0.5.0
            # for the same filters stays valid.
            parts += [self.top_level, self.current, self.root_run_id, self.delivered]
        raw = json.dumps(parts, separators=(",", ":"))
        return hashlib.sha256(raw.encode()).hexdigest()[:16]


@dataclass(frozen=True)
class RunPage:
    runs: tuple[RunRecord, ...]
    next_page_token: str | None


class RunRepository(Protocol):
    async def create(self, owner: RunOwner, spec: RunSpec) -> CreateResult:
        """Create the run, idempotent on `spec.run_id` (`create_run`):

        * new id → the new run, `created=True`;
        * the owner's run with the same `thread_id` and `mode` → that run
          unchanged, `created=False` — nothing else in `spec` is compared
          or applied (the first request wins), and nothing is validated
          first, so a retry cannot fail on state that changed since;
        * anything else → `RunIdConflict`.

        Background: the owner must be a user and `thread_id` one of their
        conversations (`ThreadNotFound`); `max_steps` and `checkpoint` are
        required (`ValueError`). Created `queued`; the caller then appends
        `status: queued` as seq 1 and enqueues the `start` job
        (`enqueue_task_job`) — Postgres does both in the create's own
        transaction. Interactive: created `running` with a lease;
        an anonymous owner may only create interactive runs (`ValueError`).
        `previous_run_id`, when set, must be the owner's run on the same
        thread (`PreviousRunNotFound`), and no other run that is not
        `failed` / `cancelled` may have it as its previous run
        (`PreviousRunAlreadyResumed`), and it must still be paused, in
        the same mode and top-level (`PreviousRunNotWaiting`) — checked
        atomically with the insert, so two concurrent resumes cannot both
        be created and a cancel can't be raced. An interactive resume
        whose earlier resume applied the answers and then ended is
        `PreviousRunAnswerApplied` (Q63)."""
        ...

    async def get(self, owner: RunOwner, run_id: str) -> RunRecord | None:
        """The owner's run, or None (missing and not-yours alike)."""
        ...

    async def list_runs(
        self,
        owner: RunOwner,
        filt: RunFilter,
        *,
        page_size: int = 20,
        page_token: str | None = None,
    ) -> RunPage:
        """The owner's runs matching `filt`, newest first (`created_at`
        desc, then `id` desc), keyset-paged: a page is stable under
        concurrent inserts. `page_token` must come from a previous page
        with the same filters (`InvalidPageToken` otherwise).
        `page_size` 1..100 (`ValueError`). Anonymous owners list
        nothing."""
        ...

    async def cancel(self, owner: RunOwner, run_id: str) -> RunRecord | None:
        """Cancel the owner's run (`queued` / `running` / `paused` →
        `cancelled`, outcome `cancelled`, `finished_at` now, lease
        cleared) and return it as it now stands; an ended run is returned
        unchanged. None when it is not the owner's. Idempotent. The
        caller appends `status: cancelled` to the log when this call made
        the change, and signals the executing harness if it is local; a
        harness in another process notices on its next `heartbeat`
        (False) or cancellation check."""
        ...

    async def answer_in_place(
        self, owner: RunOwner, run_id: str, resume: Sequence[Mapping[str, object]]
    ) -> RunRecord | None:
        """Answer the open interrupt(s) of the owner's **sub-agent** run
        `run_id` in place (Q59, `answerRun`, RUN_EVENTS.md § 4.4): one
        AG-UI `ResumeEntry` (JSON) per open interrupt, each queued as a
        `respond` job whose payload is `in_place.respond_job_payload(entry)`
        through `enqueue_task_job` as the user (0045: the run still waits
        on that question, answered once, 20 queued jobs per user). Returns
        the run as it now stands (`answer_pending` True); None when it is
        not the owner's. Raises `RunNotAnswerable`, `QuestionAlreadyAnswered`,
        `AnswerInvalid`, or `RunWriteError` (Postgres: 54000 →
        `limit_reached`). Wave 6-A."""
        ...

    async def mark_delivered(self, owner: RunOwner, run_id: str) -> RunRecord | None:
        """Mark the owner's task, whose root run is `run_id`, delivered
        (Q77, `markRunDelivered`): `public.mark_task_delivered` as the user
        (0047), idempotent. Returns the root run (`delivered` True); None
        when it is not the owner's. Raises `RunNotDeliverable`. Wave 6-A."""
        ...

    async def load_checkpoint(self, owner: RunOwner, run_id: str) -> dict[str, object] | None:
        """The harness state stored on `owner`'s run `run_id`
        (`tasks.checkpoint`): what an `Interrupted` settle stored, for the
        run that answers it (Q24, Q31). None when the run is not the
        owner's, or holds none."""
        ...

    async def mark_running(self, run_id: str) -> bool:
        """`queued` → `running` (a background worker picking it up). False
        when the run is not `queued`."""
        ...

    async def mark_answers_applied(self, run_id: str) -> bool:
        """A live interactive resume commits to its answers, durably,
        before any of them takes effect (Q63, `tasks.answers_applied_at`):
        from then on the question it answers can't be answered again,
        however the run ends. Idempotent. False when the run is no longer
        live (cancelled or reaped first): apply nothing."""
        ...

    async def settle(
        self,
        run_id: str,
        outcome: RunOutcome,
        *,
        checkpoint: dict[str, object] | None = None,
    ) -> bool:
        """End a live run: `Succeeded` → `done`, `Failed` → `failed`,
        `Cancelled` → `cancelled`, `Interrupted` → `paused`; stores
        `outcome_to_json(outcome)` in `outcome`, sets `finished_at`, clears
        the lease. `checkpoint`, when given, replaces the stored harness
        state (`tasks.checkpoint`) in the same write — the state an
        `Interrupted` run's answer continues from; None leaves it as it
        is. Only from `queued` / `running` — returns False and
        changes nothing otherwise (a concurrent `cancel` or reap won: the
        caller must not append its own terminal entry then)."""
        ...

    async def heartbeat(self, run_id: str, *, lease_seconds: float = DEFAULT_LEASE_SECONDS) -> bool:
        """Extend a live interactive run's lease to now + `lease_seconds`.
        False when the run is no longer live (cancelled elsewhere, reaped)
        — the executing process must then stop the harness."""
        ...

    async def reap_expired(self, *, limit: int = 50) -> list[RunRecord]:
        """Fail live interactive runs whose lease has lapsed (their process
        died, Q28): `failed`, outcome `error` / `worker_lost`. Returns the
        reaped runs (as now stored); the caller appends each one's
        terminal `result` entry and seals its log."""
        ...


# --- Fake ----------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass
class _Row:
    record: RunRecord
    checkpoint: dict[str, object] | None = None
    outcome: dict[str, object] | None = None
    max_steps: int = 25
    answers_applied_at: datetime | None = None
    extra: dict[str, object] = field(default_factory=dict)


class InMemoryRunRepository:
    """`RunRepository` in memory, with the same rules as the Postgres
    version (0041's `create_run` + the transitions above). For tests.

    `conversations` maps a user id to the thread ids that are synced
    conversations of theirs (background runs need one). `clock` is
    injectable so lease and ordering tests are deterministic."""

    WORKER_LOST_MESSAGE = "The run's process stopped unexpectedly."

    def __init__(
        self,
        *,
        conversations: Mapping[str, set[str]] | None = None,
        clock: Callable[[], datetime] = _now,
    ) -> None:
        self._rows: dict[str, _Row] = {}
        self._conversations = conversations if conversations is not None else {}
        self._clock = clock

    # -- helpers --

    def checkpoint_of(self, run_id: str) -> dict[str, object] | None:
        """Test hook: the stored harness state."""
        row = self._rows.get(run_id)
        return None if row is None else row.checkpoint

    def outcome_of(self, run_id: str) -> dict[str, object] | None:
        """Test hook: the stored `outcome` jsonb."""
        row = self._rows.get(run_id)
        return None if row is None else row.outcome

    def _owned(self, owner: RunOwner, run_id: str) -> _Row | None:
        row = self._rows.get(run_id)
        if row is None or row.record.owner != owner:
            return None
        return row

    def _set(self, row: _Row, **changes: object) -> RunRecord:
        row.record = replace(row.record, updated_at=self._clock(), **changes)  # type: ignore[arg-type]
        return row.record

    def _apply_outcome(self, row: _Row, outcome: RunOutcome) -> RunRecord:
        row.outcome = outcome_to_json(outcome)
        now = self._clock()
        common: dict[str, object] = {"finished_at": now, "lease_expires_at": None}
        if isinstance(outcome, Succeeded):
            return self._set(row, internal_status="done", result=outcome.result.to_json(), **common)
        if isinstance(outcome, Failed):
            return self._set(
                row,
                internal_status="failed",
                error={"code": outcome.code, "message": outcome.message},
                **common,
            )
        if isinstance(outcome, Interrupted):
            return self._set(
                row,
                internal_status="paused",
                open_interrupts=tuple(i.to_agui() for i in outcome.interrupts),
                **common,
            )
        return self._set(row, internal_status="cancelled", open_interrupts=(), **common)

    # -- owner-scoped --

    async def create(self, owner: RunOwner, spec: RunSpec) -> CreateResult:
        existing = self._rows.get(spec.run_id)
        if existing is not None:
            rec = existing.record
            if rec.owner == owner and rec.thread_id == spec.thread_id and rec.mode == spec.mode:
                return CreateResult(rec, created=False)
            raise RunIdConflict()

        prev_row: _Row | None = None
        if spec.previous_run_id is not None:
            prev = prev_row = self._owned(owner, spec.previous_run_id)
            if prev is None or prev.record.thread_id != spec.thread_id:
                raise PreviousRunNotFound()
            # 0042's `tasks_one_live_resume`; no await between this check
            # and the insert below, so it is atomic in one event loop.
            if any(
                row.record.previous_run_id == spec.previous_run_id
                and row.record.internal_status not in ("failed", "cancelled")
                for row in self._rows.values()
            ):
                raise PreviousRunAlreadyResumed()
            if (
                prev.record.internal_status != "paused"
                or prev.record.mode != spec.mode
                or prev.record.parent_run_id is not None
            ):
                raise PreviousRunNotWaiting("previous run is not waiting on these answers")
            # 0046 (Q63): an interactive resume that applied the answers
            # and then ended keeps the question closed.
            if spec.mode == "interactive" and any(
                row.record.previous_run_id == spec.previous_run_id
                and row.answers_applied_at is not None
                and row.record.internal_status in ("failed", "cancelled")
                for row in self._rows.values()
            ):
                raise PreviousRunAnswerApplied()

        now = self._clock()
        if spec.mode == "background":
            if owner.user_id is None:
                raise ValueError("anonymous runs are interactive only")
            if spec.max_steps is None or not 1 <= spec.max_steps <= 50:
                raise ValueError("max_steps must be between 1 and 50")
            cp = spec.checkpoint
            if (
                cp is None
                or not isinstance(cp.get("messages"), list)
                or not isinstance(cp.get("config"), dict)
            ):
                raise ValueError("invalid checkpoint")
            if spec.thread_id not in self._conversations.get(owner.user_id, set()):
                raise ThreadNotFound()
            config = dict(cp["config"])  # type: ignore[call-overload]
            config["maxSteps"] = spec.max_steps
            prev_record = None if prev_row is None else prev_row.record
            record = RunRecord(
                id=spec.run_id,
                owner=owner,
                thread_id=spec.thread_id,
                mode="background",
                internal_status="queued",
                created_at=now,
                updated_at=now,
                started_at=now,
                previous_run_id=spec.previous_run_id,
                goal=(spec.goal or "")[:2000],
                max_steps=spec.max_steps,
                step=0,
                # 0047's `tasks_identity` trigger.
                root_run_id=_root_of(prev_record, spec.run_id),
                research=(prev_record is not None and prev_record.research)
                or config.get("mode") == "research",
            )
            row = _Row(
                record,
                checkpoint={**cp, "step": 0, "seq": 1, "config": config},
                max_steps=spec.max_steps,
            )
        else:
            if spec.max_steps is not None and not 1 <= spec.max_steps <= 50:
                raise ValueError("max_steps must be between 1 and 50")
            lease = min(max(spec.lease_seconds or DEFAULT_LEASE_SECONDS, 10.0), 3600.0)
            record = RunRecord(
                id=spec.run_id,
                owner=owner,
                thread_id=spec.thread_id,
                mode="interactive",
                internal_status="running",
                created_at=now,
                updated_at=now,
                started_at=now,
                previous_run_id=spec.previous_run_id,
                goal=None if spec.goal is None else spec.goal[:2000],
                max_steps=spec.max_steps or 25,
                step=0,
                lease_expires_at=now + timedelta(seconds=lease),
                root_run_id=_root_of(None if prev_row is None else prev_row.record, spec.run_id),
            )
            row = _Row(record, checkpoint=spec.checkpoint, max_steps=spec.max_steps or 25)
        self._rows[spec.run_id] = row
        return CreateResult(record, created=True)

    async def get(self, owner: RunOwner, run_id: str) -> RunRecord | None:
        row = self._owned(owner, run_id)
        return None if row is None else row.record

    async def list_runs(
        self,
        owner: RunOwner,
        filt: RunFilter,
        *,
        page_size: int = 20,
        page_token: str | None = None,
    ) -> RunPage:
        if not 1 <= page_size <= 100:
            raise ValueError("page_size must be between 1 and 100")
        if filt.has_task_filters:
            raise NotImplementedError("listRuns task filters: wave 6-A")
        after: tuple[str, str] | None = None
        if page_token is not None:
            after = _decode_token(page_token, filt.fingerprint())
        if owner.is_anonymous:
            return RunPage((), None)

        def matches(r: RunRecord) -> bool:
            return (
                r.owner == owner
                and (filt.thread_id is None or r.thread_id == filt.thread_id)
                and (not filt.statuses or r.status in filt.statuses)
                and (filt.parent_run_id is None or r.parent_run_id == filt.parent_run_id)
                and (filt.mode is None or r.mode == filt.mode)
            )

        def key(r: RunRecord) -> tuple[str, str]:
            return (r.created_at.isoformat(), r.id)

        runs = sorted((row.record for row in self._rows.values()), key=key, reverse=True)
        runs = [r for r in runs if matches(r) and (after is None or key(r) < after)]
        page = runs[:page_size]
        token = None
        if len(runs) > page_size:
            token = _encode_token(key(page[-1]), filt.fingerprint())
        return RunPage(tuple(page), token)

    async def cancel(self, owner: RunOwner, run_id: str) -> RunRecord | None:
        row = self._owned(owner, run_id)
        if row is None:
            return None
        if row.record.internal_status in ("queued", "running", "paused"):
            return self._apply_outcome(row, Cancelled())
        return row.record

    async def answer_in_place(
        self, owner: RunOwner, run_id: str, resume: Sequence[Mapping[str, object]]
    ) -> RunRecord | None:
        raise NotImplementedError("answerRun: wave 6-A")

    async def mark_delivered(self, owner: RunOwner, run_id: str) -> RunRecord | None:
        raise NotImplementedError("markRunDelivered: wave 6-A")

    # -- system --

    async def load_checkpoint(self, owner: RunOwner, run_id: str) -> dict[str, object] | None:
        row = self._owned(owner, run_id)
        return None if row is None else row.checkpoint

    async def mark_running(self, run_id: str) -> bool:
        row = self._rows.get(run_id)
        if row is None or row.record.internal_status != "queued":
            return False
        self._set(row, internal_status="running")
        return True

    async def mark_answers_applied(self, run_id: str) -> bool:
        row = self._rows.get(run_id)
        if (
            row is None
            or row.record.mode != "interactive"
            or row.record.internal_status not in ("queued", "running")
        ):
            return False
        if row.answers_applied_at is None:
            row.answers_applied_at = self._clock()
        return True

    async def settle(
        self,
        run_id: str,
        outcome: RunOutcome,
        *,
        checkpoint: dict[str, object] | None = None,
    ) -> bool:
        row = self._rows.get(run_id)
        if row is None or row.record.internal_status not in ("queued", "running"):
            return False
        if checkpoint is not None:
            row.checkpoint = checkpoint
        self._apply_outcome(row, outcome)
        return True

    async def heartbeat(self, run_id: str, *, lease_seconds: float = DEFAULT_LEASE_SECONDS) -> bool:
        row = self._rows.get(run_id)
        if row is None or row.record.mode != "interactive" or not row.record.is_live:
            return False
        self._set(row, lease_expires_at=self._clock() + timedelta(seconds=lease_seconds))
        return True

    async def reap_expired(self, *, limit: int = 50) -> list[RunRecord]:
        now = self._clock()
        expired = sorted(
            (
                row
                for row in self._rows.values()
                if row.record.mode == "interactive"
                and row.record.internal_status in ("queued", "running")
                and row.record.lease_expires_at is not None
                and row.record.lease_expires_at < now
            ),
            key=lambda r: r.record.lease_expires_at or now,
        )[:limit]
        return [
            self._apply_outcome(row, Failed("worker_lost", self.WORKER_LOST_MESSAGE))
            for row in expired
        ]


def _root_of(previous: RunRecord | None, run_id: str) -> str:
    """A new run's task root: its previous run's, else itself (0047)."""
    if previous is None:
        return run_id
    return previous.root_run_id or previous.id


def _encode_token(key: tuple[str, str], fingerprint: str) -> str:
    raw = json.dumps({"c": key[0], "i": key[1], "f": fingerprint}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_token(token: str, fingerprint: str) -> tuple[str, str]:
    try:
        padded = token + "=" * (-len(token) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()))
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        raise InvalidPageToken() from exc
    if (
        not isinstance(data, dict)
        or data.get("f") != fingerprint
        or not isinstance(data.get("c"), str)
        or not isinstance(data.get("i"), str)
    ):
        raise InvalidPageToken()
    return (data["c"], data["i"])

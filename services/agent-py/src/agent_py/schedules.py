"""Recurring task runs (`task_schedules`) — the Python port of
`lib/server/agent/schedules.ts` + `schedule-codec.ts`.

  - `validate_schedule_cron` / `cron_passes_coarse_guard` — what the
    create / update routes check (identical results to the TS functions;
    see `cron.py` and `tests/test_cron_parity.py`).
  - `parse_schedule_body` — the `ScheduleCreateSchema` /
    `ScheduleUpdateSchema` (Zod) request validation, first-issue message
    and all, so a bad body gets the same 400 from either backend.
  - `row_to_schedule` — row → wire codec (`rowToSchedule`).
  - `dispatch_due_schedules` — the dispatcher the Vercel Cron's
    `/api/tasks/jobs/tick` runs (`dispatchDueSchedules`), ported
    faithfully: same due-row window and ordering, same fair batch, same
    minimum-gap deferral, same invalid-cron disable, the same guarded
    `next_run_at` claim (so this and the Vercel Cron can run side by side
    and still fire each occurrence once), and the same rows written per
    fire. The writes go through `PgScheduleStore` as the DSN role (RLS
    bypassed, like the service-role client the tick uses).
"""

from __future__ import annotations

import json
import math
import re
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from typing import Any, Final, Protocol

import asyncpg
import structlog

from . import jobs
from .cron import JS_WHITESPACE_CLASS, js_split_whitespace, next_run_from_cron, parse_cron

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Cron validation (`validateScheduleCron`, `cronPassesCoarseGuard`)
# ---------------------------------------------------------------------------

SCHEDULE_MIN_INTERVAL_MS: Final = 5 * 60_000
"""Route-side floor between two fires of one schedule."""

SCHEDULE_DISPATCH_MIN_GAP_MS: Final = 4 * 60_000
"""Dispatcher-side floor: the route's 5 minutes minus one tick of slack."""

_CRON_GAP_SAMPLE: Final = 48

_COARSE_LIST = re.compile(r"[0-5]?[0-9](,[0-5]?[0-9]){0,11}", re.ASCII)
_COARSE_STEP = re.compile(r"(\*|[0-5]?[0-9]-[0-5]?[0-9]|[0-5]?[0-9])/([5-9]|[1-5][0-9])", re.ASCII)


def cron_passes_coarse_guard(cron: str) -> bool:
    """Mirror of the DB's `private.task_schedule_cron_coarse_ok` (0035) as
    the TS routes implement it: five fields, and a minute field that fires
    at most 12 times an hour."""
    fields = js_split_whitespace(cron)
    if len(fields) != 5:
        return False
    minute = fields[0]
    return bool(_COARSE_LIST.fullmatch(minute) or _COARSE_STEP.fullmatch(minute))


@dataclass(frozen=True)
class CronValidation:
    ok: bool
    next: datetime | None = None
    message: str = ""


def validate_schedule_cron(cron: str, timezone: str, after: datetime) -> CronValidation:
    """Parseable, passes the coarse guard, and never fires twice within
    five minutes (over the next 48 fires). Returns the first fire."""
    try:
        it = parse_cron(cron, timezone=timezone, current_date=after)
        fires = [it.next_ms() for _ in range(_CRON_GAP_SAMPLE)]
    except Exception:
        return CronValidation(
            ok=False, message=f'Couldn\'t parse cron "{cron}" with timezone "{timezone}".'
        )
    too_frequent = CronValidation(
        ok=False,
        message=(
            f'Cron "{cron}" fires more often than every '
            f"{SCHEDULE_MIN_INTERVAL_MS // 60_000} minutes."
        ),
    )
    if not cron_passes_coarse_guard(cron):
        return too_frequent
    for prev, cur in pairwise(fires):
        if cur - prev < SCHEDULE_MIN_INTERVAL_MS:
            return too_frequent
    return CronValidation(ok=True, next=_ms_to_datetime(fires[0]))


def _ms_to_datetime(ms: int) -> datetime:
    return datetime(1970, 1, 1, tzinfo=UTC) + timedelta(milliseconds=ms)


def truncate_to_ms(value: datetime) -> datetime:
    """JS `Date` precision: the TS side writes millisecond timestamps."""
    return value.replace(microsecond=value.microsecond - value.microsecond % 1000)


# ---------------------------------------------------------------------------
# Request bodies (`ScheduleCreateSchema` / `ScheduleUpdateSchema`)
# ---------------------------------------------------------------------------


class ScheduleBodyError(ValueError):
    """First validation issue, worded like Zod v4's (`issues[0].message`)."""


_MISSING: Final = object()

_WS: Final = JS_WHITESPACE_CLASS
_NON_WS: Final = "[^" + JS_WHITESPACE_CLASS[1:]
# `/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/` with JS's `\s`.
_CRON_SHAPE = re.compile(
    f"{_NON_WS}+{_WS}+{_NON_WS}+{_WS}+{_NON_WS}+{_WS}+{_NON_WS}+{_WS}+{_NON_WS}+"
)
_CRON_SHAPE_MESSAGE: Final = "Cron must be 5 space-separated fields (e.g. '0 8 * * *')."


def _received(value: object) -> str:
    if value is _MISSING:
        return "undefined"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    return "object"


def _expected(kind: str, value: object) -> ScheduleBodyError:
    return ScheduleBodyError(f"Invalid input: expected {kind}, received {_received(value)}")


def _check_string(value: object, *, min_len: int | None = None, max_len: int | None = None) -> str:
    if not isinstance(value, str):
        raise _expected("string", value)
    # Zod v4 counts code points, like `len`.
    if min_len is not None and len(value) < min_len:
        raise ScheduleBodyError(f"Too small: expected string to have >={min_len} characters")
    if max_len is not None and len(value) > max_len:
        raise ScheduleBodyError(f"Too big: expected string to have <={max_len} characters")
    return value


def _check_int(value: object, *, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise _expected("number", value)
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        raise ScheduleBodyError("Invalid input: expected int, received number")
    n = int(value)
    if n < lo:
        raise ScheduleBodyError(f"Too small: expected number to be >={lo}")
    if n > hi:
        raise ScheduleBodyError(f"Too big: expected number to be <={hi}")
    return n


def _check_bool(value: object) -> bool:
    if not isinstance(value, bool):
        raise _expected("boolean", value)
    return value


def _check_enum(value: object, options: Sequence[str]) -> str:
    if not isinstance(value, str) or value not in options:
        quoted = "|".join(f'"{o}"' for o in options)
        raise ScheduleBodyError(f"Invalid option: expected one of {quoted}")
    return value


def _check_object(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _expected("object", value)
    return value


def _max_calls_config(value: object) -> dict[str, Any]:
    obj = _check_object(value)
    out: dict[str, Any] = {}
    if "maxCalls" in obj:
        out["maxCalls"] = _check_int(obj["maxCalls"], lo=1, hi=50)
    return out


def _provider_config(value: object, key: str, options: Sequence[str]) -> dict[str, Any]:
    obj = _check_object(value)
    out: dict[str, Any] = {}
    if "enabled" in obj:
        out["enabled"] = _check_bool(obj["enabled"])
    if key in obj:
        out[key] = _check_enum(obj[key], options)
    return out


def _web_search_config(value: object) -> dict[str, Any]:
    obj = _check_object(value)
    out: dict[str, Any] = {}
    if "maxCalls" in obj:
        out["maxCalls"] = _check_int(obj["maxCalls"], lo=1, hi=50)
    if "tavily" in obj:
        out["tavily"] = _provider_config(obj["tavily"], "searchDepth", ("basic", "advanced"))
    if "brave" in obj:
        out["brave"] = _provider_config(obj["brave"], "freshness", ("any", "pd", "pw", "pm", "py"))
    if "exa" in obj:
        out["exa"] = _provider_config(obj["exa"], "type", ("auto", "neural", "keyword"))
    return out


_ASPECT_RATIOS: Final = ("1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2")


def _skill(value: object) -> dict[str, Any]:
    """One `ChatRequestSchema.shape.skills` entry; unknown keys stripped."""
    obj = _check_object(value)
    out: dict[str, Any] = {"id": _check_string(obj.get("id", _MISSING), max_len=40)}
    if "webSearchConfig" in obj:
        out["webSearchConfig"] = _web_search_config(obj["webSearchConfig"])
    if "webFetchConfig" in obj:
        out["webFetchConfig"] = _max_calls_config(obj["webFetchConfig"])
    if "imageGenConfig" in obj:
        cfg = _check_object(obj["imageGenConfig"])
        image: dict[str, Any] = {}
        if "maxCalls" in cfg:
            image["maxCalls"] = _check_int(cfg["maxCalls"], lo=1, hi=50)
        if "aspectRatio" in cfg:
            image["aspectRatio"] = _check_enum(cfg["aspectRatio"], _ASPECT_RATIOS)
        out["imageGenConfig"] = image
    if "fileSearchConfig" in obj:
        out["fileSearchConfig"] = _max_calls_config(obj["fileSearchConfig"])
    return out


def _skills(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise _expected("array", value)
    if len(value) > 10:
        raise ScheduleBodyError("Too big: expected array to have <=10 items")
    return [_skill(item) for item in value]


def _cron(value: object) -> str:
    cron = _check_string(value, min_len=1, max_len=100)
    if not _CRON_SHAPE.fullmatch(cron):
        raise ScheduleBodyError(_CRON_SHAPE_MESSAGE)
    return cron


def parse_schedule_body(raw: object, *, partial: bool) -> dict[str, Any]:
    """Validate a create (`partial=False`) or update (`partial=True`)
    body. Returns the parsed object (camelCase keys, unknown keys
    dropped, absent optionals absent); raises `ScheduleBodyError` with
    the first issue, in the schema's key order like Zod."""
    body = _check_object(raw)
    out: dict[str, Any] = {}

    def field(key: str, required: bool, check: Any) -> None:
        if key in body:
            out[key] = check(body[key])
        elif required and not partial:
            check(_MISSING)

    def nullable(check: Any) -> Any:
        return lambda v: None if v is None else check(v)

    field("workspaceId", True, lambda v: _check_string(v, min_len=1, max_len=64))
    field("name", True, lambda v: _check_string(v, min_len=1, max_len=200))
    field("prompt", True, lambda v: _check_string(v, min_len=1, max_len=20_000))
    field("cron", True, _cron)
    field("timezone", False, lambda v: _check_string(v, min_len=1, max_len=100))
    field("enabled", False, _check_bool)
    field("model", False, nullable(lambda v: _check_string(v, max_len=100)))
    field("systemPrompt", False, nullable(lambda v: _check_string(v, max_len=20_000)))
    field("skills", False, _skills)
    field("maxSteps", False, nullable(lambda v: _check_int(v, lo=1, hi=50)))
    return out


# ---------------------------------------------------------------------------
# Row ↔ wire codec (`rowToSchedule`)
# ---------------------------------------------------------------------------


def pg_timestamp(value: datetime) -> str:
    """A timestamptz the way PostgREST renders it (`to_json`): ISO 8601,
    fractional seconds without trailing zeros, `+00:00`."""
    value = value.astimezone(UTC)
    base = value.strftime("%Y-%m-%dT%H:%M:%S")
    if value.microsecond:
        base += "." + f"{value.microsecond:06d}".rstrip("0")
    return base + "+00:00"


def _jsonb(value: object) -> object:
    return json.loads(value) if isinstance(value, str) else value


def row_to_schedule(row: Any) -> dict[str, Any]:
    """`task_schedules` row → `ScheduleResponse` (camelCase). `skills` is
    omitted when null, as `rowToSchedule` maps it to `undefined`."""
    out: dict[str, Any] = {
        "id": str(row["id"]),
        "workspaceId": str(row["workspace_id"]),
        "name": row["name"],
        "prompt": row["prompt"],
        "cron": row["cron"],
        "timezone": row["timezone"],
        "enabled": row["enabled"],
        "model": row["model"],
        "systemPrompt": row["system_prompt"],
    }
    skills = _jsonb(row["skills"])
    if skills is not None:
        out["skills"] = skills
    out.update(
        {
            "maxSteps": row["max_steps"],
            "lastRunAt": None if row["last_run_at"] is None else pg_timestamp(row["last_run_at"]),
            "lastRunTaskId": None
            if row["last_run_task_id"] is None
            else str(row["last_run_task_id"]),
            "nextRunAt": pg_timestamp(row["next_run_at"]),
            "createdAt": pg_timestamp(row["created_at"]),
            "updatedAt": pg_timestamp(row["updated_at"]),
        }
    )
    return out


# ---------------------------------------------------------------------------
# Dispatcher (`dispatchDueSchedules`)
# ---------------------------------------------------------------------------

DUE_FETCH_LIMIT: Final = 500
"""Due rows read per tick."""
TICK_MAX_FIRES: Final = 50
"""Fires per tick, across all users."""
TICK_MAX_FIRES_PER_USER: Final = 5
"""Fires per tick for any one user."""
DEFAULT_MAX_STEPS: Final = 25
"""`row.max_steps ?? 25` in `fireSchedule`."""


@dataclass(frozen=True)
class DueSchedule:
    """The columns of a due `task_schedules` row the dispatcher reads."""

    id: str
    user_id: str
    workspace_id: str
    name: str
    prompt: str
    cron: str
    timezone: str
    model: str | None
    system_prompt: str | None
    skills: object
    max_steps: int | None
    last_run_at: datetime | None
    next_run_at: datetime


class _HasUser(Protocol):
    @property
    def user_id(self) -> str: ...


def pick_fair_batch[R: _HasUser](
    rows: Iterable[R], *, max_total: int, max_per_user: int
) -> list[R]:
    """Round-robin across users (each user's rows in the given order), at
    most `max_per_user` each and `max_total` overall; users are visited in
    order of their first row. Port of `pickFairBatch`."""
    by_user: dict[str, list[R]] = {}
    for row in rows:
        by_user.setdefault(row.user_id, []).append(row)
    picked: list[R] = []
    for round_ in range(max_per_user):
        progressed = False
        for user_rows in by_user.values():
            if len(picked) >= max_total:
                return picked
            if round_ < len(user_rows):
                picked.append(user_rows[round_])
                progressed = True
        if not progressed:
            break
    return picked


class ScheduleStore(Protocol):
    """The writes `dispatch_due_schedules` makes. `PgScheduleStore` is the
    real one; tests use an in-memory fake with the same guard semantics."""

    async def fetch_due(self, now: datetime, limit: int) -> list[DueSchedule]: ...

    async def defer(self, row: DueSchedule, *, next_run_at: datetime, now: datetime) -> None:
        """Guarded on `row.next_run_at`."""

    async def disable(self, row: DueSchedule, *, now: datetime) -> None: ...

    async def claim(self, row: DueSchedule, *, next_run_at: datetime, now: datetime) -> bool:
        """Guarded on `row.next_run_at`; True iff this call moved the row."""

    async def fire(self, row: DueSchedule, *, run_id: str, conversation_id: str) -> None: ...

    async def set_last_run_task(self, row: DueSchedule, *, run_id: str) -> None: ...


async def dispatch_due_schedules(store: ScheduleStore, *, now: datetime | None = None) -> int:
    """Walk the due set and fire a fair batch of it. Returns the number of
    runs enqueued. Raises only when the due-row read fails; every per-row
    write failure is logged and skipped, as on the TS side (supabase-js
    returns those errors instead of throwing, and the tick ignores them)."""
    now = truncate_to_ms(now or datetime.now(UTC))
    due = await store.fetch_due(now, DUE_FETCH_LIMIT)
    if not due:
        return 0
    batch = pick_fair_batch(due, max_total=TICK_MAX_FIRES, max_per_user=TICK_MAX_FIRES_PER_USER)

    fired = 0
    for row in batch:
        # Minimum gap since the last fire, whatever the cron says: defer
        # the row to the end of the gap instead of firing (guarded).
        if row.last_run_at is not None:
            last_run = truncate_to_ms(row.last_run_at)
            if now - last_run < timedelta(milliseconds=SCHEDULE_DISPATCH_MIN_GAP_MS):
                try:
                    await store.defer(
                        row,
                        next_run_at=last_run + timedelta(milliseconds=SCHEDULE_DISPATCH_MIN_GAP_MS),
                        now=now,
                    )
                except Exception as exc:
                    logger.warning("schedules.defer_failed", schedule_id=row.id, error=str(exc))
                continue

        advanced = next_run_from_cron(row.cron, row.timezone, now)
        if advanced is None:
            # Bad cron / tz — disable so it doesn't spin; the user sees the
            # row flip off and can fix + re-enable it.
            try:
                await store.disable(row, now=now)
            except Exception as exc:
                logger.warning("schedules.disable_failed", schedule_id=row.id, error=str(exc))
            continue

        # Re-stamp `next_run_at` first with a guarded update: if another
        # dispatcher (a racing tick, or the Vercel Cron) already moved the
        # row, this touches nothing and the occurrence is not fired again.
        try:
            claimed = await store.claim(row, next_run_at=advanced, now=now)
        except Exception as exc:
            logger.warning("schedules.claim_failed", schedule_id=row.id, error=str(exc))
            claimed = False
        if not claimed:
            continue

        run_id = str(uuid.uuid4())
        try:
            await store.fire(row, run_id=run_id, conversation_id=str(uuid.uuid4()))
        except Exception as exc:
            # `next_run_at` is already pushed forward; the row's
            # `last_run_task_id` stays unchanged.
            logger.error("schedules.fire_failed", schedule_id=row.id, error=str(exc))
            continue
        fired += 1
        try:
            await store.set_last_run_task(row, run_id=run_id)
        except Exception as exc:
            logger.warning("schedules.last_run_task_failed", schedule_id=row.id, error=str(exc))
    return fired


_UNSET_SCHEDULE_SKILLS: Final = ("webSearch", "webFetch", "searchFiles", "imageGen")


def schedule_skills(skills: object) -> object:
    """A schedule's `config.skills` (`scheduleSkills` in TS). The executor
    offers only the skills listed there and the schedule editor doesn't set
    any, so unset is spelled out as all of them; `[]` stays none."""
    if skills is None:
        return [{"id": skill} for skill in _UNSET_SCHEDULE_SKILLS]
    return skills


def build_checkpoint(row: DueSchedule, max_steps: int) -> dict[str, object]:
    """The initial run checkpoint `fireSchedule` writes."""
    config: dict[str, object] = {"model": row.model if row.model is not None else ""}
    if row.system_prompt is not None:
        config["workspaceSystemPrompt"] = row.system_prompt
    config["workspaceId"] = row.workspace_id
    config["skills"] = schedule_skills(row.skills)
    config["maxSteps"] = max_steps
    return {
        "messages": [{"role": "user", "content": row.prompt}],
        "step": 0,
        "seq": 1,
        "config": config,
    }


def js_slice(text: str, end: int) -> str:
    """`text.slice(0, end)` — JS counts UTF-16 code units. A surrogate pair
    split at the boundary is dropped whole (JS would keep a lone high
    surrogate, which Postgres rejects)."""
    if len(text) <= end // 2:
        return text
    units = 0
    for i, ch in enumerate(text):
        units += 2 if ord(ch) > 0xFFFF else 1
        if units > end:
            return text[:i]
    return text


_FETCH_DUE_SQL = """
SELECT id, user_id, workspace_id, name, prompt, cron, timezone, model,
       system_prompt, skills::text AS skills, max_steps, last_run_at, next_run_at
FROM public.task_schedules
WHERE enabled = true AND next_run_at <= $1
ORDER BY next_run_at ASC
LIMIT $2;
"""

_DEFER_SQL = """
UPDATE public.task_schedules
SET next_run_at = $3, updated_at = $4
WHERE id = $1 AND user_id = $2 AND next_run_at = $5;
"""

_DISABLE_SQL = """
UPDATE public.task_schedules
SET enabled = false, updated_at = $3
WHERE id = $1 AND user_id = $2;
"""

_CLAIM_SQL = """
UPDATE public.task_schedules
SET next_run_at = $3, last_run_at = $4, updated_at = $4
WHERE id = $1 AND user_id = $2 AND next_run_at = $5
RETURNING id;
"""

_FIRE_CONVERSATION_SQL = """
INSERT INTO public.conversations (id, user_id, workspace_id, title)
VALUES ($1, $2, $3, $4);
"""

# `createRun` in lib/server/agent/store.ts.
_FIRE_TASK_SQL = """
INSERT INTO public.tasks (id, user_id, conversation_id, goal, status, step, max_steps, started_at)
VALUES ($1, $2, $3, $4, 'queued', 0, $5, $6);
"""

# `saveCheckpoint`.
_FIRE_CHECKPOINT_SQL = """
UPDATE public.tasks SET checkpoint = $3::jsonb, updated_at = $4
WHERE id = $1 AND user_id = $2;
"""

# `appendEvent` of the synthetic `status: queued` event.
_FIRE_EVENT_SQL = """
INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload, created_at)
VALUES ($1, $2, 1, 0, 'status', $3::jsonb, $4)
ON CONFLICT (task_id, seq) DO NOTHING;
"""

_SET_LAST_RUN_TASK_SQL = """
UPDATE public.task_schedules SET last_run_task_id = $3
WHERE id = $1 AND user_id = $2;
"""


def _uuid(value: str) -> uuid.UUID:
    return uuid.UUID(value)


def _row_to_due(row: Any) -> DueSchedule:
    return DueSchedule(
        id=str(row["id"]),
        user_id=str(row["user_id"]),
        workspace_id=str(row["workspace_id"]),
        name=row["name"],
        prompt=row["prompt"],
        cron=row["cron"],
        timezone=row["timezone"],
        model=row["model"],
        system_prompt=row["system_prompt"],
        skills=_jsonb(row["skills"]),
        max_steps=row["max_steps"],
        last_run_at=row["last_run_at"],
        next_run_at=row["next_run_at"],
    )


class PgScheduleStore:
    """`ScheduleStore` over the service's asyncpg pool (the DSN role —
    RLS and 0035's API-role trigger don't apply, like the service-role
    client the Vercel tick uses)."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def fetch_due(self, now: datetime, limit: int) -> list[DueSchedule]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(_FETCH_DUE_SQL, now, limit)
        return [_row_to_due(r) for r in rows]

    async def defer(self, row: DueSchedule, *, next_run_at: datetime, now: datetime) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                _DEFER_SQL,
                _uuid(row.id),
                _uuid(row.user_id),
                next_run_at,
                now,
                row.next_run_at,
            )

    async def disable(self, row: DueSchedule, *, now: datetime) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(_DISABLE_SQL, _uuid(row.id), _uuid(row.user_id), now)

    async def claim(self, row: DueSchedule, *, next_run_at: datetime, now: datetime) -> bool:
        async with self._pool.acquire() as conn:
            claimed = await conn.fetchrow(
                _CLAIM_SQL,
                _uuid(row.id),
                _uuid(row.user_id),
                next_run_at,
                now,
                row.next_run_at,
            )
        return claimed is not None

    async def fire(self, row: DueSchedule, *, run_id: str, conversation_id: str) -> None:
        """Conversation + task + checkpoint + `status: queued` event + the
        `start` job, as `fireSchedule` writes them — but in one
        transaction, so a failure leaves no half-created run behind."""
        max_steps = row.max_steps if row.max_steps is not None else DEFAULT_MAX_STEPS
        user = _uuid(row.user_id)
        run = _uuid(run_id)
        async with self._pool.acquire() as conn, conn.transaction():
            await conn.execute(
                _FIRE_CONVERSATION_SQL,
                _uuid(conversation_id),
                user,
                _uuid(row.workspace_id),
                f"Scheduled: {row.name}",
            )
            await conn.execute(
                _FIRE_TASK_SQL,
                run,
                user,
                _uuid(conversation_id),
                js_slice(row.prompt, 2000),
                max_steps,
                datetime.now(UTC),
            )
            await conn.execute(
                _FIRE_CHECKPOINT_SQL,
                run,
                user,
                json.dumps(build_checkpoint(row, max_steps)),
                datetime.now(UTC),
            )
            await conn.execute(
                _FIRE_EVENT_SQL,
                run,
                user,
                json.dumps({"status": "queued", "maxSteps": max_steps}),
                datetime.now(UTC),
            )
            # Same row `enqueue_task_job` writes for the service role.
            await conn.execute(jobs.ENQUEUE_CONTINUE_SQL, run, user, "start", "{}")

    async def set_last_run_task(self, row: DueSchedule, *, run_id: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                _SET_LAST_RUN_TASK_SQL, _uuid(row.id), _uuid(row.user_id), _uuid(run_id)
            )

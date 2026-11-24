"""`/v1/tasks/schedules` — Python mirror of `app/api/tasks/schedules/**`.

The database is a recording fake: it captures every statement (so the
tests can check the caller is impersonated before each query) and plays
back canned rows or raises asyncpg errors with a SQLSTATE.
"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

import asyncpg
import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py import db as db_module
from agent_py.contract import models
from agent_py.main import create_app
from agent_py.schedules import ScheduleBodyError, parse_schedule_body, pg_timestamp

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
USER = "00000000-0000-4000-8000-000000000123"
SID = "00000000-0000-4000-8000-0000000000aa"
WS = "00000000-0000-4000-8000-0000000000bb"
BASE = "/v1/tasks/schedules"


def _auth(sub: str = USER) -> dict[str, str]:
    token = jwt.encode(
        {
            "sub": sub,
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 600,
        },
        SECRET,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def _row(**kw: Any) -> dict[str, Any]:
    ts = datetime(2026, 11, 21, 8, 13, 51, 120000, tzinfo=UTC)
    row: dict[str, Any] = {
        "id": uuid.UUID(SID),
        "user_id": uuid.UUID(USER),
        "workspace_id": uuid.UUID(WS),
        "name": "Morning",
        "prompt": "Summarise the news",
        "cron": "0 8 * * *",
        "timezone": "UTC",
        "enabled": True,
        "model": None,
        "system_prompt": None,
        "skills": None,
        "max_steps": None,
        "last_run_at": None,
        "last_run_task_id": None,
        "next_run_at": datetime(2026, 11, 22, 8, 0, tzinfo=UTC),
        "created_at": ts,
        "updated_at": ts,
    }
    row.update(kw)
    return row


class PgError(asyncpg.PostgresError):
    def __init__(self, sqlstate: str, message: str) -> None:
        super().__init__(message)
        self.sqlstate = sqlstate
        self.message = message


class FakeConn:
    def __init__(self, db: FakeDb) -> None:
        self.db = db

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        self.db.log.append(("BEGIN", ()))
        yield
        self.db.log.append(("COMMIT", ()))

    async def _run(self, sql: str, args: tuple[Any, ...]) -> Any:
        self.db.log.append((" ".join(sql.split()), args))
        for needle, result in self.db.responses:
            if needle in sql:
                if isinstance(result, Exception):
                    raise result
                return result
        return None

    async def execute(self, sql: str, *args: Any) -> str:
        await self._run(sql, args)
        return "OK"

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        return (await self._run(sql, args)) or []

    async def fetchrow(self, sql: str, *args: Any) -> Any:
        return await self._run(sql, args)


class FakeDb:
    def __init__(self) -> None:
        self.log: list[tuple[str, tuple[Any, ...]]] = []
        self.responses: list[tuple[str, Any]] = []

    def respond(self, needle: str, result: Any) -> None:
        self.responses.insert(0, (needle, result))

    @asynccontextmanager
    async def acquire(self, timeout: float | None = None) -> AsyncIterator[FakeConn]:
        yield FakeConn(self)

    def statements(self) -> list[str]:
        return [s for s, _ in self.log]


@pytest.fixture
def fake_db() -> Iterator[FakeDb]:
    fake = FakeDb()
    db_module._pool = fake  # type: ignore[assignment]  # test-only
    yield fake
    db_module._pool = None


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    return TestClient(create_app(enable_poller=False))


def _err(r: Any) -> Any:
    """The `{code, message}` error, from either envelope: today's
    `{detail: {...}}` or the flat one a global handler produces."""
    body = r.json()
    return body.get("detail", body) if isinstance(body, dict) else body


def _assert_impersonated(fake: FakeDb) -> None:
    """Every data statement runs inside a transaction that first switched
    to the `authenticated` role with the caller's claims."""
    stmts = fake.statements()
    data = [i for i, s in enumerate(stmts) if "task_schedules" in s]
    assert data, stmts
    for i in data:
        assert stmts[i - 2] == "SET LOCAL ROLE authenticated;", stmts
        assert stmts[i - 1].startswith("SELECT set_config('request.jwt.claims'"), stmts
        claims = json.loads(fake.log[i - 1][1][0])
        assert claims == {"sub": USER, "role": "authenticated"}


# --- auth / config -------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [("GET", BASE), ("POST", BASE), ("PATCH", f"{BASE}/{SID}"), ("DELETE", f"{BASE}/{SID}")],
)
def test_unauthenticated_is_401(client: TestClient, method: str, path: str) -> None:
    r = client.request(method, path, json={})
    assert r.status_code == 401


def test_no_database_is_503(client: TestClient) -> None:
    r = client.get(BASE, headers=_auth())
    assert r.status_code == 503
    assert _err(r) == {"code": "unavailable", "message": "Supabase is not configured."}


# --- GET ------------------------------------------------------------------------


def test_list_returns_rows_as_the_caller(client: TestClient, fake_db: FakeDb) -> None:
    fake_db.respond(
        "SELECT * FROM public.task_schedules",
        [_row(), _row(skills=json.dumps([{"id": "webSearch"}]), model="anthropic/x")],
    )
    r = client.get(BASE, headers=_auth())
    assert r.status_code == 200
    body = r.json()
    models.ScheduleListResponse.model_validate(body)
    first, second = body["schedules"]
    assert "skills" not in first  # null skills → omitted, like rowToSchedule
    assert second["skills"] == [{"id": "webSearch"}]
    assert first == {
        "id": SID,
        "workspaceId": WS,
        "name": "Morning",
        "prompt": "Summarise the news",
        "cron": "0 8 * * *",
        "timezone": "UTC",
        "enabled": True,
        "model": None,
        "systemPrompt": None,
        "maxSteps": None,
        "lastRunAt": None,
        "lastRunTaskId": None,
        "nextRunAt": "2026-11-22T08:00:00+00:00",
        "createdAt": "2026-11-21T08:13:51.12+00:00",
        "updatedAt": "2026-11-21T08:13:51.12+00:00",
    }
    _assert_impersonated(fake_db)
    sql, args = next(e for e in fake_db.log if "task_schedules" in e[0])
    assert "ORDER BY created_at DESC" in sql
    assert args == (uuid.UUID(USER),)


def test_list_db_error_is_500_unknown(client: TestClient, fake_db: FakeDb) -> None:
    fake_db.respond("SELECT * FROM public.task_schedules", PgError("42501", "denied"))
    r = client.get(BASE, headers=_auth())
    assert r.status_code == 500
    assert _err(r) == {"code": "unknown", "message": "Unknown error"}


# --- POST -----------------------------------------------------------------------

VALID = {"workspaceId": WS, "name": "Morning", "prompt": "Summarise the news", "cron": "0 8 * * *"}


def test_create_inserts_as_the_caller(client: TestClient, fake_db: FakeDb) -> None:
    fake_db.respond("INSERT INTO public.task_schedules", _row())
    body = {**VALID, "skills": [{"id": "webSearch", "junk": 1}], "maxSteps": 5.0}
    r = client.post(BASE, json=body, headers=_auth())
    assert r.status_code == 201, r.text
    models.ScheduleResponse.model_validate(r.json())
    _assert_impersonated(fake_db)
    _, args = next(e for e in fake_db.log if "INSERT INTO public.task_schedules" in e[0])
    (user, ws, name, prompt, cron, tz, enabled, model, sp, skills, max_steps, next_run) = args
    assert (user, ws, name, prompt, cron, tz, enabled) == (
        uuid.UUID(USER),
        WS,
        "Morning",
        "Summarise the news",
        "0 8 * * *",
        "UTC",
        True,
    )
    # No model given: Haiku is stored (Q73).
    assert (model, sp, max_steps) == ("anthropic/claude-haiku-4.5", None, 5)
    assert json.loads(skills) == [{"id": "webSearch"}]  # unknown keys stripped
    assert next_run.tzinfo is not None and next_run.hour == 8 and next_run.minute == 0


def test_create_bad_json_is_400(client: TestClient, fake_db: FakeDb) -> None:
    r = client.post(BASE, content=b"{nope", headers={**_auth(), "content-type": "application/json"})
    assert r.status_code == 400
    assert _err(r) == {"code": "invalid_request", "message": "Body must be JSON."}


def test_create_schema_error_is_400_with_zod_message(client: TestClient, fake_db: FakeDb) -> None:
    r = client.post(BASE, json={**VALID, "cron": "0 8 * *"}, headers=_auth())
    assert r.status_code == 400
    assert _err(r) == {
        "code": "invalid_request",
        "message": "Cron must be 5 space-separated fields (e.g. '0 8 * * *').",
    }
    assert fake_db.log == []


@pytest.mark.parametrize(
    ("cron", "tz", "message"),
    [
        ("* * * * *", "UTC", 'Cron "* * * * *" fires more often than every 5 minutes.'),
        ("0,1 * * * *", "UTC", 'Cron "0,1 * * * *" fires more often than every 5 minutes.'),
        ("61 * * * *", "UTC", 'Couldn\'t parse cron "61 * * * *" with timezone "UTC".'),
        ("0 8 * * *", "Mars/Base", 'Couldn\'t parse cron "0 8 * * *" with timezone "Mars/Base".'),
    ],
)
def test_create_cron_validation_is_400(
    client: TestClient, fake_db: FakeDb, cron: str, tz: str, message: str
) -> None:
    r = client.post(BASE, json={**VALID, "cron": cron, "timezone": tz}, headers=_auth())
    assert r.status_code == 400
    assert _err(r) == {"code": "invalid_request", "message": message}
    assert fake_db.log == []


@pytest.mark.parametrize(
    ("sqlstate", "status", "code"),
    [
        ("54000", 409, "limit_reached"),
        ("42501", 403, "forbidden"),
        ("22023", 400, "invalid_request"),
    ],
)
def test_create_maps_trigger_and_rls_errors(
    client: TestClient, fake_db: FakeDb, sqlstate: str, status: int, code: str
) -> None:
    fake_db.respond("INSERT INTO public.task_schedules", PgError(sqlstate, "db says no"))
    r = client.post(BASE, json=VALID, headers=_auth())
    assert r.status_code == status
    assert _err(r) == {"code": code, "message": "db says no"}


def test_create_other_db_error_is_500_unknown(client: TestClient, fake_db: FakeDb) -> None:
    fake_db.respond("INSERT INTO public.task_schedules", PgError("22P02", "invalid uuid"))
    r = client.post(BASE, json=VALID, headers=_auth())
    assert r.status_code == 500
    assert _err(r) == {"code": "unknown", "message": "Unknown error"}


def test_create_body_cap_is_256k(client: TestClient, fake_db: FakeDb) -> None:
    r = client.post(
        BASE,
        content=b"x" * (256 * 1024 + 1),
        headers={**_auth(), "content-type": "application/json"},
    )
    assert r.status_code == 413


# --- PATCH ----------------------------------------------------------------------


def _update_sql(fake: FakeDb) -> tuple[str, tuple[Any, ...]]:
    return next(e for e in fake.log if e[0].startswith("UPDATE public.task_schedules"))


def test_patch_missing_row_is_404(client: TestClient, fake_db: FakeDb) -> None:
    r = client.patch(f"{BASE}/{SID}", json={"name": "x"}, headers=_auth())
    assert r.status_code == 404
    assert _err(r) == {"code": "not_found", "message": "Schedule not found."}


def test_patch_lookup_error_is_404(client: TestClient, fake_db: FakeDb) -> None:
    fake_db.respond("SELECT * FROM public.task_schedules", PgError("22P02", "bad uuid"))
    r = client.patch(f"{BASE}/not-a-uuid", json={"name": "x"}, headers=_auth())
    assert r.status_code == 404


def test_patch_keeps_next_run_when_cron_unchanged(client: TestClient, fake_db: FakeDb) -> None:
    fake_db.respond("SELECT * FROM public.task_schedules", _row())
    fake_db.respond("UPDATE public.task_schedules", _row(name="Evening", model=None))
    r = client.patch(
        f"{BASE}/{SID}",
        json={"name": "Evening", "cron": "0 8 * * *", "model": None, "skills": [{"id": "a"}]},
        headers=_auth(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Evening"
    sql, args = _update_sql(fake_db)
    assert "next_run_at" not in sql and "cron" not in sql
    assert "name = $4" in sql and "skills = $5::jsonb" in sql and "model = $6" in sql
    assert args[0] == SID and args[1] == uuid.UUID(USER)
    # Clearing the model of an enabled schedule stores Haiku (Q80).
    assert args[3:] == ("Evening", '[{"id": "a"}]', "anthropic/claude-haiku-4.5")
    _assert_impersonated(fake_db)


def test_patch_recomputes_next_run_when_timezone_changes(
    client: TestClient, fake_db: FakeDb
) -> None:
    fake_db.respond("SELECT * FROM public.task_schedules", _row(model="anthropic/x"))
    fake_db.respond("UPDATE public.task_schedules", _row(timezone="Asia/Tokyo"))
    r = client.patch(f"{BASE}/{SID}", json={"timezone": "Asia/Tokyo"}, headers=_auth())
    assert r.status_code == 200, r.text
    sql, args = _update_sql(fake_db)
    assert "cron = $4" in sql and "timezone = $5" in sql and "next_run_at = $6" in sql
    assert args[3:5] == ("0 8 * * *", "Asia/Tokyo")
    nxt = args[5]
    assert (nxt.hour, nxt.minute) == (23, 0)  # 08:00 Tokyo = 23:00 UTC


def test_patch_invalid_new_cron_is_400(client: TestClient, fake_db: FakeDb) -> None:
    fake_db.respond("SELECT * FROM public.task_schedules", _row())
    r = client.patch(f"{BASE}/{SID}", json={"cron": "*/2 * * * *"}, headers=_auth())
    assert r.status_code == 400
    assert _err(r)["message"] == ('Cron "*/2 * * * *" fires more often than every 5 minutes.')


def test_patch_reenable_past_cap_is_409(client: TestClient, fake_db: FakeDb) -> None:
    fake_db.respond("SELECT * FROM public.task_schedules", _row(enabled=False))
    fake_db.respond(
        "UPDATE public.task_schedules",
        PgError("54000", "schedule limit reached (20 enabled schedules per user)"),
    )
    r = client.patch(f"{BASE}/{SID}", json={"enabled": True}, headers=_auth())
    assert r.status_code == 409
    assert _err(r)["code"] == "limit_reached"


def test_patch_row_vanished_is_500(client: TestClient, fake_db: FakeDb) -> None:
    fake_db.respond("SELECT * FROM public.task_schedules", _row())
    r = client.patch(f"{BASE}/{SID}", json={"name": "x"}, headers=_auth())
    assert r.status_code == 500


def test_patch_null_where_zod_rejects_it_is_400(client: TestClient, fake_db: FakeDb) -> None:
    r = client.patch(f"{BASE}/{SID}", json={"cron": None}, headers=_auth())
    assert r.status_code == 400
    assert _err(r)["message"] == "Invalid input: expected string, received null"


# --- DELETE ---------------------------------------------------------------------


def test_delete_is_ok_even_when_nothing_matched(client: TestClient, fake_db: FakeDb) -> None:
    r = client.delete(f"{BASE}/{SID}", headers=_auth())
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    _assert_impersonated(fake_db)


def test_delete_db_error_is_500(client: TestClient, fake_db: FakeDb) -> None:
    fake_db.respond("DELETE FROM public.task_schedules", PgError("22P02", "bad uuid"))
    r = client.delete(f"{BASE}/x", headers=_auth())
    assert r.status_code == 500
    assert _err(r) == {"code": "unknown", "message": "Unknown error"}


# --- body validation: Zod parity --------------------------------------------------

# Messages produced by `ScheduleCreateSchema.safeParse(...).error.issues[0].message`
# (zod 4) for the same bodies.
_B = {"workspaceId": "w", "name": "n", "prompt": "p", "cron": "0 8 * * *"}
ZOD_CREATE_CASES: list[tuple[object, str | None]] = [
    (None, "Invalid input: expected object, received null"),
    ([], "Invalid input: expected object, received array"),
    ("x", "Invalid input: expected object, received string"),
    (
        {"name": "n", "prompt": "p", "cron": "0 8 * * *"},
        "Invalid input: expected string, received undefined",
    ),
    ({**_B, "workspaceId": 5}, "Invalid input: expected string, received number"),
    ({**_B, "workspaceId": ""}, "Too small: expected string to have >=1 characters"),
    ({**_B, "workspaceId": "x" * 65}, "Too big: expected string to have <=64 characters"),
    ({**_B, "cron": "0 8 * *"}, "Cron must be 5 space-separated fields (e.g. '0 8 * * *')."),
    ({**_B, "cron": ""}, "Too small: expected string to have >=1 characters"),
    ({**_B, "cron": "1 " * 60}, "Too big: expected string to have <=100 characters"),
    ({**_B, "timezone": None}, "Invalid input: expected string, received null"),
    ({**_B, "timezone": ""}, "Too small: expected string to have >=1 characters"),
    ({**_B, "enabled": "true"}, "Invalid input: expected boolean, received string"),
    ({**_B, "model": None}, None),
    ({**_B, "model": 1}, "Invalid input: expected string, received number"),
    ({**_B, "maxSteps": 0}, "Too small: expected number to be >=1"),
    ({**_B, "maxSteps": 51}, "Too big: expected number to be <=50"),
    ({**_B, "maxSteps": 1.5}, "Invalid input: expected int, received number"),
    ({**_B, "maxSteps": "5"}, "Invalid input: expected number, received string"),
    ({**_B, "maxSteps": 5.0}, None),
    ({**_B, "skills": None}, "Invalid input: expected array, received null"),
    ({**_B, "skills": [{"id": "x"}] * 11}, "Too big: expected array to have <=10 items"),
    ({**_B, "skills": [{"id": "x" * 41}]}, "Too big: expected string to have <=40 characters"),
    ({**_B, "skills": [{}]}, "Invalid input: expected string, received undefined"),
    (
        {**_B, "skills": [{"id": "w", "webSearchConfig": {"tavily": {"searchDepth": "deep"}}}]},
        'Invalid option: expected one of "basic"|"advanced"',
    ),
    (
        {**_B, "skills": [{"id": "w", "webSearchConfig": {"maxCalls": 0}}]},
        "Too small: expected number to be >=1",
    ),
    (
        {**_B, "skills": [{"id": "i", "imageGenConfig": {"aspectRatio": "5:4"}}]},
        'Invalid option: expected one of "1:1"|"16:9"|"9:16"|"4:3"|"3:4"|"2:3"|"3:2"',
    ),
    ({**_B, "name": "", "prompt": ""}, "Too small: expected string to have >=1 characters"),
    ({**_B, "name": "\U0001f600" * 150}, None),  # Zod counts code points
    ({**_B, "name": "\U0001f600" * 201}, "Too big: expected string to have <=200 characters"),
]


@pytest.mark.parametrize(("body", "message"), ZOD_CREATE_CASES)
def test_create_body_matches_zod(body: object, message: str | None) -> None:
    if message is None:
        parse_schedule_body(body, partial=False)
        return
    with pytest.raises(ScheduleBodyError) as exc:
        parse_schedule_body(body, partial=False)
    assert str(exc.value) == message


def test_body_strips_unknown_keys_like_zod() -> None:
    parsed = parse_schedule_body(
        {**_B, "foo": 1, "skills": [{"id": "a", "bar": 2, "webSearchConfig": {"baz": 3}}]},
        partial=False,
    )
    assert parsed == {**_B, "skills": [{"id": "a", "webSearchConfig": {}}]}


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({}, None),
        ({"cron": None}, "Invalid input: expected string, received null"),
        ({"model": None}, None),
        ({"name": 1}, "Invalid input: expected string, received number"),
    ],
)
def test_update_body_matches_zod(body: object, message: str | None) -> None:
    if message is None:
        assert parse_schedule_body(body, partial=True) == body
        return
    with pytest.raises(ScheduleBodyError) as exc:
        parse_schedule_body(body, partial=True)
    assert str(exc.value) == message


def test_pg_timestamp_matches_postgrest() -> None:
    assert pg_timestamp(datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)) == "2026-01-02T03:04:05+00:00"
    assert (
        pg_timestamp(datetime(2026, 1, 2, 3, 4, 5, 120000, tzinfo=UTC))
        == "2026-01-02T03:04:05.12+00:00"
    )

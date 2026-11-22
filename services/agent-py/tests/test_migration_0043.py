"""0043 (Q41 mutual exclusion) without a database: the SQL text.

The behaviour is pinned against Postgres in `test_background_runs_pg.py`
(opt-in, `AGENT_PY_TEST_DB_URL`); CI has no database, so this checks the
migration keeps both signatures and carries both refusals.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

MIGRATIONS = Path(__file__).resolve().parents[3] / "supabase" / "migrations"
M0043 = MIGRATIONS / "0043_answer_once.sql"

pytestmark = pytest.mark.skipif(not M0043.exists(), reason="needs the repo's supabase/")


def _signature(sql: str, name: str) -> str:
    m = re.search(rf"create or replace function public\.{name}\((.*?)\)\s*returns", sql, re.S)
    assert m is not None, name
    return " ".join(m.group(1).split())


def _body(sql: str, name: str) -> str:
    start = sql.index(f"create or replace function public.{name}(")
    return sql[start : sql.index("$$;", start)]


def test_types_marker_and_signatures_unchanged() -> None:
    sql = M0043.read_text()
    assert sql.splitlines()[0].startswith("-- verify-supabase-types: skip")
    m0034 = (MIGRATIONS / "0034_task_write_hardening.sql").read_text()
    m0042 = (MIGRATIONS / "0042_one_live_resume.sql").read_text()
    assert _signature(sql, "enqueue_task_job") == _signature(m0034, "enqueue_task_job")
    assert _signature(sql, "create_run") == _signature(m0042, "create_run")


def test_respond_refused_when_a_live_resume_exists() -> None:
    body = _body(M0043.read_text(), "enqueue_task_job")
    guard = body[body.index("p_action = 'respond' and exists") :]
    assert "r.previous_run_id = p_task_id" in guard
    assert "r.status not in ('failed', 'cancelled')" in guard
    assert "errcode = '55000'" in guard[: guard.index("end if;")]
    # The task row lock the create_run side serialises on.
    assert "for update" in body


def test_create_run_refuses_a_task_answered_the_old_way() -> None:
    body = _body(M0043.read_text(), "create_run")
    lock = body.index("for update")
    check = body.index("j.action = 'respond'")
    assert lock < check  # lock the previous run, then look for its respond job
    assert "raise exception 'run already answered' using errcode = '55000'" in body
    # agent-py's mapping keys on the message (`repository_pg.create`).
    assert "already answered" in body

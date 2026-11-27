"""Per-user opt-out from the Python executor.

agent-py is the task executor for everyone: nothing else runs a
worker. So the per-user
`agent_backend` flag is an **opt-out**: on every claim the poller calls
`python_executes_for_user(pool, user_id)`:

  - flag absent / NULL / `'python'` → Python executes the job;
  - any other value (`'off'`, `'none'`, `'ts'`, …) → the user is opted
    out: the job is released, nothing runs it, and the stale-run
    reconciler (`runs/reconcile.py`) fails the task with a clear
    "no task worker available" error once it has waited
    `TASK_NO_WORKER_TIMEOUT_MINUTES`.

The metadata column we read here is `auth.users.raw_app_meta_data`
(Supabase's `app_metadata`). It MUST be app metadata, not
`raw_user_meta_data`: any signed-in user can write their own
`user_metadata` via `supabase.auth.updateUser({ data })`, which would
let them flip their own backend. `app_metadata` is writable only with
the service role. The flag is set by an admin (a one-line Postgres
update); this module is just the *enforcement* path.
"""

from __future__ import annotations

import json
import uuid

import asyncpg

_FLAG_SQL = """
SELECT raw_app_meta_data
FROM auth.users
WHERE id = $1;
"""

# The value that keeps a user on Python explicitly (same as absent).
PYTHON_BACKEND = "python"


async def python_executes_for_user(
    pool: asyncpg.Pool,
    user_id: str,
) -> bool | None:
    """Whether Python should execute this user's jobs.

    Returns:
      - True  — no opt-out: the field is absent / NULL / `'python'`, the
        metadata is NULL / not an object / unparseable, or the user row
        is missing (a job's `user_id` is FK-checked; nothing to opt out);
      - False — `agent_backend` holds any other value (opted out);
      - None  — the lookup failed. The caller releases the job and
        retries later rather than guess: executing would override an
        opt-out, releasing just delays the run by one backoff.
    """
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(_FLAG_SQL, _coerce_uuid(user_id))
    except Exception:
        return None

    if row is None:
        return True
    meta = row["raw_app_meta_data"]
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except json.JSONDecodeError:
            return True
    if not isinstance(meta, dict):
        return True
    backend = meta.get("agent_backend")
    return backend is None or backend == PYTHON_BACKEND


def _coerce_uuid(value: str) -> uuid.UUID:
    return uuid.UUID(value)

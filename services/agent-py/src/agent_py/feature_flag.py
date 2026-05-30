"""Per-user feature flag for the Python executor.

Phase 2 of PLAN-agent-api uses `users.metadata.agent_backend = 'python'`
to opt individual users into the Python executor. On every claim the
poller calls `is_user_flagged_to_python(pool, user_id)` — if False the
job goes back to the queue and the TS worker picks it up.

The metadata column we read here is `auth.users.raw_user_meta_data`
(Supabase's standard per-user metadata). The flag is set by an admin
flow outside this PR (a one-liner Postgres update or a future admin
panel); Phase 2's deliverable is just the *enforcement* path.
"""

from __future__ import annotations

import json
import uuid

import asyncpg

_FLAG_SQL = """
SELECT raw_user_meta_data
FROM auth.users
WHERE id = $1;
"""


async def is_user_flagged_to_python(
    pool: asyncpg.Pool,
    user_id: str,
) -> bool:
    """Return True iff `auth.users.raw_user_meta_data->>'agent_backend'`
    is exactly `'python'`.

    Defensive on every shape:
      - row missing → False
      - metadata NULL → False
      - metadata not an object → False
      - field absent → False
      - field present but not 'python' → False
    """
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(_FLAG_SQL, _coerce_uuid(user_id))
    except Exception:
        # Flag-lookup failure → treat as "not flagged" so the TS
        # worker handles the job. Phase 2 invariant: any error
        # falls back to canonical TS, never to Python execution.
        return False

    if row is None:
        return False
    meta = row["raw_user_meta_data"]
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except json.JSONDecodeError:
            return False
    if not isinstance(meta, dict):
        return False
    return meta.get("agent_backend") == "python"


def _coerce_uuid(value: str) -> uuid.UUID:
    return uuid.UUID(value)

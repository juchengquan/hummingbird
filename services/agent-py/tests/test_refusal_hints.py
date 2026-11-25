"""Q88: a 54000 says which limit it met in its hint (0050), and the hint
decides the sentence, not the call it came from."""

from __future__ import annotations

import asyncpg
import pytest

from agent_py.runs.repository_pg import (
    JOB_QUEUE_FULL_MESSAGE,
    TASK_CAP_MESSAGE,
    RunWriteError,
    _raise_write_error,
)


def _limit(message: str, hint: str | None) -> asyncpg.PostgresError:
    exc = asyncpg.exceptions.ProgramLimitExceededError(message)
    exc.hint = hint  # type: ignore[attr-defined]
    return exc


@pytest.mark.parametrize(
    ("hint", "call_site", "expected"),
    [
        ("job_queue", TASK_CAP_MESSAGE, JOB_QUEUE_FULL_MESSAGE),
        ("task_cap", JOB_QUEUE_FULL_MESSAGE, TASK_CAP_MESSAGE),
        (None, TASK_CAP_MESSAGE, TASK_CAP_MESSAGE),  # a database before 0050
    ],
)
def test_the_hint_decides_the_limit_message(
    hint: str | None, call_site: str, expected: str
) -> None:
    with pytest.raises(RunWriteError) as raised:
        _raise_write_error(_limit("too many", hint), limit_message=call_site)
    assert (raised.value.status, raised.value.code, raised.value.message) == (
        409,
        "limit_reached",
        expected,
    )

"""Run tokens, the `REQUIRE_AUTH_FOR_AI` gate, anonymous limits, and the
in-memory run store (`runs/access.py`, `runs/repository_memory.py`)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from agent_py.runs.access import (
    AnonymousLimits,
    RequireAuthConfigError,
    is_run_token,
    mint_run_token,
    parse_require_auth_flag,
    require_auth_for_ai,
)
from agent_py.runs.model import Cancelled, RunOwner, Succeeded
from agent_py.runs.repository import RunSpec
from agent_py.runs.repository_memory import MemoryRunRepository, MemoryStoreFull
from agent_py.settings import Settings

THREAD = "00000000-0000-4000-8000-0000000000a0"


def _rid(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


# --- tokens ---------------------------------------------------------------------


def test_minted_tokens_are_run_tokens_and_unique() -> None:
    tokens = {mint_run_token() for _ in range(50)}
    assert len(tokens) == 50
    assert all(is_run_token(t) and len(t) >= 22 for t in tokens)


@pytest.mark.parametrize("value", ["", "short", "has spaces in it 1234567", "x" * 129, "a+b/" * 8])
def test_is_run_token_rejects_malformed(value: str) -> None:
    assert not is_run_token(value)


def test_anonymous_owner_keys_on_the_token_hash() -> None:
    token = mint_run_token()
    owner = RunOwner.anonymous(token)
    assert owner.anonymous_key != token
    assert owner == RunOwner.anonymous(token)
    assert owner != RunOwner.anonymous(mint_run_token())


# --- REQUIRE_AUTH_FOR_AI ---------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, False),
        ("", False),
        ("  ", False),
        ("false", False),
        ("0", False),
        ("FALSE", False),
        ("true", True),
        (" True ", True),
        ("1", True),
    ],
)
def test_flag_parsing_is_strict(raw: str | None, expected: bool) -> None:
    assert parse_require_auth_flag(raw) is expected


@pytest.mark.parametrize("raw", ["yes", "ture", "on", "2"])
def test_flag_parsing_rejects_anything_else(raw: str) -> None:
    with pytest.raises(RequireAuthConfigError):
        parse_require_auth_flag(raw)


def test_gate_needs_the_flag_and_a_jwt_secret() -> None:
    assert require_auth_for_ai(Settings(REQUIRE_AUTH_FOR_AI="true", SUPABASE_JWT_SECRET="s"))
    assert not require_auth_for_ai(Settings(REQUIRE_AUTH_FOR_AI="true", SUPABASE_JWT_SECRET=""))
    assert not require_auth_for_ai(Settings(REQUIRE_AUTH_FOR_AI="0", SUPABASE_JWT_SECRET="s"))
    with pytest.raises(RequireAuthConfigError):
        require_auth_for_ai(Settings(REQUIRE_AUTH_FOR_AI="yes", SUPABASE_JWT_SECRET=""))


# --- limits ---------------------------------------------------------------------------


def _limits(**kw: int) -> AnonymousLimits:
    base = {
        "rate_per_minute": 100,
        "anonymous_rate_per_minute": 100,
        "anonymous_daily_budget": 100,
        "anonymous_max_concurrent": 100,
    }
    return AnonymousLimits(**{**base, **kw})


def test_rate_applies_to_everyone() -> None:
    limits = _limits(rate_per_minute=2)
    assert limits.check_start("ip", anonymous=False, live_anonymous_runs=0) is None
    assert limits.check_start("ip", anonymous=False, live_anonymous_runs=0) is None
    refusal = limits.check_start("ip", anonymous=False, live_anonymous_runs=0)
    assert refusal is not None and refusal.retry_after_sec >= 1
    assert limits.check_start("other-ip", anonymous=False, live_anonymous_runs=0) is None


def test_anonymous_concurrency_rate_and_budget() -> None:
    assert (
        _limits(anonymous_max_concurrent=2).check_start("ip", anonymous=True, live_anonymous_runs=2)
        is not None
    )
    assert (
        _limits(anonymous_max_concurrent=2).check_start(
            "ip", anonymous=False, live_anonymous_runs=9
        )
        is None
    )
    limits = _limits(anonymous_rate_per_minute=1)
    assert limits.check_start("ip", anonymous=True, live_anonymous_runs=0) is None
    assert limits.check_start("ip", anonymous=True, live_anonymous_runs=0) is not None
    assert limits.check_start("ip", anonymous=False, live_anonymous_runs=0) is None
    budget = _limits(anonymous_daily_budget=1)
    assert budget.check_start("ip", anonymous=True, live_anonymous_runs=0) is None
    refusal = budget.check_start("ip", anonymous=True, live_anonymous_runs=0)
    assert refusal is not None and "Daily" in refusal.message


# --- memory store ------------------------------------------------------------------------


class Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 11, 21, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now


def _spec(n: int) -> RunSpec:
    return RunSpec(run_id=_rid(n), thread_id=THREAD, mode="interactive")


async def test_memory_store_refuses_background_runs() -> None:
    repo = MemoryRunRepository(ttl_seconds=60, max_runs=10)
    with pytest.raises(ValueError):
        await repo.create(
            RunOwner.user("u"),
            RunSpec(
                run_id=_rid(1),
                thread_id=THREAD,
                mode="background",
                max_steps=1,
                checkpoint={"messages": [], "config": {}},
            ),
        )


async def test_memory_store_capacity_but_retries_pass() -> None:
    repo = MemoryRunRepository(ttl_seconds=60, max_runs=1)
    owner = RunOwner.anonymous(mint_run_token())
    assert (await repo.create(owner, _spec(1))).created
    assert not (await repo.create(owner, _spec(1))).created
    with pytest.raises(MemoryStoreFull):
        await repo.create(owner, _spec(2))


async def test_memory_store_ttl_sweep_keeps_live_runs() -> None:
    clock = Clock()
    repo = MemoryRunRepository(ttl_seconds=900, max_runs=10, clock=clock)
    owner = RunOwner.anonymous(mint_run_token())
    for n in (1, 2, 3):
        await repo.create(owner, _spec(n))
    await repo.settle(_rid(1), Succeeded())
    await repo.cancel(owner, _rid(2))
    clock.now += timedelta(seconds=899)
    assert repo.sweep() == []
    clock.now += timedelta(seconds=2)
    assert sorted(repo.sweep()) == [_rid(1), _rid(2)]
    assert await repo.get(owner, _rid(1)) is None
    assert repo.contains(_rid(3)) and not repo.contains(_rid(1))
    assert (await repo.get(owner, _rid(3))) is not None  # live: kept


async def test_memory_store_counts_live_anonymous_runs_per_client() -> None:
    repo = MemoryRunRepository(ttl_seconds=60, max_runs=10)
    anon = RunOwner.anonymous(mint_run_token())
    for n in (1, 2):
        await repo.create(anon, _spec(n))
        repo.tag_client(_rid(n), "1.2.3.4")
    await repo.create(RunOwner.user("u"), _spec(3))
    repo.tag_client(_rid(3), "1.2.3.4")  # signed-in runs never count
    assert repo.live_runs_for_client("1.2.3.4") == 2
    assert repo.live_runs_for_client("5.6.7.8") == 0
    await repo.settle(_rid(1), Cancelled())
    assert repo.live_runs_for_client("1.2.3.4") == 1

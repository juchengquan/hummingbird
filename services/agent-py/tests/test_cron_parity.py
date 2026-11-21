"""Cron parity with the TypeScript schedule functions.

`tests/fixtures/cron_parity.json` was produced by running the real TS
functions (`nextRunFromCron`, `validateScheduleCron`,
`cronPassesCoarseGuard`, plus cron-parser fire sequences) under bun —
`lib/server/agent/schedules.parity.test.ts`, which also fails when the
committed fixture drifts from what cron-parser computes. Here the Python
port has to reproduce every case: DST transitions in a dozen zones,
month ends / leap days, steps, ranges, lists, names, `L`, `#`, invalid
crons and zones, millisecond instants, and a seeded fuzz set.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from agent_py.cron import CronError, parse_cron
from agent_py.schedules import cron_passes_coarse_guard, validate_schedule_cron

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "cron_parity.json").read_text())


def _instant(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def _fires(case: dict[str, Any]) -> tuple[list[int], bool]:
    """Replay the case: as many fires as TS produced, plus one more when
    TS threw (Python must throw at that same fire)."""
    fires: list[int] = []
    want = len(case["fires"]) + (1 if case["error"] else 0)
    try:
        it = parse_cron(case["cron"], timezone=case["tz"], current_date=_instant(case["after"]))
        for _ in range(want):
            fires.append(it.next_ms())
    except CronError:
        return fires, True
    return fires, False


def _describe(case: dict[str, Any]) -> str:
    return f"{case['cron']!r} @ {case['tz']!r} after {case['after']}"


def test_fixture_is_substantial() -> None:
    cases = FIXTURE["cases"]
    assert len(cases) > 1500
    assert FIXTURE["cronParser"] == "5.5.0"
    assert any(c["error"] for c in cases)
    assert any(c["validate"] not in (None, "ok") for c in cases)


def test_fire_sequences_match() -> None:
    mismatches: list[str] = []
    for case in FIXTURE["cases"]:
        fires, error = _fires(case)
        ok = error == case["error"] and fires == case["fires"]
        if not ok:
            mismatches.append(f"{_describe(case)}: want {case['fires']} got {fires} err={error}")
    assert not mismatches, f"{len(mismatches)} mismatches:\n" + "\n".join(mismatches[:20])


def test_validate_matches() -> None:
    mismatches: list[str] = []
    checked = 0
    for case in FIXTURE["cases"]:
        want = case["validate"]
        if want is None:
            continue
        checked += 1
        got = validate_schedule_cron(case["cron"], case["tz"], _instant(case["after"]))
        if want == "ok":
            ok = got.ok and got.next is not None
            ok = ok and int(got.next.timestamp() * 1000) == case["fires"][0]
        else:
            ok = not got.ok and got.message == want
        if not ok:
            mismatches.append(f"{_describe(case)}: want {want!r} got {got}")
    assert checked > 1200
    assert not mismatches, f"{len(mismatches)} mismatches:\n" + "\n".join(mismatches[:20])


@pytest.mark.parametrize(
    ("cron", "ok"),
    [(c["cron"], c["ok"]) for c in FIXTURE["coarse"]],
)
def test_coarse_guard_matches(cron: str, ok: bool) -> None:
    assert cron_passes_coarse_guard(cron) is ok

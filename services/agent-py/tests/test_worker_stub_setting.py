"""`WORKER_STUB_MODEL` is explicit and strictly parsed (Q55)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from agent_py.settings import Settings


def test_off_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WORKER_STUB_MODEL", raising=False)
    assert Settings(_env_file=None).WORKER_STUB_MODEL is False


@pytest.mark.parametrize(("raw", "on"), [("", False), ("false", False), ("true", True)])
def test_accepted_values(monkeypatch: pytest.MonkeyPatch, raw: str, on: bool) -> None:
    monkeypatch.setenv("WORKER_STUB_MODEL", raw)
    assert Settings(_env_file=None).WORKER_STUB_MODEL is on


@pytest.mark.parametrize("raw", ["1", "0", "yes", "TRUE", " true", "on"])
def test_anything_else_fails_boot(monkeypatch: pytest.MonkeyPatch, raw: str) -> None:
    monkeypatch.setenv("WORKER_STUB_MODEL", raw)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)

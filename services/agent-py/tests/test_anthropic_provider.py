"""Tests for the Anthropic streaming step-fn factory.

Tests don't hit the network — `AsyncAnthropicClient` is a Protocol,
so we hand-roll a fake that yields canned text deltas. The factory
should:

  1. Pass through the configured model / system / messages.
  2. Stream deltas through the coalescer into emitter.token (which
     persists into task_events in production).
  3. Return RunStepOutcome(done=True) — no tools yet.
  4. Flush any buffered tokens on stream exit, even on exception.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from agent_py.emitter import RunEmitter
from agent_py.events import TaskEvent, TokenEvent
from agent_py.providers.anthropic_provider import (
    AnthropicStepConfig,
    make_anthropic_step_fn,
)
from agent_py.runner import RunStepContext

# --- Fake AsyncAnthropic ---------------------------------------------------


class _FakeStream:
    """The `async with` target. Exposes `.text_stream` yielding the
    canned deltas, then exits cleanly."""

    def __init__(self, deltas: list[str], raise_on: int | None = None) -> None:
        self._deltas = deltas
        self._raise_on = raise_on

    async def __aenter__(self) -> _FakeStream:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    @property
    def text_stream(self) -> AsyncIterator[str]:
        return self._iter()

    async def _iter(self) -> AsyncIterator[str]:
        for i, delta in enumerate(self._deltas):
            if self._raise_on is not None and i == self._raise_on:
                raise RuntimeError("anthropic transport error")
            yield delta


class _FakeMessages:
    def __init__(self, deltas: list[str], raise_on: int | None = None) -> None:
        self._deltas = deltas
        self._raise_on = raise_on
        self.last_kwargs: dict[str, Any] | None = None

    def stream(self, **kwargs: Any) -> _FakeStream:
        self.last_kwargs = kwargs
        return _FakeStream(self._deltas, raise_on=self._raise_on)


class _FakeClient:
    def __init__(self, deltas: list[str], raise_on: int | None = None) -> None:
        self.messages = _FakeMessages(deltas, raise_on=raise_on)


# --- Helpers --------------------------------------------------------------


def _list_sink() -> tuple[list[TaskEvent], EmitterFactory]:
    """Build a sink + emitter factory for assertions."""

    collected: list[TaskEvent] = []

    async def sink(event: TaskEvent) -> None:
        collected.append(event)

    return collected, lambda: RunEmitter(run_id="r1", sink=sink)


# --- Tests ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_streams_deltas_through_coalescer_into_emitter() -> None:
    client = _FakeClient(deltas=["x" * 50, "y" * 60])
    collected, mk_emitter = _list_sink()
    emitter = mk_emitter()

    step = make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model="claude-sonnet-4-6",
            system="be terse",
            messages=[{"role": "user", "content": "hi"}],
        )
    )
    await emitter.start_step()
    outcome = await step(RunStepContext(step=emitter.step, emitter=emitter))
    await emitter.end_step()
    await emitter.result("done")

    assert outcome.done is True
    # We sent two deltas totalling 110 chars; the coalescer flushes at
    # 96 chars. The exact split is implementation-detail but both
    # deltas should land as `text`-channel token events totalling 110
    # chars of payload.
    token_events = [e for e in collected if isinstance(e, TokenEvent)]
    assert token_events
    assert all(e.channel == "text" for e in token_events)
    total = "".join(e.text for e in token_events)
    assert total == "x" * 50 + "y" * 60


@pytest.mark.asyncio
async def test_passes_through_config_to_anthropic_stream() -> None:
    client = _FakeClient(deltas=["ok"])
    _, mk_emitter = _list_sink()
    emitter = mk_emitter()

    step = make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model="claude-opus-4-8",
            system="You are helpful.",
            messages=[
                {"role": "user", "content": "first"},
                {"role": "assistant", "content": "reply"},
                {"role": "user", "content": "second"},
            ],
            max_tokens=2048,
        )
    )
    await emitter.start_step()
    await step(RunStepContext(step=emitter.step, emitter=emitter))

    kw = client.messages.last_kwargs
    assert kw is not None
    assert kw["model"] == "claude-opus-4-8"
    assert kw["max_tokens"] == 2048
    assert kw["system"] == "You are helpful."
    assert kw["messages"][0] == {"role": "user", "content": "first"}
    assert len(kw["messages"]) == 3


@pytest.mark.asyncio
async def test_flushes_buffer_on_exception_then_propagates() -> None:
    """If the stream raises after partial deltas, the coalescer
    flushes what was buffered before the exception bubbles to the
    runner. Production sees this as "partial output + step_error +
    re-emit on retry"; for now we just confirm partial output is
    not lost."""
    client = _FakeClient(deltas=["fifty " * 20, "BOOM"], raise_on=1)
    collected, mk_emitter = _list_sink()
    emitter = mk_emitter()

    step = make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model="claude-sonnet-4-6",
            system=None,
            messages=[{"role": "user", "content": "hi"}],
        )
    )
    await emitter.start_step()

    with pytest.raises(RuntimeError):
        await step(RunStepContext(step=emitter.step, emitter=emitter))

    # The first delta (well over the 96-char threshold) should have
    # already been flushed inline; on the second iteration the stream
    # raised before yielding, but the `finally` flush guarantees any
    # remaining buffer drains.
    token_events = [e for e in collected if isinstance(e, TokenEvent)]
    total = "".join(e.text for e in token_events)
    assert "fifty " in total


@pytest.mark.asyncio
async def test_no_tokens_still_settles() -> None:
    """An empty stream (zero deltas) is a valid edge — the step still
    settles. Mirrors the TS path where `finishReason: 'stop'` with
    no text deltas is rare but legal."""
    client = _FakeClient(deltas=[])
    collected, mk_emitter = _list_sink()
    emitter = mk_emitter()

    step = make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model="claude-sonnet-4-6",
            system=None,
            messages=[{"role": "user", "content": "hi"}],
        )
    )
    await emitter.start_step()
    outcome = await step(RunStepContext(step=emitter.step, emitter=emitter))

    assert outcome.done is True
    token_events = [e for e in collected if isinstance(e, TokenEvent)]
    assert token_events == []


# Helper type alias.
EmitterFactory = Any

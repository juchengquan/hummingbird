"""Ghost text on a model that thinks first (wave 10).

MiniMax M3 / M3.1 Flash think before every answer and can't be told not to
("requires adaptive thinking"); within the 60 output tokens Next gives a
completion, the thinking used them all and the ghost text was always empty
(8 of 8 live calls). A thinking-capable model gets room for its thinking;
the text stays as short as before, cut at a word.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from agent_py.editor_ai.command import (
    COMPLETE_MAX_CHARS,
    COMPLETE_MAX_TOKENS,
    COMPLETE_THINKING_ROOM,
    complete_text,
)


class _Stream:
    def __init__(self, chunks: list[str]) -> None:
        self._chunks = chunks

    async def __aenter__(self) -> _Stream:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    @property
    def text_stream(self) -> AsyncIterator[str]:
        async def gen() -> AsyncIterator[str]:
            for c in self._chunks:
                yield c

        return gen()


class _Client:
    def __init__(self, chunks: list[str]) -> None:
        self.kwargs: dict[str, Any] = {}
        client = self

        class _Messages:
            def stream(self, **kw: Any) -> _Stream:
                client.kwargs = kw
                return _Stream(chunks)

        self.messages = _Messages()


async def _text(client: _Client, **kw: Any) -> str:
    return "".join(
        [
            c
            async for c in complete_text(
                client=client, model="m", block_text="x", prefix=None, **kw
            )
        ]
    )


async def test_a_thinking_model_gets_room_for_its_thinking() -> None:
    client = _Client([" jumps"])
    assert await _text(client, thinking_room=COMPLETE_THINKING_ROOM) == " jumps"
    assert client.kwargs["max_tokens"] == COMPLETE_MAX_TOKENS + COMPLETE_THINKING_ROOM


async def test_others_keep_the_tight_cap() -> None:
    client = _Client([" jumps"])
    await _text(client)
    assert client.kwargs["max_tokens"] == COMPLETE_MAX_TOKENS


async def test_the_text_stays_short_cut_at_a_word() -> None:
    words = ["word "] * 200
    out = await _text(_Client(words), thinking_room=COMPLETE_THINKING_ROOM)
    assert len(out) <= COMPLETE_MAX_CHARS
    assert out.endswith("word") or out.endswith("word ")
    assert len(out) > COMPLETE_MAX_CHARS - 10


def test_the_catalog_flags_the_models_that_think_unprompted() -> None:
    from agent_py.model_allowlist import get_model_allowlist

    allowlist = get_model_allowlist()
    assert allowlist.thinks_first("minimax/minimax-m3.1-flash")
    assert allowlist.thinks_first("minimax/minimax-m2.7")
    assert not allowlist.thinks_first("anthropic/claude-haiku-4.5")

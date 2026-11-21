"""`agent_py.chunk` produces exactly the chunks `lib/server/embeddings/chunk.ts`
does. The expected chunks in `fixtures/chunk_parity.json` were produced by
running the TS chunker with bun (`bun run codegen:agent-py-parity`); the
root test suite fails when the TS chunker changes without regenerating
them, so this suite then pins the port to the new behaviour.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from agent_py.chunk import chunk_text, to_storable_text

_FIXTURE = Path(__file__).parent / "fixtures" / "chunk_parity.json"
_CASES: list[dict[str, Any]] = json.loads(_FIXTURE.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_chunks_match_the_ts_chunker(case: dict[str, Any]) -> None:
    opts = case["opts"]
    got = chunk_text(
        case["text"],
        max_chars=opts.get("maxChars"),
        overlap_chars=opts.get("overlapChars"),
    )
    assert got == case["chunks"]


def test_fixture_covers_the_tricky_cases() -> None:
    names = {c["name"] for c in _CASES}
    assert len(_CASES) >= 25
    assert any("surrogate" in n for n in names)
    assert any("table" in n for n in names)
    assert any("exact boundary" in n for n in names)
    # The emoji case really does cut a pair (else it proves nothing).
    emoji = next(c for c in _CASES if "surrogate pairs" in c["name"])
    assert any(
        "\ud800" <= ch <= "\udfff" for chunk in emoji["chunks"] for ch in (chunk[:1] + chunk[-1:])
    )


def test_lengths_are_utf16_units() -> None:
    # 😀 is two UTF-16 units: four of them are 8 units > max 6.
    assert chunk_text("😀😀😀😀", max_chars=6, overlap_chars=0) == ["😀😀😀", "😀"]
    assert chunk_text("😀😀😀", max_chars=6) == ["😀😀😀"]


def test_storable_text_replaces_lone_surrogates_only() -> None:
    assert to_storable_text("a\ud83db") == "a\ufffdb"
    assert to_storable_text("ok 😀 é") == "ok 😀 é"

"""`ArrayElements`: finished elements out of streamed `{"elements": [...]}`."""

from __future__ import annotations

import json

import pytest

from agent_py.editor_ai.elements import ArrayElements

DOC = {
    "elements": [
        {"blockId": "p1", "comment": 'a "quoted" } brace ] and \\ slash', "content": "x"},
        {"id": "c1", "content": "line\n\nline", "n": 12345},
        {"nested": {"list": [1, {"k": "]"}]}},
    ]
}
TEXT = json.dumps(DOC)


@pytest.mark.parametrize("size", [1, 2, 3, 7, 50, len(TEXT)])
def test_every_chunking_yields_each_element_once_complete(size: int) -> None:
    scanner = ArrayElements()
    seen = []
    for i in range(0, len(TEXT), size):
        got = scanner.feed(TEXT[i : i + size])
        for element in got:
            # Handed out only once its closing brace has arrived.
            assert TEXT.index(json.dumps(element)) + len(json.dumps(element)) <= i + size
        seen += got
    assert seen == DOC["elements"]


def test_nothing_before_the_array_and_nothing_after_it() -> None:
    scanner = ArrayElements()
    assert scanner.feed('{"elem') == []
    assert scanner.feed('ents": [ ') == []
    assert scanner.feed('{"a": 1}, {"b"') == [{"a": 1}]
    assert scanner.feed(": 2}]") == [{"b": 2}]
    assert scanner.feed(', "other": [{"c": 3}]}') == []


def test_a_number_at_the_end_of_the_buffer_waits() -> None:
    scanner = ArrayElements()
    assert scanner.feed('{"elements": [1') == []
    assert scanner.feed("2, 3]") == [12, 3]


def test_an_unfinished_stream_yields_only_finished_elements() -> None:
    scanner = ArrayElements()
    assert scanner.feed('{"elements": [{"a": 1}, {"b": "unterminated') == [{"a": 1}]

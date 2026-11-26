"""Finished array elements out of a streamed JSON object (wave 9, Q104).

Comment and table-cell answers arrive as one forced tool call whose input
is `{"elements": [ … ]}`, streamed as `input_json_delta` chunks. The Next
route streams `streamObject(output: "array").elementStream`, which yields
each element once it is complete; `ArrayElements.feed` does the same: it
returns the elements whose closing brace has arrived."""

from __future__ import annotations

import json
import re
from typing import Any

_ARRAY_START = re.compile(r'"elements"\s*:\s*\[')
_SEPARATORS = " \t\r\n,"


class ArrayElements:
    def __init__(self) -> None:
        self._buffer = ""
        self._pos: int | None = None
        self._done = False
        self._decoder = json.JSONDecoder()

    def feed(self, chunk: str) -> list[Any]:
        self._buffer += chunk
        if self._done:
            return []
        if self._pos is None:
            match = _ARRAY_START.search(self._buffer)
            if match is None:
                return []
            self._pos = match.end()
        found: list[Any] = []
        buffer = self._buffer
        while True:
            i = self._pos
            while i < len(buffer) and buffer[i] in _SEPARATORS:
                i += 1
            self._pos = i
            if i >= len(buffer):
                break
            if buffer[i] == "]":
                self._done = True
                break
            try:
                value, end = self._decoder.raw_decode(buffer, i)
            except json.JSONDecodeError:
                break  # incomplete: wait for more
            if end >= len(buffer) and isinstance(value, (int, float)):
                break  # a number / literal may still be growing
            found.append(value)
            self._pos = end
        return found


__all__ = ["ArrayElements"]

"""`MarkdownJoiner` (`lib/shared/markdown-joiner-transform.ts`), ported.

The Next route streams `generate` / `edit` text through
`markdownJoinerTransform`, which holds back a chunk that opens markdown
(`**`, a list marker, a link, a code fence, a table row, an MDX tag) until
it is complete, so Plate's streaming markdown deserializer never sees half
of one. `processText` returns what may go out now; `flush` the rest.
`delay_ms` is the pause the transform takes after each emitted chunk (10
ms, 100 ms while a code block, table or large document streams). Pinned
to the TS class by `tests/fixtures/editor_ai_parity.json`."""

from __future__ import annotations

import re

from .js_text import JS_WHITESPACE, js_len

DEFAULT_DELAY_MS = 10
NEST_BLOCK_DELAY_MS = 100

# JS `.` excludes the four line terminators; `$` (no `m` flag) is the end.
_DOT = "[^\n\r\u2028\u2029]"
_WS = "[" + re.escape(JS_WHITESPACE) + "]"
_NOT_WS = "[^" + re.escape(JS_WHITESPACE) + "]"

_BOLD = re.compile(rf"\*\*{_DOT}*?\*\*")
_CODE_LINE = re.compile(rf"```{_NOT_WS}+")
_LINK = re.compile(rf"^\[{_DOT}*?\]\({_DOT}*?\)\Z")
_UNORDERED_LIST = re.compile(rf"^[*-]{_WS}+{_DOT}+")
_TODO_LIST = re.compile(rf"^[*-]{_WS}+\[[ xX]\]{_WS}+{_DOT}+")
_ORDERED_LIST = re.compile(rf"^[0-9]+\.{_WS}+{_DOT}+")
_MDX_TAG = re.compile(r"<([A-Za-z][A-Za-z0-9\-_]*)>")


class MarkdownJoiner:
    def __init__(self) -> None:
        self.delay_ms = DEFAULT_DELAY_MS
        self._buffer = ""
        self._document_chars = 0
        self._buffering = False
        self._code_block = False
        self._large_document = False
        self._table = False

    def _clear(self) -> None:
        self._buffer = ""
        self._buffering = False

    def _complete_list(self) -> bool:
        b = self._buffer
        if _UNORDERED_LIST.search(b) and "[" in b:
            return bool(_TODO_LIST.search(b))
        return bool(_UNORDERED_LIST.search(b) or _ORDERED_LIST.search(b) or _TODO_LIST.search(b))

    def _false_positive(self, char: str) -> bool:
        # An unfinished link stays buffered past 30 characters.
        if self._buffer.startswith("[") and "http" in self._buffer:
            return False
        return char == "\n" or js_len(self._buffer) > 30

    def flush(self) -> str:
        remaining = self._buffer
        self._clear()
        return remaining

    def process_text(self, text: str) -> str:
        output = ""
        for char in text:
            if self._code_block or self._table or self._large_document:
                self._buffer += char
                if char == "\n":
                    output += self._buffer
                    self._clear()
                if self._buffer.rstrip(JS_WHITESPACE) == "```" and self._code_block:
                    self._code_block = False
                    self.delay_ms = DEFAULT_DELAY_MS
                    output += self._buffer
                    self._clear()
                if js_len(self._buffer) > 10 and "|" not in self._buffer and self._table:
                    self._table = False
                    self.delay_ms = DEFAULT_DELAY_MS
                    output += self._buffer
                    self._clear()
            elif self._buffering:
                self._buffer += char
                if _CODE_LINE.search(self._buffer):
                    self.delay_ms = NEST_BLOCK_DELAY_MS
                    self._code_block = True
                    continue
                if self._buffer.startswith("|") and self._buffer.endswith("|"):
                    self.delay_ms = NEST_BLOCK_DELAY_MS
                    self._table = True
                    continue
                if self._document_chars > 2500:
                    self.delay_ms = NEST_BLOCK_DELAY_MS
                    self._large_document = True
                    continue
                if (
                    _BOLD.search(self._buffer)
                    or _MDX_TAG.search(self._buffer)
                    or self._complete_list()
                    or _LINK.search(self._buffer)
                    # A false positive: flush the buffer as raw text.
                    or self._false_positive(char)
                ):
                    output += self._buffer
                    self._clear()
            elif char in "*<`|[" or char == "-" or char in "0123456789":
                self._buffer = char
                self._buffering = True
            else:
                output += char
        self._document_chars += js_len(text)
        return output


__all__ = ["DEFAULT_DELAY_MS", "NEST_BLOCK_DELAY_MS", "MarkdownJoiner"]

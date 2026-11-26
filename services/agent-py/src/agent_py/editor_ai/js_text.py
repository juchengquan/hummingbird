"""JavaScript string semantics the editor AI prompts depend on (wave 9, Q101).

The prompts are ported from TypeScript (`lib/shared/editor-ai/`) and must
come out byte-identical (`tests/fixtures/editor_ai_parity.json`). Two
things differ from Python's defaults:

* **`dedent` 1.0.0** (the npm package, as a template tag) works on the
  *raw* template text, interpolates first, then strips the smallest
  indentation found on any line — interpolated lines included — by
  slicing that many characters off every line that starts with a space or
  tab; finally it trims and turns a literal backslash-`n` into a newline.
  `dedent(strings, *values)` reproduces it: `strings` are the raw parts
  around each `${…}`.
* **JS whitespace** (`\\s`, `String.prototype.trim`) is a fixed set,
  not Python's `str.isspace()`.

Lengths are in code points; the TS side counts UTF-16 code units. They
agree for BMP text, which is all the prompts' own text is (a document
with astral characters can differ by a slice — the fixture is BMP-only)."""

from __future__ import annotations

import re
from collections.abc import Sequence

#: ECMAScript WhiteSpace + LineTerminator (what `\s` and `trim()` match).
JS_WHITESPACE = (
    "\t\n\x0b\x0c\r \u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_WS = "[" + re.escape(JS_WHITESPACE) + "]"
_NOT_WS = "[^" + re.escape(JS_WHITESPACE) + "]"

_INDENTED_LINE = re.compile(rf"^({_WS}+){_NOT_WS}+")
_LINE_CONTINUATION = re.compile(r"\\\n[ \t]*")


def js_trim(text: str) -> str:
    """`String.prototype.trim`."""
    return text.strip(JS_WHITESPACE)


def dedent(strings: Sequence[str], *values: str) -> str:
    """The `dedent` npm package, version 1.0.0, used as a template tag."""
    result = ""
    for i, raw in enumerate(strings):
        result += _LINE_CONTINUATION.sub("", raw).replace("\\`", "`")
        if i < len(values):
            result += values[i]
    lines = result.split("\n")
    mindent: int | None = None
    for line in lines:
        match = _INDENTED_LINE.match(line)
        if match:
            indent = len(match.group(1))
            mindent = indent if not mindent else min(mindent, indent)
    if mindent is not None:
        result = "\n".join(line[mindent:] if line[:1] in (" ", "\t") else line for line in lines)
    return js_trim(result).replace("\\n", "\n")


def d(raw: str) -> str:
    """`dedent` over a template without interpolations."""
    return dedent((raw,))


def js_len(text: str) -> int:
    """`String.prototype.length`: UTF-16 code units."""
    return len(text.encode("utf-16-le")) // 2


__all__ = ["JS_WHITESPACE", "d", "dedent", "js_len", "js_trim"]

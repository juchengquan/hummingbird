"""CSP violation-report intake — Python port of
`lib/server/security/csp-report.ts`.

Accepts both wire formats browsers send:

  - `application/csp-report` — legacy `report-uri`:
      `{ "csp-report": { "document-uri", "effective-directive", … } }`
  - `application/reports+json` — Reporting API (`report-to`):
      `[{ "type": "csp-violation", "body": { "documentURL", … } }, …]`

(plus `application/json`, which some browsers / proxies use for
`report-uri` bodies). Each violation becomes ONE structured log line.
Reports are attacker-controllable input (anyone can POST), so only a fixed
allow-list of fields is logged, each truncated, URLs reduced to origin +
path (query strings can carry signed-URL tokens) with share tokens
redacted; `script-sample` is dropped.

`sanitize_reported_url` reproduces what the TS original gets from the
WHATWG `URL` parser for the parts it logs (scheme, origin, path): special-
scheme slash/backslash leniency, userinfo stripping, host lower-casing +
IDNA, default-port removal, dot-segment resolution and the path
percent-encode set. String lengths / truncation are in UTF-16 code units,
as in JS. Pinned by `tests/test_csp_report.py` against fixtures generated
from the TS module (`bun run codegen:agent-py-parity`). Known gaps (exotic
inputs only, never a crash): WHATWG's IPv4 number forms (`127.1`,
`0x7f.1`) and UTS #46 mappings beyond Python's IDNA 2003 codec.
"""

from __future__ import annotations

import ipaddress
import json
import math
import re
from typing import Any, Literal

from .chunk import from_utf16_units, to_utf16_units

__all__ = [
    "ACCEPTED_TYPES",
    "CSP_REPORT_MAX_BYTES",
    "CSP_REPORT_MAX_ENTRIES",
    "decode_report_body",
    "parse_csp_reports",
    "sanitize_reported_url",
]

CSP_REPORT_MAX_BYTES = 16 * 1024
#: Upper bound on violations logged from one Reporting-API batch.
CSP_REPORT_MAX_ENTRIES = 20
_FIELD_MAX = 200

ACCEPTED_TYPES = frozenset(
    {
        "application/csp-report",
        "application/reports+json",
        # Some browsers / proxies label report-uri bodies as plain JSON.
        "application/json",
    }
)

Via = Literal["report-uri", "reporting-api"]


# --- JS string helpers (UTF-16 code units) ------------------------------


def _js_len(s: str) -> int:
    return len(to_utf16_units(s))


def _js_slice(s: str, end: int) -> str:
    units = to_utf16_units(s)
    return s if len(units) <= end else from_utf16_units(units[:end])


def _str(v: Any) -> str | None:
    return _js_slice(v, _FIELD_MAX * 4) if isinstance(v, str) and v else None


def _num(v: Any) -> int | None:
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return math.trunc(v)


def _clip(s: str) -> str:
    return f"{_js_slice(s, _FIELD_MAX)}…" if _js_len(s) > _FIELD_MAX else s


# --- URL reduction (WHATWG subset) ----------------------------------------

_KEYWORD_RE = re.compile(r"[a-z][a-z0-9-]*", re.IGNORECASE)
_SCHEME_RE = re.compile(r"([a-zA-Z][a-zA-Z0-9+.\-]*):(.*)", re.DOTALL)
_SHARE_TOKEN_RE = re.compile(r"/share/(conversation|document)/[^/]+")
_DEFAULT_PORTS = {"http": "80", "https": "443", "ws": "80", "wss": "443", "ftp": "21"}
_NETWORK_SCHEMES = frozenset({"http", "https", "ws", "wss"})
_SPECIAL_SCHEMES = _NETWORK_SCHEMES | {"ftp", "file"}
# Forbidden domain code points (after percent-decoding).
_FORBIDDEN_HOST_RE = re.compile(r"[\x00-\x20#%/:<>?@\[\\\]^|\x7f]")
_PATH_ENCODE = frozenset('"#<>?^`{}')
_SURROGATE_RE = re.compile("[\ud800-\udfff]")


class _InvalidUrl(ValueError):
    pass


def _percent_decode(s: str) -> str:
    """WHATWG percent-decode (a `%` not followed by two hex digits stays),
    then UTF-8 decode with replacement."""
    raw = s.encode("utf-8", "surrogatepass")
    out = bytearray()
    i = 0
    while i < len(raw):
        if raw[i] == 0x25 and _is_hex(raw[i + 1 : i + 3]):
            out.append(int(raw[i + 1 : i + 3], 16))
            i += 3
        else:
            out.append(raw[i])
            i += 1
    return out.decode("utf-8", "replace")


def _is_hex(b: bytes) -> bool:
    return len(b) == 2 and all(c in b"0123456789abcdefABCDEF" for c in b)


def _parse_host(raw_host: str) -> str:
    if not raw_host:
        raise _InvalidUrl("empty host")
    if raw_host.startswith("["):
        if not raw_host.endswith("]"):
            raise _InvalidUrl("bad ipv6")
        try:
            return f"[{ipaddress.IPv6Address(raw_host[1:-1]).compressed}]"
        except ValueError as exc:
            raise _InvalidUrl("bad ipv6") from exc
    host = _percent_decode(raw_host)
    if _FORBIDDEN_HOST_RE.search(host):
        raise _InvalidUrl("forbidden host code point")
    try:
        ascii_host = host.encode("idna").decode("ascii") if not host.isascii() else host
    except UnicodeError as exc:
        raise _InvalidUrl("bad idna") from exc
    ascii_host = ascii_host.lower()
    if not ascii_host:
        raise _InvalidUrl("empty host")
    return ascii_host


def _encode_path_segment(seg: str) -> str:
    out: list[str] = []
    for ch in _SURROGATE_RE.sub("\ufffd", seg):
        code = ord(ch)
        if code < 0x21 or code > 0x7E or ch in _PATH_ENCODE:
            out.extend(f"%{b:02X}" for b in ch.encode("utf-8"))
        else:
            out.append(ch)
    return "".join(out)


def _normalize_path(path: str) -> str:
    segments = path.split("/")[1:] if path else []
    out: list[str] = []
    for i, seg in enumerate(segments):
        last = i == len(segments) - 1
        low = seg.lower()
        if low in ("..", ".%2e", "%2e.", "%2e%2e"):
            if out:
                out.pop()
            if last:
                out.append("")
        elif low in (".", "%2e"):
            if last:
                out.append("")
        else:
            out.append(_encode_path_segment(seg))
    return "/" + "/".join(out)


def _parse_network_url(scheme: str, rest: str) -> tuple[str, str]:
    """`(origin, pathname)` for an http(s)/ws(s) URL; raises `_InvalidUrl`."""
    rest = rest.lstrip("/\\")
    end = len(rest)
    for sep in "/\\?#":
        idx = rest.find(sep)
        if idx != -1:
            end = min(end, idx)
    authority, remainder = rest[:end], rest[end:]
    if "@" in authority:
        authority = authority.rsplit("@", 1)[1]
    if authority.startswith("["):
        close = authority.find("]")
        if close == -1:
            raise _InvalidUrl("bad ipv6")
        raw_host, port_part = authority[: close + 1], authority[close + 1 :]
        if port_part and not port_part.startswith(":"):
            raise _InvalidUrl("junk after ipv6")
        port = port_part[1:] if port_part else ""
    else:
        raw_host, _, port = authority.partition(":")
    host = _parse_host(raw_host)
    if port:
        if not port.isdigit() or not port.isascii():
            raise _InvalidUrl("bad port")
        number = int(port)
        if number > 65535:
            raise _InvalidUrl("bad port")
        port = "" if str(number) == _DEFAULT_PORTS[scheme] else str(number)
    origin = f"{scheme}://{host}" + (f":{port}" if port else "")
    path = re.split(r"[?#]", remainder, maxsplit=1)[0].replace("\\", "/")
    return origin, _normalize_path(path)


def sanitize_reported_url(raw: str | None) -> str:
    """Reduce a reported URL to something safe to log (`sanitizeReportedUrl`).
    CSP keywords the browser reports instead of a URL (`inline`, `eval`,
    …) pass through; non-network schemes collapse to the scheme; http(s) /
    ws(s) URLs keep origin + path only, share tokens redacted."""
    if not raw:
        return ""
    if _KEYWORD_RE.fullmatch(raw):
        return _clip(raw)
    # WHATWG pre-processing: strip leading/trailing C0 controls + space,
    # drop ASCII tab / newline anywhere.
    url = re.sub(r"[\t\n\r]", "", raw.strip("".join(chr(c) for c in range(0x21))))
    match = _SCHEME_RE.fullmatch(url)
    if match is None:
        return "invalid"
    scheme = match.group(1).lower()
    rest = match.group(2)
    if scheme not in _NETWORK_SCHEMES:
        if scheme == "ftp":
            try:
                _parse_network_url("http", rest)  # same host rules; validity only
            except _InvalidUrl:
                return "invalid"
        if scheme == "about" and rest == "srcdoc":
            return "about:srcdoc"
        return f"{scheme}:"
    try:
        origin, path = _parse_network_url(scheme, rest)
    except _InvalidUrl:
        return "invalid"
    return _clip(f"{origin}{_SHARE_TOKEN_RE.sub(_redact, path, count=1)}")


def _redact(m: re.Match[str]) -> str:
    return f"/share/{m.group(1)}/:token"


# --- Report parsing ---------------------------------------------------------


def _to_log(body: dict[str, Any], via: Via) -> dict[str, Any]:
    """Normalise one violation object (either format's field names) into
    the log record (`toLog`). Key order matches the TS object."""
    directive = (
        _str(body.get("effective-directive"))
        or _str(body.get("effectiveDirective"))
        or _str(body.get("violated-directive"))
        or _str(body.get("violatedDirective"))
        or "unknown"
    )
    document = sanitize_reported_url(
        _str(body.get("document-uri")) or _str(body.get("documentURL"))
    )
    log: dict[str, Any] = {
        "evt": "csp_violation",
        "via": via,
        "directive": _clip(directive.split(" ")[0]),
        "blocked": sanitize_reported_url(
            _str(body.get("blocked-uri")) or _str(body.get("blockedURL"))
        ),
        "document": document,
    }
    source = _str(body.get("source-file")) or _str(body.get("sourceFile"))
    if source:
        log["source"] = sanitize_reported_url(source)
    line = _num(body.get("line-number"))
    if line is None:
        line = _num(body.get("lineNumber"))
    if line is not None:
        log["line"] = line
    column = _num(body.get("column-number"))
    if column is None:
        column = _num(body.get("columnNumber"))
    if column is not None:
        log["column"] = column
    disposition = _str(body.get("disposition"))
    if disposition in ("enforce", "report"):
        log["disposition"] = disposition
    if document == "about:srcdoc":
        log["srcdoc"] = True
    return log


def parse_csp_reports(payload: Any) -> list[dict[str, Any]]:
    """The violations in a parsed body (`parseCspReports`). Unknown shapes
    and non-CSP Reporting-API entries yield nothing rather than an error."""
    if isinstance(payload, list):
        out: list[dict[str, Any]] = []
        for entry in payload[:CSP_REPORT_MAX_ENTRIES]:
            if (
                not isinstance(entry, dict)
                or entry.get("type") != "csp-violation"
                or not isinstance(entry.get("body"), dict)
            ):
                continue
            out.append(_to_log(entry["body"], "reporting-api"))
        return out
    if isinstance(payload, dict) and isinstance(payload.get("csp-report"), dict):
        return [_to_log(payload["csp-report"], "report-uri")]
    return []


def _reject_constant(name: str) -> Any:
    raise ValueError(f"invalid JSON constant {name}")


def decode_report_body(raw: bytes) -> Any:
    """`JSON.parse(new TextDecoder().decode(bytes))`: invalid UTF-8 becomes
    U+FFFD, a leading BOM is dropped, and `NaN` / `Infinity` (which
    Python's `json` would accept) are rejected. Raises `ValueError`."""
    text = raw.decode("utf-8", "replace")
    if text.startswith("\ufeff"):
        text = text[1:]
    return json.loads(text, parse_constant=_reject_constant)

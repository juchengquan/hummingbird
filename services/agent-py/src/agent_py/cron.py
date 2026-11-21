"""Cron evaluation with the exact semantics of the TypeScript side.

The Next.js schedule routes and the Vercel Cron dispatcher evaluate cron
expressions with `cron-parser` 5.5.0 (`lib/server/agent/schedules.ts`:
`nextRunFromCron`, `validateScheduleCron`), which does its date math in
`luxon` 3.7. A schedule row is written by one backend and fired by the
other while both run (the agent-py scheduler overlaps the Vercel Cron by
design), so Python has to compute the *same* `next_run_at` for the same
(cron, timezone, instant) — including on DST transition days, where
cron libraries disagree most.

No Python cron library reproduces cron-parser's behaviour (its DST rules
are its own: a fire time inside a spring-forward gap moves to the next
existing hour only when the previous hour is scheduled, a fall-back hour
fires once, the day/hour search falls back to hour-by-hour stepping on
transition days, …), so this module is a line-by-line port of the parts
of cron-parser the backend uses — parsing and forward iteration
(`CronExpressionParser.parse`, `CronExpression.next`, `CronDate`,
the `CronField` classes) — plus the slice of luxon's date arithmetic
they rely on (`DateTime#plus`/`#set`/`#startOf`/`#endOf`, `fixOffset`,
zone normalisation). Quirks are kept on purpose (e.g. the loop limit
returns a non-matching date instead of throwing; `0,0` is not a
duplicate; a 4-field expression parses with `minute = 0`).

Parity is pinned by `tests/test_cron_parity.py`, which replays a table
of cases whose expected values were produced by running the TypeScript
functions under bun (`scripts/gen-cron-parity-fixtures.ts`; the bun test
`lib/server/agent/schedules.parity.test.ts` fails when the committed
fixture no longer matches cron-parser).

Known, deliberate gaps (documented in the services/agent-py README):
  - `H` (hashed) fields use an unseeded random value per parse, as
    cron-parser does without `hashSeed` — the results are random on both
    sides and so cannot be compared.
  - Time-zone names resolve through Python's `zoneinfo` (IANA tzdata,
    case-insensitive like ICU) instead of ICU. Names ICU still knows but
    tzdata dropped (e.g. `US/Pacific-New`) are rejected here.
  - `local` / `system` / `default` mean the process's own zone on both
    sides (UTC on Vercel and in the container).
"""

from __future__ import annotations

import calendar
import math
import random
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from typing import Final, Protocol
from zoneinfo import ZoneInfo, available_timezones

__all__ = [
    "JS_WHITESPACE_CLASS",
    "CronError",
    "CronIterator",
    "js_split_whitespace",
    "next_run_from_cron",
    "parse_cron",
]


class CronError(ValueError):
    """Any parse / zone / evaluation failure. The TS callers catch every
    error alike, so the message is informational only."""


# ---------------------------------------------------------------------------
# JS primitives the port depends on
# ---------------------------------------------------------------------------

# ECMAScript WhiteSpace + LineTerminator: what `\s`, `String#trim` and
# `parseInt` skip in JS. Python's `\s` / `str.strip()` use another set.
_JS_WS_CHARS: Final = "".join(
    chr(c)
    for c in (
        *(0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680),
        *range(0x2000, 0x200B),
        *(0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF),
    )
)
_JS_WS_CLASS: Final = "[" + re.escape(_JS_WS_CHARS) + "]"
JS_WHITESPACE_CLASS: Final = _JS_WS_CLASS
"""Regex character class matching what JS `\\s` matches."""
_JS_WS_RUN = re.compile(_JS_WS_CLASS + "+")
_JS_TRIM = re.compile(f"^{_JS_WS_CLASS}+|{_JS_WS_CLASS}+\\Z")

_PARSE_INT_RE = re.compile(r"[+-]?[0-9]+", re.ASCII)
_NUMBER_DEC_RE = re.compile(
    r"[+-]?(?:Infinity|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)", re.ASCII
)
_NUMBER_RADIX_RE = re.compile(r"0(?:[xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)", re.ASCII)


def _js_trim(s: str) -> str:
    return _JS_TRIM.sub("", s)


def js_split_whitespace(s: str) -> list[str]:
    """`s.trim().split(/\\s+/)`."""
    return _JS_WS_RUN.split(_js_trim(s))


def _js_parse_int(s: str) -> int | None:
    """`parseInt(s, 10)`; None stands for NaN."""
    m = _PARSE_INT_RE.match(s.lstrip(_JS_WS_CHARS))
    return int(m.group(0)) if m else None


def _js_number(s: str) -> float:
    """`Number(s)` / unary `+s` for a string; NaN when not numeric."""
    t = _js_trim(s)
    if t == "":
        return 0.0
    if _NUMBER_RADIX_RE.fullmatch(t):
        return float(int(t, 0))
    if _NUMBER_DEC_RE.fullmatch(t):
        return float(t.replace("Infinity", "inf"))
    return math.nan


def _num(value: float) -> int | float:
    """Store integral JS numbers as Python ints (the common case)."""
    if math.isfinite(value) and value == int(value):
        return int(value)
    return value


def _js_str(value: int | float | str) -> str:
    """`String(value)` for the values a cron field can hold."""
    if isinstance(value, str):
        return value
    if isinstance(value, int):
        return str(value)
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == int(value) and abs(value) < 1e21:
        return str(int(value))
    return repr(value)


# ---------------------------------------------------------------------------
# luxon: zones + date math (ms timestamps, offsets in seconds)
# ---------------------------------------------------------------------------


class _Zone(Protocol):
    def offset_s(self, ts_ms: int) -> int: ...


@dataclass(frozen=True)
class _FixedZone:
    seconds: int

    def offset_s(self, ts_ms: int) -> int:
        return self.seconds


class _SystemZone:
    """luxon's `SystemZone`: the process's own zone."""

    def offset_s(self, ts_ms: int) -> int:
        return time.localtime(ts_ms // 1000).tm_gmtoff


@dataclass(frozen=True)
class _IanaZone:
    info: ZoneInfo

    def offset_s(self, ts_ms: int) -> int:
        # luxon's IANAZone.offset formats the instant floored to the
        # second, so the offset is whole seconds.
        off = datetime.fromtimestamp(ts_ms // 1000, tz=self.info).utcoffset()
        return int(off.total_seconds()) if off is not None else 0


_UTC_ZONE: Final = _FixedZone(0)
_SYSTEM_ZONE: Final = _SystemZone()
_UTC_SPECIFIER = re.compile(r"utc(?:([+-][0-9]{1,2})(?::([0-9]{2}))?)?", re.ASCII)
# ECMA-402 offset time zones (`+05:00`, `+0500`, `+05`), accepted by
# `Intl.DateTimeFormat` and therefore by luxon's IANAZone.
_OFFSET_ZONE = re.compile(r"([+-])([01][0-9]|2[0-3])(?::?([0-5][0-9]))?", re.ASCII)


@lru_cache(maxsize=1)
def _zone_names() -> dict[str, str]:
    """Lower-cased IANA name → its canonical spelling. ICU (what luxon
    validates zones with) matches names case-insensitively."""
    return {name.lower(): name for name in available_timezones()}


@lru_cache(maxsize=512)
def _resolve_zone(tz: str) -> _Zone | None:
    """luxon's `normalizeZone` for a string; None for an invalid zone."""
    lowered = tz.lower()
    if lowered in ("default", "local", "system"):
        return _SYSTEM_ZONE
    if lowered in ("utc", "gmt"):
        return _UTC_ZONE
    spec = _UTC_SPECIFIER.fullmatch(lowered)
    if spec:
        hour_s, minute_s = spec.group(1), spec.group(2)
        hours = int(hour_s) if hour_s else 0
        minutes = int(minute_s) if minute_s else 0
        negative = bool(hour_s) and hour_s.startswith("-")
        return _FixedZone(hours * 3600 + (-minutes if negative else minutes) * 60)
    off = _OFFSET_ZONE.fullmatch(tz)
    if off:
        sign = -1 if off.group(1) == "-" else 1
        return _FixedZone(sign * (int(off.group(2)) * 3600 + int(off.group(3) or 0) * 60))
    name = _zone_names().get(lowered)
    if name is None:
        return None
    try:
        return _IanaZone(ZoneInfo(name))
    except (ValueError, OSError):
        return None


_EPOCH_ORDINAL: Final = date(1970, 1, 1).toordinal()
_MS_PER_DAY: Final = 86_400_000


@dataclass(frozen=True)
class _Local:
    year: int
    month: int
    day: int
    hour: int
    minute: int
    second: int
    millisecond: int


def _ts_to_obj(ts_ms: int, offset_s: int) -> _Local:
    days, rem = divmod(ts_ms + offset_s * 1000, _MS_PER_DAY)
    d = date.fromordinal(_EPOCH_ORDINAL + days)
    hour, rem = divmod(rem, 3_600_000)
    minute, rem = divmod(rem, 60_000)
    second, ms = divmod(rem, 1000)
    return _Local(d.year, d.month, d.day, hour, minute, second, ms)


def _obj_to_local_ts(
    year: int, month: int, day: int, hour: int, minute: int, second: int, ms: int
) -> int:
    """`Date.UTC(...)`, with its overflow normalisation of every field."""
    year += (month - 1) // 12
    month = (month - 1) % 12 + 1
    days = date(year, month, 1).toordinal() - _EPOCH_ORDINAL + (day - 1)
    return days * _MS_PER_DAY + hour * 3_600_000 + minute * 60_000 + second * 1000 + ms


def _days_in_month(year: int, month: int) -> int:
    mod_month = (month - 1) % 12 + 1
    mod_year = year + (month - mod_month) // 12
    return calendar.monthrange(mod_year, mod_month)[1]


def _fix_offset(local_ts: int, o: int, zone: _Zone) -> tuple[int, int]:
    """luxon's `fixOffset`: local wall time + an offset guess → instant."""
    utc_guess = local_ts - o * 1000
    o2 = zone.offset_s(utc_guess)
    if o == o2:
        return utc_guess, o
    utc_guess -= (o2 - o) * 1000
    o3 = zone.offset_s(utc_guess)
    if o2 == o3:
        return utc_guess, o2
    return local_ts - min(o2, o3) * 1000, max(o2, o3)


# cron-parser's `DAYS_IN_MONTH` table (February listed as 29).
_DAYS_IN_MONTH_TABLE: Final = (31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


class _CronDate:
    """cron-parser's `CronDate` over a luxon DateTime, held as
    (epoch ms, zone). Only the forward-search operations are ported."""

    __slots__ = ("dst_end", "dst_start", "ts", "zone")

    def __init__(self, ts: int, zone: _Zone) -> None:
        self.ts = ts
        self.zone = zone
        self.dst_start: int | None = None
        self.dst_end: int | None = None

    def copy(self) -> _CronDate:
        out = _CronDate(self.ts, self.zone)
        out.dst_start = self.dst_start
        out.dst_end = self.dst_end
        return out

    # --- luxon -------------------------------------------------------------

    @property
    def _offset(self) -> int:
        return self.zone.offset_s(self.ts)

    @property
    def _c(self) -> _Local:
        return _ts_to_obj(self.ts, self._offset)

    def _set(self, **values: int) -> None:
        """`DateTime#set` for gregorian units."""
        c = self._c
        mixed = {
            "year": c.year,
            "month": c.month,
            "day": c.day,
            "hour": c.hour,
            "minute": c.minute,
            "second": c.second,
            "millisecond": c.millisecond,
            **values,
        }
        if "day" not in values:
            mixed["day"] = min(_days_in_month(mixed["year"], mixed["month"]), mixed["day"])
        local = _obj_to_local_ts(
            mixed["year"],
            mixed["month"],
            mixed["day"],
            mixed["hour"],
            mixed["minute"],
            mixed["second"],
            mixed["millisecond"],
        )
        self.ts, _ = _fix_offset(local, self._offset, self.zone)

    def _plus_calendar(self, *, months: int = 0, days: int = 0) -> None:
        """`DateTime#plus` for calendar units (luxon's `adjustTime`)."""
        c = self._c
        month = c.month + months
        day = min(c.day, _days_in_month(c.year, month)) + days
        local = _obj_to_local_ts(c.year, month, day, c.hour, c.minute, c.second, c.millisecond)
        self.ts, _ = _fix_offset(local, self._offset, self.zone)

    def _start_of(self, unit: str) -> None:
        if unit == "month":
            self._set(day=1, hour=0, minute=0, second=0, millisecond=0)
        elif unit == "day":
            self._set(hour=0, minute=0, second=0, millisecond=0)
        elif unit == "hour":
            self._set(minute=0, second=0, millisecond=0)
        elif unit == "minute":
            self._set(second=0, millisecond=0)
        else:  # pragma: no cover - programming error
            raise AssertionError(unit)

    # --- CronDate ----------------------------------------------------------

    def add_month(self) -> None:
        self._plus_calendar(months=1)
        self._start_of("month")

    def add_day(self) -> None:
        self._plus_calendar(days=1)
        self._start_of("day")

    def add_hour(self) -> None:
        self.ts += 3_600_000
        self._start_of("hour")

    def add_minute(self) -> None:
        self.ts += 60_000
        self._start_of("minute")

    def add_second(self) -> None:
        self.ts += 1000

    def set_start_of_day(self) -> None:
        self._start_of("day")

    def set_end_of_day(self) -> None:
        # luxon's endOf('day'): plus a day, startOf('day'), minus 1 ms.
        self._plus_calendar(days=1)
        self._start_of("day")
        self.ts -= 1

    def set_hours(self, h: int) -> None:
        self._set(hour=h)

    def set_minutes(self, m: int) -> None:
        self._set(minute=m)

    def set_seconds(self, s: int) -> None:
        self._set(second=s)

    def set_milliseconds(self, ms: int) -> None:
        self._set(millisecond=ms)

    def get_date(self) -> int:
        return self._c.day

    def get_day(self) -> int:
        c = self._c
        return (date(c.year, c.month, c.day).weekday() + 1) % 7

    def get_month(self) -> int:
        return self._c.month - 1

    def get_full_year(self) -> int:
        return self._c.year

    def get_hours(self) -> int:
        return self._c.hour

    def get_minutes(self) -> int:
        return self._c.minute

    def get_seconds(self) -> int:
        return self._c.second

    def get_milliseconds(self) -> int:
        return self._c.millisecond

    def get_utc_offset(self) -> int:
        return self._offset

    def is_last_day_of_month(self) -> bool:
        c = self._c
        if c.month == 2:
            return c.day == _DAYS_IN_MONTH_TABLE[1] - (0 if calendar.isleap(c.year) else 1)
        return c.day == _DAYS_IN_MONTH_TABLE[c.month - 1]

    def is_last_weekday_of_month(self) -> bool:
        c = self._c
        if c.month == 2:
            last = _DAYS_IN_MONTH_TABLE[1] - (0 if calendar.isleap(c.year) else 1)
        else:
            last = _DAYS_IN_MONTH_TABLE[c.month - 1]
        return c.day > last - 7

    def _invoke(self, unit: str) -> None:
        {
            "Month": self.add_month,
            "Day": self.add_day,
            "Hour": self.add_hour,
            "Minute": self.add_minute,
            "Second": self.add_second,
        }[unit]()

    def apply_date_operation(self, unit: str, hours_length: int) -> None:
        """`applyDateOperation('Add', unit, hoursLength)`."""
        if unit in ("Month", "Day"):
            self._invoke(unit)
            return
        previous_hour = self.get_hours()
        self._invoke(unit)
        current_hour = self.get_hours()
        diff = current_hour - previous_hour
        if diff == 2:
            if hours_length != 24:
                self.dst_start = current_hour
        elif (
            diff == 0 and self.get_minutes() == 0 and self.get_seconds() == 0 and hours_length != 24
        ):
            self.dst_end = current_hour


# ---------------------------------------------------------------------------
# cron-parser: fields + parser
# ---------------------------------------------------------------------------

Value = int | float | str

_PREDEFINED: Final = {
    "@yearly": "0 0 0 1 1 *",
    "@annually": "0 0 0 1 1 *",
    "@monthly": "0 0 0 1 * *",
    "@weekly": "0 0 0 * * 0",
    "@daily": "0 0 0 * * *",
    "@hourly": "0 0 * * * *",
    "@minutely": "0 * * * * *",
    "@secondly": "* * * * * *",
    "@weekdays": "0 0 0 * * 1-5",
    "@weekends": "0 0 0 * * 0,6",
}
_MONTHS: Final = {
    m: i + 1
    for i, m in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
    )
}
_DAYS: Final = {d: i for i, d in enumerate(("sun", "mon", "tue", "wed", "thu", "fri", "sat"))}

# `[^\n\r\u2028\u2029]` is JS's `.`.
_ANY: Final = "[^\\n\\r\\u2028\\u2029]*"
_HASH_ALTERNATIVES: Final = (
    re.compile(_ANY + r"H\([0-9]+-[0-9]+\)/[0-9]+" + _ANY),
    re.compile(_ANY + r"H\([0-9]+-[0-9]+\)" + _ANY),
    re.compile(_ANY + r"H/[0-9]+" + _ANY),
)
_HASHED = re.compile(r"H(?:\(([0-9]+)-([0-9]+)\))?(?:/([0-9]+))?")
_ALIAS = re.compile(r"[a-z]{3}", re.IGNORECASE | re.ASCII)
_NTH_INCOMPATIBLE = re.compile(r"([,-/])")


@dataclass(frozen=True)
class _Unit:
    name: str
    min: int
    max: int
    chars: tuple[str, ...]
    valid_chars: re.Pattern[str]

    def valid(self, value: str) -> bool:
        return bool(self.valid_chars.fullmatch(value)) or any(
            p.fullmatch(value) for p in _HASH_ALTERNATIVES
        )


_SECOND = _Unit("Second", 0, 59, (), re.compile(r"[?,*0-9H/-]+"))
_MINUTE = _Unit("Minute", 0, 59, (), re.compile(r"[?,*0-9H/-]+"))
_HOUR = _Unit("Hour", 0, 23, (), re.compile(r"[?,*0-9H/-]+"))
_DOM = _Unit("DayOfMonth", 1, 31, ("L",), re.compile(r"[?,*0-9LH/-]+"))
_MONTH = _Unit("Month", 1, 12, (), re.compile(r"[?,*0-9H/-]+"))
_DOW = _Unit("DayOfWeek", 0, 7, ("L",), re.compile(r"[?,*0-9LH#/-]+"))


def _sort_key(v: Value) -> tuple[int, float, str]:
    # CronField.sorter: numbers ascending, then strings (localeCompare —
    # for the digit/`L` strings a field can hold, code-point order).
    if isinstance(v, str):
        return (1, 0.0, v)
    return (0, float(v), "")


class _Field:
    def __init__(
        self,
        unit: _Unit,
        values: list[Value],
        raw: str,
        nth_day: int | float = 0,
    ) -> None:
        if len(values) == 0:
            raise CronError(f"{unit.name} Validation error, values contains no values")
        self.unit = unit
        self.values: list[Value] = sorted(values, key=_sort_key)
        self.raw = raw
        if raw:
            self.is_wildcard = raw in ("*", "?")
        else:  # pragma: no cover - raw is never empty here
            self.is_wildcard = all(v in self.values for v in range(unit.min, unit.max + 1))
        self.has_last_char = "L" in raw or "L" in self.values
        self.nth_day = nth_day
        self._validate()
        # Numeric values only, for `findNearestValue` (second/minute/hour
        # hold numbers only).
        self.numbers: list[int | float] = [v for v in self.values if not isinstance(v, str)]

    def _validate(self) -> None:
        for value in self.values:
            if isinstance(value, str):
                ok = any(re.fullmatch(f"[0-9]{{0,2}}{c}", value, re.ASCII) for c in self.unit.chars)
            else:
                ok = self.unit.min <= value <= self.unit.max
            if not ok:
                raise CronError(f"{self.unit.name} Validation error, got value {value}")
        for index, value in enumerate(self.values):
            first = self.values.index(value)
            if first != index:
                # JS: `if (duplicate)` — a duplicated 0 is falsy and passes.
                if value:
                    raise CronError(f"{self.unit.name} Validation error, duplicate values")
                break

    def contains(self, value: int) -> bool:
        return any(not isinstance(v, str) and v == value for v in self.values)

    def find_nearest_value(self, current: int) -> int | float | None:
        for v in self.numbers:
            if v > current:
                return v
        return None


def _parse_hashed(value: str, unit: _Unit, rand: Callable[[], float]) -> str:
    random_value = rand()

    def repl(m: re.Match[str]) -> str:
        lo_s, hi_s, step_s = m.group(1), m.group(2), m.group(3)
        if lo_s and hi_s and step_s:
            lo, hi, step = int(lo_s), int(hi_s), int(step_s)
            if lo > hi:
                raise CronError(f"Invalid range: {lo}-{hi}, min > max")
            if step <= 0:
                raise CronError(f"Invalid step: {step}, must be positive")
            min_start = max(lo, unit.min)
            offset = math.floor(random_value * step)
            out: list[str] = []
            i = math.floor(min_start / step) * step + offset
            while i <= hi:
                if i >= min_start:
                    out.append(str(i))
                i += step
            return ",".join(out)
        if lo_s and hi_s:
            lo, hi = int(lo_s), int(hi_s)
            if lo > hi:
                raise CronError(f"Invalid range: {lo}-{hi}, min > max")
            return str(math.floor(random_value * (hi - lo + 1)) + lo)
        if step_s:
            step = int(step_s)
            if step <= 0:
                raise CronError(f"Invalid step: {step}, must be positive")
            offset = math.floor(random_value * step)
            out = []
            i = math.floor(unit.min / step) * step + offset
            while i <= unit.max:
                if i >= unit.min:
                    out.append(str(i))
                i += step
            return ",".join(out)
        return str(math.floor(random_value * (unit.max - unit.min + 1) + unit.min))

    return _HASHED.sub(repl, value)


def _create_range(unit: _Unit, lo: int, hi: int, step: int) -> list[Value]:
    stack: list[Value] = []
    if unit is _DOW and hi % 7 == 0:
        stack.append(0)
    i = lo
    while i <= hi:
        if i not in stack:
            stack.append(i)
        i += step
    return stack


def _parse_range(unit: _Unit, val: str, step: int | None) -> list[Value] | Value:
    atoms = val.split("-")
    if len(atoms) <= 1:
        n = _js_number(val)
        return val if math.isnan(n) else _num(n)
    lo, hi = _js_parse_int(atoms[0]), _js_parse_int(atoms[1])
    if lo is None or hi is None or lo < unit.min or hi > unit.max:
        raise CronError(f"Constraint error, got range {lo}-{hi}")
    if lo > hi:
        raise CronError(f"Invalid range: {lo}-{hi}")
    if step is None or step <= 0:
        raise CronError(f"Constraint error, cannot repeat at every {step} time.")
    return _create_range(unit, lo, hi, step)


def _parse_repeat(unit: _Unit, val: str) -> list[Value] | Value:
    atoms = val.split("/")
    if len(atoms) > 2:
        raise CronError(f"Invalid repeat: {val}")
    if len(atoms) == 2:
        if _js_parse_int(atoms[0]) is not None:
            atoms[0] = f"{atoms[0]}-{unit.max}"
        return _parse_range(unit, atoms[0], _js_parse_int(atoms[1]))
    return _parse_range(unit, val, 1)


def _parse_sequence(unit: _Unit, val: str) -> list[Value]:
    stack: list[Value] = []
    for atom in val.split(","):
        if not atom:
            raise CronError("Invalid list value format")
        result = _parse_repeat(unit, atom)
        if isinstance(result, list):
            stack.extend(result)
            continue
        text = _js_str(result)
        if any(c in text for c in unit.chars):
            stack.append(result)
            continue
        v = _js_parse_int(text)
        if v is None or not (unit.min <= v <= unit.max):
            raise CronError(f"Constraint error, got value {result}")
        stack.append(v % 7 if unit is _DOW else result)
    return stack


def _parse_field(unit: _Unit, value: str, rand: Callable[[], float]) -> list[Value]:
    if unit is _MONTH or unit is _DOW:

        def alias(m: re.Match[str]) -> str:
            key = m.group(0).lower()
            replacer = _MONTHS.get(key)
            if replacer is None:
                replacer = _DAYS.get(key)
            if replacer is None:
                raise CronError(f'Validation error, cannot resolve alias "{key}"')
            return str(replacer)

        value = _ALIAS.sub(alias, value)
    if not unit.valid(value):
        raise CronError(f"Invalid characters, got value: {value}")
    value = re.sub(r"[*?]", f"{unit.min}-{unit.max}", value)
    value = _parse_hashed(value, unit, rand)
    return _parse_sequence(unit, value)


def _parse_nth_day(val: str) -> tuple[str, int | float | None]:
    atoms = val.split("#")
    if len(atoms) <= 1:
        return atoms[0], None
    nth = _js_number(atoms[-1])
    if _NTH_INCOMPATIBLE.search(val):
        raise CronError("Constraint error, invalid dayOfWeek `#` and special characters")
    if not (len(atoms) <= 2 and not math.isnan(nth) and 1 <= nth <= 5):
        raise CronError("Constraint error, invalid dayOfWeek occurrence number (#)")
    return atoms[0], _num(nth)


@dataclass(frozen=True)
class _Fields:
    second: _Field
    minute: _Field
    hour: _Field
    day_of_month: _Field
    month: _Field
    day_of_week: _Field


def _parse_fields(expression: str, rand: Callable[[], float]) -> _Fields:
    expression = _PREDEFINED.get(expression, expression)
    expression = expression or "0 * * * * *"
    atoms = js_split_whitespace(expression)
    if len(atoms) > 6:
        raise CronError("Invalid cron expression, too many fields")
    defaults = ["*", "*", "*", "*", "*", "0"]
    if len(atoms) < len(defaults):
        atoms = defaults[len(atoms) :] + atoms
    second_raw, minute_raw, hour_raw, dom_raw, month_raw, dow_raw = atoms

    second = _parse_field(_SECOND, second_raw, rand)
    minute = _parse_field(_MINUTE, minute_raw, rand)
    hour = _parse_field(_HOUR, hour_raw, rand)
    month = _parse_field(_MONTH, month_raw, rand)
    dom = _parse_field(_DOM, dom_raw, rand)
    dow_value, nth = _parse_nth_day(dow_raw)
    dow = _parse_field(_DOW, dow_value, rand)
    fields = _Fields(
        second=_Field(_SECOND, second, second_raw),
        minute=_Field(_MINUTE, minute, minute_raw),
        hour=_Field(_HOUR, hour, hour_raw),
        day_of_month=_Field(_DOM, dom, dom_raw),
        month=_Field(_MONTH, month, month_raw),
        day_of_week=_Field(_DOW, dow, dow_raw, nth_day=nth or 0),
    )
    # CronFieldCollection: a single month whose smallest listed day it
    # can never have (`0 0 30 2 *`) is rejected up front.
    month_f, dom_f = fields.month, fields.day_of_month
    if len(month_f.values) == 1 and not dom_f.has_last_char:
        first_day = _js_parse_int(_js_str(dom_f.values[0]))
        month_index = int(month_f.values[0]) - 1
        limit = _DAYS_IN_MONTH_TABLE[month_index] if 0 <= month_index < 12 else None
        if first_day is None or limit is None or not first_day <= limit:
            raise CronError("Invalid explicit day of month definition")
    return fields


# ---------------------------------------------------------------------------
# cron-parser: CronExpression (forward iteration)
# ---------------------------------------------------------------------------

_LOOP_LIMIT: Final = 10_000


class CronIterator:
    """`CronExpression` with `next()` only. Construct via `parse_cron`."""

    def __init__(self, fields: _Fields, zone: _Zone, after_ms: int) -> None:
        self._fields = fields
        self._current = _CronDate(after_ms, zone)

    def _match_day_of_month(self, cd: _CronDate) -> bool:
        dom, dow = self._fields.day_of_month, self._fields.day_of_week
        matched_dom = dom.contains(cd.get_date()) or (
            dom.has_last_char and cd.is_last_day_of_month()
        )
        matched_dow = dow.contains(cd.get_day()) or (
            dow.has_last_char and self._is_last_weekday_of_month_match(dow.values, cd)
        )
        if not dom.is_wildcard and not dow.is_wildcard and (matched_dom or matched_dow):
            return True
        if matched_dom and dow.is_wildcard:
            return True
        return dom.is_wildcard and not dow.is_wildcard and matched_dow

    @staticmethod
    def _is_last_weekday_of_month_match(expressions: list[Value], cd: _CronDate) -> bool:
        is_last = cd.is_last_weekday_of_month()
        for expression in expressions:
            parsed = _js_parse_int(_js_str(expression)[:1])
            if parsed is None:
                raise CronError(f"Invalid last weekday of the month expression: {expression}")
            if cd.get_day() == parsed % 7 and is_last:
                return True
        return False

    def _check_dst_transition(self, cd: _CronDate) -> bool:
        start = cd.copy()
        start.set_start_of_day()
        end = cd.copy()
        end.set_end_of_day()
        return start.get_utc_offset() != end.get_utc_offset()

    def _match_hour(self, cd: _CronDate) -> bool:
        hour = self._fields.hour
        hours_length = len(hour.values)
        current_hour = cd.get_hours()
        is_match = hour.contains(current_hour)
        if cd.dst_start == current_hour:
            if hour.contains(current_hour - 1):
                return True
            cd.add_hour()
            return False
        if cd.dst_end == current_hour:
            cd.dst_end = None
            cd.apply_date_operation("Hour", hours_length)
            return False
        if is_match:
            return True
        cd.dst_start = None
        next_hour = hour.find_nearest_value(current_hour)
        if next_hour is None:
            cd.apply_date_operation("Day", hours_length)
            return False
        if self._check_dst_transition(cd):
            for _ in range(int(next_hour) - current_hour):
                cd.apply_date_operation("Hour", hours_length)
        else:
            cd.set_hours(int(next_hour))
        cd.set_minutes(int(self._fields.minute.values[0]))
        cd.set_seconds(int(self._fields.second.values[0]))
        return False

    def _move_to_next_minute(self, cd: _CronDate) -> None:
        f = self._fields
        next_minute = f.minute.find_nearest_value(cd.get_minutes())
        if next_minute is not None:
            cd.set_minutes(int(next_minute))
            cd.set_seconds(int(f.second.values[0]))
            return
        cd.apply_date_operation("Hour", len(f.hour.values))
        cd.set_minutes(int(f.minute.values[0]))
        cd.set_seconds(int(f.second.values[0]))

    def _move_to_next_second(self, cd: _CronDate) -> None:
        f = self._fields
        next_second = f.second.find_nearest_value(cd.get_seconds())
        if next_second is not None:
            cd.set_seconds(int(next_second))
            return
        cd.apply_date_operation("Minute", len(f.hour.values))
        cd.set_seconds(int(f.second.values[0]))

    def next_ms(self) -> int:
        """`CronExpression#next()` → epoch milliseconds."""
        f = self._fields
        hours_length = len(f.hour.values)
        cd = self._current.copy()
        start_timestamp = cd.ts
        step_count = 0
        while True:
            step_count += 1
            if step_count >= _LOOP_LIMIT:
                # `while (++stepCount < LOOP_LIMIT)` exits here and the
                # `stepCount > LOOP_LIMIT` guard after it never fires: the
                # current (non-matching) date is returned. Kept for parity.
                break
            if not self._match_day_of_month(cd):
                cd.apply_date_operation("Day", hours_length)
                continue
            nth = f.day_of_week.nth_day
            if not (nth <= 0 or math.ceil(cd.get_date() / 7) == nth):
                cd.apply_date_operation("Day", hours_length)
                continue
            if not f.month.contains(cd.get_month() + 1):
                cd.apply_date_operation("Month", hours_length)
                continue
            if not self._match_hour(cd):
                continue
            if not f.minute.contains(cd.get_minutes()):
                self._move_to_next_minute(cd)
                continue
            if not f.second.contains(cd.get_seconds()):
                self._move_to_next_second(cd)
                continue
            if start_timestamp == cd.ts:
                cd.apply_date_operation("Second", hours_length)
                continue
            break
        if cd.get_milliseconds() != 0:
            cd.set_milliseconds(0)
        self._current = cd
        return cd.ts

    def next(self) -> datetime:
        return _ms_to_datetime(self.next_ms())


def _datetime_to_ms(value: datetime) -> int:
    if value.tzinfo is None:
        raise CronError("naive datetime")
    return (value - datetime(1970, 1, 1, tzinfo=UTC)) // timedelta(milliseconds=1)


def _ms_to_datetime(ms: int) -> datetime:
    return datetime(1970, 1, 1, tzinfo=UTC) + timedelta(milliseconds=ms)


def parse_cron(
    expression: str,
    *,
    timezone: str,
    current_date: datetime,
    rand: Callable[[], float] = random.random,
) -> CronIterator:
    """`CronExpressionParser.parse(expression, { currentDate, tz })`.
    Raises `CronError` for an unparseable expression or unknown zone."""
    fields = _parse_fields(expression, rand)
    zone = _resolve_zone(timezone)
    if zone is None:
        raise CronError(f"CronDate: unhandled timestamp (unknown timezone {timezone!r})")
    return CronIterator(fields, zone, _datetime_to_ms(current_date))


def next_run_from_cron(cron: str, timezone: str, after: datetime) -> datetime | None:
    """Port of `nextRunFromCron`: the next fire strictly after `after`,
    or None for an unparseable cron / unknown timezone."""
    try:
        return parse_cron(cron, timezone=timezone, current_date=after).next()
    except Exception:
        return None

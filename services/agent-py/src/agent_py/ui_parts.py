"""Generative-UI part validation — the props shapes `renderUI` accepts.

The frontend's registry validates every part against `UiPartSchema`
(`lib/shared/generative-ui/schemas.ts`) before rendering it, and Next's
`renderUI` tool (`lib/server/generative-ui/tool.ts`) validates the
model's arguments against the same schema before emitting a part. This
module gives agent-py's `renderUI` the same check, so a part the client
would refuse to render ("props validation failed") is never raised as a
`ui-part` interrupt: the model gets a tool error instead and can retry,
as on the Next route.

The schema is `ui_part_schema.json`, generated from `UiPartSchema` by
`bun run codegen:agent-py-parity` (never edit it by hand). JSON Schema
can't express the one cross-field rule (`date-picker`: `min <= max`),
which is mirrored below; `tests/fixtures/ui_part_parity.json` (the TS
schema's verdicts on a case corpus) pins the two to agree.

Pure — the schema is read once, on first use.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

__all__ = ["SCHEMA_PATH", "render_ui_args_error", "ui_kinds"]

SCHEMA_PATH = Path(__file__).with_name("ui_part_schema.json")


@cache
def _schema() -> dict[str, Any]:
    schema: dict[str, Any] = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    return schema


@cache
def _validators() -> dict[str, Draft202012Validator]:
    """One validator per kind — the `oneOf` branch whose `kind` is that
    constant — so an error names the kind's own problem rather than every
    branch's mismatch."""
    out: dict[str, Draft202012Validator] = {}
    for branch in _schema()["oneOf"]:
        kind = branch["properties"]["kind"]["const"]
        out[kind] = Draft202012Validator(branch)
    return out


def ui_kinds() -> tuple[str, ...]:
    """The kinds `UiPartSchema` allows, in its order."""
    return tuple(_validators())


def _path(parts: Any) -> str:
    return ".".join(str(p) for p in parts) or "(root)"


def render_ui_args_error(args: Mapping[str, Any]) -> str | None:
    """`None` when `{kind, props}` is a part the client will render;
    otherwise the error the model gets back, worded like Next's
    `renderUI` (`Invalid renderUI props for kind "…": … (at …)`)."""
    kind = args.get("kind")
    validators = _validators()
    if not isinstance(kind, str) or kind not in validators:
        return f"Invalid renderUI kind {json.dumps(kind)}: expected one of {', '.join(validators)}."
    part = {"kind": kind, "props": args.get("props")}
    error = next(iter(sorted(validators[kind].iter_errors(part), key=lambda e: list(e.path))), None)
    if error is not None:
        return f'Invalid renderUI props for kind "{kind}": {error.message} (at {_path(error.path)})'
    props = part["props"]
    # `DatePickerPropsSchema.refine` — not expressible in JSON Schema.
    if kind == "date-picker" and isinstance(props, Mapping):
        lo, hi = props.get("min"), props.get("max")
        if isinstance(lo, str) and isinstance(hi, str) and lo > hi:
            return f'Invalid renderUI props for kind "{kind}": min must be <= max (at props)'
    return None

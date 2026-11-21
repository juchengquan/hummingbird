"""Citation-table extraction — Python port of `app/api/extract-table/route.ts`
and its helpers in `lib/shared/artifacts/extract-table.ts`.

Given a research report and its numbered sources, the model fills an
`Extraction` (columns + rows of column-tagged cells citing sources by
NUMBER); `extraction_to_citation_table` turns that into the stored
`CitationTable` shape (`lib/shared/artifacts/citation-table.ts`).

Generation follows the Next.js route's two-step shape:

  1. When the catalog flags the model `supportsStructuredOutput`, ask for
     the object natively. The Next.js route uses the AI SDK's
     `generateObject`; here it is a forced tool call whose input schema
     is the `Extraction` JSON Schema (the same mechanism `generateObject`
     uses against Anthropic). Any failure — a provider error, no tool
     call, a schema mismatch — falls through to step 2.
  2. Plain text with "Return ONLY JSON matching the schema." appended,
     fences stripped, `json.loads` + schema validation. A provider error
     here propagates to the route (categorised there); unparseable or
     off-schema output is an `ExtractionFailure` (502 `provider`).

The prompt text is a verbatim port of `buildExtractTablePrompt`; keep the
two in sync.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Annotated, Any, Literal

import structlog
from pydantic import BaseModel, Field, ValidationError

from .providers.anthropic_provider import AsyncAnthropicClient
from .summarise import strip_json_fences

logger = structlog.get_logger(__name__)

ColumnType = Literal["text", "number", "link", "date"]

#: Output cap + sampling for both generation steps — same values the
#: Next.js route passes (`maxOutputTokens: 4000`, `temperature: 0.2`).
EXTRACT_TABLE_MAX_TOKENS = 4000
EXTRACT_TABLE_TEMPERATURE = 0.2

#: Name of the forced tool used for native structured output. Matches the
#: AI SDK's `generateObject` tool name for Anthropic.
STRUCTURED_TOOL_NAME = "json"

TEXT_PATH_SUFFIX = "\n\nReturn ONLY JSON matching the schema."


# --- Extraction (what the model fills in) -----------------------------
# Mirrors `ExtractionSchema` and friends in
# `lib/shared/artifacts/extract-table.ts`.


class ExtractionCitation(BaseModel):
    source: Annotated[int, Field(ge=1, description="1-based index into the sources list.")]
    quote: Annotated[str, Field(max_length=2000)]


class ExtractionCell(BaseModel):
    columnId: Annotated[str, Field(min_length=1, max_length=60)]  # wire name
    value: Annotated[str, Field(max_length=4000)]
    citations: Annotated[list[ExtractionCitation], Field(max_length=8)] = []


class ExtractionColumn(BaseModel):
    id: Annotated[str, Field(min_length=1, max_length=60)]
    label: Annotated[str, Field(min_length=1, max_length=120)]
    type: ColumnType | None = None


class ExtractionRow(BaseModel):
    cells: Annotated[list[ExtractionCell], Field(max_length=12)]


class Extraction(BaseModel):
    columns: Annotated[list[ExtractionColumn], Field(min_length=1, max_length=12)]
    rows: Annotated[list[ExtractionRow], Field(max_length=200)]


@dataclass(frozen=True)
class NumberedSource:
    id: str
    title: str
    url: str | None = None
    snippet: str | None = None


@dataclass(frozen=True)
class ColumnHint:
    label: str
    type: ColumnType | None = None


@dataclass(frozen=True)
class ExtractionFailure:
    """The model answered, but not with a usable extraction. The route
    maps it to `502 {code: "provider", message}`."""

    message: str


# --- Prompt -------------------------------------------------------------


def build_extract_table_prompt(
    report_text: str,
    sources: list[NumberedSource],
    hints: list[ColumnHint | str] | None = None,
) -> str:
    """Verbatim port of `buildExtractTablePrompt`. The model cites cells by
    the source NUMBER shown here. Non-empty `hints` steer the model to
    use those labels verbatim (and per-type value formats for typed
    hints); `None` / empty leaves it free to choose 3-6 columns. Plain
    string hints are treated as Text (back-compat)."""
    typed_hints: list[ColumnHint] | None = (
        None if hints is None else [ColumnHint(label=h) if isinstance(h, str) else h for h in hints]
    )

    source_lines = "\n".join(
        f"[{i + 1}] {s.title}"
        + (f" — {s.url}" if s.url else "")
        + (f"\n    {s.snippet}" if s.snippet else "")
        for i, s in enumerate(sources)
    )

    present_types = {h.type or "text" for h in (typed_hints or [])}
    type_lines: list[str] = []
    if "number" in present_types:
        type_lines.append(
            '- For (Number) columns: emit the bare numeric value only, no units or words (e.g. "200" not "two hundred", "3.14" not "approximately three").'
        )
    if "link" in present_types:
        type_lines.append(
            "- For (Link) columns: emit a full http(s):// URL only (no surrounding text)."
        )
    if "date" in present_types:
        type_lines.append(
            '- For (Date) columns: emit the date as YYYY-MM-DD (ISO 8601), e.g. "2024-01-15".'
        )
    type_block = (
        "\n".join(["", "Per-type value format:", "- For (Text) columns: emit prose.", *type_lines])
        if type_lines
        else ""
    )

    has_hints = bool(typed_hints)
    hint_block = ""
    if typed_hints:
        labels = ", ".join(f"`{h.label}` ({_capitalize(h.type or 'text')})" for h in typed_hints)
        hint_block = "\n".join(
            [
                "",
                f"Required columns (use these labels and value formats exactly): {labels}.",
                "If the report doesn't support one of these, leave that cell empty (do NOT invent a different column).",
            ]
        )

    parts = [
        "You extract a structured comparison table from a research report.",
        "",
        "REPORT:",
        report_text,
        "",
        "SOURCES (cite by number):",
        source_lines,
        "",
        "Build a table with EXACTLY these columns (one per hint, in the order given):"
        if has_hints
        else "Build a table capturing the key comparable attributes across the entities the report discusses:",
        ""
        if has_hints
        else "- Choose 3–6 columns (the comparable attributes). Each column has a short slug `id` and a human `label`.",  # noqa: RUF001 — verbatim prompt text (en dash)
        "- One row per entity/item the report compares. Each row is a list of `cells`; each cell has the column's `columnId`, the extracted `value`, and `citations`.",
        "- Back each value with `citations` referencing the SOURCE NUMBER above plus the exact supporting quote. Only cite what the report/sources actually state; leave `citations` empty when a value isn't directly supported.",
        "- Keep values concise.",
        type_block,
        hint_block,
    ]
    return "\n".join(p for p in parts if p != "")


def _capitalize(value: str) -> str:
    """JS `value.replace(/^./, c => c.toUpperCase())` — upper-case the
    first character only, leave the rest untouched."""
    return value[:1].upper() + value[1:]


# --- Extraction → CitationTable ----------------------------------------


def extraction_to_citation_table(
    extraction: Extraction, sources: list[NumberedSource]
) -> dict[str, Any]:
    """Port of `extractionToCitationTable`. Maps each citation's 1-based
    `source` to `sources[source-1].id`; an out-of-range number drops that
    citation. Ignores a cell tagged with an undeclared column. Embeds the
    sources so the artifact is self-contained. Never raises."""
    col_ids = {c.id for c in extraction.columns}
    rows: list[dict[str, Any]] = []
    for row in extraction.rows:
        out: dict[str, Any] = {}
        for cell in row.cells:
            if cell.columnId not in col_ids:
                continue
            citations = [
                {"sourceId": sources[c.source - 1].id, "quote": c.quote}
                for c in cell.citations
                if 1 <= c.source <= len(sources)
            ]
            out[cell.columnId] = {"value": cell.value, "citations": citations}
        rows.append(out)

    safe_sources: list[dict[str, Any]] = []
    for s in sources:
        entry: dict[str, Any] = {"id": s.id, "title": (s.title or s.url or "Source")[:300]}
        if s.url is not None:
            entry["url"] = s.url
        if s.snippet is not None:
            entry["snippet"] = s.snippet[:1000]
        safe_sources.append(entry)

    return {
        "columns": [
            {"id": c.id, "label": c.label, "type": c.type or "text"} for c in extraction.columns
        ],
        "rows": rows,
        "sources": safe_sources,
    }


# --- Generation ---------------------------------------------------------


def extraction_json_schema() -> dict[str, Any]:
    """The `Extraction` JSON Schema with every `$ref` inlined, for use as
    the forced tool's `input_schema`."""
    return _inline_refs(Extraction.model_json_schema())


def _inline_refs(schema: dict[str, Any]) -> dict[str, Any]:
    defs: dict[str, Any] = schema.get("$defs", {})

    def resolve(node: Any) -> Any:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("#/$defs/"):
                return resolve(defs[ref.removeprefix("#/$defs/")])
            return {k: resolve(v) for k, v in node.items() if k != "$defs"}
        if isinstance(node, list):
            return [resolve(v) for v in node]
        return node

    resolved = resolve(schema)
    assert isinstance(resolved, dict)
    return resolved


def _blocks(message: Any) -> list[Any]:
    content = getattr(message, "content", None)
    if content is None and isinstance(message, dict):
        content = message.get("content")
    return list(content or [])


def _field(block: Any, name: str) -> Any:
    if isinstance(block, dict):
        return block.get(name)
    return getattr(block, name, None)


async def _final_message(client: AsyncAnthropicClient, kwargs: dict[str, Any]) -> Any:
    async with client.messages.stream(**kwargs) as stream:
        async for _ in stream.text_stream:
            pass
        return await stream.get_final_message()


async def generate_structured_extraction(
    *, client: AsyncAnthropicClient, model: str, prompt: str
) -> Extraction:
    """Native structured output: one forced tool call whose input is the
    extraction. Raises on any failure (the caller falls back)."""
    final = await _final_message(
        client,
        {
            "model": model,
            "max_tokens": EXTRACT_TABLE_MAX_TOKENS,
            "temperature": EXTRACT_TABLE_TEMPERATURE,
            "messages": [{"role": "user", "content": prompt}],
            "tools": [
                {
                    "name": STRUCTURED_TOOL_NAME,
                    "description": "Respond with a JSON object.",
                    "input_schema": extraction_json_schema(),
                }
            ],
            "tool_choice": {"type": "tool", "name": STRUCTURED_TOOL_NAME},
        },
    )
    for block in _blocks(final):
        if _field(block, "type") == "tool_use" and _field(block, "name") == STRUCTURED_TOOL_NAME:
            return Extraction.model_validate(_field(block, "input"))
    raise ValueError("structured extraction returned no tool call")


async def generate_text(*, client: AsyncAnthropicClient, model: str, prompt: str) -> str:
    """One plain completion; returns the joined text blocks. Provider
    errors propagate."""
    final = await _final_message(
        client,
        {
            "model": model,
            "max_tokens": EXTRACT_TABLE_MAX_TOKENS,
            "temperature": EXTRACT_TABLE_TEMPERATURE,
            "messages": [{"role": "user", "content": prompt}],
        },
    )
    parts: list[str] = []
    for block in _blocks(final):
        text = _field(block, "text")
        if _field(block, "type") == "text" and isinstance(text, str):
            parts.append(text)
    return "".join(parts)


async def generate_extraction(
    *,
    client: AsyncAnthropicClient,
    model: str,
    prompt: str,
    structured: bool,
) -> Extraction | ExtractionFailure:
    """Run the two-step generation (see module docstring). Raises only for
    a provider error on the text path."""
    if structured:
        try:
            return await generate_structured_extraction(client=client, model=model, prompt=prompt)
        except Exception as exc:
            # Fall through to the lenient text path, as the Next.js route does.
            logger.info("extract_table.structured_fallback", error=str(exc)[:300])

    text = await generate_text(client=client, model=model, prompt=f"{prompt}{TEXT_PATH_SUFFIX}")
    try:
        raw = json.loads(strip_json_fences(text))
    except ValueError:
        return ExtractionFailure("Extraction model did not return valid JSON.")
    try:
        return Extraction.model_validate(raw)
    except ValidationError:
        return ExtractionFailure("Extraction model output did not match the schema.")


__all__ = [
    "EXTRACT_TABLE_MAX_TOKENS",
    "EXTRACT_TABLE_TEMPERATURE",
    "STRUCTURED_TOOL_NAME",
    "TEXT_PATH_SUFFIX",
    "ColumnHint",
    "ColumnType",
    "Extraction",
    "ExtractionFailure",
    "NumberedSource",
    "build_extract_table_prompt",
    "extraction_json_schema",
    "extraction_to_citation_table",
    "generate_extraction",
    "generate_structured_extraction",
    "generate_text",
]

"""Cross-conversation memory extraction — Python port of
`lib/server/memory/extract.ts` (+ `prompt.ts`, `merge.ts`, `types.ts`).

After a chat turn the client posts the turn text; when the user has
`profiles.memory_enabled`, a model distils durable facts from it as a list
of `add` / `update` ops against the user's existing active facts, which
`merge_facts` turns into concrete inserts / updates on `user_memories`.
Every query runs as the user (`_set_user_context`), so the tables' RLS
applies exactly as it does to the Next.js route's user-scoped client.

Best-effort end to end, like the TS original: memory off, no model key,
a model / validation failure, a DB failure — all end silently.

Generation mirrors the AI SDK's `generateObject` against Anthropic: one
forced tool call (`json`) whose input schema is `Extraction`, validated
with the same bounds as the Zod `ExtractionSchema`. Unlike
`/v1/extract-table` there is no text fallback — the TS original has none
either (any failure skips the turn).

The prompt (`build_memory_extract_prompt`) and `merge_facts` are verbatim
ports, pinned by `tests/test_memory_extract.py` against fixtures generated
from the TS originals (`bun run codegen:agent-py-parity`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

import asyncpg
import structlog
from pydantic import BaseModel, Field, model_validator

from .model_allowlist import ModelAllowlist
from .model_routes import ModelTarget
from .providers.anthropic_provider import AsyncAnthropicClient
from .store import _set_user_context

logger = structlog.get_logger(__name__)

__all__ = [
    "EXTRACTION_JSON_SCHEMA",
    "MEMORY_EXTRACT_MAX_TOKENS",
    "MEMORY_EXTRACT_TEMPERATURE",
    "MEMORY_FACT_CAP",
    "Extraction",
    "FactOp",
    "MemoryFact",
    "MergePlan",
    "build_memory_extract_prompt",
    "extract_facts",
    "generate_extraction",
    "merge_facts",
    "plan_to_json",
    "resolve_memory_model",
]

#: Soft cap on active facts per user (`MEMORY_FACT_CAP`).
MEMORY_FACT_CAP = 100
#: Same sampling + output cap the Next.js call passes.
MEMORY_EXTRACT_TEMPERATURE = 0
MEMORY_EXTRACT_MAX_TOKENS = 800
#: Forced-tool name — the AI SDK's `generateObject` tool name for Anthropic.
STRUCTURED_TOOL_NAME = "json"


# --- Types (mirror `types.ts`) -------------------------------------------


@dataclass(frozen=True)
class MemoryFact:
    id: str
    fact: str
    category: str | None


class FactOp(BaseModel):
    """`FactOpSchema`: `add` = new fact; `update` = revise an existing fact
    by id (no `delete` — users delete via the panel). `id` / `category`
    are optional but, as in Zod, not nullable."""

    op: Literal["add", "update"]
    id: str | None = None
    fact: Annotated[str, Field(min_length=1, max_length=500)]
    category: Annotated[str, Field(max_length=40)] | None = None

    @model_validator(mode="before")
    @classmethod
    def _reject_explicit_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in ("id", "category"):
                if key in data and data[key] is None:
                    raise ValueError(f"{key} must be a string when present")
        return data


class Extraction(BaseModel):
    """`ExtractionSchema`."""

    facts: Annotated[list[FactOp], Field(max_length=20)]


#: The forced tool's `input_schema` — what the AI SDK sends for the Zod
#: `ExtractionSchema` (optional fields not nullable, closed objects).
EXTRACTION_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "facts": {
            "type": "array",
            "maxItems": 20,
            "items": {
                "type": "object",
                "properties": {
                    "op": {"type": "string", "enum": ["add", "update"]},
                    "id": {"type": "string"},
                    "fact": {"type": "string", "minLength": 1, "maxLength": 500},
                    "category": {"type": "string", "maxLength": 40},
                },
                "required": ["op", "fact"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["facts"],
    "additionalProperties": False,
}


# --- Prompt (verbatim port of `buildMemoryExtractPrompt`) ----------------


def build_memory_extract_prompt(turn: str, existing: list[MemoryFact]) -> str:
    lines = [
        "You maintain a durable memory of stable facts about a user from their chats.",
        "From the conversation turn below, extract ONLY durable, stable facts worth",
        "remembering long-term (role, tech stack, recurring preferences, ongoing",
        "projects). Skip ephemeral/task-specific details. Return `facts: []` if the",
        "turn has nothing durable (this is common).",
        "",
        "For each fact, emit an op: `add` for a new fact, or `update` with the `id`",
        "of an existing fact it revises/replaces. Do NOT duplicate an existing fact.",
        "",
        "Existing facts (id — fact):",
        "\n".join(f"{f.id} — {f.fact}" for f in existing) if existing else "(none)",
        "",
        "Conversation turn:",
        turn,
    ]
    return "\n".join(lines)


# --- Merge (verbatim port of `mergeFacts`) -------------------------------


@dataclass
class MergePlan:
    inserts: list[dict[str, str | None]] = field(default_factory=list)
    """`{fact, category}`."""
    updates: list[dict[str, str | None]] = field(default_factory=list)
    """`{id, fact, category}`."""


def merge_facts(existing: list[MemoryFact], ops: list[FactOp]) -> MergePlan:
    """Validate `update` ids (unknown → dropped: the model hallucinated
    one), and cap total active facts at `MEMORY_FACT_CAP`."""
    ids = {f.id for f in existing}
    plan = MergePlan()
    active_count = len(existing)
    for op in ops:
        category = op.category
        if op.op == "update":
            if op.id and op.id in ids:
                plan.updates.append({"id": op.id, "fact": op.fact, "category": category})
            continue
        if active_count >= MEMORY_FACT_CAP:
            continue
        active_count += 1
        plan.inserts.append({"fact": op.fact, "category": category})
    return plan


# --- Model ------------------------------------------------------------------


_WARNED_MODELS: set[str] = set()


def resolve_memory_target(allowlist: ModelAllowlist, configured: str) -> ModelTarget:
    """The extraction model: `MEMORY_EXTRACT_MODEL` when it is a catalog id
    with structured output (extraction is a forced tool call, Q116) that a
    provider serves here, else the service default."""
    model_id = configured.strip()
    if model_id and model_id in allowlist.structured_output and allowlist.available(model_id):
        return allowlist.target(model_id)
    if model_id and model_id not in _WARNED_MODELS:
        _WARNED_MODELS.add(model_id)
        logger.info(
            "memory_extract.model_not_used",
            configured=model_id,
            using=allowlist.default_model,
        )
    return allowlist.default_target


def resolve_memory_model(allowlist: ModelAllowlist, configured: str) -> str:
    """The provider's id of `resolve_memory_target`."""
    return resolve_memory_target(allowlist, configured).api_id


def _field(obj: Any, name: str) -> Any:
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


async def generate_extraction(
    *, client: AsyncAnthropicClient, model: str, prompt: str
) -> Extraction:
    """One forced `json` tool call; raises on any failure (no tool call,
    off-schema input, provider error)."""
    async with client.messages.stream(  # type: ignore[call-arg]
        model=model,
        max_tokens=MEMORY_EXTRACT_MAX_TOKENS,
        temperature=MEMORY_EXTRACT_TEMPERATURE,
        messages=[{"role": "user", "content": prompt}],
        tools=[
            {
                "name": STRUCTURED_TOOL_NAME,
                "description": "Respond with a JSON object.",
                "input_schema": EXTRACTION_JSON_SCHEMA,
            }
        ],
        tool_choice={"type": "tool", "name": STRUCTURED_TOOL_NAME},
    ) as stream:
        async for _ in stream.text_stream:
            pass
        final = await stream.get_final_message()
    for block in list(_field(final, "content") or []):
        if _field(block, "type") == "tool_use" and _field(block, "name") == STRUCTURED_TOOL_NAME:
            return Extraction.model_validate(_field(block, "input"))
    raise ValueError("memory extraction returned no tool call")


# --- Orchestration ----------------------------------------------------------


async def _load_state(pool: asyncpg.Pool, user_id: str) -> list[MemoryFact] | None:
    """The user's active facts, or `None` when memory is off (or the
    profile row is missing)."""
    async with pool.acquire() as conn, conn.transaction():
        await _set_user_context(conn, user_id=user_id)
        enabled = await conn.fetchval(
            "SELECT memory_enabled FROM public.profiles WHERE id = $1::text::uuid", user_id
        )
        if not enabled:
            return None
        rows = await conn.fetch(
            "SELECT id::text AS id, fact, category FROM public.user_memories "
            "WHERE status = 'active' AND user_id = $1::text::uuid",
            user_id,
        )
    return [MemoryFact(id=r["id"], fact=r["fact"], category=r["category"]) for r in rows]


async def _write(pool: asyncpg.Pool, user_id: str, sql: str, *args: Any) -> None:
    """One write in its own transaction — like each supabase-js call in
    the TS original, a failed insert doesn't stop the updates. Errors are
    logged and swallowed (best-effort)."""
    try:
        async with pool.acquire() as conn, conn.transaction():
            await _set_user_context(conn, user_id=user_id)
            await conn.execute(sql, *args)
    except (asyncpg.PostgresError, OSError) as exc:
        logger.info("memory_extract.write_failed", error=str(exc)[:300])


async def extract_facts(
    pool: asyncpg.Pool,
    *,
    user_id: str,
    turn_text: str,
    conversation_id: str | None,
    client: AsyncAnthropicClient | None,
    model: str,
) -> None:
    """Extract + merge + write durable facts for `user_id`. Gated (memory
    enabled) and best-effort: returns silently on any failure. `client`
    `None` (no `ANTHROPIC_API_KEY`) skips once memory is known to be on —
    the TS original's `selectModel` failure path."""
    try:
        existing = await _load_state(pool, user_id)
        if existing is None:
            return
        if client is None:
            return
        try:
            extraction = await generate_extraction(
                client=client,
                model=model,
                prompt=build_memory_extract_prompt(turn_text, existing),
            )
        except Exception as exc:
            logger.info("memory_extract.model_failed", error=str(exc)[:300])
            return

        plan = merge_facts(existing, extraction.facts)
        if plan.inserts:
            await _write(
                pool,
                user_id,
                "INSERT INTO public.user_memories (user_id, fact, category, source_conversation_id) "
                "SELECT $1::text::uuid, f.fact, f.category, $4::text::uuid "
                "FROM unnest($2::text[], $3::text[]) AS f(fact, category)",
                user_id,
                [i["fact"] for i in plan.inserts],
                [i["category"] for i in plan.inserts],
                conversation_id,
            )
        for u in plan.updates:
            await _write(
                pool,
                user_id,
                "UPDATE public.user_memories SET fact = $2, category = $3, updated_at = $4 "
                "WHERE id = $1::text::uuid AND user_id = $5::text::uuid",
                u["id"],
                u["fact"],
                u["category"],
                datetime.now(UTC),
                user_id,
            )
    except Exception as exc:
        # Best-effort: extraction never blocks or surfaces to the chat flow.
        logger.info("memory_extract.failed", error=str(exc)[:300])


def plan_to_json(plan: MergePlan) -> dict[str, Any]:
    """Test seam: the plan in the TS `MergePlan` JSON shape."""
    return {"inserts": list(plan.inserts), "updates": list(plan.updates)}

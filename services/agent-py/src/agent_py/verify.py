"""Citation verifier for research runs — agent-py port.

Mirror of `lib/shared/verify.ts` (pure core) + `lib/server/verify/
verify-answer.ts` (orchestration). Same method: a post-run pass over a
research report that treats each sentence carrying a `[N]` citation
marker as a *claim*, then asks a cheap verifier model whether the cited
sources support it. Uncited prose isn't claiming a source, so it's left
unmarked.

The serialized shape (`VerificationResult.to_payload`) matches the
`verification` field on the `result` event validated by
`verificationSchema` in `lib/shared/agent/wire.ts`, so the TS projection
folds a Python-emitted verification identically to a TS-emitted one.

Pure + SDK-free: the model call is injected as `run_verifier` (the
executor wires the real Anthropic call), so claim extraction, parsing,
mapping, and the summary are unit-testable without a live model.
Advisory + non-blocking: every failure path returns `None` (research is
never blocked on verification).
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

from .events import TaskEvent, TokenEvent, ToolOutputEvent

ClaimStatus = Literal["supported", "unsupported", "partial"]

_STATUSES: frozenset[str] = frozenset({"supported", "unsupported", "partial"})

# Sentence boundary: end punctuation + whitespace, or a newline. Naive but
# adequate — claims are matched by the presence of a citation marker, so an
# over-eager split just yields smaller claims.
_CLAIM_SPLIT_RE = re.compile(r"(?<=[.!?])\s+|\n+")
# `[1]`, `[1][2]`, or `[1, 2]` — capture the inner index list per bracket.
_CITATION_RE = re.compile(r"\[(\d+(?:\s*,\s*\d+)*)\]")
_FENCE_HEAD_RE = re.compile(r"^```(?:json)?\s*\n?")
_FENCE_TAIL_RE = re.compile(r"\n?```\s*$")

_MAX_SNIPPET_CHARS = 600


@dataclass(frozen=True)
class RetrievedSource:
    """A source the run retrieved (web search), as cited by `[N]` markers.
    `id` is the marker number as a string so claims and sources line up."""

    id: str
    title: str
    snippet: str
    url: str | None = None


@dataclass(frozen=True)
class CitedClaim:
    text: str
    cited_indices: list[int]


@dataclass(frozen=True)
class ClaimCheck:
    claim: str
    status: ClaimStatus
    source_ids: list[str]


@dataclass(frozen=True)
class RawClaimCheck:
    claim: int
    status: ClaimStatus
    source_ids: list[str]


@dataclass(frozen=True)
class VerificationSummary:
    supported: int
    partial: int
    unsupported: int
    total: int


@dataclass(frozen=True)
class VerificationResult:
    checks: list[ClaimCheck]
    summary: VerificationSummary

    def to_payload(self) -> dict[str, object]:
        """camelCase wire shape matching `verificationSchema` (wire.ts)."""
        return {
            "checks": [
                {"claim": c.claim, "status": c.status, "sourceIds": list(c.source_ids)}
                for c in self.checks
            ],
            "summary": {
                "supported": self.summary.supported,
                "partial": self.summary.partial,
                "unsupported": self.summary.unsupported,
                "total": self.summary.total,
            },
        }


@dataclass(frozen=True)
class AggregatedInputs:
    """The (text, sources) the per-chunk in-memory accumulator
    produced, re-derived from the full event log. Consumed by
    `verify_answer` exactly like the per-chunk tuple."""

    text: str
    sources: list[RetrievedSource]


def aggregate_from_events(event_list: list[TaskEvent]) -> AggregatedInputs:
    """Re-derive (text, sources) from a list of TaskEvents in seq
    order. Pure: concatenate `TokenEvent(channel='text').text` and
    collect `ToolOutputEvent.results` in cumulative citation
    order. Skips `step_error` (the run continues, the event
    isn't part of the answer), `approval` (HITL pause/response),
    and metadata kinds (`status`, `step_start`, `step_end`).

    `tool_output.results == None` or `[]` contribute no source
    (a tool that returned text-only, e.g. `webFetch` summary).
    """
    text_parts: list[str] = []
    sources: list[RetrievedSource] = []
    source_counter = 0
    for ev in event_list:
        if isinstance(ev, TokenEvent) and ev.channel == "text":
            text_parts.append(ev.text)
        elif isinstance(ev, ToolOutputEvent) and ev.results:
            for r in ev.results:
                source_counter += 1
                sources.append(
                    RetrievedSource(
                        id=str(source_counter),
                        title=r.title,
                        url=r.url,
                        snippet=r.snippet,
                    )
                )
    return AggregatedInputs(text="".join(text_parts), sources=sources)


#: prompt in, raw verifier JSON text out. Injected so the orchestration
#: is testable without a live model.
RunVerifier = Callable[[str], Awaitable[str]]


def extract_cited_claims(answer: str) -> list[CitedClaim]:
    """Sentences carrying at least one `[N]` marker, paired with the
    deduped + ascending source indices they cite. Empty for an answer with
    no citations — the caller then skips the model call (cost guard)."""
    out: list[CitedClaim] = []
    for segment in _CLAIM_SPLIT_RE.split(answer):
        text = segment.strip()
        if not text:
            continue
        indices: set[int] = set()
        for match in _CITATION_RE.finditer(text):
            for part in match.group(1).split(","):
                part = part.strip()
                if part.isdigit():
                    indices.add(int(part))
        if not indices:
            continue
        out.append(CitedClaim(text=text, cited_indices=sorted(indices)))
    return out


def parse_verification_json(raw: str) -> list[RawClaimCheck]:
    """Lenient parse of the verifier's raw text. Tolerates markdown fences
    and either a `{"checks": [...]}` envelope or a bare array. Any decode /
    shape failure yields `[]`."""
    try:
        cleaned = _FENCE_TAIL_RE.sub("", _FENCE_HEAD_RE.sub("", raw.strip())).strip()
        parsed = json.loads(cleaned)
    except (ValueError, TypeError):
        return []
    arr = parsed.get("checks") if isinstance(parsed, dict) else parsed
    if not isinstance(arr, list):
        return []
    out: list[RawClaimCheck] = []
    for item in arr:
        if not isinstance(item, dict):
            continue
        claim = item.get("claim")
        status = item.get("status")
        # `bool` is an `int` subclass — exclude it explicitly.
        if not isinstance(claim, int) or isinstance(claim, bool) or status not in _STATUSES:
            continue
        raw_ids = item.get("sourceIds")
        source_ids = [s for s in raw_ids if isinstance(s, str)] if isinstance(raw_ids, list) else []
        out.append(RawClaimCheck(claim=claim, status=status, source_ids=source_ids))
    return out


def map_raw_checks(claims: list[CitedClaim], raw: list[RawClaimCheck]) -> list[ClaimCheck]:
    """Map 1-based raw-check indices back onto claim text; drop
    out-of-range and duplicate indices."""
    out: list[ClaimCheck] = []
    seen: set[int] = set()
    for r in raw:
        if r.claim < 1 or r.claim > len(claims) or r.claim in seen:
            continue
        seen.add(r.claim)
        out.append(
            ClaimCheck(claim=claims[r.claim - 1].text, status=r.status, source_ids=r.source_ids)
        )
    return out


def summarize_checks(checks: list[ClaimCheck]) -> VerificationSummary:
    supported = sum(1 for c in checks if c.status == "supported")
    partial = sum(1 for c in checks if c.status == "partial")
    unsupported = sum(1 for c in checks if c.status == "unsupported")
    return VerificationSummary(
        supported=supported, partial=partial, unsupported=unsupported, total=len(checks)
    )


def build_verify_prompt(claims: list[CitedClaim], sources: list[RetrievedSource]) -> str:
    """The verifier prompt: numbered sources, numbered claims with the
    markers they cite, then a strict-JSON instruction. Conservative
    grading per the plan's false-positive guard."""
    source_block = "\n\n".join(
        f"[{s.id}] {s.title}{f' ({s.url})' if s.url else ''}\n{s.snippet[:_MAX_SNIPPET_CHARS].strip()}"
        for s in sources
    )
    claim_block = "\n".join(
        f"{i + 1}. {c.text}  (cites: {', '.join(f'[{n}]' for n in c.cited_indices)})"
        for i, c in enumerate(claims)
    )
    return (
        "You are a citation verifier. For each CLAIM, decide whether the cited SOURCES support it.\n\n"
        '- "supported": the sources clearly state or directly entail the claim.\n'
        '- "partial": the sources are related but don\'t fully establish the claim.\n'
        '- "unsupported": the sources do not support the claim.\n\n'
        'Be conservative: only mark "unsupported" when the claim is clearly NOT supported by its '
        'cited sources. When unsure, prefer "partial". Judge each claim only against the evidence '
        "in the sources, not outside knowledge.\n\n"
        f"SOURCES:\n{source_block}\n\n"
        f"CLAIMS:\n{claim_block}\n\n"
        "Reply with strict JSON only — no prose, no markdown fences:\n"
        '{"checks":[{"claim":1,"status":"supported","sourceIds":["1"]}]}\n'
        'where "claim" is the claim number above and "sourceIds" lists the sources that support it.'
    )


def gather_sources(results: list[tuple[str, str, str]]) -> list[RetrievedSource]:
    """Build the cited-source list from accumulated web-search results, in
    the cumulative order the model cites by (`[1]`, `[2]`, …). Each tuple
    is `(title, url, snippet)`.

    Note: `gather_sources(results)` is still used by the in-memory
    accumulator. `aggregate_from_events(events)` is the new pure
    re-derivation that reads the DB. Both produce the same shape
    (a list of RetrievedSource in cumulative citation order) and
    are interchangeable inputs to `verify_answer`."""
    return [
        RetrievedSource(id=str(i + 1), title=title, url=url or None, snippet=snippet)
        for i, (title, url, snippet) in enumerate(results)
    ]


async def verify_answer(
    answer: str,
    sources: list[RetrievedSource],
    *,
    run_verifier: RunVerifier | None,
) -> VerificationResult | None:
    """Verify a report's cited claims against its sources. Returns a
    `VerificationResult`, or `None` when there's nothing to verify
    (no cited claims / no sources / no verifier) or the verifier failed —
    research is never blocked on it."""
    if run_verifier is None:
        return None
    claims = extract_cited_claims(answer)
    if not claims or not sources:
        return None
    try:
        raw_text = await run_verifier(build_verify_prompt(claims, sources))
    except Exception:
        return None
    checks = map_raw_checks(claims, parse_verification_json(raw_text))
    if not checks:
        return None
    return VerificationResult(checks=checks, summary=summarize_checks(checks))

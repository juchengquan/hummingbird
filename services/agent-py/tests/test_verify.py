"""Tests for the citation verifier (`agent_py.verify`).

Mirrors `lib/shared/verify.test.ts` + `lib/server/verify/
verify-answer.test.ts`: the pure helpers (claim extraction, lenient parse,
mapping, summary, source gathering) + the orchestration with an injected
verifier (no live model).
"""

from __future__ import annotations

import pytest

from agent_py.verify import (
    CitedClaim,
    ClaimCheck,
    RawClaimCheck,
    RetrievedSource,
    extract_cited_claims,
    gather_sources,
    map_raw_checks,
    parse_verification_json,
    summarize_checks,
    verify_answer,
)

_SOURCES = [
    RetrievedSource(
        id="1",
        title="Boiling point of water",
        url="https://example.com/boil",
        snippet="At sea level, water boils at 100 degrees Celsius.",
    ),
    RetrievedSource(id="2", title="Mars facts", snippet="Mars has two moons."),
]

_ANSWER = (
    "Water boils at 100C at sea level [1]. Mars has three moons [2]. The weather is nice today."
)


def test_extract_cited_claims_keeps_only_cited_sentences() -> None:
    answer = "The sky is blue. Water boils at 100C [1]. Plain uncited prose."
    claims = extract_cited_claims(answer)
    assert claims == [CitedClaim(text="Water boils at 100C [1].", cited_indices=[1])]


def test_extract_cited_claims_dedupes_and_sorts_indices() -> None:
    claims = extract_cited_claims("Revenue grew [3][1] and margins held [1, 2].")
    assert len(claims) == 1
    assert claims[0].cited_indices == [1, 2, 3]


def test_extract_cited_claims_splits_sentences_and_newlines() -> None:
    answer = "First [1].\nSecond [2]! Third? Fourth [3]"
    assert [c.cited_indices for c in extract_cited_claims(answer)] == [[1], [2], [3]]


def test_extract_cited_claims_empty_when_no_citations() -> None:
    assert extract_cited_claims("No sources here.") == []
    assert extract_cited_claims("") == []


def test_parse_verification_json_envelope() -> None:
    raw = '{"checks":[{"claim":1,"status":"supported","sourceIds":["1"]},{"claim":2,"status":"unsupported","sourceIds":[]}]}'
    assert parse_verification_json(raw) == [
        RawClaimCheck(claim=1, status="supported", source_ids=["1"]),
        RawClaimCheck(claim=2, status="unsupported", source_ids=[]),
    ]


def test_parse_verification_json_tolerates_fences_and_bare_array() -> None:
    raw = '```json\n[{"claim":1,"status":"partial","sourceIds":["2"]}]\n```'
    assert parse_verification_json(raw) == [
        RawClaimCheck(claim=1, status="partial", source_ids=["2"])
    ]


def test_parse_verification_json_drops_malformed() -> None:
    raw = '{"checks":[{"claim":1,"status":"supported"},{"claim":"x","status":"supported"},{"claim":2,"status":"bogus"},{"claim":true,"status":"supported"}]}'
    assert parse_verification_json(raw) == [
        RawClaimCheck(claim=1, status="supported", source_ids=[])
    ]


def test_parse_verification_json_non_json() -> None:
    assert parse_verification_json("not json") == []


def test_map_raw_checks_maps_index_to_text() -> None:
    claims = [
        CitedClaim(text="Claim A [1].", cited_indices=[1]),
        CitedClaim(text="Claim B [2].", cited_indices=[2]),
    ]
    out = map_raw_checks(
        claims,
        [
            RawClaimCheck(claim=2, status="unsupported", source_ids=[]),
            RawClaimCheck(claim=1, status="supported", source_ids=["1"]),
        ],
    )
    assert out == [
        ClaimCheck(claim="Claim B [2].", status="unsupported", source_ids=[]),
        ClaimCheck(claim="Claim A [1].", status="supported", source_ids=["1"]),
    ]


def test_map_raw_checks_drops_out_of_range_and_dupes() -> None:
    claims = [CitedClaim(text="Claim A [1].", cited_indices=[1])]
    out = map_raw_checks(
        claims,
        [
            RawClaimCheck(claim=0, status="supported", source_ids=[]),
            RawClaimCheck(claim=2, status="supported", source_ids=[]),
            RawClaimCheck(claim=1, status="supported", source_ids=[]),
            RawClaimCheck(claim=1, status="unsupported", source_ids=[]),
        ],
    )
    assert out == [ClaimCheck(claim="Claim A [1].", status="supported", source_ids=[])]


def test_summarize_checks_tallies() -> None:
    summary = summarize_checks(
        [
            ClaimCheck(claim="a", status="supported", source_ids=[]),
            ClaimCheck(claim="b", status="supported", source_ids=[]),
            ClaimCheck(claim="c", status="partial", source_ids=[]),
            ClaimCheck(claim="d", status="unsupported", source_ids=[]),
        ]
    )
    assert (summary.supported, summary.partial, summary.unsupported, summary.total) == (2, 1, 1, 4)


def test_gather_sources_cumulative_ids() -> None:
    sources = gather_sources([("T1", "http://a", "s1"), ("T2", "", "s2")])
    assert sources == [
        RetrievedSource(id="1", title="T1", url="http://a", snippet="s1"),
        RetrievedSource(id="2", title="T2", url=None, snippet="s2"),
    ]


@pytest.mark.asyncio
async def test_verify_answer_no_cited_claims_skips_model() -> None:
    called = False

    async def runner(_: str) -> str:
        nonlocal called
        called = True
        return ""

    result = await verify_answer("No citations.", _SOURCES, run_verifier=runner)
    assert result is None
    assert called is False


@pytest.mark.asyncio
async def test_verify_answer_no_sources_skips_model() -> None:
    called = False

    async def runner(_: str) -> str:
        nonlocal called
        called = True
        return ""

    result = await verify_answer(_ANSWER, [], run_verifier=runner)
    assert result is None
    assert called is False


@pytest.mark.asyncio
async def test_verify_answer_no_runner_returns_none() -> None:
    assert await verify_answer(_ANSWER, _SOURCES, run_verifier=None) is None


@pytest.mark.asyncio
async def test_verify_answer_maps_verdicts_and_payload() -> None:
    async def runner(_: str) -> str:
        return '{"checks":[{"claim":1,"status":"supported","sourceIds":["1"]},{"claim":2,"status":"unsupported","sourceIds":[]}]}'

    result = await verify_answer(_ANSWER, _SOURCES, run_verifier=runner)
    assert result is not None
    assert result.summary.supported == 1
    assert result.summary.unsupported == 1
    assert result.summary.total == 2
    # Wire payload uses camelCase `sourceIds` matching wire.ts.
    payload = result.to_payload()
    assert payload["summary"] == {
        "supported": 1,
        "partial": 0,
        "unsupported": 1,
        "total": 2,
    }
    checks = payload["checks"]
    assert isinstance(checks, list)
    assert checks[0] == {
        "claim": "Water boils at 100C at sea level [1].",
        "status": "supported",
        "sourceIds": ["1"],
    }


@pytest.mark.asyncio
async def test_verify_answer_runner_raises_returns_none() -> None:
    async def runner(_: str) -> str:
        raise RuntimeError("provider down")

    assert await verify_answer(_ANSWER, _SOURCES, run_verifier=runner) is None


@pytest.mark.asyncio
async def test_verify_answer_empty_checks_returns_none() -> None:
    async def runner(_: str) -> str:
        return '{"checks":[]}'

    assert await verify_answer(_ANSWER, _SOURCES, run_verifier=runner) is None


@pytest.mark.asyncio
async def test_verify_answer_prompt_carries_cited_claims_only() -> None:
    seen = ""

    async def runner(prompt: str) -> str:
        nonlocal seen
        seen = prompt
        return "[]"

    await verify_answer(_ANSWER, _SOURCES, run_verifier=runner)
    assert "Water boils at 100C at sea level [1]." in seen
    assert "Mars has three moons [2]." in seen
    assert "The weather is nice today" not in seen

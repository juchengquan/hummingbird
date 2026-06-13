# Citation verifiability v2 — Design

**Status:** Draft, awaiting user review
**Date:** 2026-06-13
**Branch:** `dev`
**Plan:** [`docs/PLAN-citation-verifiability.md`](../PLAN-citation-verifiability.md)

## Background

Citation verification is shipped across 4 PRs (commits 1–4 of
[`docs/PLAN-citation-verifiability.md`](../PLAN-citation-verifiability.md)):

- **#199** — verifier core (`lib/shared/verify.ts`) + server call
  (`lib/server/verify/`) + tests against fixture answer+sources.
- **#200** — `data-verification` part, translator, store, the
  confidence chip + flagged-claims disclosure; account-menu opt-in
  toggle. Inline span markers *deferred*.
- **#201** — Sources-strip support counts: per-source "supports N
  claims" badges via `countSupportPerSource`.
- **#203** — Deep Research integration. The verifier ports to
  `services/agent-py/src/agent_py/verify.py` and runs at the terminal
  `result` via a runner `finalize` hook. Client folds the
  `view.verification` onto the result `Message`. Same-family
  Anthropic (no cross-family provider yet).

The plan's "Remaining" note calls out 3 open items, in order of
decreasing correctness / cost / UX value:

1. **Cross-chunk verification.** Today, only the *first* chunk of a
   research run verifies. A run that yields + resumes + settles in a
   later chunk gets no verification — the per-chunk
   `verify_text_parts` / `verify_sources` accumulator is only
   complete in the chunk where the run settles. (See
   `executor.py:248-251`.)
2. **Cross-family verifier.** The agent-py verifier reuses the same
   Anthropic client the answerer used — same-family, weaker. The
   plan's open question §2 says "a cheap cross-family model; never the
   same instance that wrote the answer."
3. **Inline span markers.** The disclosure lists flagged claims but
   the rendered markdown carries no visual marker. The plan's
   commit 2 noted "decorating the unsupported spans *inline* within
   the rendered markdown is fiddly (claims straddle markdown
   formatting) and is deferred."

This spec covers all 3, as 3 sequenced commits.

## Goals

- A research run that yields + resumes + settles in a later chunk
  still runs citation verification at the terminal `result` over
  the **full event log** (re-aggregated from `task_events`).
- The verifier is **cross-family by default** when a cross-family
  provider is configured. Falls back to the answerer family (with
  a one-shot log warning) when the cross-family provider is missing
  or matches the answerer.
- The inline markdown rendering **visually marks** flagged
  citations in the assistant message body. A small, low-risk
  surface (the citation marker `[N]`, not the claim sentence)
  decorated with a class + tooltip. Reuses the existing
  `MessageVerification` disclosure for the full readout.

## Non-goals

- **No UI redesign.** The existing `MessageVerification`
  disclosure stays; the inline markers are additive.
- **No verifier-prompt change.** Same prompt, same model call, same
  conservative grading. Same `extractCitedClaims` /
  `parseVerificationJson` / `mapRawChecks` / `summarizeChecks`
  pure pipeline.
- **No new test harness.** Reuse
  `services/agent-py/tests/test_verify.py` and add a small new
  test for the re-aggregator.
- **No token-cap change.** `_VERIFY_MAX_TOKENS = 800` stays.
- **No change to the inline chat route (TS-side verify).** Only
  research runs (agent-py) are touched for cross-chunk +
  cross-family. The chat-route verifier on the TS side already
  verifies on retrieval turns; the plan's open question on
  chat-route cross-family is a separate work item.
- **No agent-ts verifier.** The plan notes "agent-ts stays stubbed
  until its real-step phase" — same-family Anthropic is fine for
  the stub.
- **No OpenAI verifier in this spec.** The Google (Gemini) path
  demonstrates the cross-family shape. OpenAI follows the same
  pattern; a follow-up if needed.

## Sequencing

- **Commit 4 — cross-chunk verification.** Server-side correctness
  first. Highest-value fix (today, resumed runs get no
  verification).
- **Commit 5 — cross-family verifier.** Server-side cost / quality
  second. Reuses commit 4's re-aggregator path; no
  client-side change.
- **Commit 6 — inline span markers.** Client-side UX last.
  Smallest server-surface delta.

Each commit is a self-contained, testable change with its own PR.

## Commit 4 — Cross-chunk verification

### Code

A new function in `services/agent-py/src/agent_py/store.py`:

```python
async def load_run_events(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
) -> list[TaskEvent]:
    """Read the full event log for a run, in seq order, and
    deserialise each row's payload jsonb into a TaskEvent. Used
    by the citation verifier to re-aggregate report text +
    web-search sources at the terminal `result` for a multi-chunk
    run. Same keyset as `append_event` writes (task_id, user_id,
    seq, step, kind, payload). Caller-supplied RLS context is set
    via `_set_user_context` (mirrors `load_checkpoint`)."""
```

Internally: `SELECT seq, step, kind, payload, created_at FROM
public.task_events WHERE task_id = $1 ORDER BY seq` (after
`_set_user_context`), then a single `event_from_row_payload(seq,
step, created_at, payload)` reverse of the existing
`event_to_row_payload`. The deserialiser validates `kind` against
the `TaskEventKind` literal and constructs the right dataclass
subtype; unknown kinds are skipped with a stderr warning (same
policy as the TS projection reducer).

A new pure function in `verify.py`:

```python
@dataclass(frozen=True)
class AggregatedInputs:
    text: str
    sources: list[RetrievedSource]

def aggregate_from_events(events: list[TaskEvent]) -> AggregatedInputs:
    """Re-derive the (text, sources) the per-chunk accumulator
    built. Pure: concatenate TokenEvent(channel='text').text in
    seq order and collect ToolOutputEvent.results (web-search
    rows) in cumulative citation order. Same shape the
    in-memory accumulator produced; consumed by `verify_answer`."""
```

Skip rules: `step_error` (the model continues, the event isn't
part of the answer), `approval` (HITL pause/response — not part
of the assistant message), `status` / `step_start` / `step_end`
(metadata). Only `token` (channel=text) and `tool_output` (with
non-empty `results`) contribute to the aggregation.

Change in `executor.py`'s `finalize` hook (currently
`executor.py:341-348`):

```python
async def finalize() -> dict[str, object] | None:
    if mode != "research":
        return None
    if resume:
        # Re-aggregate from the DB. The per-chunk in-memory accumulator
        # only holds THIS chunk's text + sources, so it's incomplete
        # on a resume. The DB is the source of truth.
        events = await store.load_run_events(
            pool, run_id=payload.run_id, user_id=payload.user_id
        )
        inputs = verify.aggregate_from_events(events)
        return await _maybe_verify(
            mode=run_mode,
            text=inputs.text,
            sources=[
                (s.title, s.url or "", s.snippet)
                for s in inputs.sources
            ],
        )
    # Fast path: single-chunk run, the in-memory accumulator is
    # complete.
    return await _maybe_verify(
        mode=run_mode,
        text="".join(verify_text_parts),
        sources=verify_sources,
    )
```

`_maybe_verify` itself stays the same. The `verify_text_parts` /
`verify_sources` per-chunk accumulators stay in place as the
fast path.

### Tests

In `services/agent-py/tests/test_runner.py` (or a new
`test_executor_aggregator.py`):

- `test_load_run_events_round_trip` — drives
  `store.append_event` for 5 events (status, token x2, tool_output,
  result), then `store.load_run_events`; asserts the returned
  list is the same events in seq order, all fields preserved.
- `test_load_run_events_skips_unknown_kinds` — appends one row
  with `kind = "unknown_kind"`; asserts `load_run_events` skips
  it with a stderr warning and the rest are returned.
- `test_aggregate_from_events_pure` — builds a hand-crafted
  event list (tokens interleaved with a `step_error` to confirm
  it's skipped; a `tool_output` with `results=None` to confirm
  it doesn't contribute sources); asserts
  `aggregate_from_events` matches the shape the in-memory
  accumulator would have produced.
- `test_executor_resume_path_uses_db_aggregator` — extends the
  existing 2-chunk resume test to assert the terminal
  `result.verification` is non-`None` (currently the resumed
  run drops it).

### Out of scope

- Cross-family verifier (commit 5).
- Inline span markers (commit 6).
- Changing the per-chunk accumulator (kept for the fast path).
- Reading events from the TS side (the chat route uses a
  different `task_events` shape; orthogonal).

## Commit 5 — Cross-family verifier

### Code

Add a new env var `VERIFY_PROVIDER` (default `"anthropic"` for
backward compat) in `services/agent-py/src/agent_py/settings.py`.

Add a small `VerifierClient` protocol + a Google (Gemini) wrapper in
`services/agent-py/src/agent_py/providers/`:

```python
class VerifierClient(Protocol):
    """A provider-shaped surface large enough for the verifier's
    single non-streaming call. Mirrors the slice of
    `AsyncAnthropic` that the existing _make_anthropic_verifier
    uses, generalised across providers."""
    async def messages_create(
        self, *, model: str, max_tokens: int,
        messages: list[dict[str, object]]
    ) -> str: ...

def _make_google_verifier_client() -> VerifierClient | None:
    """Wrap the `google-generativeai` SDK (or return None if the
    key/SDK is missing). Generates content with the given model;
    joins text parts. The model is configured for non-streaming
    JSON-ish output (caller-side prompt already requests strict
    JSON)."""
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return None
    try:
        import google.generativeai as genai
    except ImportError:
        return None
    genai.configure(api_key=api_key)
    return _GeminiClient(genai)
```

The policy function:

```python
def _resolve_verifier_client(
    *, answerer_provider: str,
) -> VerifierClient | None:
    """Cross-family by default: pick a different provider family
    than the answerer. Falls back to the answerer (with a one-shot
    log warning) when the cross-family provider is missing or
    VERIFY_PROVIDER matches the answerer. Returns None when no
    verifier is configured (caller no-ops).

    The warning fires only on the *transitions* — first time the
    config is loaded with a same-family setup, or first time the
    cross-family provider is missing and we fall back. Once the
    warning has fired for the current process, subsequent calls
    stay quiet (avoids log spam on every research run)."""
    verifier_provider = (
        get_settings().VERIFY_PROVIDER.strip().lower()
    )
    if not verifier_provider:
        return None
    same_family = verifier_provider == answerer_provider
    if verifier_provider == "google":
        client = _make_google_verifier_client()
        if client is None:
            _warn_once(
                "executor.verifier_google_unavailable",
                recommendation=(
                    "set GOOGLE_API_KEY to enable cross-family "
                    "verification; falling back to Anthropic"
                ),
            )
    elif verifier_provider == "anthropic":
        client = _make_anthropic_verifier_client()
    else:
        return None
    if same_family and client is not None:
        _warn_once(
            "executor.verifier_same_family",
            answerer=answerer_provider,
            recommendation=(
                "set VERIFY_PROVIDER to a different family for "
                "stronger cross-checking"
            ),
        )
    return client or _make_anthropic_verifier_client()  # safe fallback
```

The `_warn_once` helper is a tiny module-level `set[str]` of
keys already-warned-this-process; the test resets it via a
fixture.

`_maybe_verify` changes:

```python
async def _maybe_verify(
    *, mode, text, sources,
    answerer_provider: str = "anthropic",
) -> dict[str, object] | None:
    if mode != "research":
        return None
    settings = get_settings()
    model = settings.VERIFY_MODEL.strip()
    if not model:
        return None
    client = _resolve_verifier_client(
        answerer_provider=answerer_provider
    )
    if client is None:
        return None
    try:
        raw = await client.messages_create(
            model=model,
            max_tokens=_VERIFY_MAX_TOKENS,
            messages=[
                {"role": "user", "content": _build_verify_prompt_text(text, sources)}
            ],
        )
    except Exception:
        return None
    return _verification_from_raw(raw, text, sources)
```

The executor passes the answerer provider down:

```python
# at the call site in finalize()
return await _maybe_verify(
    mode=run_mode,
    text=inputs.text,  # or "".join(verify_text_parts)
    sources=...,
    answerer_provider=_resolve_answerer_provider(),  # from cfg
)
```

`_resolve_answerer_provider` reads `cfg.get("provider")` (or
defaults to `"anthropic"` since that's the only one we ship
today; expanded when agent-ts goes live). The answerer-provider
metadata is added to the TS route's checkpoint write in a small
follow-up; for now, a sensible default of `"anthropic"` is fine.

### Default model

- `VERIFY_MODEL` default: `gemini-2.0-flash` (Google's cheap
  model, good for the verifier's small JSON output). The legacy
  Anthropic path defaults to `claude-haiku-3-5` (matches the
  shipped executor).

### Cost guard

- One verifier call per settled research run, regardless of
  chunk count (commit 4 makes sure). `_VERIFY_MAX_TOKENS` stays
  at 800.
- No per-chunk verifier calls. (We considered running the
  verifier at every chunk and merging, but rejected: more cost,
  more complexity, and the per-chunk text isn't the full report.)

### Tests

In a new `services/agent-py/tests/test_cross_family_verifier.py`:

- `test_resolve_verifier_client_picks_cross_family` — given
  `VERIFY_PROVIDER=google` + an Anthropic answerer + a stub
  `_make_google_verifier_client` that returns a sentinel, asserts
  the sentinel is returned and no warning is logged.
- `test_resolve_verifier_client_falls_back_with_warning` —
  given `VERIFY_PROVIDER=google` + no Google client available +
  the Anthropic fallback is enabled, asserts the Anthropic
  client is returned AND the
  `verifier_google_unavailable` warning is logged.
- `test_resolve_verifier_client_warns_once_on_same_family` —
  given `VERIFY_PROVIDER=anthropic` + an Anthropic answerer,
  asserts the Anthropic client is returned AND a
  `verifier_same_family` warning is logged; calling again does
  NOT log a second warning.
- `test_maybe_verify_uses_cross_family` — drive `_maybe_verify`
  with a stubbed `VerifierClient` and an `answerer_provider=
  "anthropic"`; assert the stub was called with the model
  name from `VERIFY_MODEL`.

### Out of scope

- Inline span markers (commit 6).
- OpenAI verifier wrapper (the Google path demonstrates the
  cross-family shape; OpenAI follows the same pattern).
- Chat-route (TS) cross-family — separate work item, plan §1
  says the TS verifier also defaults to same-family for
  inline chat; deferring.
- Changing `_VERIFY_MAX_TOKENS` or the verify prompt.

## Commit 6 — Inline span markers

### Why wrap the marker, not the sentence

The plan's commit 2 deferred inline markers because "claims
straddle markdown formatting." We agree: the source markdown
`The Eiffel Tower is 330m tall [1], built in 1889 [2], and...` 
has two citations in the same sentence, and the `[1]`
superscript often lands mid-token in the rendered HTML
(`330m tall <sup>[1]</sup>, built in 1889 <sup>[2]</sup>`).
Wrapping the sentence body requires per-marker span boundary
tracking through the markdown AST; wrapping the marker
itself is a single regex over the rendered HTML.

The disclosure (`MessageVerification`) already lists the
flagged claim text. The inline marker is the *at-a-glance hint*;
the tooltip carries the claim + status. The disclosure carries
the same information without the straddle risk.

### Code

A new pure function in `lib/shared/verify.ts`:

```typescript
export type CitationMarkerMark = {
  markerId: string
  claimText: string
  status: ClaimStatus
}

/** Maps a `VerificationResult.checks` to per-marker marks, so
 *  the renderer can wrap each `[N]` token in the rendered
 *  output. Skips `supported` claims (no UI cost). When two
 *  flagged claims share a marker (rare; happens when the
 *  model's `[1]` and `[2]` lists disagree with the verifier's
 *  sourceIds), the first claim wins. */
export function markerMarksFor(
  checks: ClaimCheck[]
): Map<string, CitationMarkerMark> {
  const out = new Map<string, CitationMarkerMark>()
  for (const c of checks) {
    if (c.status === "supported") continue
    for (const id of c.sourceIds) {
      if (!out.has(id)) {
        out.set(id, {
          markerId: id,
          claimText: c.claim,
          status: c.status,
        })
      }
    }
  }
  return out
}
```

A new React component
`components/panels/citation-marker.tsx`:

```tsx
"use client"

import { cn } from "@/shared/utils"
import type { CitationMarkerMark, ClaimStatus } from "@/shared/verify"

const TONE: Record<ClaimStatus, string> = {
  unsupported:
    "text-red-600 dark:text-red-400 underline decoration-wavy " +
    "underline-offset-2",
  partial:
    "text-amber-600 dark:text-amber-400 underline decoration-dotted " +
    "underline-offset-2",
  supported: "", // unused; markerMarksFor skips supported
}

const TOOLTIP: Record<ClaimStatus, string> = {
  unsupported: "not found in cited sources",
  partial: "partially supported by cited sources",
  supported: "",
}

export function CitationMarker({
  id,
  mark,
}: {
  id: string
  mark?: CitationMarkerMark
}) {
  if (!mark) return <>[{id}]</>
  return (
    <span
      className={cn("citation-marker", TONE[mark.status])}
      title={`${mark.claimText} — ${TOOLTIP[mark.status]}`}
    >[{id}]</span>
  )
}
```

A `useMemo` in the chat-message renderer that post-processes
the rendered HTML:

```typescript
const annotatedHtml = useMemo(() => {
  if (!message.verification) return renderedHtml
  const marks = markerMarksFor(message.verification.checks)
  if (marks.size === 0) return renderedHtml
  return renderedHtml.replace(
    /\[(\d+)\]/g,
    (m, n) => {
      const mark = marks.get(n)
      if (!mark) return m
      return (
        `<span class="citation-marker ${TONE[mark.status]}"` +
        ` title="${escapeHtml(`${mark.claimText} — ${TOOLTIP[mark.status]}`)}"` +
        `>[${n}]</span>`
      )
    }
  )
}, [renderedHtml, message.verification])
```

The exact insertion point depends on the existing chat-message
renderer. Today it renders `message.content` via a markdown
pipeline (likely `react-markdown` or `MarkdownPreview`); the
post-processor wraps the resulting HTML/string before
display. If the renderer outputs React nodes (not HTML
strings), the post-processor becomes a tree walk that visits
text nodes and replaces `[N]` substrings with `<CitationMarker
id={n} mark={marks.get(n)} />`. The spec stays agnostic to
which shape; the implementer picks the one that matches the
shipped renderer and the test pins the picked shape.

### Tests

In a new `lib/shared/verify-marker.test.ts`:

- `markerMarksFor_supported_skipped` — given a
  `VerificationResult` with 1 supported + 1 unsupported claim
  + 1 partial, the map has 2 entries (the supported one's
  sourceIds are absent).
- `markerMarksFor_first_claim_wins_per_marker` — given two
  flagged claims that share a sourceId, the map has one
  entry for that sourceId, pointing at the first claim.
- `markerMarksFor_empty_when_all_supported` — given an
  all-supported result, the map is empty.

The post-processor's regex is covered by a small test against
a fixture string in `components/panels/chat-message.test.ts`
(or wherever the renderer tests live).

### Out of scope

- Sentence-level wrapping (the straddle problem the plan
  called out stays deferred).
- `partial` markers in commit 6 — only `unsupported` is
  colored. `partial` claims still appear in the disclosure
  but don't trigger an inline marker (low signal-to-noise
  per the plan's false-positive guard).
- TS chat-route inline markers (the chat route doesn't render
  `verification`; the cross-family work on the TS side is a
  separate item).

## Tests — three layers

1. **Pure unit tests** (commit 4, 5, 6) — same pattern as
   the shipped `lib/shared/verify.test.ts` and
   `services/agent-py/tests/test_verify.py`: small
   fixtures, exact output pinning.
2. **Integration test** (commit 4) — drive a 2-chunk resume
   scenario through the executor and assert the terminal
   `result.verification` is non-`None` and matches what a
   single-chunk run would have produced.
3. **Render test** (commit 6) — feed the post-processor a
   fixture rendered HTML, assert the `[N]` tokens are wrapped
   in the right spans with the right tooltip text.

## Open questions for plan execution

1. **`GOOGLE_API_KEY` vs `GEMINI_API_KEY`**: either is fine;
   the Google GenAI SDK accepts the same env var either way
   under `GEMINI_API_KEY`. Spec says "either" (commit 5
   resolver), with `GOOGLE_API_KEY` checked first as a
   convention.
2. **Where exactly the post-processor plugs in** (commit 6):
   depends on whether the existing chat-message renderer
   produces HTML strings or React nodes. The spec stays
   agnostic; the implementer picks based on the shipped
   code and the test pins the choice.
3. **Default `VERIFY_MODEL` when `VERIFY_PROVIDER=google`**:
   `gemini-2.0-flash` is the spec's pick. Cheap, fast, good
   for the verifier's small JSON output. Anthropic path
   defaults to `claude-haiku-3-5` (matches the shipped
   executor).

## Out of scope (deferred)

- OpenAI verifier wrapper (commit 5 has a follow-up note).
- TS chat-route cross-family (separate work item).
- Sentence-level claim wrapping (commit 6's "straddle"
  problem stays deferred).
- agent-ts verifier (agent-ts is stubbed; out of scope until
  its real-step phase).
- Adding the answerer-provider metadata to the TS route's
  checkpoint write (a 1-line checkpoint field; small
  follow-up).

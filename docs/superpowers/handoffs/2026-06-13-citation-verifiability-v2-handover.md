# Citation Verifiability v2 — Handover

**Status:** ✅ COMPLETE — all 7 tasks shipped and merged to `dev`.

Landed via two squash-merged PRs:
- **#205** — Citation verifiability v2 (commits 4–6): cross-chunk + cross-family verification + inline markers. On `dev` as `6b31d06`.
- **#206** — `bun run check:agent-py` local gate mirroring the agent-py CI job (follow-up; the format-check step was missing locally). On `dev` as `2a49900`.

Verification at merge: agent-py 505 tests pass · ruff check + `ruff format --check` clean · mypy clean (46 files) · TS typecheck + lint clean · user-manual inventory refreshed · all PR CI checks green.

| Task | What | Result |
|---|---|---|
| 1 | `store.load_run_events` + `event_from_row_payload` | ✅ done |
| 2 | `verify.aggregate_from_events` | ✅ done |
| 3 | re-aggregate on resume (**commit 4**) | ✅ done (via the `continue` path, not `respond`) |
| 4 | cross-family verifier + `VERIFY_PROVIDER` (**commit 5**) | ✅ done (Google Gemini, opt-in; `google-generativeai` optional dep) |
| 5 | `markerMarksFor` in `lib/shared/verify.ts` | ✅ done |
| 6 | inline `[N]` markers (**commit 6**) | ✅ done (HTML-string `MarkdownPreview` pipeline, not a React component) |
| 7 | full check sweep + sign-off | ✅ done |

The plan doc (`docs/superpowers/plans/2026-06-13-citation-verifiability-v2-plan.md`) carries inline **Corrections** banners for Tasks 1/3/4/6 where the as-built implementation diverged from the as-written plan (structlog vs stdlib logging; the `continue` path; reusing `verify_answer`; the HTML-string renderer). It remains the source of truth.

Everything below this line is the **historical** in-progress handover from when only Task 1 was underway. Kept for provenance; no longer actionable.

---

## Context

We were shipping the 3 remaining items from `docs/PLAN-citation-verifiability.md`:

- **Commit 4** — Cross-chunk verification
- **Commit 5** — Cross-family verifier
- **Commit 6** — Inline span markers

The design spec is at `docs/superpowers/specs/2026-06-13-citation-verifiability-v2-design.md`. The plan is at `docs/superpowers/plans/2026-06-13-citation-verifiability-v2-plan.md` (7 tasks). This handover covered **Task 1 only** — Task 1 was 3 subagent attempts deep when the session was paused; Tasks 2-7 had not been started at the time of writing.

---

## What's already done

| Commit | What |
|---|---|
| `97b225f` | Spec written, self-reviewed, committed |
| `2d65b04` | Plan written, 7 tasks, committed |
| `d62c4ce` | Plan fix #1: use `AsyncMock` for `pool.acquire()` (matches `test_jobs.py:34-48` pattern) |
| `47c9328` | Plan fix #2: stub `conn.execute` in the test helper (because `load_run_events` calls `_set_user_context` which awaits `conn.execute`) |

All 4 commits are on `dev` (ahead of `origin/dev` by 4).

---

## Working-tree state (right now)

```
modified:   docs/superpowers/plans/2026-06-13-citation-verifiability-v2-plan.md
modified:   services/agent-py/src/agent_py/store.py
untracked:  services/agent-py/tests/test_aggregator.py
```

**Two of the three working-tree changes are commits-in-waiting** (they fix real spec bugs). The third is the test file the previous subagent created (already on disk, already corrected for the AsyncMock fix).

### Bug #3 — in working tree, NOT yet committed

The spec's `event_from_row_payload` reads `kind` from the **payload**, but the **shipped** `event_to_row_payload` writes `kind` to a **separate `task_events.kind` column** (per `supabase/migrations/0012_tasks.sql`). The test row is constructed with `kind` as a separate column too. So `payload.get("kind")` returns `None` for every event, every event is rejected as "unknown kind", and the function returns `[]`.

**Fix:** change the signature to take `kind` as a separate kwarg, not a payload field. Two specific edits to `services/agent-py/src/agent_py/store.py` (the on-disk file, not the plan spec — though the plan spec has the same bug and needs the same fix):

```python
# Change 1: function signature (line ~175)
def event_from_row_payload(
    *, seq: int, step: int, kind: str, created_at: str,
    payload: dict[str, object],
) -> events.TaskEvent | None:
    """...
    `kind` is a separate `task_events.kind` column (NOT part of
    the payload jsonb) per supabase/migrations/0012_tasks.sql.
    `event_to_row_payload` writes the kind-specific fields only;
    this function reads them back by switching on the column
    value."""
    if kind not in _VALID_KINDS:
        _log.warning("store.unknown_event_kind", extra={"kind": kind})
        return None
    base: dict[str, object] = {
        "run_id": "",
        "seq": seq,
        "step": step,
        "created_at": created_at,
    }
    merged = {**base, **payload}    # was: {**base, **{k: v for k, v in payload.items() if k != "kind"}}
    # (rest of function unchanged — the kind-discriminated branches)

# Change 2: caller in load_run_events (line ~316)
ev = event_from_row_payload(
    seq=row["seq"],
    step=row["step"],
    kind=row["kind"],                # <-- new kwarg
    created_at=...,
    payload=payload,
)
```

The plan spec (`docs/superpowers/plans/2026-06-13-citation-verifiability-v2-plan.md`) needs the same edits, but as a SEPARATE spec fix commit (so the spec is the source of truth for future implementers).

### Bug #4 — already fixed in the spec, in working tree

The spec also had `_log.warning("store.unknown_event_kind", kind=str(kind))` (stdlib `logging` reserves `kind` as a kwarg). The previous subagent caught this; the working-tree `store.py` has the fix (`extra={"kind": str(kind)}`). The plan spec also has the fix. **Already done.**

### Working-tree on-disk test file

`services/agent-py/tests/test_aggregator.py` is the corrected AsyncMock version (with `conn.execute` stub). It still fails because of Bug #3 (the function returns `[]`). One the on-disk `store.py` is fixed, the test should go green.

---

## Resume

The pickup agent's first action: **fix the working-tree `store.py`** (Bug #3). Then commit both the `store.py` change and the on-disk `test_aggregator.py` as Task 1's commit.

### Step 1 — Fix `event_from_row_payload` in `services/agent-py/src/agent_py/store.py`

The working-tree file has the spec's `event_from_row_payload` function with the kind-in-payload bug. Apply Bug #3's fix:

1. Change the function signature: `*, seq, step, kind, created_at, payload` (kind is a separate kwarg).
2. Replace the opening lines:
   ```python
   if kind not in _VALID_KINDS:
       _log.warning("store.unknown_event_kind", extra={"kind": kind})
       return None
   base = {"run_id": "", "seq": seq, "step": step, "created_at": created_at}
   merged = {**base, **payload}
   ```
3. Leave the kind-discriminated branches (`if kind == "token": ...`) unchanged — they read from `merged`, which is now correct.
4. Update the caller in `load_run_events` to pass `kind=row["kind"]` to `event_from_row_payload`.

### Step 2 — Update the plan spec

The plan spec at `docs/superpowers/plans/2026-06-13-citation-verifiability-v2-plan.md` has the same Bug #3 in its Task 1 test code (lines 175-200 area). Apply the same fix to the spec code block, so future implementers (or the next subagent) get the right spec. Commit this as a separate "fix(plan): pass kind as separate column" commit.

### Step 3 — Run the test

```bash
cd services/agent-py && uv run pytest tests/test_aggregator.py -v
```

Expected: PASS for both tests.

### Step 4 — Commit Task 1

```bash
git add services/agent-py/src/agent_py/store.py services/agent-py/tests/test_aggregator.py
git commit -m "feat(agent-py): store.load_run_events + event_from_row_payload"
```

### Step 5 — Continue to Tasks 2-7

The plan is at `docs/superpowers/plans/2026-06-13-citation-verifiability-v2-plan.md` — 7 tasks total. Task 1 is the only one with a rough start; Tasks 2-7 are unaffected by the bugs found so far and should land cleanly.

**Task 2** (subagent, code) — `verify.aggregate_from_events` + tests in `test_aggregator.py`. Plan is clean.
**Task 3** (inline, integration test) — extend `test_runner.py` with the resumed-path test. Plan acknowledges the test body mirrors the existing 2-chunk pattern; the implementer fills it in.
**Task 4** (subagent, code) — `VERIFY_PROVIDER` + Google wrapper + `_resolve_verifier_client` + `_warn_once`. Plan is clean.
**Task 5** (inline, unit test) — `markerMarksFor` + 5 unit tests. Plan is clean.
**Task 6** (subagent, code) — `<CitationMarker>` component + post-processor. The plan explicitly defers the post-processor shape (HTML string vs React tree) to execution time based on the shipped renderer. Read `components/panels/chat-message.tsx` to see which it is.
**Task 7** (inline, sign-off) — full check sweep + (if any user-manual drift) inventory refresh.

---

## Working patterns to keep

The previous subagent hit 3 spec bugs in Task 1. The working pattern that surfaced them was good — keep it:

- **Stop on non-typo failures.** Don't silently fix spec bugs.
- **Run the test, report the exact error + suggest a fix.** The plan author (me, in this case) decides whether the spec is wrong or the implementation is wrong.
- **For TDD plans with mocked asyncpg, the helper needs both `AsyncMock` for `acquire().__aenter__` AND `AsyncMock` for `conn.execute`** (because `_set_user_context` runs before the SELECT). Tasks 4+ (cross-family verifier) shouldn't hit this since they don't touch the DB, but Tasks 2-3 (verify aggregator + finalize hook) might — they re-use the same executor/store layer.

## What NOT to do

- Don't re-derive the design from scratch. The spec at `docs/superpowers/specs/2026-06-13-citation-verifiability-v2-design.md` is approved. Read it.
- Don't change the commit order. The 3 commits land as commit 4, commit 5, commit 6 in the citation-verifiability chain. The plan is sequenced server-correctness-first, server-cost-second, client-UX-third.
- Don't use subagent-driven-development for Tasks 3, 5, 7 — those are integration tests / unit tests / sign-off, and inline is fine.
- Don't add a `client-only` import to `store.py` or `executor.py` — agent-py is server-only by design.
- Don't fix Bug #3 by adding `kind` to the payload (e.g. via the SELECT AS clause or by patching `event_to_row_payload`). `kind` is intentionally a separate column. The fix lives in `event_from_row_payload`.

---

## Quick-reference file paths

| Path | Purpose |
|---|---|
| `docs/superpowers/specs/2026-06-13-citation-verifiability-v2-design.md` | Approved design spec (3 sections: cross-chunk, cross-family, inline markers) |
| `docs/superpowers/plans/2026-06-13-citation-verifiability-v2-plan.md` | 7-task implementation plan |
| `services/agent-py/src/agent_py/store.py` | Working-tree fix needed (Bug #3) |
| `services/agent-py/tests/test_aggregator.py` | On-disk test file, will go green after the fix |
| `services/agent-py/src/agent_py/verify.py` | Task 2 target: `aggregate_from_events` |
| `services/agent-py/src/agent_py/executor.py` | Task 3 target: `finalize` re-aggregates on resume |
| `services/agent-py/src/agent_py/settings.py` | Task 4 target: `VERIFY_PROVIDER` env var |
| `services/agent-py/src/agent_py/providers/__init__.py` | Task 4 target: Google wrapper |
| `lib/shared/verify.ts` | Task 5 target: `markerMarksFor` |
| `components/panels/citation-marker.tsx` | Task 6 target: new component |
| `components/panels/chat-message.tsx` | Task 6 target: post-processor |

## Where to start

**First, run the failing test to confirm the state matches what's described here:**

```bash
cd services/agent-py && uv run pytest tests/test_aggregator.py -v
```

Expected: 2 failed, with `AssertionError: assert [] == ['status', 'token', ...]` (Bug #3).

If you get a different error, stop and ask — the working tree may have drifted from what's documented here.

Then apply Bug #3's fix to `store.py`, run the test, commit. Then §Step 2-5 above.

# `backend-resolver` — defer (subsumed by spec #1)

**Status:** Draft — outcome is "no change". Identified during the 2026-06-14 architecture review as a Speculative candidate. The module is earning its keep via the deletion test, but the seam is thin (only 2 callers, one of them the lazy-import inside `api-client.ts`'s `resolveDispatch`).

**Goal:** Record the decision **not to refactor** `lib/client/api/backend-resolver.ts`, with the load-bearing reason captured so future architecture reviews don't re-suggest it. If spec #1 (the `dispatchedFetch` helper) lands, this module becomes a near-pure projection and the seam is naturally satisfied.

---

## Decisions locked during brainstorming

| # | Decision | Choice |
|---|---|---|
| Q1 | Refactor target | **No change.** `backend-resolver.ts` stays as-is. |
| Q2 | Capture reason | **This spec doc.** Future architecture-review explorations see this and skip the candidate. |
| Q3 | Future action | **If spec #1 lands**, revisit whether the lazy import inside `use-chat-send.ts:424` collapses into a `dispatchedFetch` call. Out of scope for this spec. |

---

## Why no refactor

### The deletion test (the module passes it)

Delete `lib/client/api/backend-resolver.ts` and:
- `api-client.ts:93` (inside `resolveDispatch`) must re-import `useStore` + `getSupabaseBrowserClient` directly. Forces the Zustand + Supabase imports onto every test that exercises `resolveDispatch`.
- `use-chat-send.ts:424` must do the same. Forces the same imports onto every test that exercises the chat-send hook.

Result: 2 call sites would each import the resolver's machinery directly. The complexity **reappears across 2 callers** — the module earns its keep by hiding it once.

### The seam test (the module is thin)

One adapter at the seam: `RemoteBackendContext`. Two callers (one inside `resolveDispatch` itself, one in `use-chat-send`). The two callers do the same lazy import dance, but the seam itself is justified by the deletion test.

If a **third** caller appeared, the candidate would warrant re-examination. Currently there are two.

### The architecture review's own verdict

The review marked this `Speculative` and said: "If (1) lands, (5) is naturally absorbed. If (1) doesn't land, (5) is still defensible — don't manufacture a candidate where there's no friction."

---

## What spec #1 changes (if it lands)

Spec #1 introduces `dispatchedFetch(path, body, ...)` inside `api-client.ts`. The two callers of `resolveRemoteBackend()` are:

1. `api-client.ts:93` — inside `resolveDispatch`. Unchanged by spec #1. The lazy import lives on because `dispatchedFetch` still needs to resolve the dispatch option before fetching.
2. `use-chat-send.ts:424` — calls `resolveRemoteBackend()` directly to know which backend to route the chat stream to. **Not** refactored by spec #1 (chat streams stay bespoke per spec #1's Section 6).

So spec #1 leaves the seam exactly as it is. The candidate remains speculative.

### Hypothetical future consolidation (not in this spec)

If a future spec adds a `dispatchedStream(path, body, ...)` helper for streaming endpoints (out of scope for spec #1), the chat-only `use-chat-send.ts:424` call site could collapse into it. The hypothetical helper would own the resolve-stream-fetch lifecycle; `backend-resolver.ts` would become a near-pure projection over it. That's a separate spec for a separate day.

---

## Risks of doing nothing

None material. The module is 66 lines, has clear tests (`api/backend-resolver.test.ts` per the architecture review), and is the second-most-edited file in the chat-send flow only because chat-send is the hot path.

---

## Risks of doing something

- **Premature consolidation**: introducing a seam-absorbing helper that subsumes `resolveRemoteBackend` would either (a) require streaming endpoints to adopt the helper (churn), or (b) leave `backend-resolver.ts` half-refactored (worse than today). Both are worse than the status quo.
- **Test churn**: `api/backend-resolver.test.ts` would need to change shape to test the new seam, with no behaviour delta. Net-negative ROI.
- **Future drift**: if the third caller ever appears, the cleanup will be easier *because* `backend-resolver.ts` was left simple. Speculative refactors often make future real refactors harder.

---

## ADR (architectural decision record)

This spec effectively **is** the ADR. No separate `docs/adr/` file is created — the project's docs layout per CLAUDE.md doesn't include an ADR directory, and the spec lives at the standard path.

If `docs/adr/` is ever created, this spec's content lifts verbatim into `docs/adr/0001-backend-resolver-deferred.md` per the standard convention.

---

## Rollout

None. This spec commits to `dev` as documentation, not as a refactor.

Branch: `docs/architecture-review-deferred-candidates`. Target: `dev`.

---

## Wins

- **Locality**: the decision is captured in one place. Future architecture reviews see this spec and don't re-suggest the refactor.
- **Honesty**: the architecture review explicitly noted this candidate was speculative; the right action is to record that and move on, not to manufacture friction.
- **Optionality preserved**: if the third caller ever appears, or if spec #1 (or its hypothetical streaming sibling) lands, the deferred candidate is ready to revisit without re-deriving the analysis.
# Verify: long-running agent tasks (manual QA checklist)

A browser walkthrough for the long-running-task feature shipped across
[#66](https://github.com/juchengquan/hummingbird/pull/66) →
[#73](https://github.com/juchengquan/hummingbird/pull/73), plus the
HITL approvals work in
[#76](https://github.com/juchengquan/hummingbird/pull/76). None of this
was browser-verified during development (the build sandbox had no
display), so this checklist covers the golden paths + the edge cases
worth confirming.

Tick boxes as you go; notes inline where the expected result is subtle.

## Prerequisites

- [ ] **Signed in** — the task routes require Supabase auth (they 401
  anonymously). Sign in via the email magic link first.
- [ ] **`AI_GATEWAY_API_KEY` set** (or a `minimax/*` override) — without
  a model provider, launching a task surfaces an auth error in the panel
  instead of running.
- [ ] **Supabase reachable** — `tasks` + `task_events` tables exist
  (migration `0012`). Without Supabase the route returns 503.
- [ ] **Execution headroom** — on Vercel Hobby the 60 s function cap will
  truncate longer runs; use a local `bun dev`, a Pro/Enterprise target,
  or keep test prompts short.

## 1. Launch a task (golden path)

- [ ] In the chat header, the **⚡ Task** toggle is visible next to the
  model picker. Click it → it shows an active/pressed state.
- [ ] Type a multi-step prompt (e.g. *"Research the latest AI SDK release
  notes and summarise the top 3 changes"*) with **web search enabled**,
  and send.
- [ ] A **user message** appears in the thread (the prompt).
- [ ] The **Tasks panel opens** on the right showing a live `TaskStrip`.
- [ ] An **inline pointer** appears above the input: *"Task running ·
  step N/M · View →"*. Clicking it focuses/opens the Tasks panel.
- [ ] The chat input is **not** stuck in a "streaming" state — normal
  chat still works if you toggle Task off.

## 2. The live surface (Tasks panel)

- [ ] **Status + step counter** updates ("Running · Step N / M").
- [ ] **Plan / todo list** renders and updates as the model calls
  `setPlan` — items move pending → in-progress → completed (✓). It should
  **not** appear as a tool pill (the list is its only surface).
- [ ] **Tool pills** show for web search etc. ("Searching the web for
  …" → "Searched the web · N results").
- [ ] **Streaming answer text** flows in (coalesced into ~chunks, not
  per-token — should still read as live, not one big dump at the end).
- [ ] **Reasoning** (if the model emits it) shows under a collapsible
  "Reasoning" disclosure.

## 3. Settle → durable result

- [ ] On completion the panel **collapses to a one-line badge** ("Task
  finished · N steps").
- [ ] The **final answer lands in the conversation** as a normal
  assistant message (durable — survives reload).
- [ ] The inline pointer disappears.

## 4. Cancel

- [ ] Start a task, then click **Cancel** in the panel mid-run.
- [ ] The run stops; no further tool/step activity.
- [ ] Re-check the DB (or reload): the `tasks` row is **`cancelled`**,
  not left `running`.
- [ ] *(Known rough edge — confirm severity)* the panel strip may briefly
  show a stale "running" status after Cancel before settling.

## 5. Resume-on-reload

- [ ] Start a longer task. **Reload the page mid-run.**
- [ ] The Tasks panel **re-attaches** and the run continues from roughly
  where it was (step counter resumes within ~1 step; replayed text
  reappears).
- [ ] Let it finish post-reload → the result still lands in the
  conversation exactly once (no duplicate assistant message).
- [ ] Switch to another view (Workspaces/Editor) mid-run and back → the
  run keeps going; panel reflects current state.

## 6. Orphaned-run reconciliation

- [ ] Start a task, then **kill the server / close the tab hard** so the
  run can't finish (simulates a dead function).
- [ ] Wait > 3 min, then reload / reconnect (or call `POST
  /api/tasks/sweep`).
- [ ] The run flips to **`failed`** ("stopped unexpectedly…") rather than
  sitting `running` forever; a resume stream settles instead of hanging.
- [ ] A **live** run is **never** falsely failed (event activity keeps it
  fresh) — confirm a genuinely long-but-active run survives.

## 7. Finish-while-away notification

- [ ] First time you enable Task mode, the browser **prompts for
  Notification permission**; grant it.
- [ ] Start a task, then **switch to another tab/app** (tab hidden).
- [ ] On completion a **browser notification** fires (title + first ~80
  chars of the result). It should **not** fire while the tab is focused.

## 8. MCP tools in tasks (if you use MCP)

- [ ] With a **cloud-mode** MCP server connected to the workspace, launch
  a task whose prompt needs it → the model can call the `mcp__…` tools
  (cloud-mode works with no extra client wiring).
- [ ] *(Local-mode MCP in tasks is a known follow-up — creds aren't sent
  from the client yet; confirm it's simply unavailable, not broken.)*

## 9. HITL — `askUser` (choice / input)

`askUser` is the easiest HITL path to test: the agent decides on its own
to call it when it needs a human decision, so **no client-side
configuration is required**. The trick is prompting the model so it
actually reaches for `askUser` instead of guessing.

- [ ] **Choice (single).** Prompt something like *"Plan a 2-day trip and
  ask me whether to prioritise food or museums before drafting."* →
  panel shows a **choice card** with the two options as **radio
  buttons** + a Submit button. The prompt text comes from the model.
- [ ] **Choice (multi).** Prompt *"…and ask me which of these
  cuisines I'd like, allowing multiple picks: Italian, Japanese,
  Mexican."* → the card renders **checkboxes** instead of radios, and
  Submit accepts multiple selections.
- [ ] **Input (free-form).** Prompt *"…before continuing, ask me my
  budget in USD."* → the card renders a **textarea** + Submit; the
  value flows back as the tool result and the run continues, using it
  in the answer.
- [ ] In all three cases, after submitting:
  - `status` flips from `paused` back to `running`;
  - the inline pointer reappears in the chat thread;
  - the run completes and the final answer in the conversation
    **reflects the choice/value you gave** (not a generic answer).

## 10. HITL — tool approval (approve / reject a gated MCP tool)

Approval needs `requireApprovalFor: [...]` to be sent in the task body
(the prefixed `mcp__<serverId>__<toolName>` names). **The chat-header
toggle doesn't expose this yet** — to test approval today, set the list
temporarily by either patching the task launch (the `startTask` call in
`components/panels/chat.tsx`'s task branch) or wiring a workspace
setting (a small follow-up). Cloud-mode MCP is the easiest source of a
real gated tool.

- [ ] **Pause on gated call.** With at least one MCP tool name in
  `requireApprovalFor`, prompt the agent to do something that requires
  it → the run pauses. The panel shows an **Approve / Reject card**
  with:
  - the tool name (`mcp__<serverId>__<toolName>`);
  - the proposed `args` (rendered as JSON);
  - the two buttons.
- [ ] **Approve** → the MCP tool runs server-side (via `callTool`), its
  output becomes the tool result the model reads, and the loop
  continues to a final answer.
- [ ] **Reject** → no side effect; the model receives a synthetic
  *"User declined to run this action…"* result and adapts (usually by
  suggesting an alternative or asking what to do next).
- [ ] **DB row.** Spot-check the `tasks` row mid-pause:
  `status = 'paused'` and `checkpoint IS NOT NULL`. After answering,
  `status` returns to `running`.

## 11. HITL — durable suspend / resume across reload

This is the whole point of the checkpoint: the function exits during
the wait, and a *fresh* invocation continues.

- [ ] Launch a task that triggers `askUser` or an approval. While the
  panel sits paused, **reload the page** (or close the tab and reopen).
- [ ] The Tasks panel re-attaches and the same pending card reappears
  (the resume endpoint replays the persisted log, fold sees the
  pending input).
- [ ] Answer → the **`/respond` endpoint** is hit (network tab),
  returning a new stream the panel consumes; the run continues to
  completion just as if you'd never reloaded.

## 12. HITL — interaction edges

- [ ] **Cancel a paused run.** Click Cancel while paused → `tasks.status`
  flips to `cancelled` (not stuck `paused`); the orphan reconciler
  leaves it alone (it only touches `running`/`queued`).
- [ ] **Sequential approvals / asks.** Prompt something that needs two
  back-to-back decisions (e.g. *"Ask me twice: first which language,
  then which framework, then summarise."*) → after the first Submit,
  the run **pauses again** on the next call, showing a fresh card. Both
  answers should appear in the final summary.
- [ ] **Reject + Cancel.** Reject an approval, then immediately Cancel
  before the model speaks again → the run settles `cancelled`; no
  ghost streams continue.
- [ ] **Abandon a pause.** Leave a run `paused` for > 3 min and call
  `POST /api/tasks/sweep` (or just verify it's NOT reconciled — paused
  is intentional, only `queued`/`running` get swept). Confirm the run
  stays `paused` and is resumable later.
- [ ] **Result lands once.** A run that pauses, resumes, and completes
  should land **one** assistant message in the conversation (the
  client-author guard fires on running→done; the suspend/resume cycle
  doesn't double-author).

## 13. Rate limits

- [ ] Hammer web-tool / image-gen calls across runs → the per-IP buckets
  kick in (web ~30/min, image ~5/min) with a soft error, not a crash.

## 14. Security / RLS

- [ ] As a **second user**, you cannot read or cancel another user's run
  (`/api/tasks/:id/*` 404s; `task_events` rows aren't visible).

## Known limitations (expected — not bugs)

- Tasks need sign-in; the toggle isn't hidden when signed out (the error
  surfaces in the panel).
- `failed` / `cancelled` runs do **not** author a thread message (only
  `done` does) — the panel shows the error.
- No multi-run history list yet (panel shows the single active run).
- Realtime tail is deferred (poll-tail every 1 s); queue-backed HITL
  continuation (Phase 6) is deferred — the user's browser drives
  `/respond` today.
- Approval gating has no UI toggle yet — exercising it needs
  `requireApprovalFor` patched into the task body (see §10). `askUser`
  (§9) works with no setup.
- The continuation only re-gates the tool that paused us, so if a
  follow-up call hits a *different* MCP tool, that one will execute
  without pausing. Broader continuation gating is a small follow-up.
- Stale `paused` runs sit indefinitely (intentional, no auto-reject).

## If something's off

Note which box failed + what you saw, and I can dig in. Most likely
suspects by symptom:
- Toggle does nothing → not signed in, or no model provider configured.
- Plan list empty → model didn't call `setPlan` (prompt/model-dependent).
- Run truncates early → serverless execution cap (use a longer-cap target).
- Result never lands in thread → check the running→done transition / sync.
- **`askUser` never fires** → model decided not to ask; tighten the
  prompt ("**ask me** before doing X") or switch to a more
  instruction-following model.
- **Approval never fires** → `requireApprovalFor` not set on the body,
  or the tool name doesn't match the registered `mcp__<server>__<tool>`
  exactly.
- **Paused but card empty** → check `tasks.checkpoint` is non-null and
  the latest `task_events` row is `kind:'approval', phase:'request'`.
- **Continuation 409s** (`invalid_state`) → the run's status isn't
  `paused`, or its `checkpoint` is missing (likely a stale UI; reload).
- **Double assistant message** after resume → would indicate the
  session-author guard regressed; capture the message ids.

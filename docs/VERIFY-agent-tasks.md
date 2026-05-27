# Verify: long-running agent tasks (manual QA checklist)

A browser walkthrough for the long-running-task feature shipped across
[#66](https://github.com/juchengquan/hummingbird/pull/66) →
[#73](https://github.com/juchengquan/hummingbird/pull/73). None of this
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

## 9. Rate limits

- [ ] Hammer web-tool / image-gen calls across runs → the per-IP buckets
  kick in (web ~30/min, image ~5/min) with a soft error, not a crash.

## 10. Security / RLS

- [ ] As a **second user**, you cannot read or cancel another user's run
  (`/api/tasks/:id/*` 404s; `task_events` rows aren't visible).

## Known limitations (expected — not bugs)

- Tasks need sign-in; the toggle isn't hidden when signed out (the error
  surfaces in the panel).
- `failed` / `cancelled` runs do **not** author a thread message (only
  `done` does) — the panel shows the error.
- No multi-run history list yet (panel shows the single active run).
- Realtime tail + human-in-the-loop approvals are deferred (architectural).

## If something's off

Note which box failed + what you saw, and I can dig in. Most likely
suspects by symptom:
- Toggle does nothing → not signed in, or no model provider configured.
- Plan list empty → model didn't call `setPlan` (prompt/model-dependent).
- Run truncates early → serverless execution cap (use a longer-cap target).
- Result never lands in thread → check the running→done transition / sync.

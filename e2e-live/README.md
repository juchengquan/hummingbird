# Real-stack tests

`bun run test:e2e:live` (Q82 of `docs/PLAN-frontend-backend-split.md`;
CI workflow `e2e-live`) runs the product as deployed, on one machine:

| Piece | What |
|---|---|
| Postgres, GoTrue, PostgREST | Supabase's own images, every migration applied |
| `proxy.ts` | a stand-in for Kong: `/auth/v1` → GoTrue, `/rest/v1` → PostgREST, on :54871 |
| agent-py | the real service and worker (`WORKER_DRY_RUN=false`; the scheduler is on by following the worker, `SCHEDULER_ENABLED` left unset — Q130), :8171 |
| Next | a production build pointed at that Supabase and agent-py, :3171 — the frontend only: since wave 13 it serves no `/api/*` route |
| `fakes.py` | a scripted Anthropic Messages server (:8172) that **refuses any request the real API would** — a null `system`, response-only block fields, unpaired tool results — and an MCP server (:8173) that counts every effect. agent-py reaches it as Anthropic and as its Ollama host (wave 10), so it serves an `ollama/*` model the built-in list lacks |

Then the Playwright specs drive the real UI (sign-in, sync, chat on
`/v1/runs`, the task panel with answers, cancel, sub-agents and delivery —
`tasks-runs.spec.ts` —, the editor AI, the model picker, the signed-out
calls) and `routes.py` drives `/v1/runs` directly: background tasks
started, answered (resumes, and sub-agent runs in place), cancelled and
listed there — answer-once, cancel races, children, schedules fired by
agent-py's scheduler, model refusals, the five-task cap — and checks that
Next answers 404 on `/api/tasks` and `/api/chat` (Q147). Every live spec
runs under `guard.ts`, which fails a test on any browser request to Next's
`/api/*` (Q133). The mocked suites (`bun run test:e2e`, `bun run
test:db`) can't see how these pieces work together; 5c's bugs that only
this caught are why it exists.

Needs Docker and the images above (pulled on first run). Nothing calls a
real model.

`bun run test:e2e:smoke` instead runs a few calls against the real
Anthropic API (`LIVE_ANTHROPIC_KEY` must be set; it is never printed):
a background task on `/v1/runs` without a system prompt, a tool task
paused for approval and answered by a background resume, and a chat run
with a tool. With `LIVE_MINIMAX_KEY` and `LIVE_MINIMAX_URL` (e.g.
`https://api.minimaxi.com/anthropic/v1`) it also runs MiniMax M3.1 Flash
through agent-py's own route: `/v1/models` lists it, a chat run with an
approved tool call and its resume, and a background task. Each model also
answers the Explain popover's ephemeral run (signed in, and Haiku signed out):
streamed text, no `tasks` row, and no tool run even when the prompt asks for
one. Run it before deploying a change to how agent-py calls a model.

`stack.sh` starts and removes only its own containers and processes and
refuses to run where a `.env` is present, so a developer's real Supabase
is never in play. Logs: `test-results/live/`.

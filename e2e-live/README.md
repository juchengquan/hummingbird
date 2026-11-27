# Real-stack tests

`bun run test:e2e:live` (Q82 of `docs/PLAN-frontend-backend-split.md`;
CI workflow `e2e-live`) runs the product as deployed, on one machine:

| Piece | What |
|---|---|
| Postgres, GoTrue, PostgREST | Supabase's own images, every migration applied |
| `proxy.ts` | a stand-in for Kong: `/auth/v1` → GoTrue, `/rest/v1` → PostgREST, on :54871 |
| agent-py | the real service and worker (`WORKER_DRY_RUN=false`; the scheduler is on by following the worker, `SCHEDULER_ENABLED` left unset — Q130), :8171 |
| Next | a production build pointed at that Supabase, :3171 |
| `fakes.py` | a scripted Anthropic Messages server (:8172) that **refuses any request the real API would** — a null `system`, response-only block fields, unpaired tool results — and an MCP server (:8173) that counts every effect. agent-py reaches it as Anthropic and as its Ollama host (wave 10), so it serves an `ollama/*` model the built-in list lacks |

Then `tasks.spec.ts` drives the real UI (sign-in, sync, task panel,
answers, cancel, sub-agents, model switching) and `routes.py` the task
routes and `/v1/runs` directly (answer-once, cancel races, children,
schedules, caps). The mocked suites (`bun run test:e2e`, `bun run test:db`)
can't see how these pieces work together; 5c's bugs that only this caught
are why it exists.

Needs Docker and the images above (pulled on first run). Nothing calls a
real model.

`bun run test:e2e:smoke` instead runs a few calls against the real
Anthropic API (`LIVE_ANTHROPIC_KEY` must be set; it is never printed):
a task without a system prompt, a tool task approved and resumed, and a
chat run with a tool. With `LIVE_MINIMAX_KEY` and `LIVE_MINIMAX_URL` (e.g.
`https://api.minimaxi.com/anthropic/v1`) it also runs MiniMax M3.1 Flash
through agent-py's own route: `/v1/models` lists it, a chat run with an
approved tool call and its resume, and a background task. Run it before
deploying a change to how agent-py calls a model.

`stack.sh` starts and removes only its own containers and processes and
refuses to run where a `.env` is present, so a developer's real Supabase
is never in play. Logs: `test-results/live/`.

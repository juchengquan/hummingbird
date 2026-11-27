# Parity fixtures (frozen)

These files were generated from the TypeScript originals agent-py ported
(`docs/PLAN-frontend-backend-split.md`). Wave 13 (Q141) deleted those
originals and their generators, so each file is now agent-py's own golden
file: change it by hand, together with the port it pins. Nothing
regenerates them.

| File | Generated at | By (deleted) | Replayed by |
|---|---|---|---|
| `attachments_render_parity.json` | `02de187` | `lib/server/attachments/render.parity.test.ts` | `test_run_context_render.py` |
| `chunk_parity.json` | `a74e5e7` | `scripts/gen-agent-py-parity.ts` | `test_chunk_parity.py` |
| `cron_parity.json` | `a74e5e7` | `lib/server/agent/schedules.parity.test.ts` | `test_cron_parity.py` |
| `csp_report_parity.json` | `a74e5e7` | `scripts/gen-agent-py-parity.ts` | `test_csp_report.py` |
| `editor_ai_parity.json` | `bea7335` | `components/editor/ai/editor-ai.parity.test.ts` | `test_editor_ai_prompts.py` |
| `editor_ai_streams.json` | `bea7335` | `app/api/ai/command/stream.fixture.test.ts` | `test_editor_ai_route.py` |
| `memory_parity.json` | `a74e5e7` | `scripts/gen-agent-py-parity.ts` | `test_memory_extract.py` |
| `research_prompt_parity.json` | `4f37c57` | the string literals of `lib/server/agent/task-prompt.ts`'s research prompt, which `test_task_prompt.py` used to read from the source (frozen in wave 13) | `test_task_prompt.py` |
| `schedule_fire_parity.json` | `9cf4405` | hand-written; the TS side checked it in `lib/server/agent/schedules.parity.test.ts` | `test_schedules_dispatch.py` |
| `ui_part_parity.json` | `14f9e1f` | `scripts/gen-agent-py-parity.ts` | `test_ui_parts.py` |

The JSON objects carry the same note in a top-level `"_generated"` key.
`editor_ai_streams.json` is a top-level array, so this table is its only
header.

`src/agent_py/ui_part_schema.json` (`UiPartSchema` as JSON Schema, generated
at `14f9e1f` by `scripts/gen-agent-py-parity.ts`) is frozen the same way.
Its source, `lib/shared/generative-ui/schemas.ts`, still ships in the
frontend: a change there must be mirrored in that file and in
`ui_part_parity.json` by hand.

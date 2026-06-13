<!-- pages-for: agent:token, agent:tool_input, agent:tool_output, agent:step_start, agent:step_end, agent:status, agent:plan, agent:step_error, agent:handoff, agent:approval, agent:compact, agent:artifact_ref, agent:result, panel:project-tasks-panel, sidebar:tasks -->
<!-- related: components/panels/project-tasks-panel.tsx, lib/shared/agent/events.ts, components/sidebars/tasks.tsx -->

# Agent tasks

## What it is
Long-running agent runs (a task that takes more than one model turn to
complete). The Tasks panel on the right rail and the dedicated Tasks
sidebar entry both show the live state.

## How to open it
- The **Tasks** entry in the left sidebar.
- The right-rail **project** tab in the chat view.

## What you can do
- Start an agent run by sending a message that the model escalates to
  a task (or by using a project-mode workspace).
- Watch progress: status, plan, step-by-step events, tool calls.
- Cancel a running task from the Tasks panel.
- Inspect a completed run's full event log from the task detail.

## Event kinds
The run is an append-only log of typed events:

- `token` - raw text or reasoning delta.
- `tool_input` - a tool call started (args are final).
- `tool_output` - a tool call resolved (with a one-line summary).
- `step_start` / `step_end` - one LLM call's lifecycle.
- `status` - run status change (queued, running, paused, ...).
- `plan` - the agent's live todo list (Deep-Agents style).
- `step_error` - one step failed; the run may continue.
- `handoff` - control passed between sub-agents.
- `approval` - the agent paused for human-in-the-loop approval.
- `compact` - context was compacted to fit the window.
- `artifact_ref` - the agent produced or referenced a saved artifact.
- `result` - the run's final assistant message.

## Tips & gotchas
- Tasks are durable. Closing the browser does not stop a running
  task - it picks up where it left off when you reopen.
- The Python agent service and the Next.js route are both live; the
  Tasks panel surfaces runs from either backend.

## Related
- [Settings & theme](12-settings-and-theme.md) (the chat-backend toggle)
- [Canvas](09-canvas.md)

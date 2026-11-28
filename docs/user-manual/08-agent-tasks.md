<!-- pages-for: agent:token, agent:tool_input, agent:tool_output, agent:step_start, agent:step_end, agent:status, agent:plan, agent:step_error, agent:handoff, agent:approval, agent:compact, agent:artifact_ref, agent:result, panel:project-tasks-panel, sidebar:tasks -->
<!-- related: apps/web/components/panels/project-tasks-panel.tsx, apps/web/lib/shared/agent/events.ts, apps/web/components/sidebars/tasks.tsx -->

# Agent tasks

## What it is
A long-running agent run: work that takes more than one model turn and
carries on in the background. It runs on the deployment's agent service
(agent-py) and needs a signed-in account.

## How to open it
- **Task** in the chat header: while it is on, the next message starts a
  task instead of a chat reply.
- `/research <goal>` starts a research task, with or without the toggle.
- **Run as task** on a card of a project workspace's board.

The Tasks panel opens beside the chat. The line above the message box
opens it again while a task of that conversation runs.

The panel lists **all your tasks**, from every conversation, scheduled ones included: those
that need your answer first, then the running ones, then the finished
ones. Up to 5 can run at once (the count is at the top of the list). The
**Tasks** button in the chat header opens the panel, and shows how many
tasks wait for your answer. Click a task to expand it: its text, steps,
plan, sub-agents and its question. A task that asks opens by itself.

Tasks started before the chat-backend setting was removed are in the
list like any other: a reload opens the panel on one while it runs, and
you answer, cancel and get its result from there.

A task is titled by its goal (the first line of what you
asked), with its conversation's name under it.

Signed out, there is no **Task** toggle and no **Run as task** on the
board: tasks need an account. `/research` says so.

## What you can do
- Watch progress: status, step, plan, tool calls, sub-agents and text.
- **Run several at once**: up to 5 tasks, the board's
  and `/research` included. A sixth is refused with "You already have 5
  tasks running"; wait for one to finish or cancel one.
- **Answer a question.** A task that needs you pauses and shows a card:
  approve a tool call, pick an option, type an answer or fill in an
  interactive card. Several questions come one after another. Once
  sent, the card says "Answer sent" until the task picks it up.
- **Answer a sub-agent.** When a sub-agent needs you, the task says so
  and shows that question, named after the sub-agent. Several can ask at
  once; answer them in any order. The sub-agent's own window (click it in
  the list) has the same card. The task continues when all sub-agents
  have finished.
- **Skip a sub-agent** from the list or its window. The task carries on
  with the others.
- **Cancel** the task at any point, also while it waits for you or for
  its sub-agents. That cancels its sub-agents too, and its question
  doesn't come back.
- **Stopped at the step limit.** A task that runs out of steps delivers
  what it has, with the note "Stopped at the step limit", on the task and
  at the end of its message.
- **Edit, Regenerate or Retry a task turn** and it runs as a task again,
  in the same mode (`/research` stays research). This is remembered in
  the browser that sent it; on another device such a resend is a chat
  turn.
- Find the result as a message in the conversation it started in. A
  research report also becomes a document and an artifact; a board card
  moves to Done and links its result (or back to To-do when the task
  failed or was cancelled).

## Models
Tasks run only models the Python agent service can run tasks on — the
models it has a provider key for that can call tools (with only an
Anthropic key, the Anthropic models; with a MiniMax key, the MiniMax ones
too) — and not **Auto**.
- With **Task** on, the model picker lists only those. A selected model
  that can't run tasks is switched, with a note; pick again after turning
  **Task** off to chat with another model.
- `/research`, the board and a persona or workspace model have no picker
  at that moment: that one task is started with a model that can run, and
  a note says which. Chat keeps the model you had.

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

## Notifications
The browser asks once whether the app may notify you, when you turn on
**Task**, send `/research` or run a board card. If you allow it, you get
a notification when a task needs your answer, fails or finishes, while
the app's tab is in the background; one per event, even with several
tabs open.

## Tips & gotchas
- Closing the browser does not stop a task. When you open the app again
  in the same browser it rebuilds the task, question included, however
  long it has been waiting. A task that finished meanwhile delivers its
  result then, once.
- The result message is written by the browser that watches the task.
  Another browser or device doesn't follow the task or get the message
  until the watching one has written and synced it.
- If a question says it was answered elsewhere, another tab or device
  answered first, or the task has moved on. An answer that isn't picked
  up within a minute can be given again.
- Tasks can't use local-mode MCP servers, only cloud-mode ones.
- "No task worker available" means the deployment's agent service isn't
  running tasks.

## Related
- [Schedules](15-schedules.md)
- [Skills & tools](07-skills-and-tools.md)
- [Environment variables](21-environment-variables.md)

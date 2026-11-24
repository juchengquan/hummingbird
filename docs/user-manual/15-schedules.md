<!-- pages-for: panel:schedule-section -->
<!-- related: components/panels/schedule-section.tsx, app/api/tasks/schedules/route.ts -->

# Schedules

## What it is
A saved prompt in a workspace that runs as a background task on a cron
schedule. Each run starts a new conversation; with **agent-py (runs)**
selected, the run shows in the Tasks panel and its result is written
into that conversation.

Every schedule runs on a model. A new one gets **Claude Haiku 4.5**
unless you pick another.

**Schedules made before models were added are paused.** Such a schedule
shows "Paused because it had no model". Resume it and it runs on Claude
Haiku 4.5 (the app says so); edit it first to pick another model.

## How to open it
The **Schedules** section in a workspace's settings (the settings button
on the workspace in the Workspaces view). It needs a signed-in account.

## What you can do
- Create a schedule: a name, a prompt, a cron expression, a timezone and
  a model. The model list has only models tasks can run (the Anthropic
  ones), not **Auto**.
- Edit, pause, resume or delete one from its row. The row shows its
  model, and "Paused" while it is paused.
- A scheduled task uses all the workspace's cloud MCP servers; one that
  needs approval pauses the task until you answer it in the Tasks panel.

## Tips & gotchas
- A schedule can fire at most once every 5 minutes: crons such as
  `* * * * *` or `0,2 * * * *` are rejected when you save. Use five
  fields (no seconds field).
- You can have up to 20 enabled schedules. Pause one to enable another.

## Related
- [Agent tasks](08-agent-tasks.md)
- [Environment variables](21-environment-variables.md)

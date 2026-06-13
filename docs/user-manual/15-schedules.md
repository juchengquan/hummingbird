<!-- pages-for: panel:schedule-section -->
<!-- related: components/panels/schedule-section.tsx, lib/client/hooks/store/slices/project-tasks.ts -->

# Schedules

## What it is
Workspace-scoped scheduled runs: a prompt that the model will execute
on a cron schedule ("run every morning at 9am", "run on weekdays",
etc.). Use schedules to keep a project moving without manually
sending each message.

## How to open it
The **Schedules** section in the left sidebar (under the workspace
selector) or the schedule editor inside a workspace.

## What you can do
- Create a schedule: pick a name, a prompt, a cron expression, and
  the workspace's chat that will receive the scheduled turns.
- Edit, pause, or delete an existing schedule from its row.
- View run history: when each scheduled turn fired and what the
  model produced.
- Pin a schedule to make it fire more often (or skip a run).

## Tips & gotchas
- Scheduled runs count against your normal rate limits and token
  usage. A schedule that runs every minute will add up.
- Schedules are workspace-scoped. Move a workspace, move its
  schedules with it.
- A paused schedule retains its history but stops firing until
  resumed.

## Related
- [Agent tasks](08-agent-tasks.md)
- [Settings & theme](12-settings-and-theme.md)

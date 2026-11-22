<!-- pages-for: panel:schedule-section -->
<!-- related: components/panels/schedule-section.tsx, app/api/tasks/schedules/route.ts -->

# Schedules

## What it is
A saved prompt in a workspace that is meant to run as a background task
on a cron schedule.

**Schedules made in the app don't run yet.** They have no model, and a
schedule without a model fails when it is due, with a "no model" error.
The list and the editor say so on every such schedule. Nothing is shown
in the chat when it fails.

## How to open it
The **Schedules** section in a workspace's settings (the settings button
on the workspace in the Workspaces view). It needs a signed-in account.

## What you can do
- Create a schedule: a name, a prompt, a cron expression and a timezone.
- Edit, pause, resume or delete one from its row. Pause one you don't
  want to keep failing.

The editor has no model choice. A schedule that was given a model through
the API carries no warning, but the app doesn't show scheduled results
yet.

## Tips & gotchas
- A schedule can fire at most once every 5 minutes: crons such as
  `* * * * *` or `0,2 * * * *` are rejected when you save. Use five
  fields (no seconds field).
- You can have up to 20 enabled schedules. Pause one to enable another.

## Related
- [Agent tasks](08-agent-tasks.md)
- [Environment variables](21-environment-variables.md)

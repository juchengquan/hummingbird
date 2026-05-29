# Plan: Project mode

Status: **🪜 Phases 1–4 shipped** (schema + toggle, PR #81; Kanban
board + CRUD + drag + sync, PR #86; "break this down" AI breakdown,
PR #89; per-card **Run as task** with auto-column transitions, this
PR). Phase 5 (deferred polish — milestone bar / sidebar chip /
quick filter / export as Markdown) remains. Phase 3 added a
`project-breakdown` mode on
`/api/summarize` (goal → 5–8 task titles, deduped against existing
cards), the `apiClient.summarize.projectBreakdown` method + Zod wire
schemas, and a "Generate tasks" button + checkbox import picker in
the board header. Phase 2 added the `projectTasks` store slice + mutators
(`createProjectTask`/`updateProjectTask`/`moveProjectTask`/
`deleteProjectTask`), the pure `lib/shared/project-tasks.ts` reorder
helper, full `project_tasks` sync (diff + reconcile + bulk upload),
the gated "Tasks" rail tab (desktop + mobile), and the
`ProjectTasksPanel` dnd-kit board. Manual add is wired now; per-card
"Run as task" arrives in Phase 4.
The long-running-tasks dependency is met (shipped). Phase 1 landed:
migration `0016_project_mode.sql` (workspace `is_project`/`goal`/
`milestones` columns + `project_tasks` table + RLS), the `Workspace`
project fields + `ProjectTask`/`Milestone` types, the
`setWorkspaceProjectConfig` store mutator, workspace-column sync
(diff + reconcile + bulk-upload + supabase types), and the project
toggle + goal field in the workspace detail sheet. Milestones UI is
deferred to Phase 5 (inert until the board lands); the column + type
ship now so the schema/sync are complete.

Promote a workspace to a "project" with a goal, milestones, and a
Kanban-style task surface. The AI helps break the goal into tasks,
each task can be run as a long-running task that produces an
artifact. Effectively a sub-product layered on top of workspaces.

## Why

Workspaces are already a folder structure with system prompts and a
default model. The next step beyond "good chat in folders" is
"goal-directed work" — let the user articulate what they're trying
to accomplish and the AI helps move it forward.

Distinctive because most chat apps stop at folders. The few that
have project surfaces (e.g., Replit Agent's plan view) are
agent-first and don't keep the conversational thread intact. Project
mode bridges chat → plan → task → artifact in one workspace.

This is the largest single feature in the backlog. It's gated on
[`PLAN-long-running-tasks.md`](PLAN-long-running-tasks.md) shipping
first — task cards depend on the task substrate.

## Goal & scope cuts

**v1 ships:**

- Optional "Project" mode toggle on the workspace edit dialog. When
  on, the workspace gains:
  - A `goal` text field (multiline, ~2k chars).
  - A `milestones` JSON array (each: title, optional due date).
  - A Tasks tab in the right rail with three columns: To-do,
    In progress, Done.
- "Break this down into tasks" AI action on the workspace goal —
  one-shot `generateText` call returning a list of seed task titles.
- Each task card shows title + status + optional artifact link.
  Drag between columns to update status.
- "Run this task" on any To-do card — kicks off a long-running task
  using the workspace's skills + system prompt, with the task title
  as the goal. Result lands as an artifact attached to the card.
- Workspace sidebar entry gains a small progress chip (`3/8 done`)
  when project mode is on.

**Out of v1:**

- Sub-tasks / dependencies.
- Project templates (e.g., "Research project" pre-filled with seed
  tasks).
- Time tracking, estimates, burn-down charts.
- Multi-user assignment.

## Architecture

Builds on three existing pieces:

1. **Workspaces** as the project container (existing `Workspace`
   row + the new columns).
2. **Long-running tasks** as the execution substrate (the
   `tasks` table from `PLAN-long-running-tasks.md`).
3. **Artifacts** as the deliverable per task — the existing
   `artifacts` table, joined to the task row via the existing
   `messageId` column.

```
+---------------+      +-----------------+      +---------------+
| Workspace     | ---> | project_tasks   | ---> | tasks         |
| (goal,        |      | (title, status, |      | (the long-    |
|  milestones,  |      |  position,      |      |  running      |
|  is_project)  |      |  task_id?,      |      |  task row)    |
+---------------+      |  artifact_id?)  |      +-------+-------+
                       +-----------------+              |
                                                        v
                                                 +-------------+
                                                 | artifacts   |
                                                 +-------------+
```

`project_tasks` is the Kanban-card row; `tasks` is the runtime row.
A card without a `task_id` is just a manual to-do.

## Phases

Each builds on long-running-tasks Phase 1+2. Don't start before
those land.

### Phase 1 — Schema + project toggle (≈ half day)

**Migration**:

```sql
alter table workspaces
  add column is_project boolean not null default false,
  add column goal text,
  add column milestones jsonb;

create table project_tasks (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null,
  status text not null check (status in ('todo','in_progress','done','cancelled')),
  position int not null,
  task_id uuid references tasks(id) on delete set null,
  artifact_id uuid references artifacts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on project_tasks (workspace_id, status, position);
```

**Workspace dialog.** Existing "Edit workspace" form gains a project
toggle. When on, reveal goal + milestones fields.

### Phase 2 — Tasks tab + Kanban board (≈ 1.5 days)

- New `components/panels/project-tasks-panel.tsx` mounted as the
  "Tasks" tab in the right sidebar when `workspace.is_project`.
- Three columns rendered with `@dnd-kit/sortable` for drag-reorder
  and inter-column moves.
- Card content: title, status badge, optional artifact preview
  thumbnail, "Run" button (Phase 4 wires this up).
- Store mutators: `createTask`, `updateTask`, `moveTask`,
  `deleteTask`. Sync handlers mirror to Postgres.

### Phase 3 — "Break this down" AI action (≈ half day)

A "Generate tasks from goal" button on the project header. Calls a
new `mode: 'project-breakdown'` on `/api/summarize` (or a dedicated
route — decide during implementation based on prompt complexity).
Returns a list of 5-10 task titles; user picks which to import.
Imported tasks land in the To-do column.

### Phase 4 — "Run this task" → long-running task (≈ half day)

- A `Run` button on each To-do card kicks off a long-running task
  using the workspace's `systemPrompt` + skills cascade + the task
  title as the goal.
- On task `status='done'`, link the result message's artifact back
  to the `project_tasks` row (`artifact_id`).
- Card auto-moves to "In progress" while the task runs, to "Done"
  when it finishes. User can override (drag back, etc.).
- A small spinner + step counter on the card while running, similar
  to the chat-header task strip.

### Phase 5 — Polish (deferred)

- Milestone progress bar at the top of the Tasks tab.
- Workspace sidebar entry shows the `N/M done` chip.
- Quick filter (To-do only, blocked, etc.).
- Export a project as Markdown (goal + milestones + tasks + artifacts).

## Verification

1. Toggle project mode on a fresh workspace. Verify goal + milestone
   fields appear in the edit dialog.
2. Type a goal, click "Generate tasks". 5-10 cards land in To-do.
3. Drag a card from To-do → In progress. Status persists on
   reload.
4. Click "Run" on a card with web search on. Task starts; card
   shows step counter; finishes; artifact link appears on the card.
5. Delete the task. The card's `task_id` clears but the card and
   its artifact link survive (the task row is gone, the artifact
   stays).
6. Toggle project mode OFF. The Tasks tab disappears; rows stay in
   `project_tasks` so toggling back on restores everything.
7. RLS: another user can't read another user's `project_tasks`.

## Out of scope

- Multi-user collaboration (depends on Realtime Phase 3).
- Project templates with pre-seeded tasks.
- Time tracking + estimates.
- Cross-workspace task dependencies.
- A "project home" view distinct from the chat panel — v1 just adds
  a Tasks tab; the chat is still the conversation surface.

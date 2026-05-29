-- Project mode (Phase 1) — see `docs/PLAN-project-mode.md`.
--
-- Promotes a workspace to a "project": a goal, optional milestones,
-- and a Kanban-style task surface. This migration lands the schema;
-- the board UI + AI breakdown + "Run as task" wiring come in later
-- phases.
--
-- Two parts:
--   1. Three columns on `workspaces`:
--      - `is_project`  : the mode toggle. Default false → every
--                        existing workspace stays a plain folder.
--      - `goal`        : free-text objective (nullable).
--      - `milestones`  : jsonb array of { title, dueDate? } (nullable).
--        Kept as jsonb (not a child table) because milestones are a
--        small, workspace-owned list edited as a unit — same call as
--        `mcp.capabilities` / `messages.generated_images`.
--   2. `project_tasks` — the Kanban-card table. Each card optionally
--      links to a long-running `tasks` row (`task_id`, the runtime
--      execution) and to the `artifacts` row it produced
--      (`artifact_id`). A card with neither is just a manual to-do.
--      Both FKs are ON DELETE SET NULL so deleting the task run or the
--      artifact leaves the card (and its history) intact.
--
-- RLS: the boilerplate own-your-rows pattern — same four-policy shape
-- as every other table. Idempotent: `if not exists` + add-column-
-- if-not-exists + duplicate-policy-swallowing DO blocks.

alter table workspaces
  add column if not exists is_project boolean not null default false;
alter table workspaces
  add column if not exists goal text;
alter table workspaces
  add column if not exists milestones jsonb;

create table if not exists project_tasks (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null,
  status text not null
    check (status in ('todo', 'in_progress', 'done', 'cancelled')),
  -- Ordering within a (workspace, status) column on the board.
  position int not null,
  -- The long-running run this card spawned, if any (set by "Run as
  -- task"). NULL for manual to-dos. SET NULL on task delete so the
  -- card survives a cleared run.
  task_id uuid references tasks(id) on delete set null,
  -- The deliverable the run produced, if any. SET NULL on artifact
  -- delete — the card keeps its place, just loses the link.
  artifact_id uuid references artifacts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Board render order: cards grouped by status, ordered by position.
create index if not exists project_tasks_board_idx
  on project_tasks (workspace_id, status, position);

alter table project_tasks enable row level security;

do $$ begin
  create policy "project_tasks: select own"
    on project_tasks for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "project_tasks: insert own"
    on project_tasks for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "project_tasks: update own"
    on project_tasks for update using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "project_tasks: delete own"
    on project_tasks for delete using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

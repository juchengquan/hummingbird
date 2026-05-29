-- 0015_workspace_canvas.sql — spatial canvas layout per workspace
--
-- Adds `canvas_state jsonb` to `workspaces`. Stores the workspace
-- canvas's node positions + connections + viewport as a single opaque
-- document — see `lib/shared/canvas/types.ts` (`CanvasState`). Node
-- bodies are NOT stored here; they're projected from the live
-- conversations / artifacts / notes / files / url_bookmarks rows at
-- render time, keyed by id. Only layout lives in this column.
--
-- Synced as one field (whole-object replace, debounced client-side).
-- The JSON is small (KBs — positions + a handful of edges). JSONB so
-- the shape can evolve without further migrations. Inherits the
-- workspaces-table RLS (own-your-rows). No new policies. Idempotent.

alter table public.workspaces
  add column if not exists canvas_state jsonb;

comment on column public.workspaces.canvas_state is
  'Spatial canvas layout — { nodes, edges, viewport }. Node bodies are projected from live rows by id; only layout is persisted. Null until the user adds the first canvas node.';

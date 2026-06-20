# Subagent Orchestration PR-3a — Spawned Children in the Task Strip — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface spawned subagents in the task strip — put the child task id on the `handoff` event, fold it into the run view, and render a "Spawned N subagents" group with per-child status pills.

**Architecture:** Extend `HandoffEvent` (agent-py + shared) with `childTaskId` + `subgoal`; fold handoff events into `TaskRunView.childRuns` in `reduceRun`; add a `GET /api/tasks/[id]/children` status endpoint behind `apiClient`; render the group in `components/agent/task-strip.tsx`, polling statuses while the parent runs. Drill-in + canvas deferred (PR-3b/3c).

**Tech Stack:** TypeScript, Zod, React, Next.js route; Python (agent-py) for the emit side. Bun test + pytest.

**Spec:** [`docs/superpowers/specs/2026-06-20-subagent-orchestration-pr3a-design.md`](../specs/2026-06-20-subagent-orchestration-pr3a-design.md)

**Conventions:** agent-py gate `bun run check:agent-py`; repo gate `bun run check` (typecheck + lint + test). Components call `apiClient.*` / `apiUrls.*`, never raw `fetch`. Deps pre-installed in this worktree by the controller (`bun install` + `uv sync`).

**Exact current shapes (read these):**
- `lib/shared/agent/events.ts:136-140` — `HandoffEvent { kind, agent, phase }`; union at `:238`.
- `lib/shared/agent/wire.ts:131-136` — the `handoff` Zod object (`kind`, `agent`, `phase`).
- `lib/shared/agent/project.ts:37-67` `TaskRunView`; `:86-102` `EMPTY_RUN_VIEW`; `:180` the `handoff` no-op case (grouped with step_start/step_end/compact).
- `services/agent-py/src/agent_py/events.py:162-171` `HandoffEvent` (fields `agent`, `phase`); `:295` `event_to_row_payload` handoff branch `return {"agent":…, "phase":…}`.
- `services/agent-py/src/agent_py/emitter.py` `async def handoff(self, *, agent, phase="enter")`.
- `services/agent-py/src/agent_py/executor.py:494` `await emitter.handoff(agent=spec.persona_slug, phase="enter")` (inside the fan-out loop; `child_id` + `spec.subgoal` are in scope).
- `lib/client/api-client.ts` — `schedulesList()` (~:620) is the GET+parse pattern to mirror; `apiUrls` block (~:300) for the URL builder.
- `app/api/tasks/[id]/cancel/route.ts` — auth + `getSupabaseServerClient` pattern to mirror for the new route.
- `components/agent/task-strip.tsx:155-157` — where `PlanList` / `ToolCallStrip` render; `:418` `PlanList` for the rendering idiom.

---

### Task 1: Wire — shared `HandoffEvent` + Zod schema

**Files:** Modify `lib/shared/agent/events.ts`, `lib/shared/agent/wire.ts`; Test `lib/shared/agent/wire.test.ts` (append).

- [ ] **Step 1: Write the failing test** — append to `lib/shared/agent/wire.test.ts` (match its imports of `toDataPart`/`fromDataPart`):

```typescript
import { describe, expect, test } from "bun:test"
import { fromDataPart, toDataPart } from "./wire"
import type { HandoffEvent } from "./events"

describe("HandoffEvent wire round-trip with child fields", () => {
  test("childTaskId + subgoal survive toDataPart → fromDataPart", () => {
    const ev: HandoffEvent = {
      kind: "handoff",
      runId: "r1",
      seq: 3,
      step: 1,
      createdAt: "2026-06-20T00:00:00Z",
      agent: "researcher",
      phase: "enter",
      childTaskId: "child-1",
      subgoal: "find sources",
    }
    const round = fromDataPart(toDataPart(ev))
    expect(round).not.toBeNull()
    expect(round?.kind).toBe("handoff")
    if (round?.kind === "handoff") {
      expect(round.childTaskId).toBe("child-1")
      expect(round.subgoal).toBe("find sources")
    }
  })

  test("a handoff without child fields still validates", () => {
    const ev: HandoffEvent = {
      kind: "handoff", runId: "r1", seq: 4, step: 1,
      createdAt: "2026-06-20T00:00:00Z", agent: "x", phase: "exit",
    }
    expect(fromDataPart(toDataPart(ev))).not.toBeNull()
  })
})
```
(Confirm the exact `TaskEventBase` field names — `runId`/`seq`/`step`/`createdAt` — by reading `events.ts`; match them.)

- [ ] **Step 2: Run to verify it fails** — `cd /Users/blackmount8/_repository/hummingbird-sa3 && bun test lib/shared/agent/wire.test.ts` → FAIL (childTaskId/subgoal not on the type / stripped by schema).

- [ ] **Step 3: Extend the interface** in `lib/shared/agent/events.ts` (`HandoffEvent`, :136-140):

```typescript
export interface HandoffEvent extends TaskEventBase {
  kind: "handoff"
  agent: string
  phase: "enter" | "exit"
  /** The spawned child task's id (spawn handoffs only). */
  childTaskId?: string
  /** The child's subgoal (spawn handoffs only). */
  subgoal?: string
}
```

- [ ] **Step 4: Extend the Zod schema** in `lib/shared/agent/wire.ts` (the `handoff` object, :131-136):

```typescript
    z.object({
      ...base,
      kind: z.literal("handoff"),
      agent: z.string(),
      phase: z.enum(["enter", "exit"]),
      childTaskId: z.string().optional(),
      subgoal: z.string().optional(),
    }),
```

- [ ] **Step 5: Run to verify it passes** — `bun test lib/shared/agent/wire.test.ts`.

- [ ] **Step 6: typecheck** — `bun run typecheck 2>&1 | tail -5` (clean).

- [ ] **Step 7: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird-sa3
git add lib/shared/agent/events.ts lib/shared/agent/wire.ts lib/shared/agent/wire.test.ts
git commit -m "feat(agent-events): childTaskId + subgoal on HandoffEvent (wire)"
```

---

### Task 2: Wire — agent-py `HandoffEvent` + serializer + emitter + executor call

**Files:** Modify `services/agent-py/src/agent_py/events.py`, `emitter.py`, `executor.py`; Test `tests/test_events.py` (append).

- [ ] **Step 1: Write the failing test** — append to `services/agent-py/tests/test_events.py` (match its style): construct a `HandoffEvent(..., agent="r", phase="enter", child_task_id="c1", subgoal="g")` and assert `event_to_row_payload(event)` returns `{"agent":"r","phase":"enter","childTaskId":"c1","subgoal":"g"}`; and that a handoff with `child_task_id=None` omits those keys (payload has just agent+phase). (Confirm the import names for `HandoffEvent` + `event_to_row_payload`.)

- [ ] **Step 2: Run to verify it fails** — `cd services/agent-py && uv run pytest tests/test_events.py -q`.

- [ ] **Step 3: Extend the dataclass** (`events.py:162-171`):

```python
    kind: Literal["handoff"] = field(default="handoff", init=False)
    agent: str
    phase: Literal["enter", "exit"]
    child_task_id: str | None = None
    subgoal: str | None = None
```
(Keep field ordering valid — fields with defaults must follow required ones; `agent`/`phase` are required, the two new ones have defaults, so they go last. If `TaskEventBase` uses `kw_only` or the existing fields have defaults, match that; adjust ordering so it compiles.)

- [ ] **Step 4: Extend the serializer** (`events.py:295`):

```python
    if isinstance(event, HandoffEvent):
        payload: dict[str, object] = {"agent": event.agent, "phase": event.phase}
        if event.child_task_id is not None:
            payload["childTaskId"] = event.child_task_id
        if event.subgoal is not None:
            payload["subgoal"] = event.subgoal
        return payload
```
(Use a distinct local name if `payload` collides in that function's scope — read the surrounding code.)

- [ ] **Step 5: Extend `emitter.handoff`** (`emitter.py`):

```python
    async def handoff(
        self, *, agent: str, phase: str = "enter",
        child_task_id: str | None = None, subgoal: str | None = None,
    ) -> None:
        if self._settled:
            return
        await self._emit(
            HandoffEvent(
                run_id=self._run_id, seq=self._next_seq(), step=self._step,
                created_at=_now_iso(), agent=agent, phase=phase,  # type: ignore[arg-type]
                child_task_id=child_task_id, subgoal=subgoal,
            )
        )
```

- [ ] **Step 6: Pass them at the executor call site** (`executor.py:494`):

```python
                await emitter.handoff(
                    agent=spec.persona_slug, phase="enter",
                    child_task_id=child_id, subgoal=spec.subgoal,
                )
```
(`child_id` is the result of `store.create_child_task(...)` earlier in that loop iteration; `spec.subgoal` is the SpawnSpec field — confirm both are in scope at :494.)

- [ ] **Step 7: Run to verify it passes** — `uv run pytest tests/test_events.py -q`.

- [ ] **Step 8: format/lint/typecheck** — `cd services/agent-py && uv run ruff format . && uv run ruff check --fix . && uv run mypy src/agent_py/events.py src/agent_py/emitter.py src/agent_py/executor.py 2>&1 | tail -8` (no new errors).

- [ ] **Step 9: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird-sa3
git add services/agent-py/src/agent_py/events.py services/agent-py/src/agent_py/emitter.py services/agent-py/src/agent_py/executor.py services/agent-py/tests/test_events.py
git commit -m "feat(agent-py): emit childTaskId + subgoal on spawn handoff events"
```

---

### Task 3: Projection — `ChildRunRef` + `TaskRunView.childRuns` + `reduceRun` fold

**Files:** Modify `lib/shared/agent/project.ts`; Test `lib/shared/agent/project.test.ts` (append).

- [ ] **Step 1: Write the failing test** — append to `project.test.ts` (match its `reduceRun`/`EMPTY_RUN_VIEW` imports):

```typescript
function handoff(seq: number, childTaskId: string | undefined, agent: string, subgoal: string) {
  return {
    kind: "handoff" as const, runId: "r", seq, step: 1,
    createdAt: "2026-06-20T00:00:00Z", agent, phase: "enter" as const,
    childTaskId, subgoal,
  }
}

describe("reduceRun — handoff → childRuns", () => {
  test("folds a spawn handoff into childRuns", () => {
    const v = reduceRun(EMPTY_RUN_VIEW, handoff(1, "c1", "researcher", "find sources"))
    expect(v.childRuns).toEqual([
      { childTaskId: "c1", agent: "researcher", subgoal: "find sources" },
    ])
  })

  test("dedups by childTaskId", () => {
    let v = reduceRun(EMPTY_RUN_VIEW, handoff(1, "c1", "r", "g"))
    v = reduceRun(v, handoff(2, "c1", "r", "g"))
    expect(v.childRuns).toHaveLength(1)
  })

  test("a handoff without childTaskId is a no-op for childRuns", () => {
    const v = reduceRun(EMPTY_RUN_VIEW, handoff(1, undefined, "r", "g"))
    expect(v.childRuns ?? []).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `bun test lib/shared/agent/project.test.ts`.

- [ ] **Step 3: Add the type + view field.** In `project.ts`, add near `TaskRunView`:

```typescript
export interface ChildRunRef {
  childTaskId: string
  agent: string
  subgoal: string
}
```
Add to `TaskRunView` (after `pendingInput`):
```typescript
  /** Subagents spawned this run (from `handoff` events). */
  childRuns: ChildRunRef[]
```
Add to `EMPTY_RUN_VIEW`:
```typescript
  childRuns: [],
```

- [ ] **Step 4: Fold in `reduceRun`.** Remove `case "handoff":` from the grouped no-op block (it currently falls through with `step_start`/`step_end`/`compact`) and give it its own case BEFORE that block:

```typescript
    case "handoff": {
      if (event.phase !== "enter" || !event.childTaskId) return next
      if (view.childRuns.some((c) => c.childTaskId === event.childTaskId)) return next
      next.childRuns = [
        ...view.childRuns,
        { childTaskId: event.childTaskId, agent: event.agent, subgoal: event.subgoal ?? "" },
      ]
      return next
    }
```
(Leave `step_start`/`step_end`/`compact` in the grouped no-op case.)

- [ ] **Step 5: Run to verify it passes** + the full project test file (`bun test lib/shared/agent/project.test.ts`).

- [ ] **Step 6: typecheck** — `bun run typecheck 2>&1 | tail -5`. (Adding a required `childRuns` field to `TaskRunView` + `EMPTY_RUN_VIEW` keeps it satisfied; if any other construction of `TaskRunView` exists, it'll surface here — fix by adding `childRuns: []`.)

- [ ] **Step 7: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird-sa3
git add lib/shared/agent/project.ts lib/shared/agent/project.test.ts
git commit -m "feat(agent-project): fold spawn handoffs into TaskRunView.childRuns"
```

---

### Task 4: Children-status endpoint + store helper + schema + apiClient

**Files:** Create `app/api/tasks/[id]/children/route.ts`; Modify `lib/server/agent/store.ts`, `lib/shared/api-schemas.ts`, `lib/client/api-client.ts`; Test `lib/shared/api-schemas.test.ts` (append, if it exists) + a store/route test if a mockable pattern exists.

- [ ] **Step 1: Add the response schema** in `lib/shared/api-schemas.ts`:

```typescript
export const TaskChildSchema = z.object({
  id: z.string(),
  status: z.string(),
  goal: z.string(),
})
export const TaskChildrenResponseSchema = z.object({
  children: z.array(TaskChildSchema),
})
export type TaskChildrenResponse = z.infer<typeof TaskChildrenResponseSchema>
```

- [ ] **Step 2: Add the store helper** in `lib/server/agent/store.ts` (mirror the existing query helpers' use of the typed Supabase client):

```typescript
/** List a task's child subagent tasks (status + goal), RLS-scoped. */
export async function listTaskChildren(
  db: SupabaseClient<Database>,
  parentId: string,
  userId: string
): Promise<{ id: string; status: string; goal: string }[]> {
  const { data, error } = await db
    .from("tasks")
    .select("id, status, goal")
    .eq("parent_task_id", parentId)
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
  if (error) throw new Error(`listTaskChildren: ${error.message}`)
  return data ?? []
}
```
(Match the file's actual `SupabaseClient`/`Database`/`DB` alias.)

- [ ] **Step 3: Create the route** `app/api/tasks/[id]/children/route.ts` — mirror `app/api/tasks/[id]/cancel/route.ts`'s structure (auth via `getSupabaseServerClient` + `db.auth.getUser()`, 503 if no db, 401 if no user):

```typescript
import "server-only"
import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import { getSupabaseServerClient } from "@/server/supabase/server"
import { listTaskChildren } from "@/server/agent/store"
import { categorizeError } from "@/shared/api-errors"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = await getSupabaseServerClient()
  if (!db) {
    return NextResponse.json(
      { code: "unavailable", message: "Supabase is not configured." },
      { status: 503 }
    )
  }
  const { data: userData, error: authError } = await db.auth.getUser()
  if (authError || !userData.user) {
    return NextResponse.json({ code: "auth", message: "Unauthorized." }, { status: 401 })
  }
  try {
    const children = await listTaskChildren(db, id, userData.user.id)
    return NextResponse.json({ children })
  } catch (error) {
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }
}
```
(Confirm `categorizeError` import path against the cancel route.)

- [ ] **Step 4: Add the apiUrl + apiClient method** in `lib/client/api-client.ts`. In the `apiUrls` block (near the other task URLs ~:300):

```typescript
  taskChildren: (id: string) => url(`/api/tasks/${encodeURIComponent(id)}/children`),
```
Add a method mirroring `schedulesList` (try/fetch/parse/catch → `[]` on failure):

```typescript
async function taskChildren(id: string): Promise<TaskChildrenResponse["children"]> {
  try {
    const res = await fetch(apiUrls.taskChildren(id))
    if (!res.ok) return []
    return TaskChildrenResponseSchema.parse(await res.json()).children
  } catch {
    return []
  }
}
```
Wire `taskChildren` into the exported `apiClient` object (find where `schedulesList` etc. are attached and add `listTaskChildren: taskChildren`). Import `TaskChildrenResponseSchema` + the type from `@/shared/api-schemas`.

- [ ] **Step 5: Test** — append to `lib/shared/api-schemas.test.ts` (if present) a test that `TaskChildrenResponseSchema` parses a valid `{children:[{id,status,goal}]}` and rejects a malformed one. (The route + apiClient are exercised by the manual smoke; do NOT build a Supabase mock harness from scratch.)

- [ ] **Step 6: typecheck + lint** — `bun run typecheck 2>&1 | tail -5 && bun run lint 2>&1 | tail -6` (clean / 0 errors).

- [ ] **Step 7: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird-sa3
git add app/api/tasks/[id]/children/route.ts lib/server/agent/store.ts lib/shared/api-schemas.ts lib/shared/api-schemas.test.ts lib/client/api-client.ts
git commit -m "feat(tasks): GET /api/tasks/[id]/children + apiClient.listTaskChildren"
```

---

### Task 5: Task-strip "Spawned N subagents" group

**Files:** Modify `components/agent/task-strip.tsx`; Test `components/agent/task-strip.test.tsx` (if a component test setup exists) — else a focused render test of the new sub-component.

- [ ] **Step 1: Read** `components/agent/task-strip.tsx:90-185` (the in-flight render + how `view`/`isRunning` are used) and `:418` `PlanList` (the rendering idiom — status icons + list). Mirror it.

- [ ] **Step 2: Write the failing test** — if there's an existing `task-strip` test or a component test harness (check `components/agent/` for `*.test.tsx`), append a test that, given a `view` with `childRuns: [{childTaskId:"c1",agent:"researcher",subgoal:"find sources"}]`, the rendered output contains "researcher" + "find sources" + a "Spawned" label. If NO component test harness exists in the repo, instead extract the group into a pure-ish presentational sub-component `SubagentGroup({ children, statuses })` and unit-test that it returns the right structure (or test a pure helper `childPillStatus(childTaskId, statuses)`); state which you did. Do NOT stand up a new React test runner if the repo lacks one — match what exists.

- [ ] **Step 3: Implement.** Add a `SubagentGroup` sub-component in `task-strip.tsx` and render it in the in-flight branch AFTER `PlanList` (after :155) and BEFORE `ToolCallStrip` (:157), gated on `view.childRuns?.length`:

```tsx
{view.childRuns && view.childRuns.length > 0 ? (
  <SubagentGroup childRuns={view.childRuns} statuses={childStatuses} />
) : null}
```

The component (mirror `PlanList`'s structure + the file's status-pill styling):
```tsx
function SubagentGroup({
  childRuns,
  statuses,
}: {
  childRuns: ChildRunRef[]
  statuses: Record<string, string>
}) {
  return (
    <div className="...mirror PlanList's container classes...">
      <div className="...heading classes...">Spawned {childRuns.length} subagents</div>
      {childRuns.map((c) => (
        <div key={c.childTaskId} className="...row classes...">
          <span className="...pill classes...">{statuses[c.childTaskId] ?? "queued"}</span>
          <span className="font-medium">{c.agent}</span>
          <span className="text-muted-foreground">{c.subgoal}</span>
        </div>
      ))}
    </div>
  )
}
```
Import `ChildRunRef` from `@/shared/agent/project`.

Status polling: in the `TaskStrip` component body, fetch + poll child statuses while running:
```tsx
const [childStatuses, setChildStatuses] = useState<Record<string, string>>({})
useEffect(() => {
  if (!isRunning || !view.childRuns?.length) return
  let active = true
  const load = async () => {
    const rows = await apiClient.listTaskChildren(taskId)
    if (!active) return
    setChildStatuses(Object.fromEntries(rows.map((r) => [r.id, r.status])))
  }
  void load()
  const t = setInterval(load, 2000)
  return () => { active = false; clearInterval(t) }
}, [isRunning, view.childRuns?.length, taskId])
```
(Confirm `taskId` is available in `TaskStrip`'s props/scope — the strip renders one run; find the run id it already uses, e.g. from `view` or a prop. If the run id isn't in scope, thread it from the parent that renders `TaskStrip`, or read it from the `TaskRunContext`. State what you used.)

- [ ] **Step 4: Run the test + typecheck + lint.** `bun test components/agent` (or the specific test) + `bun run typecheck 2>&1 | tail -5 && bun run lint 2>&1 | tail -6`.

- [ ] **Step 5: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird-sa3
git add components/agent/task-strip.tsx components/agent/
git commit -m "feat(task-strip): show spawned subagents group with status pills"
```

---

### Task 6: Full gate

**Files:** none.

- [ ] **Step 1: agent-py gate** — `cd /Users/blackmount8/_repository/hummingbird-sa3 && bun run check:agent-py` (ruff + format + mypy + pytest all pass).
- [ ] **Step 2: repo gate** — `bun run check` (typecheck clean, lint 0 errors, tests pass).
- [ ] **Step 3: Commit any gate fixes** (only if needed): `git add -A && git commit -m "chore: gate fixes for subagent PR-3a" || echo "nothing to commit"`.

---

## Notes for the PR description

- PR-3a of `docs/PLAN-subagent-orchestration.md` (client surfacing, first slice).
- Adds `childTaskId` + `subgoal` to `HandoffEvent` (agent-py + shared wire), folds spawn handoffs into `TaskRunView.childRuns`, adds `GET /api/tasks/[id]/children`, and renders a "Spawned N subagents" group with status pills in the task strip.
- Display-only pills (poll the children endpoint while running). Drill-in (PR-3b) + canvas node tree (PR-3c, needs tasks-as-canvas-nodes) deferred.
- **Verification caveat:** the full path needs the PR-2 spawn loop live-smoke-verified (model + Postgres); these tests prove the wire/projection/endpoint/render in isolation.
- No migration. The `HandoffEvent` fields are optional (back-compat).

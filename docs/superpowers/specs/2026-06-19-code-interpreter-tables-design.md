# Code interpreter — rich tables (PR-3) — Design

**Status:** Approved design (2026-06-19). **PR-3** of the code-interpreter
series; builds on PR-1 (`#243`) + PR-2 (`#244`).

**Builds on:** `docs/PLAN-code-interpreter.md` §"PR 3" (the table-rendering
half; **JavaScript is split out** into its own later PR — see Scope).

## Goal

`runCode` can return a **structured table** that the UI renders as a
data-grid, instead of only stdout text. The model writes a table file in
the sandbox; the adapter reads + parses it into a `table` `CodeResult`;
the existing `data-code-result` part carries it to the client unchanged.

## Decisions locked (brainstorming)

| # | Decision | Choice |
|---|---|---|
| D1 | Scope | **Tables only.** JavaScript deferred to its own PR (its node-image runtime is unvalidated). |
| D2 | Emission | **File-based JSON**, parallel to charts: the model writes `/tmp/<name>.table.json`; the adapter reads `/tmp/*.table.json`. |
| D3 | Render | A **simple scrollable data-grid**; sort/export/pagination deferred (YAGNI). |

## Why this is small

PR-1 already reserved the `table` variant through the whole data path:
`CodeResult`/`CodeResultCell` include `{ type: "table"; columns; rows }`,
the chat route's `emitter.codeResult` already sends all **non-image**
result cells, the client translator carries them as `CodeResultCell[]`,
and the store persists them. So the **route, SSE translator, store, and
wire schema need no change**. Only three things are new: the sandbox
**produces** table cells, the marshaller **maps + caps** them, and the
render component **draws** them.

## Architecture

```
model writes /tmp/sales.table.json  ( {columns, rows}  OR pandas to_json(orient="split") )
   │  microsandbox-client: after exec, read /tmp/*.table.json (alongside /tmp/*.png)
   ▼
RawRun.tables: { columns: string[]; rows: string[][] }[]
   │  marshal.toCodeRunResult → CodeResult { type:"table", columns, rows }  (capped)
   ▼
emitter.codeResult (existing — non-image cells)  →  translator → store → <CodeResult/>
   │
   ▼
code-result.tsx: new `table` branch → scrollable data-grid
```

## Components & boundaries

### Emission convention (prompt)
`lib/server/skills/code-interpreter.ts` `promptFragment` gains: to return
a table, write JSON to `/tmp/<name>.table.json` as `{ "columns": [...],
"rows": [[...], ...] }`, or `df.to_json('/tmp/<name>.table.json',
orient='split')`. (Sits beside the existing `savefig` chart guidance.)

### Adapter — `lib/server/code-sandbox/microsandbox-client.ts`
After `exec`, in the same `/tmp` read-back that collects charts, also list
`/tmp` for `*.table.json`, `read` + `JSON.parse` each, and normalize to
`{ columns: string[]; rows: string[][] }`:
- `{ columns, rows }` → used directly (stringify each cell).
- pandas `orient="split"` `{ columns, data }` (and optional `index`) →
  `columns` from `columns`, `rows` from `data` (stringify cells).
- Parse/shape failure on one file → skip it (best-effort; never throws).
Add the parsed tables to `RawRun.tables`.

### Marshal — `lib/server/code-sandbox/marshal.ts`
- Extend `RawRun` with `tables: { columns: string[]; rows: string[][] }[]`.
- `toCodeRunResult` appends a `{ type: "table", columns, rows }`
  `CodeResult` per table, applying caps (below): drop excess columns/rows,
  truncate long cells, and push a note (into the result's notes/`stderr`
  surface used by PR-2, or a `text` cell) when anything was truncated.

### Caps — `lib/server/code-sandbox/config.ts`
Env-overridable: `TABLE_MAX_COLS` (50), `TABLE_MAX_ROWS` (1000),
`TABLE_CELL_MAX` (500 chars). Over-cap → truncate + note. Bounds a
runaway `df` from flooding the payload/UI.

### Render — `components/panels/code-result.tsx`
Add a `table` branch: a horizontally-scrollable `<table>` — header row
from `columns`, one row per `rows` entry; each cell truncated with a
`title` for the full value. Reuses the component's existing collapse +
styling. `text`/`stdout`/`stderr` rendering unchanged.

### Unchanged (explicit non-changes)
- `app/api/chat/route.ts` (`maybeEmitCodeResultFrames`) — `table` is a
  non-image cell and already flows through `emitter.codeResult`.
- `sse-emitter.ts` / `sse-frame-translator.ts` / `messages` slice /
  `lib/shared/types.ts` (`CodeResultCell` already has `table`) /
  `ChatRequestSchema` — no change.

## Error handling

- A malformed / non-conforming `*.table.json` is skipped (the run still
  returns stdout + any valid tables/charts). Never fatal.
- Caps truncate rather than drop the whole table, with a note so the
  model/user knows it was clipped.

## Testing

- **marshal (pure):** `RawRun.tables` → `table` cells; both JSON shapes
  normalized (`{columns,rows}` and pandas `{columns,data}`); cell
  stringification (numbers/booleans/null → strings); col/row/cell caps →
  truncate + note; empty tables array → no table cells.
- **render:** a `table` cell renders a grid with the right headers + row
  count (if the repo has component tests; otherwise covered by smoke).
- **manual smoke (needs the microsandbox runtime):** "compute a small
  summary and return it as a table" → a data-grid appears with the
  expected columns/rows; an oversized table is clipped with a note.

## Scope / out

- **Tables only.** JavaScript (language union + a node-capable microVM
  image + per-language exec) is a **separate later PR**, gated on a
  node-image validation spike.
- No grid sort / export / pagination; no editing; no mounting tables
  back to files. Charts continue via PR-1's image path.

## Risks

- **microsandbox `fs().list/read`** already used in PR-1 for charts — the
  table read-back reuses the exact same calls (low risk).
- **Pandas `orient="split"` shape** includes `index`; the normalizer must
  take `columns` + `data` and ignore `index`. Covered by a marshal test.
- **Cell stringification** of nested/objects — JSON-encode non-scalar
  cells so the grid never renders `[object Object]`. Covered by a test.

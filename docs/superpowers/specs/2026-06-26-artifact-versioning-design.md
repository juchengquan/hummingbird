# Artifact version history + diffs — design

**Date:** 2026-06-26
**Status:** Approved (brainstorming) — pending implementation plan

## Problem

Editing an artifact's content is **destructive**: `updateArtifactContent`
replaces `artifact.content` in place with no history. The only live edit
path today is citation-table cell edits (the Artifacts-tab table editor +
the editor-doc citation-table node both wire `CitationTableView.onChange →
updateArtifactContent`), but the gap is general — a bad edit can't be
undone or reviewed, and there's no record of what changed.

## Goal

Keep a capped history of an artifact's prior content, let the user view a
diff (prior version → current), and restore a prior version
non-destructively. Builds on the existing artifacts slice; no new route.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Where versions live | **Inline on the artifact**, `versions: ArtifactVersion[]`, capped |
| Retention cap | **Last 10** (`MAX_ARTIFACT_VERSIONS = 10`) |
| Diff scope (v1) | **Prior version → current** only (not arbitrary version-to-version) |
| Diff engine | **Pure LCS line-diff helper** (no new dependency) — see note |
| Restore | **Non-destructive** (capturing current as a new version) |

**Diff-engine note (changed from the approved sketch):** the approved
design said "use `diff-match-patch-ts`", but that package is only a
*transitive* entry in the lockfile (not a declared dependency), so
importing it directly is fragile. Instead, v1 uses a small pure
line-level LCS diff helper — zero new dependency, fully unit-testable,
and line-oriented (which is why json/table content is pretty-printed
before diffing). A word/char-level upgrade (adding `diff-match-patch-ts`
as a real dep) is a possible future refinement, out of scope here.

**No `STORE_VERSION` bump:** `versions` is an optional sub-field inside
the already-persisted `artifacts` key, so the frozen persisted key-set
(`store/persist.test.ts`) is unchanged and old data simply lacks the
field. Only a Supabase migration + sync wiring are needed.

## Data model

`lib/shared/types.ts`:

```ts
export interface ArtifactVersion {
  id: string
  content: string      // a PRIOR snapshot of artifact.content
  createdAt: Date
}

export interface Artifact {
  // …existing fields…
  /** Prior content snapshots, oldest→newest, capped at
   *  MAX_ARTIFACT_VERSIONS. `content` is always the current value;
   *  `versions` holds what it was before each edit. Undefined/absent =
   *  no history yet. */
  versions?: ArtifactVersion[]
}
```

`MAX_ARTIFACT_VERSIONS = 10` lives next to the slice (or a shared const).

### Migration + sync

- New `supabase/migrations/0029_artifact_versions.sql`: `alter table
  artifacts add column versions jsonb` (nullable, default NULL — mirrors
  `0010`/`0018` JSONB columns).
- Generated `Database` type (`lib/shared/supabase/types.ts`): `versions`
  on the `artifacts` table Row (`Json | null`) / Insert / Update
  (`?: Json | null`) — hand-added (no live DB regen), as done for
  `messages.generated_files`.
- `lib/client/sync/reconcile.ts`: parse `a.versions` defensively into
  `ArtifactVersion[]` (array guard + per-field `typeof`, `createdAt` →
  `new Date`); write `versions` in the artifact upsert row + the
  bulk-upload row (null when empty/absent).
- `lib/client/sync/handlers.ts`: `diffArtifacts` writes `versions`;
  **`artifactEquals` must compare `versions`** (length + per-entry id +
  content + instant) so a version change triggers a sync upsert.

## Capture (the single trigger point)

`updateArtifactContent(artifactId, content)` is the *only* content
mutator. Rewire it to snapshot before replacing:

- If `content === a.content` → no-op (no version captured).
- Else: push `{ id: uuid(), content: a.content /* OLD */, createdAt: now }`
  onto `a.versions`, cap to the last `MAX_ARTIFACT_VERSIONS` (drop
  oldest), then set `content` to the new value.

The list logic is a pure helper for testing:

```ts
export function pushArtifactVersion(
  versions: ArtifactVersion[] | undefined,
  priorContent: string,
  newVersion: ArtifactVersion,
  cap: number,
): ArtifactVersion[]
```

(Takes the pre-built `newVersion` so the impure `uuid()`/`Date` stay in
the slice; the helper is deterministic.)

## Diff engine (pure, `lib/shared/`)

```ts
export type DiffOp = "equal" | "insert" | "delete"
export interface DiffSegment { op: DiffOp; text: string }

/** Line-level LCS diff of two text blobs. For `json`/`table` kinds the
 *  caller pretty-prints both sides first so the diff is line-oriented. */
export function diffLines(oldText: string, newText: string): DiffSegment[]

/** Prepare an artifact's content for diffing: pretty-print json/table
 *  (JSON.parse → stringify(.,2); raw on parse error), else return as-is. */
export function prettyForDiff(content: string, kind: ArtifactKind): string
```

`diffLines` is a standard LCS over split lines, emitting `equal`/`delete`
(old-only)/`insert` (new-only) segments. Pure + deterministic →
thoroughly unit-tested. `prettyForDiff` is pure too.

## Store mutations (`artifacts` slice)

- `updateArtifactContent` — rewired to capture (above).
- `restoreArtifactVersion(artifactId: string, versionId: string): void` —
  find the version; route its content through `updateArtifactContent`
  (which captures the *current* as a new version before swapping). No-op
  if the artifact or version id is missing. Non-destructive.

## UI — in `components/panels/artifacts-tab.tsx` (ArtifactPreviewDialog)

- A **"History (N)"** control, shown only when `artifact.versions?.length
  > 0` **and** the kind is text-diffable (`code|markdown|json|table|other`,
  i.e. not `image`/`file`). `N` = version count.
- Opens a **version list** (newest first; "Current" pinned at top, then
  each prior version by relative `createdAt`). Selecting a prior version
  shows a **`DiffView`** of `prettyForDiff(version) → prettyForDiff(current)`
  via `diffLines`, plus a **Restore** button (calls
  `restoreArtifactVersion`).
- New `components/panels/artifact-diff-view.tsx` — renders `DiffSegment[]`
  as a line-diff (green insert / red delete / neutral equal). Small,
  presentational.

## Data flow

```
edit content
  └─ updateArtifactContent(id, new)
        └─ changed? → pushArtifactVersion(versions, OLD, {id,OLD,now}, 10)
              → set content=new   (persist + sync upsert incl. versions)

view history
  └─ History (N) button (text kind + versions>0)
        └─ version list → pick prior v
              → DiffView( diffLines(prettyForDiff(v), prettyForDiff(current)) )
              → Restore → restoreArtifactVersion(id, v.id)
                            → updateArtifactContent(id, v.content)  [captures current]
```

## Error handling / edges

- No-op edit (content unchanged) → no version (prevents spurious history).
- Cap enforced on every capture (oldest dropped) → bounded JSONB growth.
- `image`/`file` kinds never call `updateArtifactContent` with real
  content + the History control is hidden for them → no versions.
- Dangling restore id (version deleted by cap) → no-op.
- `prettyForDiff` parse failure → diff the raw content (never throws).
- Pre-existing artifacts have `versions` undefined → treated as `[]`; no
  backfill needed.

## Testing

- **`pushArtifactVersion`** — appends prior content, caps at 10 (drops
  oldest), ordering oldest→newest.
- **`diffLines`** — pure: identical → all `equal`; insertion; deletion;
  replacement; empty sides.
- **`prettyForDiff`** — json/table pretty-printed; non-json returned
  as-is; invalid json → raw (no throw).
- **`updateArtifactContent`** captures a version on change + no-ops on
  unchanged (live store).
- **`restoreArtifactVersion`** — restores content AND captures the
  prior-current as a new version (live store); no-op on bad id.
- **Sync** — `artifactEquals` treats a versions change as not-equal
  (triggers upsert); reconcile parses `versions` round-trip. (Unit where
  feasible.)
- **Migration** — round-trip on the `versions` column.
- **UI** (`DiffView`, history panel) — not render-tested (no
  `@testing-library`); covered by the pure helpers + a manual runbook
  step (`docs/SMOKE-TEST-artifact-versioning.md`).

## Out of scope (v1)

- Version labels/notes; branching versions; diffing two arbitrary
  versions (only prior → current); word/char-level diff (line-level only);
  an inline code/markdown editor (doesn't exist yet — versioning just
  future-proofs for it).

/**
 * Fails when two files under `supabase/migrations/` share a version
 * prefix (the digits before the first `_`).
 *
 * The Supabase CLI keys `supabase_migrations.schema_migrations` by that
 * prefix (primary key), so a duplicate aborts `supabase db reset` /
 * `supabase start` with a duplicate-key error and makes
 * `supabase migration up` treat the second file as already applied.
 * `0018_message_generated_files.sql` vs `0018_realtime_task_events.sql`
 * shipped exactly this way (fixed by renaming the former to `0033_…`);
 * this guard keeps it from recurring when two branches pick the same
 * next number.
 *
 * Also rejects `.sql` files that don't match `<digits>_<name>.sql`, which
 * the CLI silently skips.
 *
 * Usage: bun scripts/check-migration-versions.ts [migrations-dir]
 */
import { readdirSync } from "node:fs"
import path from "node:path"

const MIGRATION_RE = /^(\d+)_.+\.sql$/

export interface MigrationVersionProblems {
  /** version → the filenames sharing it (only versions with ≥ 2 files). */
  duplicates: Map<string, string[]>
  /** `.sql` files the CLI wouldn't recognise as migrations. */
  malformed: string[]
}

export function findMigrationVersionProblems(
  filenames: string[]
): MigrationVersionProblems {
  const byVersion = new Map<string, string[]>()
  const malformed: string[] = []
  for (const name of [...filenames].sort()) {
    if (!name.endsWith(".sql")) continue
    const m = MIGRATION_RE.exec(name)
    if (!m) {
      malformed.push(name)
      continue
    }
    const list = byVersion.get(m[1]) ?? []
    list.push(name)
    byVersion.set(m[1], list)
  }
  const duplicates = new Map(
    [...byVersion].filter(([, files]) => files.length > 1)
  )
  return { duplicates, malformed }
}

if (import.meta.main) {
  const dir = process.argv[2] ?? path.join(import.meta.dir, "..", "supabase", "migrations")
  const { duplicates, malformed } = findMigrationVersionProblems(readdirSync(dir))
  let failed = false
  for (const [version, files] of duplicates) {
    failed = true
    console.error(
      `ERROR: migration version ${version} is used by ${files.length} files: ${files.join(", ")}`
    )
  }
  for (const name of malformed) {
    failed = true
    console.error(`ERROR: ${name} does not match <digits>_<name>.sql`)
  }
  if (failed) {
    console.error(
      "Give each migration a unique numeric prefix (the Supabase CLI keys schema_migrations by it)."
    )
    process.exit(1)
  }
  console.log("migration versions OK")
}

import { readdirSync } from "node:fs"
import path from "node:path"

import { describe, expect, test } from "bun:test"

import { findMigrationVersionProblems } from "../check-migration-versions"

describe("findMigrationVersionProblems", () => {
  test("flags two files sharing a version prefix", () => {
    const { duplicates } = findMigrationVersionProblems([
      "0017_a.sql",
      "0018_b.sql",
      "0018_c.sql",
      "0019_d.sql",
    ])
    expect([...duplicates]).toEqual([["0018", ["0018_b.sql", "0018_c.sql"]]])
  })

  test("flags .sql files without a numeric prefix; ignores non-sql", () => {
    const { duplicates, malformed } = findMigrationVersionProblems([
      "0001_ok.sql",
      "seed.sql",
      "README.md",
    ])
    expect(duplicates.size).toBe(0)
    expect(malformed).toEqual(["seed.sql"])
  })

  test("the repo's migrations have unique versions", () => {
    const dir = path.join(import.meta.dir, "..", "..", "supabase", "migrations")
    const { duplicates, malformed } = findMigrationVersionProblems(readdirSync(dir))
    expect([...duplicates]).toEqual([])
    expect(malformed).toEqual([])
  })
})

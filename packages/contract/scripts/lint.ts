/**
 * Lint + validate packages/contract/openapi.yaml with Redocly's OpenAPI
 * core (the engine behind `redocly lint`), using ./redocly.yaml.
 *
 *   bun run contract:lint
 *
 * Exits 1 on any problem, warnings included — the spec stays clean, and a
 * deliberate exception goes in ../.redocly.lint-ignore.yaml with a reason. Uses `@redocly/openapi-core`
 * directly rather than `@redocly/cli`: same rules and resolver, without
 * the CLI's docs-preview dependencies (and it is already in the tree via
 * openapi-typescript).
 */
import { fileURLToPath } from "node:url"

import { formatProblems, getTotals, lint, loadConfig } from "@redocly/openapi-core"

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

const config = await loadConfig({ configPath: here("../redocly.yaml") })
const problems = await lint({ ref: here("../openapi.yaml"), config })
const totals = getTotals(problems)

formatProblems(problems, { format: "stylish", totals, version: "contract" })

if (totals.errors > 0 || totals.warnings > 0) process.exit(1)
console.log(
  `contract:lint — openapi.yaml valid (${totals.ignored} ignored by .redocly.lint-ignore.yaml).`,
)

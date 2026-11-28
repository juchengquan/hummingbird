/**
 * `bun run env:split` — one-off migration of a repo-root `.env` into the two
 * per-app files (wave 14, docs/PLAN-frontend-backend-split.md Q154–Q155):
 *
 *   root .env        web keys  → apps/web/.env
 *                    the rest  → services/agent-py/.env
 *   root .env.local  web keys  → apps/web/.env.local
 *                    the rest  → not written (agent-py never read .env.local)
 *
 * "Web keys" are the ones Next may read (`isAllowedEnvName`, Q143:
 * NEXT_PUBLIC_*, CSP_MODE, …), so each app reads exactly what it read
 * before. Lines are copied verbatim, in order (quotes, `export`, multi-line
 * values); comments are not carried over. It refuses if any file it would
 * write exists, writes them 0600, and never prints a value — only key names.
 * The root files are left in place: both apps refuse to start while one
 * exists, so you check the new files and then remove them.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { isAllowedEnvName } from "../apps/web/scripts/check-next-env"

export const WEB_ENV = "apps/web/.env"
export const WEB_ENV_LOCAL = "apps/web/.env.local"
export const AGENT_ENV = "services/agent-py/.env"

export type EnvEntry = { key: string; lines: string[] }

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

/** The `KEY=value` entries of a dotenv file, each with its raw lines (a
 *  quoted value may span several). Comments and blank lines are dropped. */
export function parseEnvEntries(text: string): EnvEntry[] {
  const lines = text.split(/\r?\n/)
  const entries: EnvEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ASSIGNMENT)
    if (!m) continue
    const entry: EnvEntry = { key: m[1], lines: [lines[i]] }
    const value = m[2].trimStart()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && !closesOnLine(value.slice(1), quote)) {
      while (i + 1 < lines.length) {
        entry.lines.push(lines[++i])
        if (closesOnLine(lines[i], quote)) break
      }
    }
    entries.push(entry)
  }
  return entries
}

function closesOnLine(rest: string, quote: string): boolean {
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "\\") i++
    else if (rest[i] === quote) return true
  }
  return false
}

export type Split = { web: EnvEntry[]; agent: EnvEntry[] }

export function splitEntries(entries: EnvEntry[]): Split {
  return {
    web: entries.filter((e) => isAllowedEnvName(e.key)),
    agent: entries.filter((e) => !isAllowedEnvName(e.key)),
  }
}

export type SplitReport = {
  /** Repo-relative path → the key names written to it. */
  written: Record<string, string[]>
  /** Keys in the root .env.local nobody reads any more. */
  skipped: string[]
}

export class EnvSplitError extends Error {}

function render(source: string, entries: EnvEntry[]): string {
  return [`# Written by \`bun run env:split\` from the repo-root ${source} (wave 14).`, ...entries.flatMap((e) => e.lines), ""].join("\n")
}

/** Plan and write the split under `root`. Throws `EnvSplitError` before
 *  writing anything if there is nothing to split or a target exists. */
export function runEnvSplit(root: string): SplitReport {
  const rootEnv = join(root, ".env")
  const rootEnvLocal = join(root, ".env.local")
  if (!existsSync(rootEnv) && !existsSync(rootEnvLocal)) {
    throw new EnvSplitError("No .env or .env.local at the repo root — nothing to split.")
  }

  const outputs: { path: string; source: string; entries: EnvEntry[] }[] = []
  const skipped: string[] = []
  if (existsSync(rootEnv)) {
    const { web, agent } = splitEntries(parseEnvEntries(readFileSync(rootEnv, "utf8")))
    if (web.length) outputs.push({ path: WEB_ENV, source: ".env", entries: web })
    if (agent.length) outputs.push({ path: AGENT_ENV, source: ".env", entries: agent })
  }
  if (existsSync(rootEnvLocal)) {
    const { web, agent } = splitEntries(parseEnvEntries(readFileSync(rootEnvLocal, "utf8")))
    if (web.length) outputs.push({ path: WEB_ENV_LOCAL, source: ".env.local", entries: web })
    skipped.push(...agent.map((e) => e.key))
  }

  const existing = outputs.map((o) => o.path).filter((p) => existsSync(join(root, p)))
  if (existing.length) {
    throw new EnvSplitError(
      `Refusing to overwrite ${existing.join(", ")} — move ${existing.length > 1 ? "them" : "it"} aside first. Nothing was written.`
    )
  }

  const written: Record<string, string[]> = {}
  for (const o of outputs) {
    const abs = join(root, o.path)
    writeFileSync(abs, render(o.source, o.entries), { mode: 0o600 })
    chmodSync(abs, 0o600)
    written[o.path] = o.entries.map((e) => e.key)
  }
  return { written, skipped }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..")
  try {
    const { written, skipped } = runEnvSplit(root)
    for (const [path, keys] of Object.entries(written)) {
      console.log(`wrote ${path} (${keys.length} keys): ${keys.join(", ")}`)
    }
    if (skipped.length) {
      console.log(`not carried over from .env.local (read by neither app): ${skipped.join(", ")}`)
    }
    const left = [".env", ".env.local"].filter((n) => existsSync(join(root, n)))
    console.log(
      `\nCheck the new files, then remove the root ${left.join(" and ")} — both apps refuse to start while ${left.length > 1 ? "they exist" : "it exists"} (${relative(process.cwd(), root) || "."}).`
    )
  } catch (error) {
    if (error instanceof EnvSplitError) {
      console.error(error.message)
      process.exit(1)
    }
    throw error
  }
}

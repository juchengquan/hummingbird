/**
 * The repo-root `.env` / `.env.local` from before the split (wave 14,
 * docs/PLAN-frontend-backend-split.md Q154–Q155). Next reads only
 * apps/web's own env files, so a root one would be silently ignored;
 * `next.config.ts` refuses to start while one exists instead.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"

export const ROOT_ENV_NAMES: readonly string[] = [".env", ".env.local"]

/** The first root env file that exists, or null. */
export function staleRootEnv(repoRoot: string): string | null {
  for (const name of ROOT_ENV_NAMES) {
    const file = join(repoRoot, name)
    if (existsSync(file)) return file
  }
  return null
}

export function refuseStaleRootEnv(repoRoot: string): void {
  const stale = staleRootEnv(repoRoot)
  if (stale) {
    throw new Error(
      `${stale} is no longer read: settings live in apps/web/.env and services/agent-py/.env ` +
        "(wave 14). Run `bun run env:split` to write both from it, check them, then remove the root file."
    )
  }
}

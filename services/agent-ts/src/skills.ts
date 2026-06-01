/**
 * Tool-registry wiring — bridge between `lib/server/skills/registry.ts`
 * (the existing TS server-side skill registry) and agent-ts's chat
 * route.
 *
 * Mirrors agent-py's `default_tool_registry(context)` (Phase 4-3 of
 * PLAN-agent-api). Walks the registry, calls each skill's
 * `buildTool` with a per-request `SkillRuntimeContext`, and collects
 * the non-null results into the `StreamTextTools` shape `streamText({ tools })`
 * wants.
 *
 * Notes on which skills work end-to-end:
 *   - `webFetch` — works (no per-request context).
 *   - `webSearch` — works when at least one provider key (TAVILY,
 *     BRAVE, or EXA) is set in env.
 *   - `imageGen` — works when MINIMAX_CN_API_KEY is set; persistence
 *     via `image-persistence.ts`.
 *   - `searchFiles` — works when the user is signed in AND the
 *     `postgres` pool is open. The cookie-based skill returned by
 *     `SERVER_SKILLS` always returns `not_signed_in` inside agent-ts
 *     (no cookies); we override it with `buildSearchFilesTool` from
 *     `./search-files`, which talks to Postgres directly under
 *     per-user RLS impersonation. Mirrors agent-py's wiring.
 */

import type { streamText } from "ai"

import { SERVER_SKILLS } from "@/server/skills/registry"
import type {
  ServerSkill,
  SkillRequestEntry,
  SkillRuntimeContext,
} from "@/server/skills/registry"

import { type Sql } from "./db"
import { buildSearchFilesTool } from "./search-files"

export type SkillEntry = SkillRequestEntry

/** Type alias for the `tools` field on `streamText`'s args — the
 *  full `StreamTextTools` declaration in `ai` is a deep generic that blows
 *  up `tsc`'s instantiation depth budget when we try to construct
 *  it from a `Record<string, Tool>` literal. Same indirection
 *  `app/api/chat/route.ts` uses for the same reason. */
type StreamTextTools = NonNullable<Parameters<typeof streamText>[0]["tools"]>

export interface BuildToolsOptions {
  /** Per-skill request entries from the chat body — provider toggles,
   *  per-skill caps, etc. Skills that aren't in this list fall back to
   *  their built-in defaults. */
  skills?: SkillEntry[]
  /** Upstream abort signal (typically `c.req.raw.signal`) so in-flight
   *  outbound fetches cancel when the client disconnects. */
  signal?: AbortSignal
  /** Optional registry override for tests — defaults to the live
   *  `SERVER_SKILLS` array. */
  registry?: ServerSkill[]
  /** Verified JWT sub claim. Required for `searchFiles` (RLS uses
   *  it for `auth.uid()`) and forward-compat with other per-user
   *  tools. Empty / missing → searchFiles surfaces `not_signed_in`. */
  userId?: string
  /** Postgres pool from `db.ts`. When omitted (dev) the
   *  agent-ts-specific `searchFiles` falls back to an upstream-
   *  error response without crashing. */
  sql?: Sql | null
}

/** Walk the skill registry and build an AI SDK `StreamTextTools` for this
 *  request. Skills that aren't configured (e.g. `imageGen` without
 *  `MINIMAX_CN_API_KEY`) are skipped — their `buildTool` returns
 *  null. The keys of the returned set match each skill's `toolName`
 *  so the model sees `webFetch`, `generateImage`, etc.
 *
 *  Special case: `searchFiles` is overridden with the agent-ts
 *  Postgres-driver implementation (`./search-files`). The shared
 *  registry's `searchFilesSkill` resolves Supabase via cookies,
 *  which we don't have — its tool would always return
 *  `not_signed_in`. We swap in a working version. */
export function buildToolSet(opts: BuildToolsOptions = {}): StreamTextTools {
  const registry = opts.registry ?? SERVER_SKILLS
  const entryById = new Map<string, SkillEntry>()
  for (const e of opts.skills ?? []) {
    if (e && typeof e.id === "string") entryById.set(e.id, e)
  }

  const ctx: SkillRuntimeContext = {
    signal: opts.signal,
    // Budget enforcement lives in the Next.js inline path
    // (`consumeBudget`); agent-ts is per-process and doesn't share
    // that bucket. Omitted here — every tool runs without a soft cap
    // from this side. Per-tool hard caps still apply (the `cap`
    // field inside each skill's `buildTool`).
  }

  const tools: Record<string, unknown> = {}
  for (const skill of registry) {
    if (skill.id === "searchFiles") {
      // Override with the postgres-driver version. The cookie path
      // would never produce a working tool inside agent-ts.
      tools[skill.toolName] = buildSearchFilesTool({
        userId: opts.userId ?? "",
        sql: opts.sql ?? null,
      })
      continue
    }
    const tool = skill.buildTool(entryById.get(skill.id), ctx)
    if (tool) tools[skill.toolName] = tool
  }
  // Same indirection `app/api/chat/route.ts` uses — a direct cast
  // from a typed record to the deep generic `StreamTextTools` blows
  // up tsc's instantiation depth, so we cast via `unknown`.
  return tools as unknown as StreamTextTools
}

/** Build the system-prompt fragment for the enabled skills. Mirrors
 *  the Next.js route's `buildSkillNotes` — each skill contributes a
 *  one-paragraph capability blurb, joined with a leading bullet. */
export function buildSkillNotes(opts: BuildToolsOptions = {}): string | null {
  const registry = opts.registry ?? SERVER_SKILLS
  const entryById = new Map<string, SkillEntry>()
  for (const e of opts.skills ?? []) {
    if (e && typeof e.id === "string") entryById.set(e.id, e)
  }
  const notes: string[] = []
  for (const skill of registry) {
    const fragment = skill.promptFragment(entryById.get(skill.id))
    if (fragment) notes.push(fragment)
  }
  if (notes.length === 0) return null
  return `Available capabilities:\n${notes.map((n) => `- ${n}`).join("\n")}`
}

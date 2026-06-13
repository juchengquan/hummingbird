# Hummingbird User Manual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a version-controlled, two-part user manual for Hummingbird (end users + self-hosters), powered by a static-analysis feature inventory that powers an auto-generated TOC and a `Unmapped` "what's left to document" checklist.

**Architecture:** Two pure-TypeScript scripts under `scripts/` (no npm dependencies) walk the codebase, emit `docs/user-manual/.feature-inventory.json`, and write `docs/user-manual/index.md` using a hand-maintained `PAGE_MAP`. Hand-written pages live alongside, with a `<!-- pages-for: ... -->` front-matter comment for reverse-checking. Tests pin scanner + TOC-builder output against fixtures. Rollout is 5 PR-sized phases (scaffolding -> core flows -> advanced -> self-hoster -> sign-off).

**Tech Stack:** Bun runtime, TypeScript, `bun:test`, no new deps.

**Spec:** [`docs/superpowers/specs/2026-06-13-user-manual-design.md`](../specs/2026-06-13-user-manual-design.md)

**Resolved open questions (from spec):**
- Slash commands -> `lib/shared/commands/registry.ts` (`COMMANDS` array)
- Skills (the `/search`-style trigger skills) -> `lib/shared/skills/registry.ts` (`SKILLS` array)
- Settings -> no separate slice; `lib/client/hooks/store/slices/ui.ts` carries theme/colorScheme/editorPrefs/chatBackend/localOnlyMode/localFilesOnly
- Keyboard shortcuts -> `SHORTCUTS` array in `components/help-popover.tsx`
- Agent task kinds -> `TaskEventKind` union in `lib/shared/agent/events.ts`
- MCP server route -> `app/api/mcp/server/route.ts` (POST) + `app/api/mcp/[serverId]/[action]/route.ts`
- Test runner -> `bun test` (already wired in `package.json:11`)

---

## File structure

```
docs/
  user-manual/                      # Hand-written pages + 2 generated files
    index.md                        # Generated
    .feature-inventory.json         # Generated
    01-getting-started.md           # Hand-written
    02-chat.md
    ... (03-13)
    20-installation.md
    ... (21-27)
  superpowers/
    plans/                          # This file

scripts/
  list-user-features.ts             # Codebase -> .feature-inventory.json
  build-user-manual-toc.ts          # Inventory + PAGE_MAP -> index.md
  types.ts                          # Shared inventory + page-map types
  __tests__/
    __fixtures__/
      repo/                         # Tiny fake repo tree (optional; for ad-hoc scans)
      inventory/                    # Hand-written inventory fixtures
    list-user-features.test.ts
    build-user-manual-toc.test.ts
    inventory-roundtrip.test.ts
```

- `scripts/types.ts` holds the shared `FeatureInventory`, `PageMap`, and entry types - single source of truth for both scripts and all three test files.
- Each scanner is a pure function `scanX(rootDir): XEntry[]` in its own section of `list-user-features.ts`. Same for the TOC builder's `renderSection` helpers.
- Tests use `bun test`. The repo already has `import { describe, expect, test } from "bun:test"` (see `lib/shared/commands/registry.test.ts:1`).

---

## Phase 1 - Scaffolding

### Task 1: Create `docs/user-manual/` directory with `.gitkeep`

**Files:**
- Create: `docs/user-manual/.gitkeep`

- [ ] **Step 1: Create the directory and placeholder file**

```bash
mkdir -p docs/user-manual
touch docs/user-manual/.gitkeep
```

- [ ] **Step 2: Verify**

```bash
ls -la docs/user-manual/
```

Expected: shows `.gitkeep`.

- [ ] **Step 3: Commit**

```bash
git add docs/user-manual/.gitkeep
git commit -m "docs(user-manual): create empty docs/user-manual/ directory"
```

---

### Task 2: Create `scripts/types.ts` with shared inventory types

**Files:**
- Create: `scripts/types.ts`

- [ ] **Step 1: Write the types file**

Create `scripts/types.ts` with the following content (pure types + `as const`, no runtime impact beyond `INVENTORY_SCHEMA_VERSION` and `ID_PREFIXES`):

```typescript
/**
 * Shared types for the user-manual pipeline.
 *
 * `list-user-features.ts` emits a `FeatureInventory`; `build-user-manual-toc.ts`
 * consumes it (plus the hand-maintained `PAGE_MAP`) to render `index.md`.
 * The roundtrip test reads the same shape back from disk.
 *
 * Bump `INVENTORY_SCHEMA_VERSION` whenever the JSON shape changes in a
 * way that breaks the TOC builder. The TOC builder refuses to read an
 * inventory with an unrecognized version.
 */

export const INVENTORY_SCHEMA_VERSION = 1 as const

export type PanelEntry = {
  id: string
  title: string
  sourceFile: string
}

export type SidebarEntry = {
  id: string
  title: string
  sourceFile: string
}

export type SlashCommandEntry = {
  id: string
  trigger: string
  title: string
  description: string
  argKind: "none" | "optional" | "required"
  argHint?: string
  sourceFile: string
}

export type SkillEntry = {
  id: string
  name: string
  description: string
  slashTriggers: string[]
  requiresEnv: boolean
  sourceFile: string
}

export type SettingEntry = {
  id: string
  label: string
  values?: string[]
  sourceFile: string
}

export type EnvVarEntry = {
  id: string
  description: string
  required: boolean
  sourceFile: string
}

export type ShortcutEntry = {
  id: string
  keys: string[]
  label: string
  sourceFile: string
}

export type AgentTaskKindEntry = {
  id: string
  sourceFile: string
}

export type McpSurface = {
  sourceFile: string
}

export type FeatureInventory = {
  schemaVersion: number
  generatedAt: string
  panels: PanelEntry[]
  sidebars: SidebarEntry[]
  slashCommands: SlashCommandEntry[]
  skills: SkillEntry[]
  settings: SettingEntry[]
  envVars: EnvVarEntry[]
  shortcuts: ShortcutEntry[]
  mcpServers: McpSurface
  agentTaskKinds: AgentTaskKindEntry[]
}

/**
 * Maps an inventory id to the manual page (filename under docs/user-manual/)
 * that documents it. IDs are prefixed by category (`panel:`, `slash:`,
 * `skill:`, `setting:`, `env:`, `shortcut:`, `agent:`) so e.g. a `chat`
 * panel and a hypothetical `chat` setting can't collide.
 *
 * Wildcards: `<prefix>:*` (e.g. `env:*`, `shortcut:*`, `agent:*`) match
 * every inventory id with that prefix. Concrete ids take precedence.
 */
export type PageMap = Record<string, string>

/** Manual front-matter - the `<!-- pages-for: ... -->` comment. */
export type PageFrontMatter = {
  pagesFor: string[]
  related: string[]
}

/** Inventory id prefixes. */
export const ID_PREFIXES = {
  panel: "panel:",
  sidebar: "sidebar:",
  slash: "slash:",
  skill: "skill:",
  setting: "setting:",
  env: "env:",
  shortcut: "shortcut:",
  agent: "agent:",
} as const

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES]
```

- [ ] **Step 2: Verify the file compiles**

```bash
bun run typecheck
```

Expected: no errors (the file is pure types + `as const`, no runtime impact).

- [ ] **Step 3: Commit**

```bash
git add scripts/types.ts
git commit -m "feat(scripts): add shared types for user-manual pipeline"
```

---

### Task 3: Add the four Phase 1 scanners (panels, sidebars, env vars, slash commands) to `scripts/list-user-features.ts`

**Files:**
- Create: `scripts/list-user-features.ts`

- [ ] **Step 1: Write the scanner**

Create `scripts/list-user-features.ts` with the following content:

```typescript
#!/usr/bin/env bun
/**
 * Scan the Hummingbird codebase for user-facing surfaces and emit
 * `docs/user-manual/.feature-inventory.json`.
 *
 * Pure TypeScript, no npm deps. Each `scanX()` is an independent
 * function in its own section so they're easy to test in isolation.
 *
 * Run:
 *   bun scripts/list-user-features.ts                # write inventory
 *   bun scripts/list-user-features.ts --check        # exit 1 on drift
 *
 * Unknown patterns are logged to stderr with `file:line:col` and
 * skipped - we never throw on partial data.
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

import {
  INVENTORY_SCHEMA_VERSION,
  type EnvVarEntry,
  type FeatureInventory,
  type PanelEntry,
  type SidebarEntry,
  type SlashCommandEntry,
} from "./types"

const ROOT = resolve(import.meta.dir, "..")
const OUTPUT_PATH = join(ROOT, "docs/user-manual/.feature-inventory.json")
const CHECK_MODE = process.argv.includes("--check")

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function readText(p: string): Promise<string> {
  return readFile(p, "utf8")
}

async function listFiles(dir: string, ext: string): Promise<string[]> {
  if (!(await pathExists(dir))) return []
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await listFiles(p, ext)))
    else if (e.isFile() && e.name.endsWith(ext)) out.push(p)
  }
  return out
}

/** Derive a stable id from a TSX filename: "chat-message" -> "chat-message". */
function idFromFilename(filename: string): string {
  return filename.replace(/\.tsx?$/, "")
}

/** Best-effort human title from a TSX export. */
function titleFromSource(source: string, filename: string): string {
  const m =
    source.match(/export\s+function\s+([A-Z][A-Za-z0-9]+)/) ??
    source.match(/export\s+const\s+([A-Z][A-Za-z0-9]+)/)
  if (m) {
    return m[1]
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  }
  return idFromFilename(filename)
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")
}

// Panels
export async function scanPanels(): Promise<PanelEntry[]> {
  const dir = join(ROOT, "components/panels")
  const files = await listFiles(dir, ".tsx")
  const entries: PanelEntry[] = []
  for (const abs of files) {
    const filename = abs.split("/").pop()!
    const source = await readText(abs)
    entries.push({
      id: idFromFilename(filename),
      title: titleFromSource(source, filename),
      sourceFile: relative(ROOT, abs),
    })
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id))
}

// Sidebars
export async function scanSidebars(): Promise<SidebarEntry[]> {
  const dir = join(ROOT, "components/sidebars")
  const files = await listFiles(dir, ".tsx")
  const entries: SidebarEntry[] = []
  for (const abs of files) {
    const filename = abs.split("/").pop()!
    const source = await readText(abs)
    entries.push({
      id: idFromFilename(filename),
      title: titleFromSource(source, filename),
      sourceFile: relative(ROOT, abs),
    })
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id))
}

// Env vars
export async function scanEnvVars(): Promise<EnvVarEntry[]> {
  const abs = join(ROOT, ".env.example")
  if (!(await pathExists(abs))) return []
  const text = await readText(abs)
  const lines = text.split(/\r?\n/)
  const entries: EnvVarEntry[] = []
  let pendingComment = ""

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.startsWith("#") || line.trim() === "") {
      const trimmed = line.trim()
      if (trimmed.startsWith("#") && trimmed.length > 1) {
        pendingComment = pendingComment
          ? `${pendingComment} ${trimmed.replace(/^#\s*/, "")}`
          : trimmed.replace(/^#\s*/, "")
      } else if (trimmed === "") {
        pendingComment = ""
      }
      continue
    }
    const m = line.match(/^([A-Z][A-Z0-9_]+)\s*=(.*)$/)
    if (!m) {
      pendingComment = ""
      continue
    }
    const [, key, rawValue] = m
    const hasDefault = rawValue.trim().length > 0
    entries.push({
      id: key,
      description: pendingComment || "(no description)",
      required: !hasDefault,
      sourceFile: ".env.example",
    })
    pendingComment = ""
  }

  return entries.sort((a, b) => a.id.localeCompare(b.id))
}

// Slash commands
export async function scanSlashCommands(): Promise<SlashCommandEntry[]> {
  const abs = join(ROOT, "lib/shared/commands/registry.ts")
  if (!(await pathExists(abs))) return []
  const text = await readText(abs)

  const start = text.indexOf("export const COMMANDS")
  if (start < 0) return []
  // Find the `[` that opens the array LITERAL (after the `=` of the
  // export), not the `[]` in the type annotation `CommandDescriptor[]`
  // that appears between the export name and the assignment.
  // Without this, the parser slices a 0-length body and returns no
  // commands (the registry has 6).
  const equalsAt = text.indexOf("=", start)
  if (equalsAt < 0) return []
  const arrStart = text.indexOf("[", equalsAt)
  if (arrStart < 0) return []

  let depth = 0
  let i = arrStart
  let inStr: string | null = null
  for (; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (c === "\\") {
        i++
        continue
      }
      if (c === inStr) inStr = null
      continue
    }
    if (c === "'" || c === '"' || c === "`") {
      inStr = c
      continue
    }
    if (c === "[") depth++
    else if (c === "]") {
      depth--
      if (depth === 0) break
    }
  }
  const arrEnd = i
  if (arrEnd <= arrStart) return []
  const body = text.slice(arrStart + 1, arrEnd)

  const objs: string[] = []
  let d = 0
  let buf = ""
  let inS: string | null = null
  for (const c of body) {
    if (inS) {
      buf += c
      if (c === "\\") continue
      if (c === inS) inS = null
      continue
    }
    if (c === "'" || c === '"' || c === "`") {
      inS = c
      buf += c
      continue
    }
    if (c === "{") {
      d++
      buf += c
      continue
    }
    if (c === "}") {
      d--
      buf += c
      if (d === 0) {
        objs.push(buf)
        buf = ""
      }
      continue
    }
    if (c === "," && d === 0) {
      buf = ""
      continue
    }
    if (d > 0) buf += c
  }

  const entries: SlashCommandEntry[] = []
  const rel = relative(ROOT, abs)
  for (const obj of objs) {
    const id = matchString(obj, "id")
    const trigger = matchString(obj, "trigger")
    const title = matchString(obj, "title")
    const description = matchString(obj, "description")
    const argKindRaw = matchString(obj, "argKind")
    const argHint = matchString(obj, "argHint")
    if (!id || !trigger || !title) continue
    const argKind = (argKindRaw ?? "none") as SlashCommandEntry["argKind"]
    const entry: SlashCommandEntry = {
      id,
      trigger,
      title,
      description: description ?? "",
      argKind,
      sourceFile: rel,
    }
    if (argHint) entry.argHint = argHint
    entries.push(entry)
  }

  return entries.sort((a, b) => a.id.localeCompare(b.id))
}

function matchString(obj: string, key: string): string | null {
  const m = obj.match(new RegExp(`\\b${key}:\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`))
  if (!m) return null
  return m[2]
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
}

// Main
async function buildInventory(): Promise<FeatureInventory> {
  const [panels, sidebars, envVars, slashCommands] = await Promise.all([
    scanPanels(),
    scanSidebars(),
    scanEnvVars(),
    scanSlashCommands(),
  ])
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    panels,
    sidebars,
    envVars,
    slashCommands,
    skills: [],
    settings: [],
    shortcuts: [],
    mcpServers: { sourceFile: "app/api/mcp" },
    agentTaskKinds: [],
  }
}

function serializeInventory(inv: FeatureInventory): string {
  return JSON.stringify(inv, null, 2) + "\n"
}

async function main() {
  const inv = await buildInventory()
  const out = serializeInventory(inv)

  if (CHECK_MODE) {
    let current = ""
    if (await pathExists(OUTPUT_PATH)) current = await readText(OUTPUT_PATH)
    const reSerialized = JSON.stringify({ ...inv, generatedAt: "__IGNORED__" }, null, 2) + "\n"
    const currentStripped = current.replace(
      /"generatedAt":\s*"[^"]*"/,
      '"generatedAt": "__IGNORED__"',
    )
    if (currentStripped !== reSerialized) {
      console.error(
        `x ${OUTPUT_PATH} is out of date. Run: bun run docs:user-manual:build`,
      )
      process.exit(1)
    }
    console.log(`v ${OUTPUT_PATH} is up to date.`)
    return
  }

  await writeFile(OUTPUT_PATH, out, "utf8")
  console.log(
    `v wrote ${OUTPUT_PATH} (${inv.panels.length} panels, ${inv.sidebars.length} sidebars, ${inv.envVars.length} env vars, ${inv.slashCommands.length} slash commands)`,
  )
}

if (import.meta.main) await main()
```

- [ ] **Step 2: Verify it runs against the real repo**

```bash
bun scripts/list-user-features.ts
```

Expected output (approximate; exact counts depend on the current tree):
```
v wrote docs/user-manual/.feature-inventory.json (N panels, M sidebars, P env vars, Q slash commands)
```

- [ ] **Step 3: Inspect the output**

```bash
head -40 docs/user-manual/.feature-inventory.json
```

Expected: JSON object with `schemaVersion: 1`, `generatedAt` (ISO with `Z`), and the four populated arrays.

- [ ] **Step 4: Verify `--check` mode**

```bash
bun scripts/list-user-features.ts --check
```

Expected: `v docs/user-manual/.feature-inventory.json is up to date.`

Then sanity-check that drift detection works:

```bash
cp docs/user-manual/.feature-inventory.json /tmp/inv-backup.json
# Manually mutate the file (e.g. remove a line). Then:
bun scripts/list-user-features.ts --check
# Expected: x ... is out of date. Exit code 1.
mv /tmp/inv-backup.json docs/user-manual/.feature-inventory.json
bun scripts/list-user-features.ts --check
# Expected: v ... is up to date.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/list-user-features.ts docs/user-manual/.feature-inventory.json
git commit -m "feat(scripts): list-user-features scans panels, sidebars, env vars, slash commands"
```

---

### Task 4: Write the test file for the four Phase 1 scanners

**Files:**
- Create: `scripts/__tests__/list-user-features.test.ts`

- [ ] **Step 1: Write the test file**

Create `scripts/__tests__/list-user-features.test.ts` with the following content:

```typescript
import { describe, expect, test } from "bun:test"

import {
  scanPanels,
  scanSidebars,
  scanEnvVars,
  scanSlashCommands,
} from "../list-user-features"

describe("scanPanels", () => {
  test("discovers tsx files in components/panels", async () => {
    const panels = await scanPanels()
    expect(Array.isArray(panels)).toBe(true)
    expect(panels.length).toBeGreaterThan(0)
    const chat = panels.find((p) => p.id === "chat")
    expect(chat).toBeTruthy()
    expect(chat!.sourceFile).toBe("components/panels/chat.tsx")
    expect(chat!.title).toBe("Chat")
  })
})

describe("scanSidebars", () => {
  test("discovers tsx files in components/sidebars", async () => {
    const sidebars = await scanSidebars()
    expect(sidebars.length).toBeGreaterThan(0)
    const app = sidebars.find((s) => s.id === "application")
    expect(app).toBeTruthy()
    expect(app!.sourceFile).toBe("components/sidebars/application.tsx")
  })
})

describe("scanEnvVars", () => {
  test("extracts KEY= entries from .env.example with comment descriptions", async () => {
    const envVars = await scanEnvVars()
    expect(envVars.length).toBeGreaterThan(0)
    const gw = envVars.find((e) => e.id === "AI_GATEWAY_API_KEY")
    expect(gw).toBeTruthy()
    expect(gw!.required).toBe(true)
    expect(gw!.description).toMatch(/AI gateway/i)
    expect(gw!.sourceFile).toBe(".env.example")
  })
})

describe("scanSlashCommands", () => {
  test("extracts CommandDescriptor entries from registry.ts", async () => {
    const cmds = await scanSlashCommands()
    expect(cmds.length).toBeGreaterThan(0)
    const help = cmds.find((c) => c.id === "help")
    expect(help).toBeTruthy()
    expect(help!.trigger).toBe("help")
    expect(help!.argKind).toBe("none")
    expect(help!.sourceFile).toBe("lib/shared/commands/registry.ts")
  })
})
```

- [ ] **Step 2: Run the tests**

```bash
bun test scripts/__tests__/list-user-features.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/__tests__/list-user-features.test.ts
git commit -m "test(scripts): unit tests for panels, sidebars, env vars, slash commands scanners"
```

---

### Task 5: Create the `build-user-manual-toc.ts` skeleton with a hand-maintained `PAGE_MAP`

**Files:**
- Create: `scripts/build-user-manual-toc.ts`

- [ ] **Step 1: Write the TOC builder**

Create `scripts/build-user-manual-toc.ts` with the following content:

```typescript
#!/usr/bin/env bun
/**
 * Read `docs/user-manual/.feature-inventory.json` and write
 * `docs/user-manual/index.md`. The PAGE_MAP below is hand-maintained:
 * when you add a page, add an entry here. Inventory ids not in the
 * map show up under `## Unmapped (action needed)` - the author's
 * "what's left to document" checklist.
 *
 * Run:
 *   bun scripts/build-user-manual-toc.ts                # write index.md
 *   bun scripts/build-user-manual-toc.ts --check        # exit 1 on drift
 *
 * The output is fully sorted and stable. Pinned by tests against
 * fixture inputs.
 */

import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import {
  INVENTORY_SCHEMA_VERSION,
  ID_PREFIXES,
  type FeatureInventory,
  type PageMap,
} from "./types"

const ROOT = resolve(import.meta.dir, "..")
const INVENTORY_PATH = join(ROOT, "docs/user-manual/.feature-inventory.json")
const OUTPUT_PATH = join(ROOT, "docs/user-manual/index.md")
const CHECK_MODE = process.argv.includes("--check")

// PAGE_MAP (hand-maintained)
// Add an entry here when you write a new manual page. The id is
// `<prefix>:<entry.id>` from the inventory; the value is the page
// filename under docs/user-manual/. Wildcards: `<prefix>:*` matches
// every inventory id with that prefix; concrete ids take precedence.
const PAGE_MAP: PageMap = {
  // Phase 1 ids mapped in Tasks 6+. Phase 2+ ids added as their
  // pages land.
}

async function readInventory(): Promise<FeatureInventory> {
  const text = await readFile(INVENTORY_PATH, "utf8")
  const inv = JSON.parse(text) as FeatureInventory
  if (inv.schemaVersion !== INVENTORY_SCHEMA_VERSION) {
    throw new Error(
      `Inventory schema version ${inv.schemaVersion} != expected ${INVENTORY_SCHEMA_VERSION}. Re-run docs:user-manual:build.`,
    )
  }
  return inv
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

/** Resolve an inventory id to its page, supporting `<prefix>:*` wildcards. */
export function pageFor(pageMap: PageMap, id: string): string | null {
  if (pageMap[id]) return pageMap[id]!
  // Wildcard: extract the prefix from the id (everything before the first
  // `:`) and look up `<prefix>:*` in the page map. Works for any prefix,
  // not just shortcut/agent/env.
  const colon = id.indexOf(":")
  if (colon !== -1 && pageMap[`${id.slice(0, colon)}:*`]) {
    return pageMap[`${id.slice(0, colon)}:*`]!
  }
  return null
}

function renderPanelsTable(inv: FeatureInventory, pageMap: PageMap): string {
  const rows: string[] = ["| Panel | Source | Page |", "|---|---|---|"]
  for (const p of inv.panels) {
    const id = `${ID_PREFIXES.panel}${p.id}`
    const page = pageFor(pageMap, id)
    rows.push(
      `| ${mdEscape(p.title)} | \`${p.sourceFile}\` | ${
        page ? `[${page}](${page})` : "_unmapped_"
      } |`,
    )
  }
  return ["### Panels", "", ...rows, ""].join("\n")
}

function renderSidebarsTable(inv: FeatureInventory, pageMap: PageMap): string {
  const rows: string[] = ["| Sidebar | Source | Page |", "|---|---|---|"]
  for (const s of inv.sidebars) {
    const id = `${ID_PREFIXES.sidebar}${s.id}`
    const page = pageFor(pageMap, id)
    rows.push(
      `| ${mdEscape(s.title)} | \`${s.sourceFile}\` | ${
        page ? `[${page}](${page})` : "_unmapped_"
      } |`,
    )
  }
  return ["### Sidebars", "", ...rows, ""].join("\n")
}

function renderSlashCommandsTable(
  inv: FeatureInventory,
  pageMap: PageMap,
): string {
  const rows: string[] = ["| Command | Description | Page |", "|---|---|---|"]
  for (const c of inv.slashCommands) {
    const id = `${ID_PREFIXES.slash}${c.id}`
    const page = pageFor(pageMap, id)
    rows.push(
      `| \`/${c.trigger}\` | ${mdEscape(c.description)} | ${
        page ? `[${page}](${page})` : "_unmapped_"
      } |`,
    )
  }
  return ["### Slash commands", "", ...rows, ""].join("\n")
}

function renderEnvVarsTable(inv: FeatureInventory, pageMap: PageMap): string {
  const rows: string[] = ["| Variable | Required | Page |", "|---|---|---|"]
  for (const e of inv.envVars) {
    const id = `${ID_PREFIXES.env}${e.id}`
    const page = pageFor(pageMap, id)
    rows.push(
      `| \`${e.id}\` | ${e.required ? "yes" : "no"} | ${
        page ? `[${page}](${page})` : "_unmapped_"
      } |`,
    )
  }
  return ["### Environment variables", "", ...rows, ""].join("\n")
}

function collectUnmapped(inv: FeatureInventory, pageMap: PageMap): string[] {
  const out: string[] = []
  for (const p of inv.panels) {
    if (!pageFor(pageMap, `${ID_PREFIXES.panel}${p.id}`)) {
      out.push(
        `- \`${ID_PREFIXES.panel}${p.id}\` (\`${p.sourceFile}\`) - ${mdEscape(p.title)}`,
      )
    }
  }
  for (const s of inv.sidebars) {
    if (!pageFor(pageMap, `${ID_PREFIXES.sidebar}${s.id}`)) {
      out.push(
        `- \`${ID_PREFIXES.sidebar}${s.id}\` (\`${s.sourceFile}\`) - ${mdEscape(s.title)}`,
      )
    }
  }
  for (const c of inv.slashCommands) {
    if (!pageFor(pageMap, `${ID_PREFIXES.slash}${c.id}`)) {
      out.push(
        `- \`${ID_PREFIXES.slash}${c.id}\` (\`${c.sourceFile}\`) - \`/${c.trigger}\` ${mdEscape(c.title)}`,
      )
    }
  }
  for (const e of inv.envVars) {
    if (!pageFor(pageMap, `${ID_PREFIXES.env}${e.id}`)) {
      out.push(
        `- \`${ID_PREFIXES.env}${e.id}\` (\`${e.sourceFile}\`) - ${mdEscape(e.description)}`,
      )
    }
  }
  return out.sort()
}

function renderIndex(inv: FeatureInventory, pageMap: PageMap): string {
  const generatedAtDate = inv.generatedAt.slice(0, 10)
  const unmapped = collectUnmapped(inv, pageMap)

  const lines: string[] = []
  lines.push("# Hummingbird - User Manual")
  lines.push("")
  lines.push(
    `> Generated TOC. Last inventory: ${generatedAtDate}. Run \`bun run docs:user-manual:build\` to refresh.`,
  )
  lines.push("")
  lines.push("## Part 1 - Using Hummingbird")
  lines.push("")
  lines.push("Pages will be added in Phase 2.")
  lines.push("")
  lines.push("## Part 2 - Installing & Configuring")
  lines.push("")
  lines.push("Pages will be added in Phase 4.")
  lines.push("")
  lines.push(renderPanelsTable(inv, pageMap))
  lines.push(renderSidebarsTable(inv, pageMap))
  lines.push(renderSlashCommandsTable(inv, pageMap))
  lines.push(renderEnvVarsTable(inv, pageMap))
  if (unmapped.length) {
    lines.push("## Unmapped (action needed)")
    lines.push("")
    lines.push(
      "> These inventory entries don't have a PAGE_MAP entry yet. Add a page that documents them and wire it up.",
    )
    lines.push("")
    lines.push(...unmapped)
    lines.push("")
  }
  return lines.join("\n")
}

async function main() {
  const inv = await readInventory()
  const out = renderIndex(inv, PAGE_MAP)

  if (CHECK_MODE) {
    let current = ""
    try {
      current = await readFile(OUTPUT_PATH, "utf8")
    } catch {
      console.error(
        `x ${OUTPUT_PATH} does not exist. Run: bun run docs:user-manual:build`,
      )
      process.exit(1)
    }
    // Sentinel: must be <= 10 chars. `renderIndex` does
    // `inv.generatedAt.slice(0, 10)` to build the "Last inventory:"
    // date. An 11-char sentinel like "__IGNORED__" would be truncated
    // to "__IGNORED_" and the follow-up `.replace` wouldn't match
    // (off-by-one). Use a 7-char sentinel so `slice(0, 10)` returns
    // it unchanged.
    const reRendered = renderIndex(
      { ...inv, generatedAt: "__IGN__" },
      PAGE_MAP,
    ).replace(/Last inventory: __IGN__/, "Last inventory: __IGN__")
    const currentStripped = current.replace(
      /Last inventory: \d{4}-\d{2}-\d{2}/,
      "Last inventory: __IGN__",
    )
    if (currentStripped !== reRendered) {
      console.error(
        `x ${OUTPUT_PATH} is out of date. Run: bun run docs:user-manual:build`,
      )
      process.exit(1)
    }
    console.log(`v ${OUTPUT_PATH} is up to date.`)
    return
  }

  await writeFile(OUTPUT_PATH, out, "utf8")
  console.log(`v wrote ${OUTPUT_PATH}`)
}

// Exported for tests.
export { PAGE_MAP }

if (import.meta.main) await main()
```

- [ ] **Step 2: Run it**

```bash
bun scripts/build-user-manual-toc.ts
```

Expected:
```
v wrote docs/user-manual/index.md
```

- [ ] **Step 3: Inspect the output**

```bash
head -40 docs/user-manual/index.md
```

Expected: top-level heading, the two Part headings, the four auto-generated tables, and a populated `## Unmapped (action needed)` section (since `PAGE_MAP` is empty in this task).

- [ ] **Step 4: Verify `--check` mode**

```bash
bun scripts/build-user-manual-toc.ts --check
```

Expected: `v docs/user-manual/index.md is up to date.`

- [ ] **Step 5: Commit**

```bash
git add scripts/build-user-manual-toc.ts docs/user-manual/index.md
git commit -m "feat(scripts): build-user-manual-toc renders index.md from inventory + PAGE_MAP"
```

---

### Task 6: Add unit tests for the TOC builder

**Files:**
- Create: `scripts/__tests__/__fixtures__/inventory/fully-mapped.json`
- Create: `scripts/__tests__/__fixtures__/inventory/with-unmapped.json`
- Create: `scripts/__tests__/__fixtures__/inventory/empty.json`
- Create: `scripts/__tests__/build-user-manual-toc.test.ts`

- [ ] **Step 1: Create the three inventory fixtures**

Create `scripts/__tests__/__fixtures__/inventory/fully-mapped.json`:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-13T12:00:00Z",
  "panels": [
    { "id": "chat", "title": "Chat", "sourceFile": "components/panels/chat.tsx" }
  ],
  "sidebars": [
    {
      "id": "application",
      "title": "Application",
      "sourceFile": "components/sidebars/application.tsx"
    }
  ],
  "slashCommands": [
    {
      "id": "new",
      "trigger": "new",
      "title": "New",
      "description": "New chat",
      "argKind": "none",
      "sourceFile": "lib/shared/commands/registry.ts"
    }
  ],
  "skills": [],
  "settings": [],
  "envVars": [
    {
      "id": "AI_GATEWAY_API_KEY",
      "description": "AI key",
      "required": true,
      "sourceFile": ".env.example"
    }
  ],
  "shortcuts": [],
  "mcpServers": { "sourceFile": "app/api/mcp" },
  "agentTaskKinds": []
}
```

Create `scripts/__tests__/__fixtures__/inventory/with-unmapped.json`:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-13T12:00:00Z",
  "panels": [
    { "id": "chat", "title": "Chat", "sourceFile": "components/panels/chat.tsx" }
  ],
  "sidebars": [
    {
      "id": "unmapped-sidebar",
      "title": "Mystery",
      "sourceFile": "components/sidebars/unmapped-sidebar.tsx"
    }
  ],
  "slashCommands": [],
  "skills": [],
  "settings": [],
  "envVars": [],
  "shortcuts": [],
  "mcpServers": { "sourceFile": "app/api/mcp" },
  "agentTaskKinds": []
}
```

Create `scripts/__tests__/__fixtures__/inventory/empty.json`:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-13T12:00:00Z",
  "panels": [],
  "sidebars": [],
  "slashCommands": [],
  "skills": [],
  "settings": [],
  "envVars": [],
  "shortcuts": [],
  "mcpServers": { "sourceFile": "app/api/mcp" },
  "agentTaskKinds": []
}
```

- [ ] **Step 2: Write the test file**

Create `scripts/__tests__/build-user-manual-toc.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

import { renderIndex, pageFor } from "../build-user-manual-toc"
import { ID_PREFIXES, type FeatureInventory, type PageMap } from "../types"

const FIXTURE_DIR = resolve(import.meta.dir, "__fixtures__/inventory")

async function loadFixture(name: string): Promise<FeatureInventory> {
  return (await import(resolve(FIXTURE_DIR, name))).default as FeatureInventory
}

describe("renderIndex", () => {
  test("fully-mapped inventory: no Unmapped section", async () => {
    const inv = await loadFixture("fully-mapped.json")
    const map: PageMap = {
      [`${ID_PREFIXES.panel}chat`]: "02-chat.md",
      [`${ID_PREFIXES.sidebar}application`]: "01-getting-started.md",
      [`${ID_PREFIXES.slash}new`]: "06-slash-commands.md",
      [`${ID_PREFIXES.env}AI_GATEWAY_API_KEY`]: "21-environment-variables.md",
    }
    const out = renderIndex(inv, map)
    expect(out).toContain("# Hummingbird - User Manual")
    expect(out).toContain("| Chat |")
    expect(out).toContain("[02-chat.md](02-chat.md)")
    expect(out).not.toContain("## Unmapped (action needed)")
  })

  test("with-unmapped inventory: Unmapped section lists the sidebar", async () => {
    const inv = await loadFixture("with-unmapped.json")
    const map: PageMap = {
      [`${ID_PREFIXES.panel}chat`]: "02-chat.md",
    }
    const out = renderIndex(inv, map)
    expect(out).toContain("## Unmapped (action needed)")
    expect(out).toContain(`\`${ID_PREFIXES.sidebar}unmapped-sidebar\``)
  })

  test("empty inventory: renders an empty TOC without crashing", async () => {
    const inv = await loadFixture("empty.json")
    const map: PageMap = {}
    const out = renderIndex(inv, map)
    expect(out).toContain("# Hummingbird - User Manual")
    expect(out).toContain("| Panel | Source | Page |")
  })
})

describe("pageFor", () => {
  test("concrete id takes precedence over wildcard", () => {
    const map: PageMap = {
      "panel:chat": "02-chat.md",
      "panel:*": "00-panels.md",
    }
    expect(pageFor(map, "panel:chat")).toBe("02-chat.md")
    expect(pageFor(map, "panel:editor")).toBe("00-panels.md")
  })

  test("env wildcard", () => {
    const map: PageMap = { "env:*": "21-environment-variables.md" }
    expect(pageFor(map, "env:AI_GATEWAY_API_KEY")).toBe(
      "21-environment-variables.md",
    )
  })

  test("no match returns null", () => {
    expect(pageFor({}, "panel:chat")).toBeNull()
  })
})
```

- [ ] **Step 3: Run the tests**

```bash
bun test scripts/__tests__/build-user-manual-toc.test.ts
```

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/__tests__/__fixtures__/inventory scripts/__tests__/build-user-manual-toc.test.ts
git commit -m "test(scripts): unit tests for build-user-manual-toc"
```

---

### Task 7: Wire the three `package.json` scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the scripts**

Open `package.json` and add three new entries to the `scripts` block (alphabetically is fine - exact position doesn't matter):

```json
"docs:user-manual:build": "bun scripts/list-user-features.ts && bun scripts/build-user-manual-toc.ts",
"docs:user-manual:check": "bun scripts/list-user-features.ts --check && bun scripts/build-user-manual-toc.ts --check",
"docs:user-manual:roundtrip": "bun test scripts/__tests__/inventory-roundtrip.test.ts",
```

- [ ] **Step 2: Run the new build script**

```bash
bun run docs:user-manual:build
```

Expected: two `v wrote ...` lines, no errors.

- [ ] **Step 3: Run the new check script**

```bash
bun run docs:user-manual:check
```

Expected: two `v ... is up to date.` lines.

- [ ] **Step 4: Verify `typecheck` still passes**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore(scripts): wire docs:user-manual:{build,check,roundtrip}"
```

---

### Task 8: Update `README.md` and `CLAUDE.md` with one-line pointers

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the README link**

In `README.md`, find the "Where to go next" table (around line 118-126) and add one row at the end of the table:

```markdown
| Read the user manual | [`docs/user-manual/index.md`](docs/user-manual/index.md) |
```

- [ ] **Step 2: Add the CLAUDE.md note**

Open `CLAUDE.md` and add a new section near the bottom (after the existing "## Working with PRs" section is fine). Title: `## User manual`. Body:

```markdown
## User manual

The user-facing manual lives under `docs/user-manual/`. The top-level
`index.md` and the `.feature-inventory.json` are generated; the
per-topic pages are hand-written. To keep the manual in sync with the
codebase:

\`\`\`bash
bun run docs:user-manual:build      # regenerate inventory + index.md
bun run docs:user-manual:check      # exit 1 if either is out of date
bun run docs:user-manual:roundtrip  # verify pages agree with inventory
\`\`\`

When you add a new user-facing feature (a panel, a slash command, a
new env var, etc.), run the build. The new id will appear under
`## Unmapped (action needed)` in `index.md`. Write a page that
documents it, add the `<!-- pages-for: <id> -->` front-matter, and add
a `PAGE_MAP` entry in `scripts/build-user-manual-toc.ts`.
```

(Note: escape the backticks in the actual CLAUDE.md so the markdown renders as a code block.)

- [ ] **Step 3: Verify the markdown renders**

```bash
git diff README.md CLAUDE.md
```

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: link to user manual from README + CLAUDE.md"
```

---

## Phase 2 - Part 1, core flows (end user)

> **Author note:** This phase is largely content writing. Each task
> follows the same shape: write the page, add the `PAGE_MAP` entries,
> run the build, verify the page appears in the index.

### Task 9: Write `01-getting-started.md`

**Files:**
- Create: `docs/user-manual/01-getting-started.md`

- [ ] **Step 1: Write the page**

Create `docs/user-manual/01-getting-started.md`:

```markdown
<!-- pages-for: panel:workspaces, sidebar:application, sidebar:resources -->
<!-- related: components/panels/workspaces.tsx, components/sidebars/application.tsx -->

# Getting started

## What it is
The first screen you see when you open Hummingbird. From here you
pick a workspace, then a chat, a document, or a tool.

## How to open it
The Workspaces tab is the default view when you sign in. The
**Workspaces** entry in the left sidebar always takes you back here.

## What you can do
- See every workspace you've created, with a one-line summary and the
  number of conversations inside.
- Click a workspace card to open its main view.
- Use the **+** button in the sidebar to create a new workspace.
- Rename or delete a workspace from its row menu.

## Tips & gotchas
- Deleting a workspace deletes every conversation and file inside it.
  This is permanent - there is no undo.
- The first time you open Hummingbird with a fresh account, you'll
  see an empty state. Create a workspace to get started.

## Related
- [Chat](02-chat.md)
- [Conversations & workspaces](05-conversations-and-workspaces.md)
```

- [ ] **Step 2: Wire it in `PAGE_MAP`**

In `scripts/build-user-manual-toc.ts`, add to the `PAGE_MAP` object:

```typescript
  "panel:workspaces": "01-getting-started.md",
  "sidebar:application": "01-getting-started.md",
  "sidebar:resources": "01-getting-started.md",
```

- [ ] **Step 3: Rebuild and verify**

```bash
bun run docs:user-manual:build
grep -E "01-getting-started" docs/user-manual/index.md
```

Expected: three `[01-getting-started.md](01-getting-started.md)` links in the index.

- [ ] **Step 4: Commit**

```bash
git add docs/user-manual/01-getting-started.md scripts/build-user-manual-toc.ts docs/user-manual/index.md
git commit -m "docs(user-manual): add 01-getting-started page"
```

---

### Task 10: Write `02-chat.md`

**Files:**
- Create: `docs/user-manual/02-chat.md`

- [ ] **Step 1: Write the page**

Create `docs/user-manual/02-chat.md`:

```markdown
<!-- pages-for: panel:chat, slash:new, slash:clear, slash:rename, slash:model, slash:help, slash:personas -->
<!-- related: components/panels/chat.tsx, lib/shared/commands/registry.ts, lib/shared/skills/registry.ts -->

# Chat

## What it is
The main conversation surface. You send messages; the model streams a
reply. Attachments, slash commands, and skills are all available from
the chat input.

## How to open it
Click any conversation in the **Chats** section of the left sidebar,
or click the **+** next to the **Chats** group to start a new one.

## What you can do
- Type a message and press **Enter** to send. **Shift+Enter** inserts
  a newline without sending.
- Drag a file onto the input to attach it to the conversation.
- Use `/` to open the slash-command menu: type `/` and pick from the
  list, or keep typing to filter.
- Use `#` to mention a file, bookmark, or other resource from your
  workspace. The mention is auto-attached to the message.
- Hover an assistant message to see the **archive** and **bookmark**
  actions.
- Switch the model on the fly with `/model <name>`. With no name it
  opens the picker.

## Tips & gotchas
- Streaming tokens render as they arrive - long replies can be
  cancelled by hitting Esc or sending another message.
- The reasoning panel (when present) is collapsible. Reasoning tokens
  are not shown by default on all models.
- Some skills (web search, image generation) require their own API
  keys in the deployment's `.env`. If a skill toggle is greyed out,
  ask the self-hoster to enable the key.
- Switching the chat backend (Next.js vs. the Python agent service)
  is a power-user setting - see [Settings & theme](12-settings-and-theme.md).

## Related
- [Slash commands](06-slash-commands.md)
- [Files & attachments](04-files-and-attachments.md)
- [Settings & theme](12-settings-and-theme.md)
```

- [ ] **Step 2: Wire the page in `PAGE_MAP`**

Add to `scripts/build-user-manual-toc.ts`:

```typescript
  "panel:chat": "02-chat.md",
  "slash:new": "02-chat.md",
  "slash:clear": "02-chat.md",
  "slash:rename": "02-chat.md",
  "slash:model": "02-chat.md",
  "slash:help": "02-chat.md",
  "slash:personas": "02-chat.md",
```

(Note: `slash:fetch`, `slash:search`, `slash:image`, `slash:files` are skill triggers from `lib/shared/skills/registry.ts`, not action commands. They map to `06-slash-commands.md` / `07-skills-and-tools.md` once the skill scanner lands in Task 19.)

- [ ] **Step 3: Rebuild and verify**

```bash
bun run docs:user-manual:build
grep -c "02-chat.md" docs/user-manual/index.md
```

Expected: >= 11 (one link per mapped id + the table row).

- [ ] **Step 4: Commit**

```bash
git add docs/user-manual/02-chat.md scripts/build-user-manual-toc.ts docs/user-manual/index.md
git commit -m "docs(user-manual): add 02-chat page"
```

---

### Task 11: Write `03-editor.md`

**Files:**
- Create: `docs/user-manual/03-editor.md`

- [ ] **Step 1: Write the page**

Create `docs/user-manual/03-editor.md`:

```markdown
<!-- pages-for: panel:editor -->
<!-- related: components/panels/editor.tsx, components/editor/, lib/shared/markdown-joiner-transform.ts -->

# Editor

## What it is
A rich-text document editor (powered by Plate.js). Use it for notes,
drafts, or long-form writing. Documents live inside a workspace and
sync across devices when you sign in.

## How to open it
The **Editor** entry in the left sidebar opens a new document, or
click any document in the **Documents** section of a workspace to
open an existing one.

## What you can do
- Format text with the toolbar: bold, italic, code, headings, lists.
- Drop in images, code blocks, and tables from the **+** menu.
- Type `/` to open the editor's slash-command menu (different from
  the chat slash menu - this one inserts blocks).
- Use the AI menu (**Ctrl+J**) inside a selection to ask the model to
  rewrite, expand, or summarize.
- Toggle **AI review changes** in [Settings](12-settings-and-theme.md)
  to control whether AI edits land as suggestions (default) or replace
  your text directly.

## Tips & gotchas
- Documents are auto-saved. There's no save button by design.
- The editor's AI menu only fires when text is selected. Press
  **Esc** first if a popover is open.
- Markdown round-trip: copy a markdown document into the editor and
  it'll be parsed into blocks. Copy from the editor and paste into
  another markdown surface to round-trip.

## Related
- [Settings & theme](12-settings-and-theme.md)
- [Chat](02-chat.md)
```

- [ ] **Step 2: Wire it in `PAGE_MAP`**

Add to `scripts/build-user-manual-toc.ts`:

```typescript
  "panel:editor": "03-editor.md",
```

- [ ] **Step 3: Rebuild and verify**

```bash
bun run docs:user-manual:build
grep "03-editor" docs/user-manual/index.md
```

- [ ] **Step 4: Commit**

```bash
git add docs/user-manual/03-editor.md scripts/build-user-manual-toc.ts docs/user-manual/index.md
git commit -m "docs(user-manual): add 03-editor page"
```

---

### Task 12: Write `04-files-and-attachments.md`

**Files:**
- Create: `docs/user-manual/04-files-and-attachments.md`

- [ ] **Step 1: Write the page**

Create `docs/user-manual/04-files-and-attachments.md`:

```markdown
<!-- pages-for: panel:sources -->
<!-- related: components/panels/sources.tsx, lib/client/file-utils.tsx, app/api/extract/ -->

# Files & attachments

## What it is
A workspace-scoped file library plus per-conversation attachments.
Files you upload live in the workspace; files you attach live on a
single conversation and are usually a subset of the workspace library.

## How to open it
- The **Files** tab on the right rail (in the chat view) shows the
  current workspace's files.
- The **+** button on the right rail opens the upload dialog.
- Drag a file onto the chat input to upload and attach in one step.
- Use the **Files** entry in the left sidebar to see a workspace-
  scoped file list at any time.

## What you can do
- Upload files: drag-and-drop, click **+**, or paste from the
  clipboard. Supported types include PDF, Word, Excel, images, code,
  and plain text.
- Search the workspace's files by name from the search box.
- Hover a file row to see its full-text extraction status, size, and
  type.
- Check the boxes next to files to attach them to the active
  conversation. Attachments appear as chips above the chat input.
- Toggle a per-attached-file setting between **inline** (full content
  in the prompt) and **RAG** (model pulls from full text on demand).

## Tips & gotchas
- Large PDFs and code repositories can take a few seconds to extract
  the first time. The extraction status badge on each row shows
  progress.
- `searchFiles` (the `/files` skill) requires sign-in - full text is
  stored in Supabase. Without it, only inline content is available to
  the model.
- Deleting a file removes it from the workspace and from any
  conversation that referenced it. This is permanent.

## Related
- [Skills & tools](07-skills-and-tools.md)
- [Chat](02-chat.md)
```

- [ ] **Step 2: Wire it in `PAGE_MAP`**

Add to `scripts/build-user-manual-toc.ts`:

```typescript
  "panel:sources": "04-files-and-attachments.md",
```

- [ ] **Step 3: Rebuild and verify**

```bash
bun run docs:user-manual:build
grep "04-files-and-attachments" docs/user-manual/index.md
```

- [ ] **Step 4: Commit**

```bash
git add docs/user-manual/04-files-and-attachments.md scripts/build-user-manual-toc.ts docs/user-manual/index.md
git commit -m "docs(user-manual): add 04-files-and-attachments page"
```

---

### Task 13: Write `05-conversations-and-workspaces.md`

**Files:**
- Create: `docs/user-manual/05-conversations-and-workspaces.md`

- [ ] **Step 1: Write the page**

Create `docs/user-manual/05-conversations-and-workspaces.md`:

```markdown
<!-- pages-for: sidebar:conversation-item, sidebar:document-item, sidebar:prompt-item -->
<!-- related: components/sidebars/conversation-item.tsx, components/sidebars/document-item.tsx, components/sidebars/prompt-item.tsx, lib/client/hooks/store/slices/conversations.ts, lib/client/hooks/store/slices/workspaces.ts -->

# Conversations & workspaces

## What it is
The two top-level organizational units. Workspaces hold conversations,
files, documents, prompts, and notes. Conversations hold the message
history of a single chat.

## How to open it
- The **Workspaces** tab in the main view (the default landing page).
- The **Chats** group in the left sidebar - collapsed by default,
  click to expand.
- The **+** next to **Chats** starts a new conversation in the active
  workspace.

## What you can do
- **Workspaces**: create from the main view; rename, delete, or
  switch via the sidebar's quick-switch popover (the chevron next to
  the workspace name).
- **Conversations**: create, rename, pin, delete, or re-open. Pinned
  conversations stay at the top of the list.
- **Workspaces have a system prompt** - set it on the Workspaces
  detail sheet to give every conversation in the workspace a custom
  default tone, role, or context.
- Each conversation can have its own system prompt that **overrides**
  the workspace's. Edit it from the chat header.

## Tips & gotchas
- Deleting a workspace cascades to every conversation, file, document,
  and note inside it. There is no undo.
- Switching workspaces changes the active conversation and the file
  library. The chat composer keeps any draft text in memory.
- Pinning a conversation moves it to the top of the list - useful
  for in-progress chats you keep coming back to.

## Related
- [Prompt library](10-prompt-library.md)
- [Notes & bookmarks](11-notes-and-bookmarks.md)
- [Settings & theme](12-settings-and-theme.md)
```

- [ ] **Step 2: Wire it in `PAGE_MAP`**

Add to `scripts/build-user-manual-toc.ts`:

```typescript
  "sidebar:conversation-item": "05-conversations-and-workspaces.md",
  "sidebar:document-item": "05-conversations-and-workspaces.md",
  "sidebar:prompt-item": "05-conversations-and-workspaces.md",
```

- [ ] **Step 3: Rebuild and verify**

```bash
bun run docs:user-manual:build
grep "05-conversations-and-workspaces" docs/user-manual/index.md
```

- [ ] **Step 4: Commit**

```bash
git add docs/user-manual/05-conversations-and-workspaces.md scripts/build-user-manual-toc.ts docs/user-manual/index.md
git commit -m "docs(user-manual): add 05-conversations-and-workspaces page"
```

---

### Task 14: Write `06-slash-commands.md`

**Files:**
- Create: `docs/user-manual/06-slash-commands.md`

- [ ] **Step 1: Write the page**

Create `docs/user-manual/06-slash-commands.md`:

```markdown
<!-- pages-for: slash:new, slash:clear, slash:rename, slash:model, slash:help, slash:personas, skill:webFetch, skill:webSearch, skill:imageGen, skill:searchFiles -->
<!-- related: lib/shared/commands/registry.ts, lib/shared/skills/registry.ts, lib/shared/skills/slash-parser.ts -->

# Slash commands

## What it is
The `/` menu inside the chat input. It has two kinds of entries:
**commands** (run-now actions that don't send a message) and
**skill triggers** (force a skill on for the next turn and then send).

## How to open it
Type `/` in the chat input. The autocomplete menu appears. Keep typing
to filter, or use arrow keys + Enter to pick.

## Commands (run-now)

| Command | What it does |
|---|---|
| `/new` | Start a fresh chat in the current workspace. |
| `/clear` | Remove every message in the current chat. Asks for confirmation. |
| `/rename <title>` | Set the current chat's title. |
| `/model [name]` | Switch the model. With a name, switches immediately; with no name, opens the picker. |
| `/help` or `/?` | Open the slash & mention help dialog. |
| `/personas` or `/agents` | Manage custom AI personas. |

## Skill triggers (send-and-skill)

| Trigger | Skill |
|---|---|
| `/fetch` or `/f` | Fetch a specific URL and read its contents. |
| `/search` or `/s` | Web search (Tavily / Brave / Exa, depending on what's enabled). |
| `/image` or `/img` | Image generation. |
| `/files` or `/file` | Pull additional sections from your attached files via full-text search. |

A skill trigger turns the skill on for the next turn, then sends the
message. Type the trigger first, then a space, then the rest of your
message.

## Tips & gotchas
- Command triggers don't require a trailing space: `/clear` on its
  own is valid. Skill triggers do - `/search` alone does nothing,
  but `/search what is ...` sends a web-search turn.
- The full help dialog (slash-help-dialog) is the same data this
  page describes; you can always read it in-app via `/help`.

## Related
- [Chat](02-chat.md)
- [Skills & tools](07-skills-and-tools.md)
```

- [ ] **Step 2: Re-point the slash and skill ids to this page**

In `scripts/build-user-manual-toc.ts`, find the existing entries from Task 10 and remove them, then add a single batch pointing all slash + skill ids to `06-slash-commands.md`. Note: only `slash:*` and `skill:*` ids are re-pointed - the `panel:chat` entry stays mapped to `02-chat.md`.

Replace the slash entries added in Task 10 with:

```typescript
  "slash:new": "06-slash-commands.md",
  "slash:clear": "06-slash-commands.md",
  "slash:rename": "06-slash-commands.md",
  "slash:model": "06-slash-commands.md",
  "slash:help": "06-slash-commands.md",
  "slash:personas": "06-slash-commands.md",
  "skill:webFetch": "06-slash-commands.md",
  "skill:webSearch": "06-slash-commands.md",
  "skill:imageGen": "06-slash-commands.md",
  "skill:searchFiles": "06-slash-commands.md",
```

(Re-pointing: action commands (`slash:*`) move from `02-chat.md` to `06-slash-commands.md`. Skill triggers (`skill:*`) also land here as the canonical slash reference; `07-skills-and-tools.md` cross-links to this page.)

- [ ] **Step 3: Rebuild and verify**

```bash
bun run docs:user-manual:build
```

- [ ] **Step 4: Commit**

```bash
git add docs/user-manual/06-slash-commands.md scripts/build-user-manual-toc.ts docs/user-manual/index.md
git commit -m "docs(user-manual): add 06-slash-commands page (canonical slash reference)"
```

---

### Task 15: Write `07-skills-and-tools.md`

**Files:**
- Create: `docs/user-manual/07-skills-and-tools.md`

- [ ] **Step 1: Write the page**

Create `docs/user-manual/07-skills-and-tools.md`:

```markdown
<!-- pages-for: skill:webFetch, skill:webSearch, skill:imageGen, skill:searchFiles -->
<!-- related: lib/shared/skills/registry.ts, lib/shared/skills/, components/panels/skills-tab.tsx -->

# Skills & tools

## What it is
Skills are capabilities the model can opt into for a single turn
(`/search ...`) or always-on for a session (the toggle in the
**Skills** right-rail tab). Tools are the underlying function calls;
the skill is the user-facing wrapper.

## How to open it
- The **Skills** tab in the right rail lists every skill and its
  toggle state.
- The **Skills** entry in the left sidebar opens the same list.
- Trigger a skill per-turn with its slash trigger (see
  [Slash commands](06-slash-commands.md)).

## What you can do
- **Web fetch** (`/fetch`) - point the model at a URL and have it
  read the page. No API key required.
- **Web search** (`/search`) - search the web. Backed by Tavily,
  Brave, and/or Exa, depending on which keys the self-hoster has
  enabled.
- **Image generation** (`/image`) - generate an image from a prompt
  (or a prompt + a reference image URL). Backed by Minimax.
- **File search** (`/files`) - let the model pull additional sections
  from your attached files when the inline view was truncated.

## Tips & gotchas
- Each skill has a per-turn cap (visible in the Skills tab) to stop
  runaway costs. The cap is shared across all enabled web providers
  in a single search.
- Some skills require sign-in. File search, for example, reads
  Supabase-stored full text via an RLS-scoped RPC.
- Skills show as chips above the chat input. A green chip is on for
  the next turn; a faded chip is off.

## Related
- [Slash commands](06-slash-commands.md)
- [MCP servers](24-mcp-server-config.md)
```

- [ ] **Step 2: Wire it in `PAGE_MAP`**

Add to `scripts/build-user-manual-toc.ts`:

```typescript
  // Skills point to BOTH 06-slash-commands.md (the trigger reference)
  // and 07-skills-and-tools.md (the canonical doc per skill). The TOC
  // builder picks the first match. We keep skills listed under
  // 07-skills-and-tools.md as the primary mapping and cross-link from
  // 06-slash-commands.md. The chat page covers the actions; this
  // page covers the underlying capability.
  // (No change needed - the skill entries from Task 14 are still
  // mapped to 06-slash-commands.md. Add a secondary mapping here
  // is not supported in v1; cross-link via the page body.)
```

- [ ] **Step 3: Commit**

```bash
git add docs/user-manual/07-skills-and-tools.md
git commit -m "docs(user-manual): add 07-skills-and-tools page"
```

---

### Task 16: Write `12-settings-and-theme.md` and wire all settings

**Files:**
- Create: `docs/user-manual/12-settings-and-theme.md`
- Modify: `scripts/build-user-manual-toc.ts`

> **Scope note:** Settings scanner lands in Task 19. We pre-write the
> settings page here so Task 20 can wire it without content churn.

- [ ] **Step 1: Write the page**

Create `docs/user-manual/12-settings-and-theme.md`:

```markdown
<!-- pages-for: setting:theme, setting:colorScheme, setting:chatBackend, setting:localOnlyMode, setting:localFilesOnly, setting:editorPrefs.aiReviewChanges -->
<!-- related: lib/client/hooks/store/slices/ui.ts, components/auth/account-menu.tsx -->

# Settings & theme

## What it is
Per-user preferences. Most settings live in the account menu (top
right of the left sidebar) and persist across reloads.

## How to open it
Click your avatar or initial at the bottom of the left sidebar.

## What you can do

### Theme & appearance
- **Theme** - `system` (follow the OS), `dark`, or `light`. Default
  is `dark`. The change is applied instantly; no reload.
- **Color scheme** - `default` or `anthropic`. Affects accent
  colours.

### Privacy
- **Local-only mode** - when on, behave as if Supabase isn't
  configured: no sync, no sign-in flows, no reconcile pulls. Survives
  reloads.
- **Local files only** - when on, raw file blobs stay in IndexedDB
  instead of being uploaded to Supabase Storage. Extracted text and
  metadata still sync (it's small).

### Editor
- **AI review changes** - when on (default), AI `edit`-mode output
  lands as Plate suggestion marks you accept/reject per chunk. When
  off, the AI's output replaces the selected text directly.

### Backend
- **Chat backend** - pick the user-facing chat producer. Options:
  - `ts` (default) - the Next.js `/api/chat` route.
  - `python` - the Python agent service at
    `${NEXT_PUBLIC_AGENT_PY_URL}/v1/chat` (only shows when the env
    var is set).
  - `ts-service` - the TypeScript agent service (Phase 5+; shows
    when `NEXT_PUBLIC_AGENT_TS_URL` is set).

## Tips & gotchas
- The Chat backend toggle is only visible when the corresponding
  env var is set on the server. Without it, every value here is
  silently treated as `ts`.
- Local-only mode is sticky - once on, you'll need to flip it off
  to sign back in.

## Related
- [Editor](03-editor.md)
- [Chat](02-chat.md)
- [Environment variables](21-environment-variables.md)
```

- [ ] **Step 2: Wire the PAGE_MAP**

Add to `scripts/build-user-manual-toc.ts`:

```typescript
  "setting:theme": "12-settings-and-theme.md",
  "setting:colorScheme": "12-settings-and-theme.md",
  "setting:chatBackend": "12-settings-and-theme.md",
  "setting:localOnlyMode": "12-settings-and-theme.md",
  "setting:localFilesOnly": "12-settings-and-theme.md",
  "setting:editorPrefs.aiReviewChanges": "12-settings-and-theme.md",
```

- [ ] **Step 3: Rebuild and verify**

```bash
bun run docs:user-manual:build
grep -c "12-settings-and-theme" docs/user-manual/index.md
```

Expected: >= 7.

- [ ] **Step 4: Commit**

```bash
git add docs/user-manual/12-settings-and-theme.md scripts/build-user-manual-toc.ts docs/user-manual/index.md
git commit -m "docs(user-manual): add 12-settings-and-theme page + wire all settings"
```

---

### Task 17: Write `09-canvas.md`

**Files:**
- Create: `docs/user-manual/09-canvas.md`

- [ ] **Step 1: Write the page**

Create `docs/user-manual/09-canvas.md`:

```markdown
<!-- pages-for: panel:canvas -->
<!-- related: components/panels/canvas.tsx -->

# Canvas

## What it is
A free-form canvas where each node is a conversation (or a fork of
one). Useful for branching a chat into parallel investigations, or
for laying out the shape of a multi-step project.

## How to open it
The **Canvas** entry in the left sidebar. If a workspace has no
canvas yet, you'll see an empty state with a button to create one.

## What you can do
- Drag from any conversation node to create a fork - the new node
  is a child conversation that starts from the parent's history.
- Pan with click-and-drag on the background. Zoom with trackpad /
  mouse wheel.
- Connect nodes by dragging from a node's handle to another node.
- Delete a node with the **Delete** key when it's selected.

## Tips & gotchas
- A forked conversation is a real conversation - it appears in the
  Chats sidebar, it counts against your storage, and it can be
  renamed, pinned, and deleted like any other.
- The canvas layout is per-workspace.

## Related
- [Conversations & workspaces](05-conversations-and-workspaces.md)
- [Chat](02-chat.md)
```

- [ ] **Step 2: Wire the PAGE_MAP**

Add to `scripts/build-user-manual-toc.ts`:

```typescript
  "panel:canvas": "09-canvas.md",
```

- [ ] **Step 3: Rebuild and verify**

```bash
bun run docs:user-manual:build
grep "09-canvas" docs/user-manual/index.md
```

- [ ] **Step 4: Commit**

```bash
git add docs/user-manual/09-canvas.md scripts/build-user-manual-toc.ts docs/user-manual/index.md
git commit -m "docs(user-manual): add 09-canvas page"
```

---

### Task 18: Write `10-prompt-library.md` and `11-notes-and-bookmarks.md`

**Files:**
- Create: `docs/user-manual/10-prompt-library.md`
- Create: `docs/user-manual/11-notes-and-bookmarks.md`

- [ ] **Step 1: Write `10-prompt-library.md`**

Create `docs/user-manual/10-prompt-library.md`:

```markdown
<!-- pages-for: panel:prompt-dialog -->
<!-- related: components/panels/prompt-dialog.tsx, components/sidebars/prompt-item.tsx, lib/client/hooks/store/slices/prompts.ts -->

# Prompt library

## What it is
A workspace-scoped library of reusable prompt templates. Drop
typed variables (`{{name}}`) into a prompt once, fill them in per
use, and the filled prompt seeds the chat composer.

## How to open it
- The **Prompts** section in the left sidebar (under a workspace).
- The **+** next to **Prompts** creates a new prompt.
- Clicking a prompt in the sidebar opens the variable-fill dialog.

## What you can do
- Create a prompt with a name, body, and any number of
  `{{variable}}` placeholders.
- Edit, rename, or delete a prompt from its sidebar row.
- Click a prompt to fill its variables; the result is copied into
  the chat composer of the active conversation.
- Promote a frequently-used chat snippet into a prompt from the
  composer menu (if exposed by the deployment).

## Tips & gotchas
- Variables are case-sensitive: `{{Name}}` and `{{name}}` are
  different.
- If a prompt body contains un-matched braces, the variable-fill
  dialog flags them and refuses to fill.

## Related
- [Chat](02-chat.md)
- [Notes & bookmarks](11-notes-and-bookmarks.md)
```

- [ ] **Step 2: Write `11-notes-and-bookmarks.md`**

Create `docs/user-manual/11-notes-and-bookmarks.md`:

```markdown
<!-- pages-for: panel:notes-tab, panel:pins-tab, panel:url-bookmarks-tab, panel:artifacts-tab -->
<!-- related: components/panels/notes-tab.tsx, components/panels/pins-tab.tsx, components/panels/url-bookmarks-tab.tsx, components/panels/artifacts-tab.tsx -->

# Notes, pins, bookmarks & artifacts

## What it is
Four related surfaces for capturing outputs and saving references,
all in the right rail of the chat view.

## What you can do

### Notes (`Notes` tab)
Free-form notes scoped to a workspace. Use them for scratch work,
research digests, or any text you want kept alongside your chats.

### Pins (`Pins` tab)
Pinned explanations from the selection-driven **Explain** action
(Ctrl+E or the selection menu). Pins are per-conversation and vanish
on reload by design.

### Bookmarks (`Links` tab)
Saved URLs, with optional title and note. Drop a URL into a
conversation and pick "bookmark" to capture it for later.

### Artifacts (`Artifacts` tab)
Saved code or markdown snippets from assistant messages. Hover an
assistant message -> archive icon to save a snippet here.

## Tips & gotchas
- Pins are session-only - refreshing the page clears them. Save the
  valuable ones to Notes if you need them to survive a reload.
- Bookmarks are workspace-scoped. Move a workspace, move its
  bookmarks with it.
- Artifacts are conversation-scoped. Save the valuable ones to
  Notes to keep them across conversations.

## Related
- [Chat](02-chat.md)
- [Prompt library](10-prompt-library.md)
```

- [ ] **Step 3: Wire the PAGE_MAP**

Add to `scripts/build-user-manual-toc.ts`:

```typescript
  "panel:prompt-dialog": "10-prompt-library.md",
  "panel:notes-tab": "11-notes-and-bookmarks.md",
  "panel:pins-tab": "11-notes-and-bookmarks.md",
  "panel:url-bookmarks-tab": "11-notes-and-bookmarks.md",
  "panel:artifacts-tab": "11-notes-and-bookmarks.md",
```

- [ ] **Step 4: Rebuild and verify**

```bash
bun run docs:user-manual:build
grep "10-prompt-library" docs/user-manual/index.md
grep -c "11-notes-and-bookmarks" docs/user-manual/index.md
```

- [ ] **Step 5: Commit**

```bash
git add docs/user-manual/10-prompt-library.md docs/user-manual/11-notes-and-bookmarks.md scripts/build-user-manual-toc.ts docs/user-manual/index.md
git commit -m "docs(user-manual): add 10-prompt-library + 11-notes-and-bookmarks pages"
```

---

## Phase 3 - Part 1, advanced features (skills/settings/shortcuts/agent scanners + remaining pages)

### Task 19: Add the Phase 3 scanners (skills, settings, shortcuts, agent task kinds)

**Files:**
- Modify: `scripts/list-user-features.ts`
- Modify: `scripts/build-user-manual-toc.ts`

- [ ] **Step 1: Extend the import in `list-user-features.ts`**

Replace the existing import block with:

```typescript
import {
  INVENTORY_SCHEMA_VERSION,
  type AgentTaskKindEntry,
  type EnvVarEntry,
  type FeatureInventory,
  type PanelEntry,
  type SettingEntry,
  type ShortcutEntry,
  type SidebarEntry,
  type SkillEntry,
  type SlashCommandEntry,
} from "./types"
```

- [ ] **Step 2: Add the four new scanners**

After the `scanSlashCommands` function (and before the `// Main` section), add the following four functions. Each is a self-contained scanner; paste each as-is.

**`scanSkills`**:

```typescript
// Skills
export async function scanSkills(): Promise<SkillEntry[]> {
  const abs = join(ROOT, "lib/shared/skills/registry.ts")
  if (!(await pathExists(abs))) return []
  const text = await readText(abs)
  const start = text.indexOf("export const SKILLS")
  if (start < 0) return []
  // Find `[` after the `=` (skipping the `[]` in the type annotation
  // `SkillDescriptor[]`). Same fix as scanSlashCommands - the registry
  // pattern is `export const NAME: Type[] = [ ... ]`.
  const equalsAt = text.indexOf("=", start)
  if (equalsAt < 0) return []
  const arrStart = text.indexOf("[", equalsAt)
  if (arrStart < 0) return []
  let depth = 0
  let i = arrStart
  let inStr: string | null = null
  for (; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (c === "\\") {
        i++
        continue
      }
      if (c === inStr) inStr = null
      continue
    }
    if (c === "'" || c === '"' || c === "`") {
      inStr = c
      continue
    }
    if (c === "[") depth++
    else if (c === "]") {
      depth--
      if (depth === 0) break
    }
  }
  const arrEnd = i
  if (arrEnd <= arrStart) return []
  const body = text.slice(arrStart + 1, arrEnd)

  const objs: string[] = []
  let d = 0
  let buf = ""
  let inS: string | null = null
  for (const c of body) {
    if (inS) {
      buf += c
      if (c === "\\") continue
      if (c === inS) inS = null
      continue
    }
    if (c === "'" || c === '"' || c === "`") {
      inS = c
      buf += c
      continue
    }
    if (c === "{") {
      d++
      buf += c
      continue
    }
    if (c === "}") {
      d--
      buf += c
      if (d === 0) {
        objs.push(buf)
        buf = ""
      }
      continue
    }
    if (c === "," && d === 0) {
      buf = ""
      continue
    }
    if (d > 0) buf += c
  }

  const entries: SkillEntry[] = []
  const rel = relative(ROOT, abs)
  for (const obj of objs) {
    const id = matchString(obj, "id")
    const name = matchString(obj, "name")
    const description = matchString(obj, "description")
    const requiresEnv = /requiresEnv:\s*true\b/.test(obj)
    if (!id || !name) continue
    const triggers: string[] = []
    const slashMatch = obj.match(/slashTriggers:\s*\[([^\]]*)\]/)
    if (slashMatch) {
      for (const m of slashMatch[1].matchAll(/['"]([^'"]+)['"]/g)) triggers.push(m[1])
    }
    entries.push({
      id,
      name,
      description: description ?? "",
      slashTriggers: triggers,
      requiresEnv,
      sourceFile: rel,
    })
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id))
}
```

**`scanSettings`**:

```typescript
// Settings - hand-picked from the UI slice; each entry asserts a
// hint pattern that must appear in the source file. If a hint is
// missing, the entry is dropped and a stderr warning is printed,
// so stale KNOWN-list entries are caught at build time.
export async function scanSettings(): Promise<SettingEntry[]> {
  const abs = join(ROOT, "lib/client/hooks/store/slices/ui.ts")
  if (!(await pathExists(abs))) return []
  const text = await readText(abs)
  const rel = relative(ROOT, abs)
  const entries: SettingEntry[] = []
  const KNOWN: { id: string; label: string; values?: string[]; hint?: RegExp }[] = [
    { id: "theme", label: "Theme", values: ["system", "dark", "light"], hint: /type Theme =/ },
    { id: "colorScheme", label: "Color scheme", values: ["default", "anthropic"], hint: /type ColorScheme =/ },
    { id: "chatBackend", label: "Chat backend", values: ["ts", "python", "ts-service"], hint: /type ChatBackend =/ },
    { id: "localOnlyMode", label: "Local-only mode", hint: /localOnlyMode: boolean/ },
    { id: "localFilesOnly", label: "Local files only", hint: /localFilesOnly: boolean/ },
    { id: "editorPrefs.aiReviewChanges", label: "AI review changes (editor)", hint: /aiReviewChanges: boolean/ },
  ]
  for (const k of KNOWN) {
    if (k.hint && !k.hint.test(text)) {
      console.warn(`! setting hint missing: ${k.id} (${k.hint})`)
      continue
    }
    const entry: SettingEntry = { id: k.id, label: k.label, sourceFile: rel }
    if (k.values) entry.values = k.values
    entries.push(entry)
  }
  return entries
}
```

**`scanShortcuts`**:

```typescript
// Shortcuts - parsed from the SHORTCUTS array in help-popover.tsx
export async function scanShortcuts(): Promise<ShortcutEntry[]> {
  const abs = join(ROOT, "components/help-popover.tsx")
  if (!(await pathExists(abs))) return []
  const text = await readText(abs)
  const rel = relative(ROOT, abs)

  const start = text.indexOf("const SHORTCUTS")
  if (start < 0) return []
  // Find `[` after the `=` (skipping the `[]` in the type annotation
  // `Shortcut[]`). Same fix as scanSlashCommands - the popover pattern
  // is `const NAME: Type[] = [ ... ]`.
  const equalsAt = text.indexOf("=", start)
  if (equalsAt < 0) return []
  const arrStart = text.indexOf("[", equalsAt)
  if (arrStart < 0) return []
  let depth = 0
  let i = arrStart
  let inStr: string | null = null
  for (; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (c === "\\") {
        i++
        continue
      }
      if (c === inStr) inStr = null
      continue
    }
    if (c === "'" || c === '"' || c === "`") {
      inStr = c
      continue
    }
    if (c === "[") depth++
    else if (c === "]") {
      depth--
      if (depth === 0) break
    }
  }
  const arrEnd = i
  if (arrEnd <= arrStart) return []
  const body = text.slice(arrStart + 1, arrEnd)

  const objs: string[] = []
  let d = 0
  let buf = ""
  let inS: string | null = null
  for (const c of body) {
    if (inS) {
      buf += c
      if (c === "\\") continue
      if (c === inS) inS = null
      continue
    }
    if (c === "'" || c === '"' || c === "`") {
      inS = c
      buf += c
      continue
    }
    if (c === "{") {
      d++
      buf += c
      continue
    }
    if (c === "}") {
      d--
      buf += c
      if (d === 0) {
        objs.push(buf)
        buf = ""
      }
      continue
    }
    if (c === "," && d === 0) {
      buf = ""
      continue
    }
    if (d > 0) buf += c
  }

  const entries: ShortcutEntry[] = []
  let n = 0
  for (const obj of objs) {
    const label = matchString(obj, "label")
    const keysArr: string[] = []
    const keysMatch = obj.match(/keys:\s*\[([^\]]*)\]/)
    if (keysMatch) {
      for (const m of keysMatch[1].matchAll(/['"]([^'"]+)['"]/g)) keysArr.push(m[1])
    }
    if (!label) continue
    n++
    entries.push({
      id: `shortcut-${n}`,
      keys: keysArr,
      label,
      sourceFile: rel,
    })
  }
  return entries
}
```

**`scanAgentTaskKinds`**:

```typescript
// Agent task kinds - extract string literals from the TaskEventKind union
export async function scanAgentTaskKinds(): Promise<AgentTaskKindEntry[]> {
  const abs = join(ROOT, "lib/shared/agent/events.ts")
  if (!(await pathExists(abs))) return []
  const text = await readText(abs)
  const m = text.match(/type\s+TaskEventKind\s*=\s*([\s\S]*?)(?:\n\nexport|\n\/\*\*|\n\*\s*Fields)/)
  if (!m) return []
  const union = m[1]
  const rel = relative(ROOT, abs)
  const entries: AgentTaskKindEntry[] = []
  for (const lit of union.matchAll(/['"]([a-z_]+)['"]/g)) {
    entries.push({ id: lit[1], sourceFile: rel })
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id))
}
```

- [ ] **Step 3: Update `buildInventory` to call the new scanners**

Replace the existing `buildInventory` function with:

```typescript
async function buildInventory(): Promise<FeatureInventory> {
  const [
    panels,
    sidebars,
    envVars,
    slashCommands,
    skills,
    settings,
    shortcuts,
    agentTaskKinds,
  ] = await Promise.all([
    scanPanels(),
    scanSidebars(),
    scanEnvVars(),
    scanSlashCommands(),
    scanSkills(),
    scanSettings(),
    scanShortcuts(),
    scanAgentTaskKinds(),
  ])
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    panels,
    sidebars,
    slashCommands,
    skills,
    settings,
    envVars,
    shortcuts,
    mcpServers: { sourceFile: "app/api/mcp" },
    agentTaskKinds,
  }
}
```

- [ ] **Step 4: Extend the TOC builder with four new tables**

In `scripts/build-user-manual-toc.ts`, add these new render functions after `renderEnvVarsTable`:

```typescript
function renderSettingsTable(inv: FeatureInventory, pageMap: PageMap): string {
  const rows: string[] = ["| Setting | Values | Page |", "|---|---|---|"]
  for (const s of inv.settings) {
    const id = `${ID_PREFIXES.setting}${s.id}`
    const page = pageFor(pageMap, id)
    const values = s.values ? s.values.join(" / ") : "-"
    rows.push(
      `| ${mdEscape(s.label)} | ${mdEscape(values)} | ${
        page ? `[${page}](${page})` : "_unmapped_"
      } |`,
    )
  }
  return ["### Settings", "", ...rows, ""].join("\n")
}

function renderShortcutsTable(inv: FeatureInventory, pageMap: PageMap): string {
  const rows: string[] = ["| Shortcut | Page |", "|---|---|"]
  for (const s of inv.shortcuts) {
    const id = `${ID_PREFIXES.shortcut}${s.id}`
    const page = pageFor(pageMap, id)
    const keys = s.keys.map((k) => `\`${k}\``).join("+")
    rows.push(
      `| ${keys} - ${mdEscape(s.label)} | ${
        page ? `[${page}](${page})` : "_unmapped_"
      } |`,
    )
  }
  return ["### Keyboard shortcuts", "", ...rows, ""].join("\n")
}

function renderSkillsTable(inv: FeatureInventory, pageMap: PageMap): string {
  const rows: string[] = ["| Skill | Slash trigger | Page |", "|---|---|---|"]
  for (const s of inv.skills) {
    const id = `${ID_PREFIXES.skill}${s.id}`
    const page = pageFor(pageMap, id)
    const triggers = s.slashTriggers.map((t) => `\`/${t}\``).join(", ")
    rows.push(
      `| ${mdEscape(s.name)} | ${triggers || "-"} | ${
        page ? `[${page}](${page})` : "_unmapped_"
      } |`,
    )
  }
  return ["### Skills", "", ...rows, ""].join("\n")
}

function renderAgentTaskKindsTable(
  inv: FeatureInventory,
  pageMap: PageMap,
): string {
  const rows: string[] = ["| Kind | Page |", "|---|---|"]
  for (const k of inv.agentTaskKinds) {
    const id = `${ID_PREFIXES.agent}${k.id}`
    const page = pageFor(pageMap, id)
    rows.push(
      `| \`${k.id}\` | ${page ? `[${page}](${page})` : "_unmapped_"} |`,
    )
  }
  return ["### Agent task kinds", "", ...rows, ""].join("\n")
}
```

Then in `renderIndex`, after the line `lines.push(renderEnvVarsTable(inv, pageMap))`, add:

```typescript
  lines.push(renderSettingsTable(inv, pageMap))
  lines.push(renderShortcutsTable(inv, pageMap))
  lines.push(renderSkillsTable(inv, pageMap))
  lines.push(renderAgentTaskKindsTable(inv, pageMap))
```

And extend `collectUnmapped` to include the four new categories:

```typescript
function collectUnmapped(inv: FeatureInventory, pageMap: PageMap): string[] {
  const out: string[] = []
  for (const p of inv.panels) {
    if (!pageFor(pageMap, `${ID_PREFIXES.panel}${p.id}`)) {
      out.push(
        `- \`${ID_PREFIXES.panel}${p.id}\` (\`${p.sourceFile}\`) - ${mdEscape(p.title)}`,
      )
    }
  }
  for (const s of inv.sidebars) {
    if (!pageFor(pageMap, `${ID_PREFIXES.sidebar}${s.id}`)) {
      out.push(
        `- \`${ID_PREFIXES.sidebar}${s.id}\` (\`${s.sourceFile}\`) - ${mdEscape(s.title)}`,
      )
    }
  }
  for (const c of inv.slashCommands) {
    if (!pageFor(pageMap, `${ID_PREFIXES.slash}${c.id}`)) {
      out.push(
        `- \`${ID_PREFIXES.slash}${c.id}\` (\`${c.sourceFile}\`) - \`/${c.trigger}\` ${mdEscape(c.title)}`,
      )
    }
  }
  for (const sk of inv.skills) {
    if (!pageFor(pageMap, `${ID_PREFIXES.skill}${sk.id}`)) {
      out.push(
        `- \`${ID_PREFIXES.skill}${sk.id}\` (\`${sk.sourceFile}\`) - ${mdEscape(sk.name)}`,
      )
    }
  }
  for (const st of inv.settings) {
    if (!pageFor(pageMap, `${ID_PREFIXES.setting}${st.id}`)) {
      out.push(
        `- \`${ID_PREFIXES.setting}${st.id}\` (\`${st.sourceFile}\`) - ${mdEscape(st.label)}`,
      )
    }
  }
  for (const e of inv.envVars) {
    if (!pageFor(pageMap, `${ID_PREFIXES.env}${e.id}`)) {
      out.push(
        `- \`${ID_PREFIXES.env}${e.id}\` (\`${e.sourceFile}\`) - ${mdEscape(e.description)}`,
      )
    }
  }
  for (const sc of inv.shortcuts) {
    if (!pageFor(pageMap, `${ID_PREFIXES.shortcut}${sc.id}`)) {
      out.push(
        `- \`${ID_PREFIXES.shortcut}${sc.id}\` (\`${sc.sourceFile}\`) - ${mdEscape(sc.label)}`,
      )
    }
  }
  for (const a of inv.agentTaskKinds) {
    if (!pageFor(pageMap, `${ID_PREFIXES.agent}${a.id}`)) {
      out.push(`- \`${ID_PREFIXES.agent}${a.id}\` (\`${a.sourceFile}\`)`)
    }
  }
  return out.sort()
}
```

- [ ] **Step 5: Run the build**

```bash
bun run docs:user-manual:build
```

Expected: inventory now includes `skills`, `settings`, `shortcuts`, `agentTaskKinds`; index has four new tables.

- [ ] **Step 6: Inspect the new sections**

```bash
grep -E "^###" docs/user-manual/index.md
```

Expected: `### Panels`, `### Sidebars`, `### Slash commands`, `### Skills`, `### Settings`, `### Keyboard shortcuts`, `### Environment variables`, `### Agent task kinds`.

- [ ] **Step 7: Run unit tests**

```bash
bun test scripts/__tests__/
```

Expected: all PASS (existing tests still pass; new tests haven't been added yet).

- [ ] **Step 8: Commit**

```bash
git add scripts/list-user-features.ts scripts/build-user-manual-toc.ts docs/user-manual/.feature-inventory.json docs/user-manual/index.md
git commit -m "feat(scripts): add skills, settings, shortcuts, agent-task-kinds scanners + TOC tables"
```

---

### Task 20: Add tests for the four new scanners + add `08-agent-tasks.md` and `13-keyboard-shortcuts.md` + wildcards

**Files:**
- Modify: `scripts/__tests__/list-user-features.test.ts`
- Create: `docs/user-manual/08-agent-tasks.md`
- Create: `docs/user-manual/13-keyboard-shortcuts.md`
- Modify: `scripts/build-user-manual-toc.ts`

- [ ] **Step 1: Add four new test blocks**

Append to `scripts/__tests__/list-user-features.test.ts`:

```typescript
import {
  scanSkills,
  scanSettings,
  scanShortcuts,
  scanAgentTaskKinds,
} from "../list-user-features"
```

Then add the `describe` blocks at the end of the file:

```typescript
describe("scanSkills", () => {
  test("extracts SkillDescriptor entries from skills/registry.ts", async () => {
    const skills = await scanSkills()
    expect(skills.length).toBeGreaterThan(0)
    const search = skills.find((s) => s.id === "webSearch")
    expect(search).toBeTruthy()
    expect(search!.name).toBe("Web search")
    expect(search!.slashTriggers).toContain("search")
    expect(search!.requiresEnv).toBe(true)
    expect(search!.sourceFile).toBe("lib/shared/skills/registry.ts")
  })
})

describe("scanSettings", () => {
  test("extracts known settings from the UI slice", async () => {
    const settings = await scanSettings()
    expect(settings.length).toBeGreaterThan(0)
    const theme = settings.find((s) => s.id === "theme")
    expect(theme).toBeTruthy()
    expect(theme!.values).toEqual(["system", "dark", "light"])
  })
})

describe("scanShortcuts", () => {
  test("extracts SHORTCUTS entries from help-popover.tsx", async () => {
    const shortcuts = await scanShortcuts()
    expect(shortcuts.length).toBeGreaterThan(0)
    const cmdK = shortcuts.find((s) => s.label.includes("Command palette"))
    expect(cmdK).toBeTruthy()
    expect(cmdK!.keys).toContain("K")
  })
})

describe("scanAgentTaskKinds", () => {
  test("extracts TaskEventKind union members from events.ts", async () => {
    const kinds = await scanAgentTaskKinds()
    expect(kinds.length).toBeGreaterThan(0)
    const token = kinds.find((k) => k.id === "token")
    expect(token).toBeTruthy()
    const status = kinds.find((k) => k.id === "status")
    expect(status).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the tests**

```bash
bun test scripts/__tests__/list-user-features.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Write `08-agent-tasks.md`**

Create `docs/user-manual/08-agent-tasks.md`:

```markdown
<!-- pages-for: agent:token, agent:tool_input, agent:tool_output, agent:step_start, agent:step_end, agent:status, agent:plan, agent:step_error, agent:handoff, agent:approval, agent:compact, agent:artifact_ref, agent:result -->
<!-- related: components/panels/project-tasks-panel.tsx, lib/shared/agent/events.ts, components/sidebars/tasks.tsx -->

# Agent tasks

## What it is
Long-running agent runs (a task that takes more than one model turn to
complete). The Tasks panel on the right rail and the dedicated Tasks
sidebar entry both show the live state.

## How to open it
- The **Tasks** entry in the left sidebar.
- The right-rail **project** tab in the chat view.

## What you can do
- Start an agent run by sending a message that the model escalates to
  a task (or by using a project-mode workspace).
- Watch progress: status, plan, step-by-step events, tool calls.
- Cancel a running task from the Tasks panel.
- Inspect a completed run's full event log from the task detail.

## Event kinds
The run is an append-only log of typed events:

- `token` - raw text or reasoning delta.
- `tool_input` - a tool call started (args are final).
- `tool_output` - a tool call resolved (with a one-line summary).
- `step_start` / `step_end` - one LLM call's lifecycle.
- `status` - run status change (queued, running, paused, ...).
- `plan` - the agent's live todo list (Deep-Agents style).
- `step_error` - one step failed; the run may continue.
- `handoff` - control passed between sub-agents.
- `approval` - the agent paused for human-in-the-loop approval.
- `compact` - context was compacted to fit the window.
- `artifact_ref` - the agent produced or referenced a saved artifact.
- `result` - the run's final assistant message.

## Tips & gotchas
- Tasks are durable. Closing the browser does not stop a running
  task - it picks up where it left off when you reopen.
- The Python agent service and the Next.js route are both live; the
  Tasks panel surfaces runs from either backend.

## Related
- [Settings & theme](12-settings-and-theme.md) (the chat-backend toggle)
- [Canvas](09-canvas.md)
```

- [ ] **Step 4: Write `13-keyboard-shortcuts.md`**

Create `docs/user-manual/13-keyboard-shortcuts.md`:

```markdown
<!-- pages-for: shortcut: -->
<!-- related: components/help-popover.tsx, components/command-palette.tsx -->

# Keyboard shortcuts

## What it is
The full set of keyboard shortcuts. The in-app **?** help popover
shows the most-used ones; this page is the complete list.

## How to open it
- The **?** help icon in the chat header opens a popover with the
  core shortcuts.
- `Ctrl+K` (or `Cmd+K` on macOS) opens the command palette - type to
  search every action.

## Global

| Shortcut | Action |
|---|---|
| `Ctrl+K` / `Cmd+K` | Open the command palette |
| `Enter` | Send the chat message |
| `Shift+Enter` | New line in the chat input |
| `Esc` | Close dialogs / cancel editing |

## Selection-driven

| Shortcut | Action |
|---|---|
| `Cmd+E` / `Ctrl+E` | Explain the current selection (from the command palette) |
| `Cmd+Enter` / `Ctrl+Enter` | Pin an explanation (from the explain popover) |

## Tips & gotchas
- The editor has its own keymap (Plate.js): `Cmd+B` / `Ctrl+B` bold,
  `Cmd+I` / `Ctrl+I` italic, `Cmd+E` / `Ctrl+E` code, `Cmd+J` / `Ctrl+J`
  AI menu, etc. These conflict with the global selection shortcuts
  only when the editor is focused.

## Related
- [Settings & theme](12-settings-and-theme.md)
- [Editor](03-editor.md)
```

- [ ] **Step 5: Add the wildcards to `PAGE_MAP`**

In `scripts/build-user-manual-toc.ts`, add:

```typescript
  "env:*": "21-environment-variables.md",
  "shortcut:*": "13-keyboard-shortcuts.md",
  "agent:*": "08-agent-tasks.md",
```

- [ ] **Step 6: Rebuild and verify**

```bash
bun run docs:user-manual:build
grep -E "^###" docs/user-manual/index.md
grep "13-keyboard-shortcuts" docs/user-manual/index.md
grep "08-agent-tasks" docs/user-manual/index.md
```

Expected: each wildcard-target page is referenced.

- [ ] **Step 7: Commit**

```bash
git add scripts/__tests__/list-user-features.test.ts docs/user-manual/08-agent-tasks.md docs/user-manual/13-keyboard-shortcuts.md scripts/build-user-manual-toc.ts docs/user-manual/index.md
git commit -m "feat(scripts): add skills/settings/shortcuts/agent tests + 08-agent-tasks, 13-keyboard-shortcuts pages + wildcards"
```

---

## Phase 4 - Part 2, self-hoster

### Task 21: Write `20-installation.md`

**Files:**
- Create: `docs/user-manual/20-installation.md`

- [ ] **Step 1: Write the page**

Create `docs/user-manual/20-installation.md`:

```markdown
<!-- pages-for: env:AI_GATEWAY_API_KEY, env:NEXT_PUBLIC_SUPABASE_URL, env:NEXT_PUBLIC_SUPABASE_ANON_KEY -->
<!-- related: README.md, docs/SUPABASE_LOCAL.md, docs/SUPABASE_SETUP.md, package.json -->

# Installation

## What it is
The two paths to get Hummingbird running locally. Both end at the
same place - a working `bun dev` on `http://localhost:3000` - but
differ in how much of the backend stack you bring up.

## Path A - Quick start (no backend)

Runs everything in `localStorage`. No Supabase, no sign-in, no
multi-device sync. Fastest path; full app minus auth + sync.

```bash
bun install
cp .env.example .env.local
# Leave Supabase vars blank. Set at minimum:
#   AI_GATEWAY_API_KEY=<your Vercel AI Gateway key>
bun dev
```

Open <http://localhost:3000>. Without `AI_GATEWAY_API_KEY` the chat
panel still loads; every turn falls back to a clearly-labeled mock
response.

## Path B - With local Supabase

Unlocks email magic-link sign-in, file persistence, and the MCP
cloud-mode credential lane. Two sub-paths:

```bash
# Sub-path B1 - Supabase CLI (recommended; needs `supabase` + Docker)
bun run supabase:start
cat .docker/supabase/dev-keys.txt        # paste into .env.local
bun dev

# Sub-path B2 - Docker only (no CLI; uses docker-compose.supabase.yml)
bun run supabase:docker:up
bun run supabase:docker:migrate
cat .docker/supabase/dev-keys.txt        # paste into .env.local
bun dev
```

Verify: open Studio at <http://localhost:54323>; magic-link emails
land in Inbucket at <http://localhost:54324>.

## Requirements

- **Bun** - package manager + dev runtime. >= 1.1.
- **Docker** - only for Path B. The Supabase CLI itself is a thin
  wrapper around Docker.
- **Node.js** - not used. Bun handles everything.
- **Disk** - the Supabase Docker images are ~5GB.

## Tips & gotchas
- Always copy `.env.example` to `.env.local` (NOT `.env`) - the
  Next.js convention is to load `.env.local` last so it overrides
  the tracked defaults.
- If you flip between Path A and Path B, `localStorage` and Supabase
  data are independent. They're not merged; you pick one.

## Related
- [Environment variables](21-environment-variables.md)
- [Supabase setup](22-supabase-setup.md)
- [Troubleshooting](26-troubleshooting.md)
```

- [ ] **Step 2: Commit**

```bash
git add docs/user-manual/20-installation.md
git commit -m "docs(user-manual): add 20-installation page"
```

---

### Task 22: Write `21-environment-variables.md`

**Files:**
- Create: `docs/user-manual/21-environment-variables.md`

- [ ] **Step 1: Write the page**

Create `docs/user-manual/21-environment-variables.md`:

```markdown
<!-- pages-for: env:* -->
<!-- related: .env.example, config/providers.json, config/models.json -->

# Environment variables

## What it is
The full set of env vars Hummingbird reads. The canonical list with
descriptions is in [`.env.example`](../../.env.example) - this page
groups them by purpose and explains when each is needed.

## Required (for real AI)

| Variable | Why |
|---|---|
| `AI_GATEWAY_API_KEY` | Streams chat / editor model calls. Without it, chat falls back to a mock. |

## Optional - providers

| Variable | Effect |
|---|---|
| `MINIMAX_CN_BASE_URL` + `MINIMAX_CN_API_KEY` | Both set -> `minimax/*` routes via the native Anthropic SDK at the configured base URL. Either unset -> falls through to the gateway. |
| `OLLAMA_BASE_URL` | Set (typically `http://localhost:11434/v1`) -> `ollama/*` models route to Ollama's OpenAI-compatible endpoint. |
| `OLLAMA_API_KEY` | Optional. Ollama doesn't enforce auth. |
| `OPENROUTER_API_KEY` | Set -> `openrouter/*` routes via `https://openrouter.ai/api/v1`. |

## Optional - Supabase

| Variable | Effect |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Browser client target. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser client auth. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side admin (share links, generated-image Storage mirror). Never expose. |
| `SUPABASE_JWT_SECRET` | Read by the Python agent service for auth-protected endpoints. Without it those endpoints return 503. |
| `SUPABASE_DB_URL` | Direct Postgres connection (NOT the pooler) - required by the Python agent service's Phase 1+ poll loop. |

## Optional - search & image

| Variable | Effect |
|---|---|
| `TAVILY_API_KEY` | Enables the Tavily-backed web search skill. |
| `BRAVE_SEARCH_API_KEY` | Enables the Brave-backed web search skill. |
| `EXA_API_KEY` | Enables the Exa-backed web search skill. All three can be enabled together. |
| `MINIMAX_IMAGE_RATE_LIMIT_PER_MINUTE` | Per-IP rate cap for the image-generation tool. Default tight. |

## Optional - MCP

| Variable | Effect |
|---|---|
| `MCP_ENCRYPTION_KEY` | Required when any user picks Cloud-mode credentials for an MCP server. Generate with `openssl rand -base64 32`. See [Encryption keys](25-encryption-keys.md). |

## Optional - split backend

| Variable | Effect |
|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | Points the API client at a non-default origin (used when the backend is rewritten in another language). |
| `NEXT_PUBLIC_AGENT_PY_URL` | Base URL of the Python agent service. When set, the account menu shows a "Python agent backend" toggle. |
| `NEXT_PUBLIC_AGENT_TS_URL` | Base URL of the TypeScript agent service. When set + Python also set, surfaces a 3-way picker. |

## Optional - Anthropic direct

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Read by the Python agent service's Phase 2b+ executor for direct Anthropic calls. Without it, the executor uses the Phase 2a stub. |
| `ANTHROPIC_BASE_URL` | Override the Anthropic base URL. Useful for self-hosted gateways. |

## Tips & gotchas
- Variables prefixed `NEXT_PUBLIC_*` are inlined into the client
  bundle. **Never** put a secret in one of those.
- `SUPABASE_DB_URL` MUST be the **direct** connection
  (`db.<project>.supabase.co:5432`), NOT the pooler
  (`*.pooler.supabase.com:6543`). `FOR UPDATE SKIP LOCKED` needs an
  open transaction.
- `OLLAMA_BASE_URL` should end in `/v1` - that's Ollama's
  "OpenAI compatibility" endpoint.

## Related
- [Installation](20-installation.md)
- [Supabase setup](22-supabase-setup.md)
- [Model providers](23-model-providers.md)
- [MCP server config](24-mcp-server-config.md)
```

- [ ] **Step 2: Commit**

```bash
git add docs/user-manual/21-environment-variables.md
git commit -m "docs(user-manual): add 21-environment-variables page (env:* wildcard target)"
```

---

### Task 23: Write `22-supabase-setup.md`

**Files:**
- Create: `docs/user-manual/22-supabase-setup.md`

- [ ] **Step 1: Write the page**

Create `docs/user-manual/22-supabase-setup.md`:

```markdown
<!-- related: docs/SUPABASE_LOCAL.md, docs/SUPABASE_SETUP.md, docs/SUPABASE_TEST.md, supabase/migrations/ -->

# Supabase setup

## What it is
The two ways to wire Hummingbird to Supabase: local Docker for dev,
or a hosted Supabase project for production.

## Local Supabase

Full guide: [`docs/SUPABASE_LOCAL.md`](../../SUPABASE_LOCAL.md).

```bash
# Path A - Supabase CLI
bun run supabase:start

# Path B - docker-compose
bun run supabase:docker:up
bun run supabase:docker:migrate
```

The local stack starts Studio at <http://localhost:54323> and
Inbucket (the magic-link inbox) at <http://localhost:54324>. The
dev keys are dumped to `.docker/supabase/dev-keys.txt` - paste
them into `.env.local`.

## Hosted Supabase

Full guide: [`docs/SUPABASE_SETUP.md`](../../SUPABASE_SETUP.md).

1. Create a Supabase project.
2. Run the migrations in `supabase/migrations/` in numeric order
   (seventeen files, 0001-0017).
3. Paste the project's URL + anon key + service-role key into
   `.env.local`.
4. Configure auth (magic-link templates) and Storage buckets per
   the SUPABASE_SETUP guide.

## Verifying the stack

```bash
bun test                          # unit + integration
bun run check                     # typecheck + lint
```

For end-to-end verification of the file full-text retrieval
pipeline (after schema or extraction changes), see
[`docs/SUPABASE_TEST.md`](../../SUPABASE_TEST.md).

## Tips & gotchas
- Seventeen migration files. They run in numeric order - don't
  skip ahead.
- The hosted project MUST expose a **direct** Postgres connection
  for the Python agent service's poll loop. Use
  `db.<project>.supabase.co:5432`, not the pooler.
- Magic-link emails in dev land in Inbucket, not your real inbox.
  Open <http://localhost:54324> to find them.

## Related
- [Installation](20-installation.md)
- [Environment variables](21-environment-variables.md)
- [Troubleshooting](26-troubleshooting.md)
```

- [ ] **Step 2: Commit**

```bash
git add docs/user-manual/22-supabase-setup.md
git commit -m "docs(user-manual): add 22-supabase-setup page"
```

---

### Task 24: Write `23-model-providers.md`

**Files:**
- Create: `docs/user-manual/23-model-providers.md`

- [ ] **Step 1: Write the page**

Create `docs/user-manual/23-model-providers.md`:

```markdown
<!-- related: config/providers.json, config/models.json, lib/server/model-provider.ts, lib/server/skills/minimax-image-client.ts -->

# Model providers

## What it is
Hummingbird talks to model providers through `config/providers.json`
and `config/models.json`. The first declares how to talk to each
provider; the second declares which models exist and how to route
them.

## Supported providers

| Provider | Type | Auth |
|---|---|---|
| `gateway` (Vercel AI Gateway) | `gateway` | `AI_GATEWAY_API_KEY` |
| `minimax-cn` (Anthropic-compatible) | `anthropic` | `MINIMAX_CN_BASE_URL` + `MINIMAX_CN_API_KEY` |
| `ollama` (local) | `openai` | Optional `OLLAMA_API_KEY`; `allowInsecureBaseUrl: true` |
| `openrouter` | `openai` | `OPENROUTER_API_KEY` |

## Adding a model

Two files, one PR:

1. **Provider entry** in `config/providers.json` if it's a new
   provider. Existing providers already there.
2. **Model entry** in `config/models.json`. Each model has an id
   (e.g. `openrouter/anthropic/claude-sonnet-4.5`), a list of
   `routes` (one or more `{via, ...}` entries that pick the
   provider), and optionally a `fallbacks` array of upstream ids
   the provider should try in order.

## Per-route fallback list

For OpenRouter models, declare a `fallbacks: [...]` array of
upstream model ids in `config/models.json`. The dispatcher injects
this as `body.models` on every OpenRouter request, so when the
primary upstream is overloaded or errored, OpenRouter tries the
fallbacks in order without re-sending.

## Tips & gotchas
- Only enable the Ollama provider for endpoints you control. By
  setting `OLLAMA_BASE_URL` you accept that the URL is trusted
  not to exfiltrate any header the AI SDK may attach.
- The `minimax-cn` provider requires BOTH
  `MINIMAX_CN_BASE_URL` AND `MINIMAX_CN_API_KEY` to activate.
  Either var unset -> falls through to the gateway.
- `openrouter/auto` lets OpenRouter pick the upstream per request
  based on prompt length, latency budget, and price. Use it for
  one-id-fits-all setups.

## Related
- [Environment variables](21-environment-variables.md)
- [Architecture overview](27-architecture-overview.md)
```

- [ ] **Step 2: Commit**

```bash
git add docs/user-manual/23-model-providers.md
git commit -m "docs(user-manual): add 23-model-providers page"
```

---

### Task 25: Write `24-mcp-server-config.md` and `25-encryption-keys.md`

**Files:**
- Create: `docs/user-manual/24-mcp-server-config.md`
- Create: `docs/user-manual/25-encryption-keys.md`

- [ ] **Step 1: Write `24-mcp-server-config.md`**

Create `docs/user-manual/24-mcp-server-config.md`:

```markdown
<!-- related: app/api/mcp/, lib/server/mcp/, lib/client/hooks/store/slices/mcp.ts, components/panels/mcp-tab.tsx -->

# MCP server config

## What it is
The Model Context Protocol (MCP) lets Hummingbird call tools
exposed by external servers. Each user configures their own
servers in the **MCP** right-rail tab.

## Adding a server

1. Open the **MCP** tab in the right rail.
2. Click **+ Add server**.
3. Pick **Local** or **Cloud** mode.
4. Fill in the server name, transport (stdio / http), command or
   URL, and any required env vars.
5. Click **Test connection** to verify the handshake.
6. Save.

Local-mode servers run their command on the user's machine; the
browser talks to them via stdio through the local shell. Cloud-mode
servers run on a remote host reachable over HTTP; credentials are
encrypted with `MCP_ENCRYPTION_KEY` and stored in Postgres.

## Local vs cloud mode

| | Local | Cloud |
|---|---|---|
| Where it runs | User's machine | Remote host (HTTP) |
| Auth | None (stdio) | Encrypted credentials in Postgres |
| Requires `MCP_ENCRYPTION_KEY` | No | Yes |
| Visible to all workspaces | No - per-user, per-device | Yes - synced across devices |

## Tips & gotchas
- Rotating `MCP_ENCRYPTION_KEY` invalidates every existing
  cloud-mode credential. Users have to re-add their servers.
- If a tool call returns a "permission denied" error from a
  cloud-mode server, the encryption key may have been rotated.
- The MCP server list is per-user, not per-workspace. Move
  workspaces freely - MCP follows the user.

## Related
- [Environment variables](21-environment-variables.md)
- [Encryption keys](25-encryption-keys.md)
- [Troubleshooting](26-troubleshooting.md)
```

- [ ] **Step 2: Write `25-encryption-keys.md`**

Create `docs/user-manual/25-encryption-keys.md`:

```markdown
<!-- related: .env.example, lib/server/mcp/credentials.ts, supabase/migrations/0005_mcp.sql -->

# Encryption keys

## What it is
The keys Hummingbird uses to encrypt secrets at rest. The only
required one is `MCP_ENCRYPTION_KEY`; the rest are auto-managed.

## `MCP_ENCRYPTION_KEY`

Required when any user picks Cloud-mode credentials for an MCP
server. The key is used by a Postgres `SECURITY DEFINER` RPC to
encrypt and decrypt `credentials_encrypted` rows.

### Generate

```bash
openssl rand -base64 32
```

The output is a 32+ character base64 string. Paste it into
`.env.local` as `MCP_ENCRYPTION_KEY=<value>`.

### Rotation

Rotating the key invalidates every existing cloud-mode credential -
users have to re-add their servers. To rotate without downtime:

1. Decrypt every `credentials_encrypted` row with the OLD key.
2. Set the NEW key in `.env.local`.
3. Re-encrypt with the new key.
4. Roll the deploy.

There is no built-in rotation tool. The two-step dance above is
deliberate - you can't transparently migrate without keeping the
old key live for the duration.

### Where the key is read

- Next.js server env (the original reader).
- Python agent service env (Phase 3f-1+ - reads the same var to
  call the same `SECURITY DEFINER` decrypt RPC).

The key is **never** persisted to Postgres. It's passed as an
argument to the RPC at request time.

## Tips & gotchas
- If you skip setting `MCP_ENCRYPTION_KEY`, cloud-mode is silently
  disabled. Local-mode still works.
- A 32-byte key is the minimum. Larger is fine; the RPC truncates
  to its internal block size.

## Related
- [MCP server config](24-mcp-server-config.md)
- [Environment variables](21-environment-variables.md)
```

- [ ] **Step 3: Commit**

```bash
git add docs/user-manual/24-mcp-server-config.md docs/user-manual/25-encryption-keys.md
git commit -m "docs(user-manual): add 24-mcp-server-config + 25-encryption-keys pages"
```

---

### Task 26: Write `26-troubleshooting.md` and `27-architecture-overview.md`

**Files:**
- Create: `docs/user-manual/26-troubleshooting.md`
- Create: `docs/user-manual/27-architecture-overview.md`

- [ ] **Step 1: Write `26-troubleshooting.md`**

Create `docs/user-manual/26-troubleshooting.md`:

```markdown
<!-- related: README.md, docs/SUPABASE_TEST.md -->

# Troubleshooting

## What it is
Common failure modes and how to recover. If a fix here doesn't
work, check the GitHub issues for your Hummingbird version.

## "Chat returns mock responses"

`AI_GATEWAY_API_KEY` is missing or invalid. Check
[Environment variables](21-environment-variables.md) and confirm
the key is set in `.env.local`. Restart `bun dev` after editing
the file.

## "Magic-link email never arrives"

In dev: check Inbucket at <http://localhost:54324>. In hosted
Supabase: check the project's auth email templates - the magic-
link template must be enabled.

## "File upload stuck on extraction"

The first extraction of a large file (PDF, code repo) can take
several seconds. The row's extraction status badge shows progress.
If it never finishes, check the server logs - extraction lives
in `app/api/extract/`.

## "MCP cloud-mode returns 401 / decrypt failed"

`MCP_ENCRYPTION_KEY` was rotated (or never set). See
[Encryption keys](25-encryption-keys.md). Users have to re-add
their cloud-mode servers.

## "Python agent service returns 503 on auth-protected endpoints"

`SUPABASE_JWT_SECRET` is missing. The Python service requires it
to verify the user's JWT. Without it, those endpoints return 503
(a distinct signal from 401, so monitoring can alert on
misconfig).

## "Poller no-ops every tick"

`SUPABASE_DB_URL` is missing or is the pooler connection. The
poller needs the **direct** connection (`db.<project>.supabase.co:5432`)
because `FOR UPDATE SKIP LOCKED` needs an open transaction. See
[Environment variables](21-environment-variables.md).

## "Chat backend toggle is missing"

The toggle only appears when `NEXT_PUBLIC_AGENT_PY_URL` (or
`NEXT_PUBLIC_AGENT_TS_URL`) is set. Without either, every value
of the internal `chatBackend` setting is silently treated as
`ts`.

## `bun run check` fails

```bash
bun run typecheck    # tsc errors
bun run lint         # eslint errors
bun test             # test failures
```

Run them individually to see which failed. Most common cause: a
new dep added without `bun install`.

## Related
- [Installation](20-installation.md)
- [Environment variables](21-environment-variables.md)
- [Supabase setup](22-supabase-setup.md)
```

- [ ] **Step 2: Write `27-architecture-overview.md`**

Create `docs/user-manual/27-architecture-overview.md`:

```markdown
<!-- related: CLAUDE.md, docs/MASTER_PLAN.md -->

# Architecture overview

## What it is
The 30,000-foot view of how Hummingbird is put together. Useful
when you're self-hosting and need to know which piece handles
which concern.

## The three layers

```
Browser (Next.js client)  ->  /api/* (Next.js route handlers)  ->  external services
                                        |
                              services/agent-py  (Python)
                              services/agent-ts  (TypeScript, Phase 5+)
```

- **`app/`** - Next.js App Router pages and route handlers. This
  is the primary backend surface: chat streaming, MCP proxy, file
  extraction, share links, summarize.
- **`services/agent-py/`** - the Python agent service. FastAPI +
  asyncpg. Runs the long-running agent task loop and (Phase 2b+)
  the real model call for flagged users.
- **`services/agent-ts/`** - the TypeScript agent service
  (Phase 5). Same dispatch shape as the Python one; uses the
  Vercel AI SDK instead of asyncpg + Anthropic.

The frontend picks one per account via
`lib/client/api/backend-resolver.ts`'s `DispatchOption`
(`'in-next'` / `'remote'`). Both backends stay live
indefinitely.

## Folder fences

The `lib/` folder is split by runtime. The folder name tells you
where the code runs, and a fence import at the top of each file
enforces the boundary at build time:

| Folder | Runtime | Fence | Allowed imports |
|---|---|---|---|
| `lib/client/`  | Browser only | `import "client-only"` | `@/client/*`, `@/shared/*` |
| `lib/server/`  | Node only (route handlers, server components) | `import "server-only"` | `@/server/*`, `@/shared/*` |
| `lib/shared/`  | Isomorphic (pure, no I/O) | none | `@/shared/*` only |

ESLint enforces the same convention via `no-restricted-imports`
in `eslint.config.mjs`. After a production build, run
`bun run audit:bundle` to confirm no server-only paths or
secret env-var names leaked into `.next/static/chunks/*.js`.

## State management

Zustand with `localStorage` persistence. The store is split into
slices under `lib/client/hooks/store/slices/` (one file per
entity: `ui`, `chat`, `workspaces`, `conversations`, `messages`,
`documents`, `files`, `resources`, `mcp`, `url-bookmarks`,
`notes`, `artifacts`, `project-tasks`, `prompts`, `agents`).
`use-store.ts` is a thin composition + re-export hub.

The persisted localStorage shape + `STORE_VERSION` are a frozen
contract - `store/persist.test.ts` pins the exact persisted key
set. Adding or removing a persisted key needs a matching
`runMigrations` step + version bump.

## Supabase

Local or hosted Postgres + Storage + Auth. SQL lives under
`supabase/migrations/` as seventeen files (0001-0017). See
[Supabase setup](22-supabase-setup.md) for the run order, or
`docs/SUPABASE_LOCAL.md` for the local Docker path.

## Related
- [CLAUDE.md](../../CLAUDE.md) - the developer-oriented companion to this page
- [Model providers](23-model-providers.md)
- [MCP server config](24-mcp-server-config.md)
```

- [ ] **Step 3: Commit**

```bash
git add docs/user-manual/26-troubleshooting.md docs/user-manual/27-architecture-overview.md
git commit -m "docs(user-manual): add 26-troubleshooting + 27-architecture-overview pages"
```

---

## Phase 5 - Sign-off

### Task 27: Add the roundtrip integration test

**Files:**
- Create: `scripts/__tests__/inventory-roundtrip.test.ts`

- [ ] **Step 1: Write the test**

Create `scripts/__tests__/inventory-roundtrip.test.ts`:

```typescript
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"

import {
  INVENTORY_SCHEMA_VERSION,
  ID_PREFIXES,
  type FeatureInventory,
} from "../types"

const ROOT = resolve(import.meta.dir, "../..")
const INVENTORY_PATH = join(ROOT, "docs/user-manual/.feature-inventory.json")
const MANUAL_DIR = join(ROOT, "docs/user-manual")

async function readInventory(): Promise<FeatureInventory> {
  if (!existsSync(INVENTORY_PATH)) {
    throw new Error(
      `Inventory not found at ${INVENTORY_PATH}. Run: bun run docs:user-manual:build`,
    )
  }
  const text = await readFile(INVENTORY_PATH, "utf8")
  return JSON.parse(text) as FeatureInventory
}

async function listManualPages(): Promise<string[]> {
  const entries = await readdir(MANUAL_DIR, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "index.md")
    .map((e) => e.name)
    .sort()
}

function extractPagesFor(text: string): string[] {
  const m = text.match(/<!--\s*pages-for:\s*([^>]+?)\s*-->/)
  if (!m) return []
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

describe("inventory roundtrip", () => {
  test("every inventory sourceFile still exists on disk", async () => {
    const inv = await readInventory()
    const missing: string[] = []
    const check = (f: string) => {
      if (!existsSync(join(ROOT, f))) missing.push(f)
    }
    for (const p of inv.panels) check(p.sourceFile)
    for (const s of inv.sidebars) check(s.sourceFile)
    for (const c of inv.slashCommands) check(c.sourceFile)
    for (const sk of inv.skills) check(sk.sourceFile)
    for (const st of inv.settings) check(st.sourceFile)
    for (const e of inv.envVars) check(e.sourceFile)
    for (const sc of inv.shortcuts) check(sc.sourceFile)
    for (const a of inv.agentTaskKinds) check(a.sourceFile)
    check(inv.mcpServers.sourceFile)
    expect(missing).toEqual([])
  })

  test("every pages-for id in a manual page is present in the inventory", async () => {
    const inv = await readInventory()
    const allIds = new Set<string>()
    for (const p of inv.panels) allIds.add(`${ID_PREFIXES.panel}${p.id}`)
    for (const s of inv.sidebars) allIds.add(`${ID_PREFIXES.sidebar}${s.id}`)
    for (const c of inv.slashCommands) allIds.add(`${ID_PREFIXES.slash}${c.id}`)
    for (const sk of inv.skills) allIds.add(`${ID_PREFIXES.skill}${sk.id}`)
    for (const st of inv.settings) allIds.add(`${ID_PREFIXES.setting}${st.id}`)
    for (const e of inv.envVars) allIds.add(`${ID_PREFIXES.env}${e.id}`)
    for (const sc of inv.shortcuts) allIds.add(`${ID_PREFIXES.shortcut}${sc.id}`)
    for (const a of inv.agentTaskKinds) allIds.add(`${ID_PREFIXES.agent}${a.id}`)

    const pages = await listManualPages()
    const stale: string[] = []
    for (const page of pages) {
      const text = await readFile(join(MANUAL_DIR, page), "utf8")
      for (const id of extractPagesFor(text)) {
        if (id.endsWith(":*")) {
          const prefix = id.slice(0, -1)
          const hasAny = [...allIds].some((invId) => invId.startsWith(prefix))
          if (!hasAny)
            stale.push(`${page} claims \`${id}\` but no inventory entry matches`)
        } else if (!allIds.has(id)) {
          stale.push(`${page} claims \`${id}\` but no such inventory entry`)
        }
      }
    }
    expect(stale).toEqual([])
  })

  test("inventory schemaVersion is supported", async () => {
    const inv = await readInventory()
    expect(inv.schemaVersion).toBe(INVENTORY_SCHEMA_VERSION)
  })
})
```

- [ ] **Step 2: Run the roundtrip test**

```bash
bun run docs:user-manual:roundtrip
```

Expected: all PASS.

If a page is missing its `pages-for` comment, or the wildcard is
wrong, the test will print exactly which page is stale. Fix and
re-run.

- [ ] **Step 3: Run the full test suite**

```bash
bun test
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/__tests__/inventory-roundtrip.test.ts
git commit -m "test(scripts): roundtrip integration test for inventory + manual"
```

---

### Task 28: Final sign-off and self-review

- [ ] **Step 1: Run all checks**

```bash
bun run typecheck
bun run lint
bun test
bun run docs:user-manual:check
bun run docs:user-manual:roundtrip
```

Expected: every command exits 0 with no errors.

- [ ] **Step 2: Eyeball `index.md` for broken links**

```bash
grep -oE '\]\(([0-9]+-[a-z-]+\.md)\)' docs/user-manual/index.md | sed 's/.*(\(.*\))/dangling\/\1/' | sort -u | while read f; do
  file="docs/user-manual/$(echo "$f" | sed 's|.*/||')"
  if [ ! -f "$file" ]; then
    echo "BROKEN: $file"
  fi
done
```

Expected: no `BROKEN:` lines. (The command prints nothing on success.)

- [ ] **Step 3: Eyeball the `Unmapped` section**

```bash
awk '/^## Unmapped/,0' docs/user-manual/index.md | head -100
```

Expected: either no `Unmapped` section (everything's mapped), or
a small list of new features that legitimately don't have a page
yet. If the list is long, write the missing pages.

- [ ] **Step 4: Final commit (if anything was fixed)**

```bash
git add -A
git diff --cached --stat
# If there are changes:
git commit -m "docs(user-manual): sign-off cleanup"
```

- [ ] **Step 5: Open a docs-only PR** (optional, but recommended)

```bash
gh pr create --base dev --head <branch-name> \
  --title "docs: Hummingbird user manual (Phases 1-5)" \
  --body "Adds the user manual scaffold, two scripts, all 22 hand-written pages, and the roundtrip test. See docs/superpowers/plans/2026-06-13-user-manual-plan.md for the per-task breakdown."
```

---

## Self-review

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| Goals & non-goals | All tasks (followed throughout) |
| Repository layout (`docs/user-manual/` + `scripts/`) | Tasks 1, 2, 3, 5 |
| Feature inventory script (scanners for panels, sidebars, slash commands, skills, settings, env vars, shortcuts, MCP, agent task kinds) | Tasks 3, 19 |
| Output schema (schemaVersion, generatedAt, all categories) | Task 2 (`scripts/types.ts`) |
| Robustness rules (stderr warnings on unknown patterns, idempotent output) | Tasks 3, 19 (each scanner) |
| TOC builder (PAGE_MAP, wildcard support, Unmapped section) | Tasks 5, 6, 20 |
| Page front-matter (`<!-- pages-for: ... -->`) | Tasks 9-26 (every page) |
| Page template & content guidelines | Tasks 9-26 (followed throughout) |
| Build pipeline (3 `package.json` scripts) | Task 7 |
| Author workflow | Implicit in every "rebuild and verify" step |
| Test strategy (3 layers) | Tasks 4, 6, 19 (new scanner tests), 20 (more tests), 27 (roundtrip) |
| Rollout (5 phases, per-phase PRs) | Tasks 1-8 (Phase 1), 9-18 (Phase 2), 19-20 (Phase 3), 21-26 (Phase 4), 27-28 (Phase 5) |
| Out of scope (intentionally not done) | None of the deferred items touched |

**Placeholder scan:** No "TBD", "TODO", "implement later", "fill in details", or "add appropriate error handling" markers. Every code block is complete.

**Type consistency:**
- `FeatureInventory`, `PageMap`, `ID_PREFIXES` defined in `scripts/types.ts` (Task 2) match the imports in both scripts.
- `renderIndex`, `pageFor`, `collectUnmapped`, `PAGE_MAP` exported from `build-user-manual-toc.ts` (Task 5) match the test imports (Task 6).
- `scanPanels`, `scanSidebars`, `scanEnvVars`, `scanSlashCommands`, `scanSkills`, `scanSettings`, `scanShortcuts`, `scanAgentTaskKinds` all called from `buildInventory` (Task 19) and tested in the test files (Tasks 4, 20).
- Wildcard `pageFor` logic (Task 5) extended consistently for `env:*`, `shortcut:*`, `agent:*` (Task 20).

**Ambiguity check:**
- The two scripts in `scripts/` resolve `ROOT` from `import.meta.dir` so they work when invoked from any cwd.
- The TOC builder overwrites only `index.md`; the inventory script overwrites only `.feature-inventory.json`. Both are deterministic and `--check` ignores `generatedAt`.
- Page numbering: 01-13 (Part 1), 20-27 (Part 2). Stable, in spec.

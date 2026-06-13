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
  // 01-getting-started.md
  "panel:workspaces": "01-getting-started.md",
  "sidebar:application": "01-getting-started.md",
  "sidebar:resources": "01-getting-started.md",

  // 02-chat.md
  "panel:chat": "02-chat.md",

  // 03-editor.md
  "panel:editor": "03-editor.md",

  // 04-files-and-attachments.md
  "panel:sources": "04-files-and-attachments.md",

  // 05-conversations-and-workspaces.md
  "sidebar:conversation-item": "05-conversations-and-workspaces.md",
  "sidebar:document-item": "05-conversations-and-workspaces.md",
  "sidebar:prompt-item": "05-conversations-and-workspaces.md",

  // 06-slash-commands.md (canonical slash reference; re-pointed
  // from 02-chat.md in Task 14)
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

  // 07-skills-and-tools.md
  // (skill entries above also point here via 06-slash-commands.md;
  // skill entries are ambiguous by design - 06 is the trigger
  // reference, 07 is the capability reference. The TOC picks
  // the first match.)

  // 09-canvas.md
  "panel:canvas": "09-canvas.md",

  // 10-prompt-library.md
  "panel:prompt-dialog": "10-prompt-library.md",

  // 11-notes-and-bookmarks.md
  "panel:notes-tab": "11-notes-and-bookmarks.md",
  "panel:pins-tab": "11-notes-and-bookmarks.md",
  "panel:url-bookmarks-tab": "11-notes-and-bookmarks.md",
  "panel:artifacts-tab": "11-notes-and-bookmarks.md",

  // 14-library.md
  "panel:library": "14-library.md",

  // 15-schedules.md
  "panel:schedule-section": "15-schedules.md",

  // 12-settings-and-theme.md (settings scanner lands in Task 19;
  // these entries become live then)
  "setting:theme": "12-settings-and-theme.md",
  "setting:colorScheme": "12-settings-and-theme.md",
  "setting:chatBackend": "12-settings-and-theme.md",
  "setting:localOnlyMode": "12-settings-and-theme.md",
  "setting:localFilesOnly": "12-settings-and-theme.md",
  "setting:editorPrefs.aiReviewChanges": "12-settings-and-theme.md",

  // Wildcards (Task 20)
  "env:*": "21-environment-variables.md", // wired in Task 22
  "shortcut:*": "13-keyboard-shortcuts.md",
  "agent:*": "08-agent-tasks.md",
}

export async function readInventory(): Promise<FeatureInventory> {
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

export function collectUnmapped(inv: FeatureInventory, pageMap: PageMap): string[] {
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

/** Derive the sorted list of unique pages used by Part 1 (01-19). */
function part1Pages(pageMap: PageMap): string[] {
  return uniquePagesByPrefix(pageMap, "0") // "0" sorts before "2"
}

/** Derive the sorted list of unique pages used by Part 2 (20-29). */
function part2Pages(pageMap: PageMap): string[] {
  return uniquePagesByPrefix(pageMap, "2")
}

function uniquePagesByPrefix(pageMap: PageMap, prefix: string): string[] {
  const set = new Set<string>()
  for (const page of Object.values(pageMap)) {
    if (page.startsWith(prefix)) set.add(page)
  }
  return [...set].sort()
}

function pageTitle(page: string): string {
  // Convert "01-getting-started.md" to "Getting started"
  return page
    .replace(/^\d+-/, "")
    .replace(/\.md$/, "")
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")
}

export function renderIndex(inv: FeatureInventory, pageMap: PageMap): string {
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
  for (const page of part1Pages(pageMap)) {
    lines.push(`- [${pageTitle(page)}](${page})`)
  }
  lines.push("")
  lines.push("## Part 2 - Installing & Configuring")
  lines.push("")
  for (const page of part2Pages(pageMap)) {
    lines.push(`- [${pageTitle(page)}](${page})`)
  }
  lines.push("")
  lines.push(renderPanelsTable(inv, pageMap))
  lines.push(renderSidebarsTable(inv, pageMap))
  lines.push(renderSlashCommandsTable(inv, pageMap))
  lines.push(renderEnvVarsTable(inv, pageMap))
  lines.push(renderSettingsTable(inv, pageMap))
  lines.push(renderShortcutsTable(inv, pageMap))
  lines.push(renderSkillsTable(inv, pageMap))
  lines.push(renderAgentTaskKindsTable(inv, pageMap))
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

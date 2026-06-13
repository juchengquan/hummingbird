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
  // Find the `[` that opens the array LITERAL (after the `=` of the export),
  // not the `[]` in the type annotation `CommandDescriptor[]` that appears
  // between the export name and the assignment.
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
      if (inStr === null) inStr = c
      else if (inStr === c) inStr = null
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
  const body = text
    .slice(arrStart + 1, arrEnd)
    .replace(/\/\/[^\n]*/g, "")

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
      if (inS === null) inS = c
      else if (inS === c) inS = null
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

// Skills
export async function scanSkills(): Promise<SkillEntry[]> {
  const abs = join(ROOT, "lib/shared/skills/registry.ts")
  if (!(await pathExists(abs))) return []
  const text = await readText(abs)
  const start = text.indexOf("export const SKILLS")
  if (start < 0) return []
  // Find `[` after the `=` (skipping the `[]` in the type annotation
  // `SkillDescriptor[]`). Same fix as scanSlashCommands.
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
      if (inStr === null) inStr = c
      else if (inStr === c) inStr = null
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
  const body = text
    .slice(arrStart + 1, arrEnd)
    .replace(/\/\/[^\n]*/g, "")

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
      if (inS === null) inS = c
      else if (inS === c) inS = null
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

// Settings - hand-picked from the UI slice; each entry asserts a
// hint pattern that must appear in the source file. If a hint is
// missing, the entry is dropped and a stderr warning is printed.
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

// Shortcuts - parsed from the SHORTCUTS array in help-popover.tsx
export async function scanShortcuts(): Promise<ShortcutEntry[]> {
  const abs = join(ROOT, "components/help-popover.tsx")
  if (!(await pathExists(abs))) return []
  const text = await readText(abs)
  const rel = relative(ROOT, abs)

  const start = text.indexOf("const SHORTCUTS")
  if (start < 0) return []
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
      if (inStr === null) inStr = c
      else if (inStr === c) inStr = null
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
  const body = text
    .slice(arrStart + 1, arrEnd)
    .replace(/\/\/[^\n]*/g, "")

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
      if (inS === null) inS = c
      else if (inS === c) inS = null
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

// Main
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

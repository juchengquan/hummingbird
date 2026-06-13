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

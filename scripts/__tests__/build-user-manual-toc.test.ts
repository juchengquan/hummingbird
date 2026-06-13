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

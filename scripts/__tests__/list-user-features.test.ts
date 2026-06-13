import { describe, expect, test } from "bun:test"

import {
  scanPanels,
  scanSidebars,
  scanEnvVars,
  scanSlashCommands,
  scanSkills,
  scanSettings,
  scanShortcuts,
  scanAgentTaskKinds,
} from "../list-user-features"

describe("scanPanels", () => {
  test("discovers tsx files in components/panels", async () => {
    const panels = await scanPanels()
    expect(Array.isArray(panels)).toBe(true)
    expect(panels.length).toBeGreaterThan(0)
    const chat = panels.find((p) => p.id === "chat")
    expect(chat).toBeTruthy()
    expect(chat!.sourceFile).toBe("components/panels/chat.tsx")
    expect(chat!.title).toBe("Chat Panel")
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

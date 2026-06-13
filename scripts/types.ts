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
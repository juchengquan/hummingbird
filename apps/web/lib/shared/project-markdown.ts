import type { Artifact, Milestone, ProjectTask, Workspace } from "./types"

/**
 * Format a Markdown export of a project workspace — goal, milestones,
 * tasks grouped by column, and any linked artifacts inlined as code
 * fences (markdown artifacts inline as-is).
 *
 * Pure and testable; the panel calls this then hands the result to
 * `downloadAsFile` from `@/client/export`.
 */
export function projectToMarkdown(
  workspace: Workspace,
  tasks: ProjectTask[],
  artifacts: Artifact[]
): string {
  const lines: string[] = []
  lines.push(`# ${workspace.name}`)
  lines.push("")
  lines.push(`_Exported ${new Date().toISOString()}_`)
  lines.push("")

  const goal = workspace.goal?.trim()
  if (goal) {
    lines.push("## Goal")
    lines.push("")
    lines.push(goal)
    lines.push("")
  }

  const milestones = workspace.milestones ?? []
  if (milestones.length > 0) {
    lines.push("## Milestones")
    lines.push("")
    for (const m of milestones) {
      lines.push(formatMilestoneLine(m))
    }
    lines.push("")
  }

  const byStatus = {
    todo: [] as ProjectTask[],
    in_progress: [] as ProjectTask[],
    done: [] as ProjectTask[],
    cancelled: [] as ProjectTask[],
  }
  // Workspace-scoped, sorted by position within column.
  for (const t of tasks
    .filter((t) => t.workspaceId === workspace.id)
    .slice()
    .sort((a, b) => a.position - b.position)) {
    byStatus[t.status].push(t)
  }

  const artifactsById = new Map(artifacts.map((a) => [a.id, a]))

  lines.push("## Tasks")
  lines.push("")
  appendColumn(lines, "To-do", byStatus.todo, artifactsById)
  appendColumn(lines, "In progress", byStatus.in_progress, artifactsById)
  appendColumn(lines, "Done", byStatus.done, artifactsById)
  if (byStatus.cancelled.length > 0) {
    appendColumn(lines, "Cancelled", byStatus.cancelled, artifactsById)
  }

  return lines.join("\n").replace(/\n+$/, "") + "\n"
}

function appendColumn(
  out: string[],
  heading: string,
  cards: ProjectTask[],
  artifactsById: Map<string, Artifact>
): void {
  out.push(`### ${heading} (${cards.length})`)
  out.push("")
  if (cards.length === 0) {
    out.push("_None._")
    out.push("")
    return
  }
  for (const c of cards) {
    out.push(`- ${c.title}`)
    const artifact = c.artifactId ? artifactsById.get(c.artifactId) : undefined
    if (artifact) appendArtifact(out, artifact)
  }
  out.push("")
}

function appendArtifact(out: string[], a: Artifact): void {
  // Inline the deliverable when it's safe to embed (text-shaped kinds);
  // for binary or unknown shapes, just note the title.
  if (a.kind === "markdown") {
    out.push("")
    for (const line of a.content.split("\n")) out.push(`  ${line}`)
    out.push("")
    return
  }
  if (a.kind === "code" || a.kind === "json") {
    const lang = a.kind === "json" ? "json" : a.language ?? ""
    out.push("")
    out.push("  ```" + lang)
    for (const line of a.content.split("\n")) out.push(`  ${line}`)
    out.push("  ```")
    out.push("")
    return
  }
  out.push(`  _Artifact: ${a.title}_`)
}

function formatMilestoneLine(m: Milestone): string {
  const date = m.dueDate?.trim()
  return date ? `- ${m.title} — due ${date}` : `- ${m.title}`
}

/**
 * Progress numbers for a project workspace's cards. `total` excludes
 * cancelled cards (they don't count against progress); `done` is the
 * count in the Done column. Used by the panel progress bar and the
 * `N/M done` chip on the workspace row.
 */
export function projectProgress(tasks: ProjectTask[]): {
  done: number
  total: number
} {
  let done = 0
  let total = 0
  for (const t of tasks) {
    if (t.status === "cancelled") continue
    total++
    if (t.status === "done") done++
  }
  return { done, total }
}

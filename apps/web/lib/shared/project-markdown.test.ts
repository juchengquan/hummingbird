import { describe, expect, it } from "bun:test"

import { projectProgress, projectToMarkdown } from "./project-markdown"
import type { Artifact, ProjectTask, Workspace } from "./types"

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    name: "Launch site",
    systemPrompt: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    isProject: true,
    ...overrides,
  }
}

function task(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "t-1",
    workspaceId: "ws-1",
    title: "Draft outline",
    status: "todo",
    position: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe("projectProgress", () => {
  it("counts done over non-cancelled total", () => {
    const tasks: ProjectTask[] = [
      task({ id: "a", status: "todo" }),
      task({ id: "b", status: "in_progress" }),
      task({ id: "c", status: "done" }),
      task({ id: "d", status: "done" }),
      task({ id: "e", status: "cancelled" }),
    ]
    expect(projectProgress(tasks)).toEqual({ done: 2, total: 4 })
  })

  it("is 0/0 for an empty board", () => {
    expect(projectProgress([])).toEqual({ done: 0, total: 0 })
  })

  it("is 0/N when nothing is done yet", () => {
    expect(
      projectProgress([task({ id: "a" }), task({ id: "b" })])
    ).toEqual({ done: 0, total: 2 })
  })
})

describe("projectToMarkdown", () => {
  it("includes the goal section when set, skips it when blank", () => {
    const ws = workspace({ goal: "Ship a landing page." })
    const md = projectToMarkdown(ws, [], [])
    expect(md).toContain("## Goal")
    expect(md).toContain("Ship a landing page.")

    const md2 = projectToMarkdown(workspace({ goal: "   " }), [], [])
    expect(md2).not.toContain("## Goal")
  })

  it("lists milestones with optional due dates", () => {
    const ws = workspace({
      milestones: [
        { title: "Wireframe done" },
        { title: "Launch", dueDate: "2026-06-15" },
      ],
    })
    const md = projectToMarkdown(ws, [], [])
    expect(md).toContain("## Milestones")
    expect(md).toContain("- Wireframe done")
    expect(md).toContain("- Launch — due 2026-06-15")
  })

  it("omits the milestones section entirely when there are none", () => {
    const md = projectToMarkdown(workspace({ milestones: [] }), [], [])
    expect(md).not.toContain("## Milestones")
  })

  it("groups tasks by column in position order", () => {
    const tasks: ProjectTask[] = [
      task({ id: "a", title: "Second todo", status: "todo", position: 1 }),
      task({ id: "b", title: "First todo", status: "todo", position: 0 }),
      task({ id: "c", title: "Doing", status: "in_progress", position: 0 }),
      task({ id: "d", title: "Shipped", status: "done", position: 0 }),
    ]
    const md = projectToMarkdown(workspace(), tasks, [])
    expect(md).toContain("### To-do (2)")
    expect(md).toContain("### In progress (1)")
    expect(md).toContain("### Done (1)")
    const todoIdx = md.indexOf("### To-do")
    const firstIdx = md.indexOf("First todo", todoIdx)
    const secondIdx = md.indexOf("Second todo", todoIdx)
    expect(firstIdx).toBeGreaterThan(0)
    expect(secondIdx).toBeGreaterThan(firstIdx)
  })

  it("shows the Cancelled column only when there are cancelled cards", () => {
    expect(
      projectToMarkdown(workspace(), [task({ status: "todo" })], [])
    ).not.toContain("### Cancelled")
    expect(
      projectToMarkdown(
        workspace(),
        [task({ id: "x", status: "cancelled" })],
        []
      )
    ).toContain("### Cancelled (1)")
  })

  it("ignores tasks from other workspaces", () => {
    const tasks: ProjectTask[] = [
      task({ id: "mine", title: "Mine", workspaceId: "ws-1" }),
      task({ id: "other", title: "Other", workspaceId: "ws-2" }),
    ]
    const md = projectToMarkdown(workspace(), tasks, [])
    expect(md).toContain("Mine")
    expect(md).not.toContain("Other")
  })

  it("inlines a markdown artifact under its card, indented", () => {
    const artifact: Artifact = {
      id: "art-1",
      workspaceId: "ws-1",
      conversationId: "c-1",
      messageId: null,
      kind: "markdown",
      language: null,
      title: "Outline",
      content: "# Outline\n\n- Hero\n- Footer",
      storagePath: null,
      pinned: false,
      createdAt: new Date(),
    }
    const tasks: ProjectTask[] = [
      task({ id: "x", title: "Draft outline", status: "done", artifactId: "art-1" }),
    ]
    const md = projectToMarkdown(workspace(), tasks, [artifact])
    expect(md).toContain("- Draft outline")
    expect(md).toContain("  # Outline")
    expect(md).toContain("  - Hero")
  })

  it("wraps a code artifact in a fenced block with the language", () => {
    const artifact: Artifact = {
      id: "art-2",
      workspaceId: "ws-1",
      conversationId: "c-1",
      messageId: null,
      kind: "code",
      language: "tsx",
      title: "Hero.tsx",
      content: "export const Hero = () => <h1>Hi</h1>",
      storagePath: null,
      pinned: false,
      createdAt: new Date(),
    }
    const tasks: ProjectTask[] = [
      task({ id: "x", title: "Hero component", status: "done", artifactId: "art-2" }),
    ]
    const md = projectToMarkdown(workspace(), tasks, [artifact])
    expect(md).toContain("  ```tsx")
    expect(md).toContain("  export const Hero")
    expect(md).toContain("  ```")
  })

  it("ends with exactly one trailing newline", () => {
    const md = projectToMarkdown(workspace(), [], [])
    expect(md.endsWith("\n")).toBe(true)
    expect(md.endsWith("\n\n")).toBe(false)
  })
})

"use client"

import { useEffect, useState } from "react"
import { format } from "date-fns"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useStore } from "@/client/hooks/use-store"
import { CHAT_MODELS } from "@/shared/models"
import { WorkspaceMcpSection } from "@/components/panels/workspace-mcp-section"
import type { Workspace } from "@/shared/types"

interface WorkspaceDetailSheetProps {
  workspaceId: string | null
  onClose: () => void
}

export function WorkspaceDetailSheet({ workspaceId, onClose }: WorkspaceDetailSheetProps) {
  const workspace = useStore((s) =>
    workspaceId ? s.workspaces.find((w) => w.id === workspaceId) ?? null : null
  )
  if (!workspace) return null
  return (
    <Sheet open={true} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent
        side="right"
        className="w-[480px] sm:max-w-[90vw] p-0 gap-0 flex flex-col"
      >
        <WorkspaceDetailBody workspace={workspace} />
      </SheetContent>
    </Sheet>
  )
}

function WorkspaceDetailBody({ workspace }: { workspace: Workspace }) {
  const renameWorkspace = useStore((s) => s.renameWorkspace)
  const setWorkspaceSystemPrompt = useStore((s) => s.setWorkspaceSystemPrompt)
  const setWorkspaceDefaultModel = useStore((s) => s.setWorkspaceDefaultModel)
  const setWorkspaceProjectConfig = useStore((s) => s.setWorkspaceProjectConfig)

  // Local editable name with auto-save on blur (or Enter). Reset when the
  // viewed workspace changes.
  const [name, setName] = useState(workspace.name)
  useEffect(() => {
    setName(workspace.name)
  }, [workspace.id, workspace.name])

  const commitName = () => {
    const trimmed = name.trim()
    if (trimmed && trimmed !== workspace.name) renameWorkspace(workspace.id, trimmed)
    else setName(workspace.name)
  }

  return (
    <>
      <SheetHeader className="shrink-0 pl-4 pr-12 py-2.5 border-b border-[var(--border)] flex-row items-center gap-2 space-y-0">
        <SheetTitle className="text-sm font-medium truncate flex-1 min-w-0">
          Workspace settings
        </SheetTitle>
      </SheetHeader>

      <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
        <div>
          <label className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] font-medium">
            Name
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              }
              if (e.key === "Escape") setName(workspace.name)
            }}
            placeholder="Workspace name"
            className="mt-1 text-sm"
          />
        </div>

        <div>
          <label className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] font-medium">
            System prompt
          </label>
          <Textarea
            value={workspace.systemPrompt ?? ""}
            onChange={(e) => setWorkspaceSystemPrompt(workspace.id, e.target.value)}
            placeholder="Optional. Prepended to every chat in this workspace."
            className="mt-1 text-xs resize-y min-h-[160px]"
            rows={8}
          />
          <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
            Give the workspace a persona, role, or style. Each chat in this workspace
            inherits this prompt automatically.
          </p>
        </div>

        <div>
          <label className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] font-medium">
            Default model
          </label>
          <Select
            value={workspace.defaultModel ?? "__none__"}
            onValueChange={(v) =>
              setWorkspaceDefaultModel(workspace.id, v === "__none__" ? "" : v)
            }
          >
            <SelectTrigger
              className="mt-1 text-xs h-8"
              aria-label="Default model for this workspace"
            >
              <SelectValue placeholder="No preference" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__" className="text-xs">
                No preference
              </SelectItem>
              {Object.entries(
                CHAT_MODELS.reduce<Record<string, typeof CHAT_MODELS>>((acc, m) => {
                  if (!acc[m.provider]) acc[m.provider] = []
                  acc[m.provider].push(m)
                  return acc
                }, {})
              ).map(([provider, models]) => (
                <SelectGroup key={provider}>
                  <SelectLabel>{provider}</SelectLabel>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-xs">
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
            Auto-applied when you open this workspace. The chat-input model picker
            still overrides per session.
          </p>
        </div>

        <div className="pt-3 border-t border-[var(--border)]">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <label className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] font-medium">
                Project mode
              </label>
              <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">
                Turn this workspace into a project with a goal and a
                Kanban task board.
              </p>
            </div>
            <Switch
              checked={workspace.isProject ?? false}
              onCheckedChange={(checked) =>
                setWorkspaceProjectConfig(workspace.id, { isProject: checked })
              }
              aria-label="Toggle project mode"
            />
          </div>

          {workspace.isProject && (
            <div className="mt-3">
              <label className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] font-medium">
                Goal
              </label>
              <Textarea
                value={workspace.goal ?? ""}
                onChange={(e) =>
                  setWorkspaceProjectConfig(workspace.id, { goal: e.target.value })
                }
                placeholder="What is this project trying to accomplish? The AI can break this into tasks."
                className="mt-1 text-xs resize-y min-h-[80px]"
                rows={4}
              />
            </div>
          )}
        </div>

        <div className="pt-3 border-t border-[var(--border)]">
          <WorkspaceMcpSection workspaceId={workspace.id} />
        </div>

        <div className="pt-2 border-t border-[var(--border)] grid grid-cols-2 gap-3 text-[11px] text-[var(--muted-foreground)]">
          <div>
            <div className="uppercase tracking-wide text-[10px] font-medium">Created</div>
            <div className="mt-0.5">{safeFormat(workspace.createdAt)}</div>
          </div>
          <div>
            <div className="uppercase tracking-wide text-[10px] font-medium">Updated</div>
            <div className="mt-0.5">{safeFormat(workspace.updatedAt)}</div>
          </div>
        </div>
      </div>
    </>
  )
}

function safeFormat(d: Date | string): string {
  try {
    return format(new Date(d), "MMM d, yyyy · h:mm a")
  } catch {
    return ""
  }
}

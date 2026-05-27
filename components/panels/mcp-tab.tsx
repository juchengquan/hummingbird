"use client"

import { useMemo, useState } from "react"
import { FileText, Plus, Server, X } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  useStore,
  useWorkspaceMcpResources,
  useWorkspaceMcpServers,
  useConversationSelectedMcpResourceIds,
} from "@/client/hooks/use-store"
import { TabEmptyState } from "@/components/panels/tab-empty-state"
import { cn } from "@/shared/utils"
import type { McpServer } from "@/shared/types"

/**
 * MCP tab — workspace-level MCP resources from configured servers.
 *
 * Resources are bound to the workspace and tickable on/off for the
 * current conversation. No conversation-private lane.
 * servers. Mirrors the Files tab's two-stack layout:
 *   - "This conversation" — privately pinned (`conversationMcpResources`).
 *   - "Workspace MCP resources" — bound to the workspace
 *     (`mcpResourceBindings`), tickable on/off for the current
 *     conversation.
 *
 * The "Add resource" picker enumerates every discovered resource
 * across enabled servers — capabilities come from each server's
 * cached `capabilities.resources` (populated by Stage 2's discovery).
 */
export function McpTab() {
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const servers = useWorkspaceMcpServers()
  const workspaceResources = useWorkspaceMcpResources()
  const selectedIds = useConversationSelectedMcpResourceIds()

  const upsertMcpResource = useStore((s) => s.upsertMcpResource)
  const addMcpResourceBinding = useStore((s) => s.addMcpResourceBinding)
  const removeMcpResourceBinding = useStore((s) => s.removeMcpResourceBinding)
  const toggleSelection = useStore(
    (s) => s.toggleConversationMcpResourceSelection
  )

  const [pickerOpen, setPickerOpen] = useState<"workspace" | null>(null)

  // Resolve the server for each rendered resource so the row can show
  // "GitHub: README.md" style provenance.
  const serverById = useMemo(() => {
    const m = new Map<string, McpServer>()
    for (const s of servers) m.set(s.id, s)
    return m
  }, [servers])

  // For workspace-binding removal we need the binding id (not just the
  // resource id). Build a lookup.
  const bindings = useStore((s) => s.mcpResourceBindings)
  const bindingByResourceId = useMemo(() => {
    const m = new Map<string, string>()
    for (const b of bindings) {
      if (b.workspaceId !== activeWorkspaceId) continue
      m.set(b.resourceId, b.id)
    }
    return m
  }, [bindings, activeWorkspaceId])

  const handlePicked = (
    pick: { server: McpServer; uri: string; name: string; description?: string; mimeType?: string }
  ) => {
    const resource = upsertMcpResource({
      workspaceId: activeWorkspaceId,
      serverId: pick.server.id,
      uri: pick.uri,
      name: pick.name,
      description: pick.description,
      mimeType: pick.mimeType,
    })
    addMcpResourceBinding(activeWorkspaceId, resource.id)
    setPickerOpen(null)
  }

  const noServers = servers.length === 0

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Workspace MCP resources — tickable on/off for this conversation. */}
      <div className="flex-1 min-h-0 flex flex-col border-t border-[var(--border)]">
        <div className="shrink-0 h-11 px-3 flex items-center justify-between gap-2 border-b border-[var(--border)]">
          <div className="flex items-center gap-1.5 min-w-0">
            <Server size={11} className="shrink-0 text-[var(--muted-foreground)]" />
            <p className="text-[11px] font-medium text-[var(--foreground)] truncate">
              Workspace MCP resources
            </p>
            <span className="text-[10px] text-[var(--muted-foreground)] shrink-0">
              {workspaceResources.length}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setPickerOpen("workspace")}
            disabled={noServers}
            aria-label="Add resource to workspace"
            title={
              noServers
                ? "Configure an MCP server in workspace settings first."
                : "Add a resource to the workspace library"
            }
            className={cn(
              "shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors",
              noServers
                ? "text-[var(--muted-foreground)]/50 cursor-not-allowed"
                : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
            )}
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
          {workspaceResources.length === 0 ? (
            <TabEmptyState icon={Server} onClick={noServers ? undefined : () => setPickerOpen("workspace")}>
              {noServers
                ? "Add an MCP server in workspace settings to start attaching resources."
                : "No workspace MCP resources yet. Add one to share across conversations."}
            </TabEmptyState>
          ) : (
            <ul className="space-y-0.5">
              {workspaceResources.map((resource) => {
                const attached = selectedIds.includes(resource.id)
                const server = serverById.get(resource.serverId)
                return (
                  <li key={resource.id} className="group/mcp-row relative">
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleSelection(resource.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          toggleSelection(resource.id)
                        }
                      }}
                      aria-pressed={attached}
                      className={cn(
                        "w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left transition-colors cursor-pointer pr-8",
                        attached
                          ? "bg-[var(--primary)]/10 ring-1 ring-[var(--primary)]/40"
                          : "hover:bg-[var(--accent)]"
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "mt-0.5 shrink-0 size-4 rounded-[4px] border inline-flex items-center justify-center transition-colors text-[10px]",
                          attached
                            ? "bg-[var(--primary)] border-[var(--primary)] text-[var(--primary-foreground)]"
                            : "border-[var(--border)] bg-transparent"
                        )}
                      >
                        {attached && "✓"}
                      </span>
                      <FileText size={12} className="mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
                      <div className="flex-1 min-w-0">
                        <div
                          className={cn(
                            "text-xs font-medium truncate",
                            attached ? "text-[var(--primary)]" : "text-[var(--foreground)]"
                          )}
                        >
                          {resource.name}
                        </div>
                        <div className="text-[10px] text-[var(--muted-foreground)] truncate">
                          {server?.name ?? "Unknown server"} · {resource.uri}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        const bindingId = bindingByResourceId.get(resource.id)
                        if (bindingId) removeMcpResourceBinding(bindingId)
                      }}
                      aria-label={`Remove ${resource.name} from workspace`}
                      title="Remove from workspace"
                      className="absolute top-1.5 right-1.5 p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)] transition-colors opacity-0 group-hover/mcp-row:opacity-100 focus-within:opacity-100"
                    >
                      <X size={12} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Resource picker dialog. */}
      <ResourcePickerDialog
        open={pickerOpen !== null}
        onOpenChange={(o) => !o && setPickerOpen(null)}
        servers={servers}
        onPick={handlePicked}
      />
    </div>
  )
}

function ResourcePickerDialog({
  open,
  onOpenChange,
  servers,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  servers: McpServer[]
  onPick: (
    pick: { server: McpServer; uri: string; name: string; description?: string; mimeType?: string }
  ) => void
}) {
  const [query, setQuery] = useState("")
  // Flatten resources across all servers, filter live ones.
  const flattened = useMemo(() => {
    const out: {
      server: McpServer
      uri: string
      name: string
      description?: string
      mimeType?: string
    }[] = []
    for (const server of servers) {
      for (const r of server.capabilities?.resources ?? []) {
        out.push({
          server,
          uri: r.uri,
          name: r.name ?? r.uri,
          description: r.description,
          mimeType: r.mimeType,
        })
      }
    }
    return out
  }, [servers])

  const filtered = useMemo(() => {
    if (!query.trim()) return flattened
    const q = query.toLowerCase()
    return flattened.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.uri.toLowerCase().includes(q) ||
        r.server.name.toLowerCase().includes(q)
    )
  }, [flattened, query])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a resource to the workspace</DialogTitle>
          <DialogDescription>
            Pick from resources discovered on your configured MCP servers.
            Need more? Hit the refresh button on a server row in workspace
            settings.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search resources"
            className="text-sm"
            autoFocus
          />
          <div className="max-h-[280px] overflow-y-auto rounded-md border border-[var(--border)] divide-y divide-[var(--border)]">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-[11px] text-[var(--muted-foreground)]">
                {flattened.length === 0
                  ? "No discovered resources yet — try refreshing a server in workspace settings."
                  : `No resources match "${query}".`}
              </p>
            ) : (
              filtered.map((r, i) => (
                <button
                  key={`${r.server.id}::${r.uri}::${i}`}
                  type="button"
                  onClick={() => onPick(r)}
                  className="w-full px-3 py-2 text-left flex items-start gap-2 hover:bg-[var(--accent)] transition-colors"
                >
                  <FileText size={12} className="mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate text-[var(--foreground)]">
                      {r.name}
                    </div>
                    <div className="text-[10px] text-[var(--muted-foreground)] truncate">
                      {r.server.name} · {r.uri}
                    </div>
                    {r.description && (
                      <div className="text-[10px] text-[var(--muted-foreground)] truncate mt-0.5">
                        {r.description}
                      </div>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

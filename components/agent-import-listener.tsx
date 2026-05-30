"use client"

import "client-only"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { useStore } from "@/client/hooks/use-store"
import {
  decodeAgentShareToken,
  type ShareableAgent,
} from "@/shared/agents/share"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/**
 * Listens for a `?import-agent=<token>` URL query on mount. Decodes
 * the shareable persona payload and pops a confirm modal asking the
 * user whether to import it into their active workspace.
 *
 * Phase 2 of `PLAN-custom-agents.md`. The token format + decoder live
 * in `lib/shared/agents/share.ts`; this component is just the entry
 * surface. Mounted once near the dashboard root, alongside the rest of
 * the application-wide providers.
 */
export function AgentImportListener() {
  const [shareable, setShareable] = useState<ShareableAgent | null>(null)
  const consumedRef = useRef(false)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const allMcpServers = useStore((s) => s.mcpServers)
  const createAgent = useStore((s) => s.createAgent)

  useEffect(() => {
    if (consumedRef.current) return
    consumedRef.current = true
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const token = params.get("import-agent")
    if (!token) return
    const decoded = decodeAgentShareToken(token)
    // Always clear the param so a refresh doesn't re-prompt.
    params.delete("import-agent")
    const next = params.toString()
    window.history.replaceState(
      {},
      "",
      window.location.pathname + (next ? `?${next}` : "") + window.location.hash
    )
    if (!decoded) {
      toast.error("Couldn't decode the persona share URL")
      return
    }
    setShareable(decoded)
  }, [])

  if (!shareable) return null

  const handleConfirm = () => {
    if (!activeWorkspaceId) {
      toast.error("Open a workspace to import this persona into")
      return
    }
    // MCP allow-list portability: server ids are user-scoped; filter
    // out any that the recipient doesn't have. The persona still
    // imports with a thinner list.
    const knownMcp = new Set(
      allMcpServers
        .filter((m) => m.workspaceId === activeWorkspaceId && !m.deletedAt)
        .map((m) => m.id)
    )
    const filteredMcp = shareable.allowedMcpServerIds.filter((id) =>
      knownMcp.has(id)
    )
    const droppedMcp = shareable.allowedMcpServerIds.length - filteredMcp.length

    createAgent({
      workspaceId: activeWorkspaceId,
      name: shareable.name,
      slug: shareable.slug,
      systemPrompt: shareable.systemPrompt,
      modelId: shareable.modelId,
      allowedSkillIds: shareable.allowedSkillIds,
      allowedMcpServerIds: filteredMcp,
      icon: shareable.icon,
    })
    setShareable(null)
    if (droppedMcp > 0) {
      toast.success(
        `Imported "${shareable.name}" — ${droppedMcp} MCP server reference${droppedMcp === 1 ? "" : "s"} dropped (not found in this workspace)`
      )
    } else {
      toast.success(`Imported "${shareable.name}"`)
    }
  }

  return (
    <Dialog
      open={!!shareable}
      onOpenChange={(open) => {
        if (!open) setShareable(null)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import persona?</DialogTitle>
          <DialogDescription>
            A shared persona was attached to this URL. Import it into your
            active workspace?
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <div>
            <span className="font-medium">{shareable.name}</span>
            <span className="font-mono text-[11px] text-[var(--muted-foreground)] ml-2">
              /{shareable.slug}
            </span>
          </div>
          {shareable.systemPrompt ? (
            <p className="text-[13px] text-[var(--muted-foreground)] line-clamp-4 whitespace-pre-wrap">
              {shareable.systemPrompt}
            </p>
          ) : null}
          <p className="text-[11px] text-[var(--muted-foreground)]">
            Skills: {shareable.allowedSkillIds.join(", ") || "none"}
            {shareable.allowedMcpServerIds.length > 0
              ? ` · MCP: ${shareable.allowedMcpServerIds.join(", ")}`
              : ""}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setShareable(null)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleConfirm}>
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

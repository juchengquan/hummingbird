"use client"

import { useState } from "react"
import { Plus, Trash2, ExternalLink, Lock, Cloud, AlertCircle } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog"
import { useStore, useWorkspaceMcpServers } from "@/client/hooks/use-store"
import {
  credentialFingerprint,
  removeLocalCred,
  setLocalCred,
  type McpCredentials,
} from "@/client/mcp/local-creds"
import { cn } from "@/shared/utils"
import type { McpCredentialMode, McpServer } from "@/shared/types"

/**
 * Workspace settings → MCP servers section. Stage 1 surface: list +
 * add + remove + enable toggle. Discovery and tool wiring land in
 * Stages 2-3 (see `docs/PLAN-mcp-integration.md`).
 */
export function WorkspaceMcpSection({ workspaceId }: { workspaceId: string }) {
  const servers = useWorkspaceMcpServers().filter(
    (s) => s.workspaceId === workspaceId
  )
  const removeMcpServer = useStore((s) => s.removeMcpServer)
  const setMcpServerEnabled = useStore((s) => s.setMcpServerEnabled)

  const [addOpen, setAddOpen] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const pendingDelete =
    confirmDeleteId !== null
      ? servers.find((s) => s.id === confirmDeleteId)
      : null

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <label className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] font-medium">
          MCP servers
        </label>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="inline-flex items-center gap-1 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
        >
          <Plus size={12} />
          Add
        </button>
      </div>
      {servers.length === 0 ? (
        <p className="text-[11px] text-[var(--muted-foreground)] italic">
          No MCP servers configured. Add one to extend this workspace with
          external tools and resources (GitHub, Notion, filesystem, …).
        </p>
      ) : (
        <ul className="space-y-1">
          {servers.map((server) => (
            <li
              key={server.id}
              className={cn(
                "group/mcp-row flex items-center gap-2 px-2 py-1.5 rounded-md border border-[var(--border)] bg-[var(--background)]/40",
                !server.enabled && "opacity-60"
              )}
            >
              {server.credentialMode === "local" ? (
                <Lock
                  size={12}
                  className="shrink-0 text-[var(--muted-foreground)]"
                />
              ) : (
                <Cloud
                  size={12}
                  className="shrink-0 text-[var(--muted-foreground)]"
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{server.name}</div>
                <div className="text-[10px] text-[var(--muted-foreground)] truncate flex items-center gap-1">
                  <ExternalLink size={9} />
                  <span className="truncate">{server.url}</span>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={server.enabled}
                aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
                onClick={() => setMcpServerEnabled(server.id, !server.enabled)}
                className={cn(
                  "shrink-0 h-4 w-7 rounded-full transition-colors relative",
                  server.enabled
                    ? "bg-[var(--primary)]"
                    : "bg-[var(--border)]"
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 size-3 rounded-full bg-white transition-transform",
                    server.enabled ? "translate-x-3.5" : "translate-x-0.5"
                  )}
                />
              </button>
              <button
                type="button"
                onClick={() => setConfirmDeleteId(server.id)}
                aria-label={`Remove ${server.name}`}
                className="p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)] transition-colors opacity-0 group-hover/mcp-row:opacity-100 focus-within:opacity-100"
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[10px] text-[var(--muted-foreground)]">
        Discovery, tool calling, and resource attachment will light up after
        Stage 2 of the MCP integration. See <code>docs/PLAN-mcp-integration.md</code>.
      </p>

      <AddMcpServerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        workspaceId={workspaceId}
      />

      <DeleteConfirmDialog
        open={confirmDeleteId !== null}
        onOpenChange={(open) => !open && setConfirmDeleteId(null)}
        title={<>Remove &ldquo;{pendingDelete?.name ?? "server"}&rdquo;?</>}
        description={
          <>
            Detaches this server from the workspace and revokes any local
            credentials. Cached resources and bindings are removed; historic
            message references still resolve to a &ldquo;removed&rdquo; label.{" "}
            <span className="font-medium text-[var(--foreground)]">
              This action cannot be undone.
            </span>
          </>
        }
        onConfirm={() => {
          if (confirmDeleteId) {
            removeLocalCred(confirmDeleteId)
            removeMcpServer(confirmDeleteId)
          }
        }}
      />
    </div>
  )
}

function AddMcpServerDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
}) {
  const addMcpServer = useStore((s) => s.addMcpServer)
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [credentialMode, setCredentialMode] = useState<McpCredentialMode>("local")
  const [authType, setAuthType] = useState<"bearer" | "none">("bearer")
  const [token, setToken] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setName("")
    setUrl("")
    setCredentialMode("local")
    setAuthType("bearer")
    setToken("")
    setError(null)
  }

  const handleClose = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const handleSubmit = async () => {
    setError(null)
    const trimmedName = name.trim()
    const trimmedUrl = url.trim()
    if (!trimmedName) return setError("Name is required.")
    if (!trimmedUrl) return setError("URL is required.")
    try {
      new URL(trimmedUrl)
    } catch {
      return setError("URL is not valid.")
    }
    if (credentialMode === "cloud") {
      return setError(
        "Cloud-stored credentials are not yet wired (lands in Stage 2). " +
          "Please use Local for now."
      )
    }
    setSubmitting(true)
    try {
      const cred: McpCredentials = buildCred(authType, token)
      const fingerprint = await credentialFingerprint(cred)
      const server: McpServer = addMcpServer({
        workspaceId,
        name: trimmedName,
        url: trimmedUrl,
        credentialMode,
        credentialFingerprint: fingerprint,
      })
      if (authType !== "none") setLocalCred(server.id, cred)
      handleClose(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add MCP server</DialogTitle>
          <DialogDescription>
            Connect this workspace to a Model Context Protocol server.
            HTTP / Streamable HTTP only for now.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] font-medium">
              Name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. GitHub"
              className="mt-1 text-sm"
              autoFocus
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] font-medium">
              URL
            </label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp.example.com/sse"
              className="mt-1 text-sm font-mono"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] font-medium">
              Credential storage
            </label>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <CredModeButton
                label="Local"
                description="This device only"
                icon={Lock}
                active={credentialMode === "local"}
                onClick={() => setCredentialMode("local")}
              />
              <CredModeButton
                label="Cloud"
                description="Synced (Stage 2)"
                icon={Cloud}
                active={credentialMode === "cloud"}
                onClick={() => setCredentialMode("cloud")}
                disabled
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] font-medium">
              Authentication
            </label>
            <div className="mt-1 flex gap-2">
              <button
                type="button"
                onClick={() => setAuthType("bearer")}
                className={cn(
                  "text-[11px] px-2 py-1 rounded-md border",
                  authType === "bearer"
                    ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                    : "border-[var(--border)] text-[var(--muted-foreground)]"
                )}
              >
                Bearer token
              </button>
              <button
                type="button"
                onClick={() => setAuthType("none")}
                className={cn(
                  "text-[11px] px-2 py-1 rounded-md border",
                  authType === "none"
                    ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                    : "border-[var(--border)] text-[var(--muted-foreground)]"
                )}
              >
                None
              </button>
            </div>
            {authType === "bearer" && (
              <Input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste your token"
                className="mt-2 text-xs font-mono"
                type="password"
                autoComplete="off"
              />
            )}
          </div>
          {error && (
            <div className="flex items-start gap-1.5 text-[11px] text-[var(--destructive)]">
              <AlertCircle size={12} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => handleClose(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Adding…" : "Add server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CredModeButton({
  label,
  description,
  icon: Icon,
  active,
  onClick,
  disabled,
}: {
  label: string
  description: string
  icon: typeof Lock
  active: boolean
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex flex-col items-start gap-0.5 px-2.5 py-2 rounded-md border text-left transition-colors",
        active
          ? "border-[var(--primary)] bg-[var(--primary)]/10"
          : "border-[var(--border)] hover:bg-[var(--accent)]",
        disabled && "opacity-50 cursor-not-allowed hover:bg-transparent"
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon
          size={12}
          className={active ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]"}
        />
        <span
          className={cn(
            "text-xs font-medium",
            active ? "text-[var(--primary)]" : "text-[var(--foreground)]"
          )}
        >
          {label}
        </span>
      </div>
      <span className="text-[10px] text-[var(--muted-foreground)]">
        {description}
      </span>
    </button>
  )
}

function buildCred(
  authType: "bearer" | "none",
  token: string
): McpCredentials {
  if (authType === "none") return { type: "none" }
  return {
    type: "bearer",
    headers: { authorization: `Bearer ${token.trim()}` },
  }
}

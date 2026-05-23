"use client"

import { useState } from "react"
import { Plus, Trash2, ExternalLink, Lock, Cloud, AlertCircle, RefreshCw } from "lucide-react"
import { toast } from "sonner"
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
import { Switch } from "@/components/ui/switch"
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog"
import { useStore, useWorkspaceMcpServers } from "@/client/hooks/use-store"
import { useAuth } from "@/client/hooks/use-auth"
import {
  credentialFingerprint,
  getLocalCred,
  removeLocalCred,
  serializeCredentialHeader,
  setLocalCred,
  type McpCredentials,
} from "@/client/mcp/local-creds"
import { apiClient } from "@/client/api-client"
import { cn } from "@/shared/utils"
import type { McpCapabilities, McpCredentialMode, McpServer } from "@/shared/types"

/**
 * Workspace settings → MCP servers section. Stage 1 surface: list +
 * add + remove + enable toggle. Discovery and tool wiring land in
 * Stages 2-3 (see `docs/_done/PLAN-mcp-integration.md`).
 */
export function WorkspaceMcpSection({ workspaceId }: { workspaceId: string }) {
  const servers = useWorkspaceMcpServers().filter(
    (s) => s.workspaceId === workspaceId
  )
  const removeMcpServer = useStore((s) => s.removeMcpServer)
  const setMcpServerEnabled = useStore((s) => s.setMcpServerEnabled)
  const setMcpServerCapabilities = useStore((s) => s.setMcpServerCapabilities)

  const [addOpen, setAddOpen] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const pendingDelete =
    confirmDeleteId !== null
      ? servers.find((s) => s.id === confirmDeleteId)
      : null

  const refresh = async (server: McpServer) => {
    setRefreshingId(server.id)
    try {
      const cred = getLocalCred(server.id)
      const result = await apiClient.mcp.proxy(
        "discover",
        {
          server: {
            id: server.id,
            name: server.name,
            url: server.url,
            transport: server.transport,
          },
        },
        cred
          ? { credentialHeader: serializeCredentialHeader(cred) }
          : undefined
      )
      if (!result.ok) {
        toast.error(
          result.error.message ?? "Failed to reach MCP server",
          { description: `Status ${result.status}` }
        )
        return
      }
      const capabilities = result.data.capabilities as McpCapabilities | undefined
      if (!capabilities) {
        toast.error("Server returned no capabilities")
        return
      }
      setMcpServerCapabilities(server.id, capabilities)
      const toolCount = capabilities.tools?.length ?? 0
      const resourceCount = capabilities.resources?.length ?? 0
      toast.success(
        `Connected to ${server.name}`,
        {
          description:
            `${toolCount} ${toolCount === 1 ? "tool" : "tools"}` +
            `, ${resourceCount} ${resourceCount === 1 ? "resource" : "resources"}`,
        }
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshingId(null)
    }
  }

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
                {server.capabilities ? (
                  <div className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
                    {server.capabilities.tools?.length ?? 0} tools ·{" "}
                    {server.capabilities.resources?.length ?? 0} resources
                  </div>
                ) : (
                  <div className="text-[10px] text-[var(--muted-foreground)] italic mt-0.5">
                    Not discovered yet
                  </div>
                )}
              </div>
              <Switch
                checked={server.enabled}
                onCheckedChange={(v) => setMcpServerEnabled(server.id, v)}
                aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
                className="shrink-0"
              />
              <button
                type="button"
                onClick={() => void refresh(server)}
                disabled={refreshingId === server.id}
                aria-label={`Refresh capabilities for ${server.name}`}
                title="Refresh capabilities"
                className={cn(
                  "p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] transition-colors",
                  refreshingId === server.id && "animate-spin",
                  refreshingId !== server.id && "opacity-0 group-hover/mcp-row:opacity-100 focus-within:opacity-100"
                )}
              >
                <RefreshCw size={12} />
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
        Stage 2 of the MCP integration. See <code>docs/_done/PLAN-mcp-integration.md</code>.
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
  const setMcpServerCapabilities = useStore((s) => s.setMcpServerCapabilities)
  const auth = useAuth()
  // Cloud mode requires an authenticated Supabase session — the
  // encryption key + RPC live behind cookie-auth.
  const cloudAvailable = auth.status === "signed-in"
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
    if (credentialMode === "cloud" && !cloudAvailable) {
      return setError(
        "Cloud-stored credentials require sign-in. Sign in to enable, or " +
          "use Local mode (the credential stays on this device)."
      )
    }
    if (credentialMode === "cloud" && authType === "none") {
      return setError(
        'Cloud mode needs a credential. Pick "Bearer token" or switch to ' +
          "Local mode."
      )
    }
    setSubmitting(true)
    try {
      const cred: McpCredentials = buildCred(authType, token)

      if (credentialMode === "cloud") {
        // Cloud mode: create the row locally (no cred — we don't keep
        // a plaintext copy client-side), then immediately push the
        // encrypted version to Supabase via the dedicated route.
        // The local row gets the cred-encrypted "marker" by reading
        // back capabilities later via discover.
        const server: McpServer = addMcpServer({
          workspaceId,
          name: trimmedName,
          url: trimmedUrl,
          credentialMode: "cloud",
        })
        const upsert = await apiClient.mcp.upsertCloudServer({
          id: server.id,
          workspaceId,
          name: trimmedName,
          url: trimmedUrl,
          credentials: cred,
        })
        if (!upsert.ok) {
          setError(
            upsert.error.message ?? "Failed to save credential to Supabase."
          )
          // Roll back the local row — without the encrypted cred in
          // Supabase, the row would be useless and confusing.
          useStore.getState().removeMcpServer(server.id)
          return
        }
        // Discovery via the proxy uses the encrypted cred (header
        // omitted; route falls through to the Supabase decrypt path).
        void discoverInBackground(server, undefined, setMcpServerCapabilities)
        handleClose(false)
        return
      }

      // Local mode (existing flow).
      const fingerprint = await credentialFingerprint(cred)
      const server: McpServer = addMcpServer({
        workspaceId,
        name: trimmedName,
        url: trimmedUrl,
        credentialMode,
        credentialFingerprint: fingerprint,
      })
      if (authType !== "none") setLocalCred(server.id, cred)
      // Run discovery once so the row shows tool/resource counts
      // immediately. Failure here doesn't block adding — the user can
      // hit the refresh button later.
      void discoverInBackground(server, cred, setMcpServerCapabilities)
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
                description={cloudAvailable ? "Synced across devices" : "Sign in to enable"}
                icon={Cloud}
                active={credentialMode === "cloud"}
                onClick={() => cloudAvailable && setCredentialMode("cloud")}
                disabled={!cloudAvailable}
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

async function discoverInBackground(
  server: McpServer,
  /** Local-mode cred to send in the `X-MCP-Credentials` header.
   *  Pass undefined for cloud-mode servers — the proxy decrypts from
   *  Supabase by serverId. */
  cred: McpCredentials | undefined,
  setCapabilities: (id: string, caps: McpCapabilities) => void
): Promise<void> {
  try {
    const result = await apiClient.mcp.proxy(
      "discover",
      {
        server: {
          id: server.id,
          name: server.name,
          url: server.url,
          transport: server.transport,
        },
      },
      cred && cred.type !== "none"
        ? { credentialHeader: serializeCredentialHeader(cred) }
        : undefined
    )
    if (!result.ok) {
      toast.error(
        result.error.message ?? "Discovery failed",
        { description: "You can retry from the row's refresh button." }
      )
      return
    }
    const capabilities = result.data.capabilities as McpCapabilities | undefined
    if (capabilities) {
      setCapabilities(server.id, capabilities)
      const toolCount = capabilities.tools?.length ?? 0
      const resourceCount = capabilities.resources?.length ?? 0
      toast.success(
        `Connected to ${server.name}`,
        {
          description:
            `${toolCount} ${toolCount === 1 ? "tool" : "tools"}` +
            `, ${resourceCount} ${resourceCount === 1 ? "resource" : "resources"}`,
        }
      )
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Discovery failed")
  }
}

"use client"

import { useState } from "react"
import { Copy, Loader2, Check, MessageSquare, FileText, AlertCircle } from "lucide-react"
import { toast } from "sonner"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/shared/utils"
import { useAuth } from "@/client/hooks/use-auth"
import { copyText } from "@/client/export"
import { apiClient } from "@/client/api-client"

type ShareKind = "conversation" | "document"

interface ShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Target conversation for kind='conversation' shares. */
  conversationId: string
  /** Target document for kind='document' shares. Null when the active
   *  workspace has no documents yet — the Document option is disabled
   *  in that case. */
  documentId: string | null
}

/**
 * Modal that lets the user mint a public share link. Two kinds:
 *   - Conversation: read-only view of the message history.
 *   - Document:     read-only view of the currently open workspace doc.
 *
 * Anonymous users see a sign-in nudge — share rows need a `user_id` for
 * revocation and RLS, which requires an authenticated session.
 */
export function ShareDialog({ open, onOpenChange, conversationId, documentId }: ShareDialogProps) {
  const { status } = useAuth()
  const [kind, setKind] = useState<ShareKind>("conversation")
  const [creating, setCreating] = useState(false)
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const [createdKind, setCreatedKind] = useState<ShareKind | null>(null)
  const [copied, setCopied] = useState(false)

  const reset = () => {
    setCreatedToken(null)
    setCreatedKind(null)
    setCopied(false)
  }

  const handleClose = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const handleCreate = async () => {
    setCreating(true)
    try {
      const result = await apiClient.share.create(
        kind === "conversation"
          ? { kind: "conversation", conversationId }
          : { kind: "document", documentId: documentId! }
      )
      if (!result.ok || !result.data) {
        toast.error(
          result.error ?? `Couldn't create share (HTTP ${result.status})`
        )
        return
      }
      setCreatedToken(result.data.token)
      setCreatedKind(result.data.kind)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create share")
    } finally {
      setCreating(false)
    }
  }

  const url =
    createdToken && createdKind
      ? `${typeof window !== "undefined" ? window.location.origin : ""}/share/${createdKind}/${createdToken}`
      : null

  const handleCopy = async () => {
    if (!url) return
    try {
      await copyText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error("Failed to copy")
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share</DialogTitle>
          <DialogDescription>
            Create a read-only link anyone can open. Revoke it any time from
            the conversation menu.
          </DialogDescription>
        </DialogHeader>

        {status !== "signed-in" ? (
          <div className="flex items-start gap-2 rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-3 py-2.5 text-sm">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
            <p className="text-[var(--muted-foreground)]">
              Sharing needs a signed-in account so links can be revoked
              later. Sign in from the sidebar to enable this.
            </p>
          </div>
        ) : createdToken && url ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--muted-foreground)]">
              Anyone with this link can view your{" "}
              {createdKind === "document" ? "document" : "conversation"}.
            </p>
            <div className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-2 py-1.5">
              <code className="flex-1 truncate text-xs">{url}</code>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCopy}
                className="h-7 gap-1.5"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={reset}
              className="w-full justify-center text-xs"
            >
              Share something else
            </Button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <KindCard
                kind="conversation"
                active={kind === "conversation"}
                onClick={() => setKind("conversation")}
                icon={<MessageSquare size={16} />}
                title="Conversation"
                description="The full chat thread."
              />
              <KindCard
                kind="document"
                active={kind === "document"}
                onClick={() => documentId && setKind("document")}
                icon={<FileText size={16} />}
                title="Document"
                description={
                  documentId
                    ? "The currently open workspace document."
                    : "No document open."
                }
                disabled={!documentId}
              />
            </div>
            <Button
              onClick={handleCreate}
              disabled={creating || (kind === "document" && !documentId)}
              className="w-full mt-2"
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : null}
              {creating ? "Creating…" : "Create link"}
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function KindCard({
  active,
  onClick,
  icon,
  title,
  description,
  disabled = false,
}: {
  kind: ShareKind
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  title: string
  description: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      disabled={disabled}
      className={cn(
        "flex flex-col gap-1 px-3 py-2.5 text-left rounded-md border transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        disabled && "opacity-50 cursor-not-allowed",
        active
          ? "border-[var(--primary)] bg-[var(--primary)]/5"
          : "border-[var(--border)] hover:bg-[var(--accent)]"
      )}
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-sm font-medium">{title}</span>
      </div>
      <p className="text-[11px] text-[var(--muted-foreground)]">{description}</p>
    </button>
  )
}

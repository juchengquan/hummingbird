"use client"

import "client-only"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { useStore } from "@/client/hooks/use-store"
import { decodeSkillShareToken } from "@/shared/skills/user-skill-share"
import type { ShareableUserSkill } from "@/shared/skills/user-skill-types"

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
 * Listens for a `?import-skill=<token>` URL query on mount. Decodes the
 * shareable SKILL.md payload and pops a confirm modal asking whether to
 * import it (enabled) into the active workspace. Mirrors
 * `AgentImportListener`. See `docs/PLAN-portable-skills.md`.
 */
export function SkillImportListener() {
  const [shareable, setShareable] = useState<ShareableUserSkill | null>(null)
  const consumedRef = useRef(false)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const createUserSkill = useStore((s) => s.createUserSkill)

  useEffect(() => {
    if (consumedRef.current) return
    consumedRef.current = true
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const token = params.get("import-skill")
    if (!token) return
    const decoded = decodeSkillShareToken(token)
    // Always clear the param so a refresh doesn't re-prompt.
    params.delete("import-skill")
    const next = params.toString()
    window.history.replaceState(
      {},
      "",
      window.location.pathname + (next ? `?${next}` : "") + window.location.hash
    )
    if (!decoded) {
      toast.error("Couldn't decode the skill share URL")
      return
    }
    setShareable(decoded)
  }, [])

  if (!shareable) return null

  const handleConfirm = () => {
    if (!activeWorkspaceId) {
      toast.error("Open a workspace to import this skill into")
      return
    }
    createUserSkill({
      workspaceId: activeWorkspaceId,
      name: shareable.name,
      description: shareable.description,
      whenToUse: shareable.whenToUse,
      body: shareable.body,
      enabled: true,
    })
    setShareable(null)
    toast.success(`Imported skill "${shareable.name}"`)
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
          <DialogTitle>Import skill?</DialogTitle>
          <DialogDescription>
            A shared skill was attached to this URL. Import it into your active
            workspace? It will be enabled — its instructions apply to this
            workspace&apos;s chats until you turn it off.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <div className="font-medium">{shareable.name}</div>
          {shareable.description ? (
            <p className="text-[13px] text-[var(--muted-foreground)]">
              {shareable.description}
            </p>
          ) : null}
          {shareable.body ? (
            <p className="text-[12px] text-[var(--muted-foreground)] line-clamp-4 whitespace-pre-wrap border-l-2 border-[var(--border)] pl-2">
              {shareable.body}
            </p>
          ) : null}
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

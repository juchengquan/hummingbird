"use client"

import { useEffect, useRef, useState } from "react"
import {
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Sparkles,
  Download,
  Copy,
  Check,
  X,
  PanelRight,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  useStore,
  useActiveConversation,
  useActiveWorkspace,
} from "@/lib/hooks/use-store"
import {
  conversationToMarkdown,
  copyText,
  downloadAsFile,
  safeFilename,
} from "@/lib/export"
import { ConversationSummaryDialog } from "@/components/conversation-summary-dialog"
import { ResourcesMobileDrawer } from "@/components/sidebars/resources-mobile-drawer"
import { cn } from "@/lib/utils"

/**
 * Top-of-chat header showing the workspace → conversation breadcrumb plus a
 * compact actions menu. Designed to stay out of the way (light border-bottom,
 * no fill) while giving the user constant context about *where they are*
 * and one-click access to the most-used per-conversation actions.
 *
 * Renamed in place — click the title (or the Rename menu item) to flip into
 * an inline input. Esc cancels, Enter / blur saves. Mirrors the sidebar's
 * rename UX so the muscle memory transfers.
 */
export function ChatHeader() {
  const workspace = useActiveWorkspace()
  const conversation = useActiveConversation()
  const renameConversation = useStore((s) => s.renameConversation)
  const togglePin = useStore((s) => s.togglePin)
  const setActiveView = useStore((s) => s.setActiveView)

  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draftTitle, setDraftTitle] = useState("")
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [mobileResourcesOpen, setMobileResourcesOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [renaming])

  if (!conversation) return null

  const startRename = () => {
    setMenuOpen(false)
    setDraftTitle(conversation.title)
    setRenaming(true)
  }
  const saveRename = () => {
    const t = draftTitle.trim()
    if (t && t !== conversation.title) renameConversation(conversation.id, t)
    setRenaming(false)
  }
  const cancelRename = () => {
    setDraftTitle(conversation.title)
    setRenaming(false)
  }

  const handlePin = () => {
    setMenuOpen(false)
    togglePin(conversation.id)
  }

  const handleSummarise = () => {
    setMenuOpen(false)
    setSummaryOpen(true)
  }

  const handleExport = () => {
    setMenuOpen(false)
    const md = conversationToMarkdown(conversation)
    downloadAsFile(`${safeFilename(conversation.title)}.md`, md)
    toast.success("Conversation exported")
  }

  const handleCopy = async () => {
    setMenuOpen(false)
    try {
      await copyText(conversationToMarkdown(conversation))
      toast.success("Copied as Markdown")
    } catch {
      toast.error("Failed to copy to clipboard")
    }
  }

  return (
    <>
      <div className="shrink-0 h-11 flex items-center gap-2 px-4 border-b border-[var(--border)]">
        {/* Breadcrumb — workspace › conversation title */}
        <div className="flex-1 min-w-0 flex items-center gap-1.5 text-sm">
          {workspace && (
            <>
              <button
                type="button"
                onClick={() => setActiveView("workspaces")}
                className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors truncate max-w-[40%]"
                title={`Workspace: ${workspace.name}`}
              >
                {workspace.name}
              </button>
              <span className="text-[var(--muted-foreground)] shrink-0">›</span>
            </>
          )}
          {conversation.pinned && !renaming && (
            <Pin size={12} className="text-amber-500 shrink-0" />
          )}
          {renaming ? (
            <div className="flex-1 min-w-0 flex items-center gap-1">
              <input
                ref={inputRef}
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onBlur={saveRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveRename()
                  if (e.key === "Escape") cancelRename()
                }}
                className="flex-1 min-w-0 px-1 py-0.5 text-sm bg-background border border-input rounded focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={saveRename}
                className="h-6 w-6"
                aria-label="Save"
              >
                <Check size={12} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={cancelRename}
                className="h-6 w-6"
                aria-label="Cancel rename"
              >
                <X size={12} />
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={startRename}
              className="font-medium truncate text-[var(--foreground)] hover:text-[var(--foreground)]/80 transition-colors text-left"
              title="Click to rename"
            >
              {conversation.title}
            </button>
          )}
        </div>

        {/* Actions */}
        {!renaming && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileResourcesOpen(true)}
            className="h-7 w-7 shrink-0 text-[var(--muted-foreground)] lg:hidden"
            aria-label="Open resources panel"
            title="Resources"
          >
            <PanelRight size={14} />
          </Button>
        )}
        {!renaming && (
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-[var(--muted-foreground)]"
                aria-label="Conversation actions"
              >
                <MoreVertical size={14} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-44 p-1">
              <Button
                variant="ghost"
                onClick={handleSummarise}
                className={cn("w-full justify-start gap-2 cursor-pointer")}
              >
                <Sparkles size={14} />
                Summarise
              </Button>
              <Button
                variant="ghost"
                onClick={handlePin}
                className="w-full justify-start gap-2 cursor-pointer"
              >
                {conversation.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                {conversation.pinned ? "Unpin" : "Pin"}
              </Button>
              <Button
                variant="ghost"
                onClick={startRename}
                className="w-full justify-start gap-2 cursor-pointer"
              >
                <Pencil size={14} />
                Rename
              </Button>
              <Button
                variant="ghost"
                onClick={handleExport}
                className="w-full justify-start gap-2 cursor-pointer"
              >
                <Download size={14} />
                Export as .md
              </Button>
              <Button
                variant="ghost"
                onClick={handleCopy}
                className="w-full justify-start gap-2 cursor-pointer"
              >
                <Copy size={14} />
                Copy as Markdown
              </Button>
            </PopoverContent>
          </Popover>
        )}
      </div>

      <ConversationSummaryDialog
        conversation={summaryOpen ? conversation : null}
        onClose={() => setSummaryOpen(false)}
      />
      <ResourcesMobileDrawer
        open={mobileResourcesOpen}
        onOpenChange={setMobileResourcesOpen}
      />
    </>
  )
}

"use client"

import { useEffect, useRef, useState } from "react"
import {
  ChevronDown,
  FileText,
  Pencil,
  Pin,
  PinOff,
  Sparkles,
  Download,
  Copy,
  Check,
  X,
  PanelRight,
  Share2,
  GitBranch,
  Zap,
  Brain,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AUTO_MODEL_ID,
  CHAT_MODELS,
  ROUTING_AVAILABLE,
  modelSupportsReasoningEffort,
} from "@/shared/models"
import {
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "@/shared/reasoning-effort"

/** User-facing labels for the reasoning-effort tiers. The wire values
 *  stay `low`/`medium`/`high`; these are the friendlier surface. */
const REASONING_EFFORT_LABEL: Record<ReasoningEffort, string> = {
  low: "Fast",
  medium: "Balanced",
  high: "Thorough",
}
/** Radix Select can't use an empty-string value, so `null` (provider
 *  default) is represented by this sentinel in the control. */
const REASONING_EFFORT_DEFAULT = "default"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  useStore,
  useActiveConversation,
  useActiveWorkspace,
} from "@/client/hooks/use-store"
import {
  conversationToMarkdown,
  copyText,
  downloadAsFile,
  safeFilename,
} from "@/client/export"
import { ConversationSummaryDialog } from "@/components/conversation-summary-dialog"
import { ThreadInstructionsDialog } from "@/components/chat/thread-instructions-dialog"
import { ContextMeter } from "@/components/panels/context-meter"
import { CompressButton } from "@/components/chat/compress-button"
import { ResourcesMobileDrawer } from "@/components/sidebars/resources-mobile-drawer"
import { ShareDialog } from "@/components/share-dialog"
import { BranchesDialog } from "@/components/branches-dialog"
import { cn } from "@/shared/utils"

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
interface ChatHeaderProps {
  /** Current model id. */
  chatModel: string
  /** Called when the user picks a model from the header's model select.
   *  Owned by ChatPanel so it can chain a retry on the pending-error case. */
  onModelPick: (modelId: string) => void
  /** Controlled-open state for the model picker (lets ChatPanel pop it open
   *  programmatically when the user clicks `Change model` on an error). */
  modelPickerOpen: boolean
  onModelPickerOpenChange: (open: boolean) => void
  /** Reasoning-effort tier for the next turn (`null` = provider default).
   *  Only surfaced when the active model supports it. */
  chatReasoningEffort: ReasoningEffort | null
  onReasoningEffortPick: (effort: ReasoningEffort | null) => void
  /** "Run as task" mode — next send launches a long-running agent task
   *  in the Tasks panel instead of an inline chat turn. */
  runAsTask: boolean
  onRunAsTaskChange: (v: boolean) => void
}

export function ChatHeader({
  chatModel,
  onModelPick,
  modelPickerOpen,
  onModelPickerOpenChange,
  chatReasoningEffort,
  onReasoningEffortPick,
  runAsTask,
  onRunAsTaskChange,
}: ChatHeaderProps) {
  const workspace = useActiveWorkspace()
  const conversation = useActiveConversation()
  const renameConversation = useStore((s) => s.renameConversation)
  const setConversationMemoryOff = useStore((s) => s.setConversationMemoryOff)
  const togglePin = useStore((s) => s.togglePin)
  const setActiveView = useStore((s) => s.setActiveView)
  const activeDocumentId = useStore((s) => s.activeDocumentId)

  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draftTitle, setDraftTitle] = useState("")
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [threadInstructionsOpen, setThreadInstructionsOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [branchesOpen, setBranchesOpen] = useState(false)
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

  const handleThreadInstructions = () => {
    setMenuOpen(false)
    setThreadInstructionsOpen(true)
  }

  const handleToggleMemory = () => {
    setMenuOpen(false)
    // Checked = "use memory in this chat" (the default). Unchecking flips
    // `memoryOff` true, which the route/client honour as a per-conversation
    // bypass of fact injection + extraction.
    setConversationMemoryOff(conversation.id, !conversation.memoryOff)
  }

  const handleShare = () => {
    setMenuOpen(false)
    setShareOpen(true)
  }

  const handleBranches = () => {
    setMenuOpen(false)
    setBranchesOpen(true)
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
        {/* Mobile-only: SidebarTrigger lives inside the (closed) left sidebar
            on mobile, so we surface it here as an always-visible hamburger.
            md:hidden — desktop has the trigger in the sidebar header where
            users can already see it. */}
        <SidebarTrigger className="md:hidden -ml-2" />
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
            <>
              <button
                type="button"
                onClick={startRename}
                className="font-medium truncate text-[var(--foreground)] hover:text-[var(--foreground)]/80 transition-colors text-left"
                title="Click to rename"
              >
                {conversation.title}
              </button>
              {/* Title dropdown — chevron next to the title opens the
                  conversation actions menu (Summarise, Pin, Export, etc.). */}
              <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 text-[var(--muted-foreground)]"
                    aria-label="Conversation actions"
                  >
                    <ChevronDown size={14} />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-52 p-1">
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
                    onClick={handleThreadInstructions}
                    className={cn(
                      "w-full justify-start gap-2 cursor-pointer",
                      // Subtle dot when a non-empty conversation prompt is
                      // set, so the user can see at a glance that this
                      // thread has ad-hoc context attached.
                      conversation.systemPrompt.trim().length > 0 &&
                        "font-medium",
                    )}
                  >
                    <FileText size={14} />
                    {conversation.systemPrompt.trim().length > 0
                      ? "Thread instructions •"
                      : "Thread instructions"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={handleToggleMemory}
                    className={cn(
                      "w-full justify-start gap-2 cursor-pointer",
                      // Subtle marker when memory is off for this thread, so
                      // the user can see at a glance that recall/extraction
                      // is paused here.
                      conversation.memoryOff && "font-medium",
                    )}
                    role="menuitemcheckbox"
                    aria-checked={!conversation.memoryOff}
                  >
                    <Brain size={14} />
                    {conversation.memoryOff
                      ? "Use memory in this chat"
                      : "Use memory in this chat ✓"}
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
                  <Button
                    variant="ghost"
                    onClick={handleBranches}
                    className="w-full justify-start gap-2 cursor-pointer"
                  >
                    <GitBranch size={14} />
                    Branches
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={handleShare}
                    className="w-full justify-start gap-2 cursor-pointer"
                  >
                    <Share2 size={14} />
                    Share…
                  </Button>
                </PopoverContent>
              </Popover>
            </>
          )}
        </div>

        {/* Context-window meter — hides when there are no messages yet
            or the model is unknown. Sits to the left of the model picker
            so the user sees `used / total` alongside the model name.
            Followed by the Compress action when the meter is in the
            warn / danger zone and the conversation has enough headroom
            to be worth compressing. */}
        {!renaming && (
          <>
            <ContextMeter
              messages={conversation.messages}
              modelId={chatModel}
            />
            <CompressButton
              conversationId={conversation.id}
              messages={conversation.messages}
              modelId={chatModel}
            />
          </>
        )}

        {/* Model picker — moved here from the input bar so the bar can stay
            focused on text entry. ChatPanel owns the state so it can pop
            this open programmatically (e.g. when the user clicks
            `Change model` on an error). */}
        {!renaming && (
          <Select
            value={chatModel}
            onValueChange={onModelPick}
            open={modelPickerOpen}
            onOpenChange={onModelPickerOpenChange}
          >
            <SelectTrigger
              size="sm"
              className="h-7 text-xs gap-1 border-none bg-transparent hover:bg-[var(--secondary)] shrink-0 max-w-[180px]"
              aria-label="Model"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {/* Smart routing — picks the cheapest capable model per
                  message. Shown only when a routing pair is configured.
                  See docs/PLAN-model-routing.md. */}
              {ROUTING_AVAILABLE && (
                <SelectGroup>
                  <SelectItem value={AUTO_MODEL_ID}>Auto</SelectItem>
                </SelectGroup>
              )}
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
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Reasoning-effort dial — only for models that expose a
            thinking-budget / reasoning_effort knob. `Auto` (the sentinel)
            sends nothing, leaving the provider default. See
            docs/PLAN-reasoning-effort-control.md. */}
        {!renaming && modelSupportsReasoningEffort(chatModel) && (
          <Select
            value={chatReasoningEffort ?? REASONING_EFFORT_DEFAULT}
            onValueChange={(v) =>
              onReasoningEffortPick(
                v === REASONING_EFFORT_DEFAULT ? null : (v as ReasoningEffort)
              )
            }
          >
            <SelectTrigger
              size="sm"
              className="h-7 text-xs gap-1 border-none bg-transparent hover:bg-[var(--secondary)] shrink-0"
              aria-label="Reasoning effort"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value={REASONING_EFFORT_DEFAULT}>Auto effort</SelectItem>
              {REASONING_EFFORTS.map((effort) => (
                <SelectItem key={effort} value={effort}>
                  {REASONING_EFFORT_LABEL[effort]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Run-as-task toggle — when on, the next send launches a
            long-running agent task (Tasks panel) instead of a chat turn. */}
        {!renaming && (
          <Button
            variant={runAsTask ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onRunAsTaskChange(!runAsTask)}
            className={cn(
              "h-7 text-xs gap-1 shrink-0",
              runAsTask && "text-[var(--primary)]"
            )}
            aria-pressed={runAsTask}
            title="Run the next message as a long-running task"
          >
            <Zap size={14} />
            Task
          </Button>
        )}

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
      </div>

      <ConversationSummaryDialog
        conversation={summaryOpen ? conversation : null}
        onClose={() => setSummaryOpen(false)}
      />
      <ThreadInstructionsDialog
        conversation={threadInstructionsOpen ? conversation : null}
        onClose={() => setThreadInstructionsOpen(false)}
      />
      <ShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        conversationId={conversation.id}
        documentId={activeDocumentId}
      />
      <BranchesDialog
        open={branchesOpen}
        onOpenChange={setBranchesOpen}
        anchorConversationId={conversation.id}
      />
      <ResourcesMobileDrawer
        open={mobileResourcesOpen}
        onOpenChange={setMobileResourcesOpen}
      />
    </>
  )
}

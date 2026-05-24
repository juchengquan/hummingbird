"use client"
import "client-only"

/**
 * Categorized context manager that sits to the left of the chat
 * textarea. Replaces the old `+` attach button. One small trigger
 * button → a popover with sections per attached-context kind, each
 * section listing current items + an "Add" affordance that flips the
 * right rail to the matching tab.
 *
 * Skills get a different × semantic from everything else: clicking ×
 * mutes the skill for the *next send only*, not permanently. The
 * permanent on/off lives in the right-rail Skills tab. The mute state
 * is owned by the chat panel (it has to survive across sends) and
 * passed in as `mutedSkillIds` + `onToggleMute`.
 */

import { useEffect, useRef } from "react"
import {
  FileText,
  Image as ImageIcon,
  Lock,
  Paperclip,
  Pause,
  Plus,
  Server,
  Wrench,
  X,
  Bookmark as BookmarkIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/shared/utils"
import { formatFileSize } from "@/client/file-utils"
import { useStore } from "@/client/hooks/use-store"
import {
  useAttachedContext,
  type AttachedBookmark,
  type AttachedFile,
  type AttachedMcpResource,
  type AttachedSkill,
} from "@/client/hooks/use-attached-context"
import type { SkillId } from "@/shared/skills/types"

export interface ContextPickerProps {
  /** Open state — lifted to the chat panel so the inline preview's
   *  `+N` overflow chip can trigger the popover. */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Set of skill ids the user has muted for the *next* send. Owned by
   *  the chat panel. */
  mutedSkillIds: Set<SkillId>
  /** Toggle a skill's mute-for-next-send flag. */
  onToggleMute: (skillId: SkillId) => void
  /** Open the hidden file input from the chat panel. Used by the
   *  picker's "Add file" action so the same upload path is reused. */
  onPickFile: () => void
}

export function ContextPicker({
  open,
  onOpenChange,
  mutedSkillIds,
  onToggleMute,
  onPickFile,
}: ContextPickerProps) {
  const ctx = useAttachedContext()

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-2 rounded-full relative transition-transform hover:scale-110 active:scale-95"
          aria-label={
            ctx.totalCount === 0
              ? "Attach context"
              : `Context — ${ctx.totalCount} attached`
          }
          title={
            ctx.totalCount === 0
              ? "Attach context"
              : `${ctx.totalCount} attached`
          }
        >
          <Paperclip size={18} />
          {ctx.totalCount > 0 && (
            <span
              aria-hidden
              className={cn(
                "absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full",
                "bg-[var(--primary)] text-[var(--primary-foreground)]",
                "text-[10px] font-medium leading-none tabular-nums",
                "inline-flex items-center justify-center"
              )}
            >
              {ctx.totalCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-80 max-h-[60vh] overflow-y-auto p-0"
      >
        <PickerBody
          ctx={ctx}
          mutedSkillIds={mutedSkillIds}
          onToggleMute={onToggleMute}
          onPickFile={onPickFile}
          onClose={() => onOpenChange(false)}
        />
      </PopoverContent>
    </Popover>
  )
}

function PickerBody({
  ctx,
  mutedSkillIds,
  onToggleMute,
  onPickFile,
  onClose,
}: {
  ctx: ReturnType<typeof useAttachedContext>
  mutedSkillIds: Set<SkillId>
  onToggleMute: (skillId: SkillId) => void
  onPickFile: () => void
  onClose: () => void
}) {
  const setActiveView = useStore((s) => s.setActiveView)
  const setResourcesSidebarOpen = useStore(
    (s) => s.setResourcesSidebarOpen
  )
  const setResourcesSidebarTab = useStore(
    (s) => s.setResourcesSidebarTab
  )
  const toggleConversationFileSelection = useStore(
    (s) => s.toggleConversationFileSelection
  )
  const removeConversationFile = useStore((s) => s.removeConversationFile)
  const activeConversationId = useStore((s) => s.activeConversationId)
  const toggleConversationUrlBookmarkSelection = useStore(
    (s) => s.toggleConversationUrlBookmarkSelection
  )
  const toggleConversationMcpResourceSelection = useStore(
    (s) => s.toggleConversationMcpResourceSelection
  )

  // Jump to a right-rail tab — open the rail if it isn't already and
  // switch tab. The chat view stays active so the user can keep
  // typing; they just see the rail change behind the popover.
  const jumpToTab = (
    tab: "files" | "notes" | "artifacts" | "skills" | "pins" | "mcp" | "links"
  ) => {
    setActiveView("chat")
    setResourcesSidebarOpen(true)
    setResourcesSidebarTab(tab)
    onClose()
  }

  // Tab/Backspace navigation across rows. Refs keep the ordered list of
  // focusable detach buttons so Backspace from a focused row fires its
  // own click.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Backspace") return
      const active = document.activeElement
      if (!(active instanceof HTMLElement) || !root.contains(active)) return
      const btn = active.closest("[data-detach]") as HTMLButtonElement | null
      if (btn) {
        e.preventDefault()
        btn.click()
      }
    }
    root.addEventListener("keydown", onKey)
    return () => root.removeEventListener("keydown", onKey)
  }, [])

  return (
    <div ref={rootRef} className="py-1.5">
      {/* Skills */}
      <Section title="Skills">
        {ctx.skills.length === 0 ? (
          <EmptyHint>No skills enabled.</EmptyHint>
        ) : (
          ctx.skills.map((s) => (
            <SkillRow
              key={s.id}
              skill={s}
              muted={mutedSkillIds.has(s.id)}
              onToggleMute={() => onToggleMute(s.id)}
            />
          ))
        )}
        <AddRow onClick={() => jumpToTab("skills")} label="Manage skills" />
      </Section>

      <Divider />

      {/* Files: workspace + conversation merged for compactness, but
          differentiated visually so the user knows which lane each is in. */}
      <Section title="Files">
        {ctx.workspaceFiles.length === 0 && ctx.conversationFiles.length === 0 ? (
          <EmptyHint>No files attached.</EmptyHint>
        ) : (
          <>
            {ctx.workspaceFiles.map((f) => (
              <FileRow
                key={f.id}
                file={f}
                onDetach={() => toggleConversationFileSelection(f.id)}
              />
            ))}
            {ctx.conversationFiles.map((f) => (
              <FileRow
                key={f.id}
                file={f}
                onDetach={() => {
                  if (activeConversationId)
                    removeConversationFile(activeConversationId, f.id)
                }}
              />
            ))}
          </>
        )}
        <AddRow onClick={onPickFile} label="Upload file" />
        <AddRow
          onClick={() => jumpToTab("files")}
          label="Browse workspace files"
        />
      </Section>

      <Divider />

      {/* URL bookmarks */}
      <Section title="Bookmarks">
        {ctx.bookmarks.length === 0 ? (
          <EmptyHint>No URLs attached.</EmptyHint>
        ) : (
          ctx.bookmarks.map((b) => (
            <BookmarkRow
              key={b.id}
              bookmark={b}
              onDetach={() => toggleConversationUrlBookmarkSelection(b.id)}
            />
          ))
        )}
        <AddRow onClick={() => jumpToTab("links")} label="Add URL" />
      </Section>

      {ctx.mcpResources.length > 0 || true ? (
        <>
          <Divider />
          {/* MCP resources */}
          <Section title="MCP resources">
            {ctx.mcpResources.length === 0 ? (
              <EmptyHint>No resources attached.</EmptyHint>
            ) : (
              ctx.mcpResources.map((r) => (
                <McpRow
                  key={r.id}
                  resource={r}
                  onDetach={() => toggleConversationMcpResourceSelection(r.id)}
                />
              ))
            )}
            <AddRow
              onClick={() => jumpToTab("mcp")}
              label="Manage MCP servers"
            />
          </Section>
        </>
      ) : null}
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="px-2">
      <p className="px-1.5 py-1 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] font-medium">
        {title}
      </p>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  )
}

function Divider() {
  return <div className="my-1.5 h-px bg-[var(--border)] mx-2" />
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <li className="px-1.5 py-1 text-[11px] text-[var(--muted-foreground)] italic">
      {children}
    </li>
  )
}

function SkillRow({
  skill,
  muted,
  onToggleMute,
}: {
  skill: AttachedSkill
  muted: boolean
  onToggleMute: () => void
}) {
  const Icon = skill.icon
  return (
    <li>
      <div
        className={cn(
          "group/row flex items-center gap-2 rounded-md px-1.5 py-1.5",
          "hover:bg-[var(--accent)] transition-colors",
          muted && "opacity-60"
        )}
      >
        <Icon
          size={14}
          className={cn(
            "shrink-0",
            muted ? "text-[var(--muted-foreground)]" : "text-[var(--foreground)]"
          )}
        />
        <span
          className={cn(
            "text-xs flex-1 min-w-0 truncate",
            muted && "line-through"
          )}
        >
          {skill.name}
        </span>
        {muted && (
          <span className="text-[10px] text-[var(--muted-foreground)] italic">
            paused
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-detach
              onClick={onToggleMute}
              aria-label={
                muted ? `Resume ${skill.name}` : `Pause ${skill.name} for next send`
              }
              className={cn(
                "shrink-0 size-5 inline-flex items-center justify-center rounded",
                "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--background)]",
                "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
                "transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
              )}
            >
              {muted ? <Plus size={12} /> : <Pause size={12} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-[200px]">
            {muted
              ? "Resume this skill for the next send."
              : "Pause this skill for the next send only. Restored automatically afterwards."}
          </TooltipContent>
        </Tooltip>
      </div>
    </li>
  )
}

function FileRow({
  file,
  onDetach,
}: {
  file: AttachedFile
  onDetach: () => void
}) {
  const isPrivate = file.kind === "conversationFile"
  const isImage = file.type.startsWith("image/")
  return (
    <li>
      <div
        className={cn(
          "group/row flex items-center gap-2 rounded-md px-1.5 py-1.5",
          "hover:bg-[var(--accent)] transition-colors"
        )}
      >
        {isImage ? (
          <ImageIcon
            size={14}
            className="shrink-0 text-[var(--muted-foreground)]"
          />
        ) : (
          <FileText
            size={14}
            className="shrink-0 text-[var(--muted-foreground)]"
          />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-xs truncate">{file.name}</p>
          <p className="text-[10px] text-[var(--muted-foreground)] flex items-center gap-1">
            {formatFileSize(file.size)}
            {isPrivate && (
              <>
                <span aria-hidden>·</span>
                <Lock size={9} aria-hidden />
                <span>only this chat</span>
              </>
            )}
          </p>
        </div>
        <DetachButton onClick={onDetach} label={`Detach ${file.name}`} />
      </div>
    </li>
  )
}

function BookmarkRow({
  bookmark,
  onDetach,
}: {
  bookmark: AttachedBookmark
  onDetach: () => void
}) {
  return (
    <li>
      <div
        className={cn(
          "group/row flex items-center gap-2 rounded-md px-1.5 py-1.5",
          "hover:bg-[var(--accent)] transition-colors"
        )}
      >
        <BookmarkIcon size={14} className="shrink-0 text-[var(--muted-foreground)]" />
        <div className="flex-1 min-w-0">
          <p className="text-xs truncate">{bookmark.title}</p>
          <p className="text-[10px] text-[var(--muted-foreground)] truncate">
            {bookmark.url}
          </p>
        </div>
        <DetachButton onClick={onDetach} label={`Detach ${bookmark.title}`} />
      </div>
    </li>
  )
}

function McpRow({
  resource,
  onDetach,
}: {
  resource: AttachedMcpResource
  onDetach: () => void
}) {
  return (
    <li>
      <div
        className={cn(
          "group/row flex items-center gap-2 rounded-md px-1.5 py-1.5",
          "hover:bg-[var(--accent)] transition-colors"
        )}
      >
        <Server size={14} className="shrink-0 text-[var(--muted-foreground)]" />
        <div className="flex-1 min-w-0">
          <p className="text-xs truncate">{resource.name}</p>
          <p className="text-[10px] text-[var(--muted-foreground)] truncate flex items-center gap-1">
            <Wrench size={9} aria-hidden />
            {resource.serverName}
          </p>
        </div>
        <DetachButton onClick={onDetach} label={`Detach ${resource.name}`} />
      </div>
    </li>
  )
}

function DetachButton({
  onClick,
  label,
}: {
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      data-detach
      onClick={onClick}
      aria-label={label}
      className={cn(
        "shrink-0 size-5 inline-flex items-center justify-center rounded",
        "text-[var(--muted-foreground)] hover:text-[var(--destructive)] hover:bg-[var(--background)]",
        "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
        "transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
      )}
    >
      <X size={12} />
    </button>
  )
}

function AddRow({
  onClick,
  label,
}: {
  onClick: () => void
  label: string
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "w-full flex items-center gap-2 rounded-md px-1.5 py-1.5 text-left",
          "text-[11px] text-[var(--muted-foreground)]",
          "hover:bg-[var(--accent)] hover:text-[var(--foreground)] transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
        )}
      >
        <Plus size={12} className="shrink-0" />
        <span>{label}</span>
      </button>
    </li>
  )
}

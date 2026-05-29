"use client"

/**
 * Custom React Flow node renderers for the workspace canvas.
 *
 * Each projected node (message / artifact / note / file / url-bookmark)
 * resolves its body from the live Zustand store by id at render time —
 * so edits to the underlying row reflect on the canvas without pushing
 * data back through React Flow. When the backing row is gone the node
 * renders a muted "removed" placeholder (pruned from canvas_state on the
 * next re-seed). Sticky nodes have no backing row: their text lives in
 * the node data and persists to `canvas_state`.
 *
 * Node `id` IS the underlying row id (or a generated id for stickies),
 * so a given object appears on the canvas at most once.
 */

import { memo, useCallback } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import {
  Boxes,
  MessageSquare,
  type LucideIcon,
  NotebookPen,
  Paperclip,
  StickyNote,
  Link2,
} from "lucide-react"

import { useStore } from "@/client/hooks/use-store"
import { focusCanvasNode } from "@/client/canvas/use-canvas-focus"
import { cn } from "@/shared/utils"
import type { CanvasNodeKind } from "@/shared/canvas/types"

/** Shape carried in each React Flow node's `data`. Only sticky uses the
 *  content / onStickyChange fields. */
export interface CanvasNodeData {
  kind: CanvasNodeKind
  content?: string
  onStickyChange?: (content: string) => void
  [key: string]: unknown
}

// --- shared card chrome -----------------------------------------------------

const CARD = cn(
  "w-[220px] rounded-lg border bg-[var(--card)] text-[var(--card-foreground)]",
  "border-[var(--border)] shadow-sm overflow-hidden",
  "transition-shadow hover:shadow-md"
)

const HANDLE = cn(
  "!h-2 !w-2 !rounded-full !border !border-[var(--border)] !bg-[var(--muted)]"
)

function NodeShell({
  icon: Icon,
  label,
  accent,
  onOpen,
  children,
}: {
  icon: LucideIcon
  label: string
  accent: string
  onOpen?: () => void
  children: React.ReactNode
}) {
  return (
    <div className={CARD}>
      <Handle type="target" position={Position.Left} className={HANDLE} />
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        className={cn(
          "w-full text-left",
          onOpen && "cursor-pointer"
        )}
      >
        <div
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1.5 border-b border-[var(--border)]",
            "text-[10px] font-medium uppercase tracking-wide"
          )}
          style={{ color: accent }}
        >
          <Icon size={11} className="shrink-0" />
          <span className="truncate">{label}</span>
        </div>
        <div className="px-2.5 py-2 text-xs leading-snug text-[var(--foreground)]">
          {children}
        </div>
      </button>
      <Handle type="source" position={Position.Right} className={HANDLE} />
    </div>
  )
}

function RemovedShell({ icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <NodeShell icon={icon} label={label} accent="var(--muted-foreground)">
      <span className="italic text-[var(--muted-foreground)]">
        (item removed)
      </span>
    </NodeShell>
  )
}

function clamp(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

// --- chat-message -----------------------------------------------------------

const MessageNode = memo(function MessageNode({ id }: NodeProps) {
  const message = useStore((s) => {
    for (const c of s.conversations) {
      const m = c.messages.find((mm) => mm.id === id)
      if (m) return m
    }
    return undefined
  })
  if (!message) return <RemovedShell icon={MessageSquare} label="Message" />
  return (
    <NodeShell
      icon={MessageSquare}
      label={message.role === "user" ? "You" : "Assistant"}
      accent="var(--primary)"
      onOpen={() => focusCanvasNode("chat-message", id)}
    >
      {clamp(message.content) || (
        <span className="italic text-[var(--muted-foreground)]">(empty)</span>
      )}
    </NodeShell>
  )
})

// --- artifact ---------------------------------------------------------------

const ArtifactNode = memo(function ArtifactNode({ id }: NodeProps) {
  const artifact = useStore((s) => s.artifacts.find((a) => a.id === id))
  if (!artifact) return <RemovedShell icon={Boxes} label="Artifact" />
  return (
    <NodeShell
      icon={Boxes}
      label={artifact.kind}
      accent="var(--primary)"
      onOpen={() => focusCanvasNode("artifact", id)}
    >
      <div className="font-medium truncate mb-0.5">
        {artifact.title || "Untitled"}
      </div>
      <div className="text-[var(--muted-foreground)] font-mono text-[10px]">
        {clamp(artifact.content, 100)}
      </div>
    </NodeShell>
  )
})

// --- note -------------------------------------------------------------------

const NoteNode = memo(function NoteNode({ id }: NodeProps) {
  const note = useStore((s) => s.notes.find((n) => n.id === id))
  if (!note) return <RemovedShell icon={NotebookPen} label="Note" />
  return (
    <NodeShell
      icon={NotebookPen}
      label="Note"
      accent="var(--primary)"
      onOpen={() => focusCanvasNode("note", id)}
    >
      {clamp(note.body) || (
        <span className="italic text-[var(--muted-foreground)]">
          (empty note)
        </span>
      )}
    </NodeShell>
  )
})

// --- file -------------------------------------------------------------------

const FileNode = memo(function FileNode({ id }: NodeProps) {
  const file = useStore((s) => s.files.find((f) => f.id === id))
  if (!file || file.deletedAt) return <RemovedShell icon={Paperclip} label="File" />
  return (
    <NodeShell
      icon={Paperclip}
      label="File"
      accent="var(--primary)"
      onOpen={() => focusCanvasNode("file", id)}
    >
      <div className="font-medium truncate">{file.name}</div>
      <div className="text-[var(--muted-foreground)] text-[10px] mt-0.5">
        {file.type || "unknown type"}
      </div>
    </NodeShell>
  )
})

// --- url-bookmark -----------------------------------------------------------

const UrlBookmarkNode = memo(function UrlBookmarkNode({ id }: NodeProps) {
  const bookmark = useStore((s) => s.urlBookmarks.find((b) => b.id === id))
  if (!bookmark || bookmark.deletedAt) {
    return <RemovedShell icon={Link2} label="Link" />
  }
  return (
    <NodeShell
      icon={Link2}
      label="Link"
      accent="var(--primary)"
      onOpen={() => focusCanvasNode("url-bookmark", id)}
    >
      <div className="font-medium truncate mb-0.5">{bookmark.title}</div>
      <div className="text-[var(--muted-foreground)] text-[10px] truncate">
        {bookmark.url}
      </div>
    </NodeShell>
  )
})

// --- sticky -----------------------------------------------------------------

const StickyNodeComp = memo(function StickyNodeComp({ id, data }: NodeProps) {
  const d = data as CanvasNodeData
  const onStickyChange = d.onStickyChange
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onStickyChange?.(e.target.value)
    },
    [onStickyChange]
  )
  return (
    <div
      className={cn(
        "w-[200px] rounded-lg border shadow-sm overflow-hidden",
        "border-amber-300/60 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800/60"
      )}
    >
      <Handle type="target" position={Position.Left} className={HANDLE} />
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
        <StickyNote size={11} className="shrink-0" />
        <span>Note</span>
      </div>
      <textarea
        value={typeof d.content === "string" ? d.content : ""}
        onChange={handleChange}
        // Stop drag-start so typing/selecting inside the textarea doesn't
        // pan the node; RF treats `nodrag` as a no-drag zone.
        className={cn(
          "nodrag w-full resize-none bg-transparent px-2.5 pb-2 text-xs leading-snug",
          "text-amber-900 dark:text-amber-100 outline-none",
          "placeholder:text-amber-700/50 dark:placeholder:text-amber-400/40"
        )}
        rows={4}
        placeholder="Type a note…"
        data-node-id={id}
      />
      <Handle type="source" position={Position.Right} className={HANDLE} />
    </div>
  )
})

export const canvasNodeTypes = {
  "chat-message": MessageNode,
  artifact: ArtifactNode,
  note: NoteNode,
  file: FileNode,
  "url-bookmark": UrlBookmarkNode,
  sticky: StickyNodeComp,
}

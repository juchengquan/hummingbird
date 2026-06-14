"use client"

import { useEffect, useState } from "react"
import { format } from "date-fns"
import {
  Archive,
  Code2,
  Eye,
  FileText,
  Braces,
  Pin,
  PinOff,
  Trash2,
  Copy,
  Send,
  Pencil,
  Check,
  X,
  Image as ImageIcon,
  Table,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/shared/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  useStore,
  useWorkspaceArtifacts,
  useConversationSelectedArtifactIds,
} from "@/client/hooks/use-store"
import { copyText } from "@/client/export"
import { TabEmptyState } from "@/components/panels/tab-empty-state"
import { CodeHighlight, JsonHighlight } from "@/components/code-highlight"
import { MarkdownPreview } from "@/components/markdown-preview"
import { detectArtifactShell } from "@/client/live-artifact/detect"
import { openLiveArtifact } from "@/components/right-panel-slot"
import type { Artifact } from "@/shared/types"
import { CitationTableView } from "@/components/panels/citation-table"
import { parseCitationTable } from "@/shared/artifacts/citation-table"
import { citationTableMarkerMarkdown } from "@/shared/artifacts/citation-table-md"

function artifactKindIcon(artifact: Artifact) {
  if (artifact.kind === "code") return <Code2 size={12} />
  if (artifact.kind === "json") return <Braces size={12} />
  if (artifact.kind === "image") return <ImageIcon size={12} />
  if (artifact.kind === "table") return <Table size={12} />
  return <FileText size={12} />
}

function asMarkdownForEditor(artifact: Artifact): string {
  if (artifact.kind === "code") {
    return `\`\`\`${artifact.language ?? ""}\n${artifact.content}\n\`\`\``
  }
  if (artifact.kind === "json") {
    let pretty = artifact.content
    try {
      pretty = JSON.stringify(JSON.parse(artifact.content), null, 2)
    } catch {
      /* leave raw */
    }
    return `\`\`\`json\n${pretty}\n\`\`\``
  }
  if (artifact.kind === "image") {
    const src = artifact.storagePath ?? artifact.content
    return artifact.content
      ? `![${artifact.content.slice(0, 60)}](${src})`
      : `![](${src})`
  }
  if (artifact.kind === "table") {
    return citationTableMarkerMarkdown(artifact.id)
  }
  return artifact.content
}

export function ArtifactsTab() {
  const artifacts = useWorkspaceArtifacts()
  const selectedIds = useConversationSelectedArtifactIds()
  const deleteArtifact = useStore((s) => s.deleteArtifact)
  const togglePinArtifact = useStore((s) => s.togglePinArtifact)
  const updateArtifactTitle = useStore((s) => s.updateArtifactTitle)
  const updateArtifactContent = useStore((s) => s.updateArtifactContent)
  const appendToActiveDocumentOrCreate = useStore(
    (s) => s.appendToActiveDocumentOrCreate
  )
  const requestEditorReload = useStore((s) => s.requestEditorReload)
  const setActiveView = useStore((s) => s.setActiveView)
  const toggleSelection = useStore((s) => s.toggleConversationArtifactSelection)

  const [openId, setOpenId] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])

  const open = openId ? artifacts.find((a) => a.id === openId) ?? null : null

  const handleSendToEditor = (a: Artifact) => {
    appendToActiveDocumentOrCreate(asMarkdownForEditor(a))
    requestEditorReload()
    setActiveView("editor")
    setOpenId(null)
    toast.success("Sent to editor")
  }

  const handleCopy = async (a: Artifact) => {
    try {
      await copyText(a.content)
      toast.success("Copied")
    } catch {
      toast.error("Failed to copy")
    }
  }

  const handleDelete = (a: Artifact) => {
    deleteArtifact(a.id)
    if (openId === a.id) setOpenId(null)
  }


  return (
    <>
      <div className="shrink-0 h-11 px-3 border-b border-[var(--border)] flex items-center">
        <p className="text-[11px] text-[var(--muted-foreground)]">
          {artifacts.length === 0
            ? "No artifacts yet"
            : `${artifacts.length} ${artifacts.length === 1 ? "artifact" : "artifacts"}`}
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1">
        {artifacts.length === 0 ? (
          <TabEmptyState icon={Archive}>
            Click the <strong>archive</strong> icon on an assistant message
            to save code blocks or the full reply as an artifact.
          </TabEmptyState>
        ) : (
          artifacts.map((a) => {
            const attached = selectedIds.includes(a.id)
            return (
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              onClick={() => toggleSelection(a.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  toggleSelection(a.id)
                }
              }}
              aria-pressed={attached}
              className={cn(
                "w-full text-left px-2 py-1.5 rounded-md transition-colors flex items-start gap-2 cursor-pointer",
                "hover:bg-[var(--accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                attached && "bg-[var(--primary)]/10 ring-1 ring-[var(--primary)]/40",
                a.pinned && !attached && "bg-[var(--primary)]/5"
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 shrink-0 size-4 rounded-[4px] border inline-flex items-center justify-center transition-colors",
                  attached
                    ? "bg-[var(--primary)] border-[var(--primary)] text-[var(--primary-foreground)]"
                    : "border-[var(--border)] bg-transparent"
                )}
              >
                {attached && <Check size={12} strokeWidth={3} />}
              </span>
              <span className="mt-0.5 shrink-0 text-[var(--muted-foreground)]">
                {artifactKindIcon(a)}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  {a.pinned && (
                    <Pin size={10} className="text-amber-500 shrink-0" />
                  )}
                  <span className="text-xs font-medium truncate">{a.title}</span>
                </div>
                <div className="text-[10px] text-[var(--muted-foreground)] flex items-center gap-1.5">
                  {a.kind === "code" && a.language && (
                    <span className="px-1 py-px rounded bg-[var(--secondary)] font-mono">
                      {a.language}
                    </span>
                  )}
                  {a.kind === "image" && (
                    <span className="px-1 py-px rounded bg-[var(--secondary)]">
                      image
                    </span>
                  )}
                  {mounted && <span>{format(new Date(a.createdAt), "MMM d, h:mm a")}</span>}
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setOpenId(a.id)
                }}
                aria-label={`Preview ${a.title}`}
                title="Preview"
                className="p-0.5 rounded text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] transition-colors mt-0.5"
              >
                <Eye size={12} />
              </button>
            </div>
          )})
        )}
      </div>

      <ArtifactPreviewDialog
        artifact={open}
        onClose={() => setOpenId(null)}
        onCopy={handleCopy}
        onSendToEditor={handleSendToEditor}
        onTogglePin={(a) => togglePinArtifact(a.id)}
        onRename={(a, t) => updateArtifactTitle(a.id, t)}
        onDelete={handleDelete}
        onChangeContent={(a, content) => updateArtifactContent(a.id, content)}
      />
    </>
  )
}

interface ArtifactPreviewDialogProps {
  artifact: Artifact | null
  onClose: () => void
  onCopy: (a: Artifact) => void
  onSendToEditor: (a: Artifact) => void
  onTogglePin: (a: Artifact) => void
  onRename: (a: Artifact, title: string) => void
  onDelete: (a: Artifact) => void
  onChangeContent: (a: Artifact, content: string) => void
}

function ArtifactPreviewDialog({
  artifact,
  onClose,
  onCopy,
  onSendToEditor,
  onTogglePin,
  onRename,
  onDelete,
  onChangeContent,
}: ArtifactPreviewDialogProps) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState("")

  const startEditTitle = () => {
    if (!artifact) return
    setTitleDraft(artifact.title)
    setEditingTitle(true)
  }
  const saveTitle = () => {
    if (!artifact) return
    const t = titleDraft.trim()
    if (t && t !== artifact.title) onRename(artifact, t)
    setEditingTitle(false)
  }

  return (
    <Dialog
      open={artifact !== null}
      onOpenChange={(v) => {
        if (!v) {
          setEditingTitle(false)
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 min-w-0">
            {artifact &&
              (artifact.kind === "code" ? (
                <Code2 size={14} />
              ) : artifact.kind === "json" ? (
                <Braces size={14} />
              ) : artifact.kind === "image" ? (
                <ImageIcon size={14} />
              ) : (
                <FileText size={14} />
              ))}
            {editingTitle ? (
              <div className="flex-1 flex items-center gap-1">
                <Input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveTitle()
                    if (e.key === "Escape") setEditingTitle(false)
                  }}
                  autoFocus
                  className="h-7 text-sm"
                />
                <Button size="icon" variant="ghost" onClick={saveTitle} className="h-7 w-7">
                  <Check size={14} />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setEditingTitle(false)}
                  className="h-7 w-7"
                >
                  <X size={14} />
                </Button>
              </div>
            ) : (
              <>
                <span className="truncate">{artifact?.title}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={startEditTitle}
                  className="h-6 w-6 text-[var(--muted-foreground)]"
                  aria-label="Rename"
                >
                  <Pencil size={12} />
                </Button>
              </>
            )}
            {artifact?.kind === "code" && artifact.language && (
              <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-[var(--secondary)] font-mono text-[var(--muted-foreground)]">
                {artifact.language}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-auto rounded-md border border-[var(--border)] bg-[var(--background)]">
          {artifact?.kind === "code" ? (
            <CodeHighlight code={artifact.content} language={artifact.language} />
          ) : artifact?.kind === "json" ? (
            <JsonHighlight content={artifact.content} />
          ) : artifact?.kind === "markdown" ? (
            <MarkdownPreview content={artifact.content} />
          ) : artifact?.kind === "image" ? (
            <div className="flex flex-col items-center p-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- data: URLs + signed Supabase URLs with unknown dimensions; next/image doesn't fit. */}
              <img
                src={artifact.storagePath ?? artifact.content}
                alt={artifact.title}
                className="max-w-full max-h-[50vh] rounded-md object-contain"
              />
              {artifact.content && (
                <p className="mt-3 text-xs text-[var(--muted-foreground)] text-center max-w-md">
                  {artifact.content}
                </p>
              )}
            </div>
          ) : artifact?.kind === "table" ? (
            (() => {
              const table = parseCitationTable(artifact.content)
              return table ? (
                <CitationTableView
                  data={table}
                  onChange={(next) =>
                    onChangeContent(artifact, JSON.stringify(next))
                  }
                />
              ) : (
                <pre className="text-xs p-3 whitespace-pre-wrap break-words font-mono">
                  {artifact.content}
                </pre>
              )
            })()
          ) : (
            <pre className="text-xs p-3 whitespace-pre-wrap break-words font-mono">
              {artifact?.content}
            </pre>
          )}
        </div>

        {artifact && (
          <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-[var(--border)]">
            {artifact.kind === "code" &&
              detectArtifactShell({
                language: artifact.language,
                content: artifact.content,
              }).renderable && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => openLiveArtifact({ artifactId: artifact.id })}
                  className="gap-1.5"
                >
                  <Eye size={12} />
                  Preview
                </Button>
              )}
            <Button size="sm" variant="secondary" onClick={() => onSendToEditor(artifact)} className="gap-1.5">
              <Send size={12} />
              Send to editor
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onCopy(artifact)} className="gap-1.5">
              <Copy size={12} />
              Copy
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onTogglePin(artifact)}
              className={cn("gap-1.5", artifact.pinned && "text-amber-500")}
            >
              {artifact.pinned ? <PinOff size={12} /> : <Pin size={12} />}
              {artifact.pinned ? "Unpin" : "Pin"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDelete(artifact)}
              className="ml-auto gap-1.5 text-[var(--destructive)] hover:text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
            >
              <Trash2 size={12} />
              Delete
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

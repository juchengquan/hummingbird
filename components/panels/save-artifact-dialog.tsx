"use client"

import { useState, useEffect } from "react"
import { Code2, FileText } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"

export interface DetectedBlock {
  language: string | null
  code: string
}

export interface SaveArtifactSelection {
  blockIndices: number[]
  alsoSaveAsMarkdown: boolean
}

interface SaveArtifactDialogProps {
  open: boolean
  blocks: DetectedBlock[]
  onCancel: () => void
  onConfirm: (selection: SaveArtifactSelection) => void
}

function previewLines(code: string, max = 3): string {
  const lines = code.split("\n")
  if (lines.length <= max) return lines.join("\n")
  return lines.slice(0, max).join("\n") + "\n…"
}

export function SaveArtifactDialog({
  open,
  blocks,
  onCancel,
  onConfirm,
}: SaveArtifactDialogProps) {
  const [checked, setChecked] = useState<boolean[]>([])
  const [alsoMarkdown, setAlsoMarkdown] = useState(false)

  useEffect(() => {
    // Default to all blocks selected so the common case is one click.
    setChecked(blocks.map(() => true))
    setAlsoMarkdown(false)
  }, [blocks])

  const toggle = (i: number) =>
    setChecked((prev) => prev.map((v, idx) => (idx === i ? !v : v)))

  const selectedCount = checked.filter(Boolean).length + (alsoMarkdown ? 1 : 0)

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onCancel()
      }}
    >
      <DialogContent className="sm:max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Save artifacts from this message</DialogTitle>
          <DialogDescription>
            We detected {blocks.length} code blocks. Pick what to archive — each
            saved item becomes a separate artifact.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-2 -mx-1 px-1">
          {blocks.map((b, i) => {
            const lineCount = b.code.split("\n").length
            return (
              <label
                key={i}
                className={cn(
                  "flex items-start gap-2 p-2 rounded-md border border-[var(--border)] cursor-pointer transition-colors",
                  checked[i]
                    ? "bg-[var(--primary)]/5 border-[var(--primary)]/40"
                    : "hover:bg-[var(--accent)]"
                )}
              >
                <Checkbox
                  checked={checked[i] ?? false}
                  onCheckedChange={() => toggle(i)}
                  className="mt-1 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 text-xs">
                    <Code2 size={12} className="text-[var(--muted-foreground)]" />
                    <span className="font-medium">Block {i + 1}</span>
                    {b.language && (
                      <span className="px-1 py-px rounded bg-[var(--secondary)] font-mono text-[10px] text-[var(--muted-foreground)]">
                        {b.language}
                      </span>
                    )}
                    <span className="text-[10px] text-[var(--muted-foreground)]">
                      {lineCount} {lineCount === 1 ? "line" : "lines"}
                    </span>
                  </div>
                  <pre className="mt-1 text-[11px] font-mono text-[var(--muted-foreground)] whitespace-pre-wrap break-words line-clamp-3">
                    {previewLines(b.code)}
                  </pre>
                </div>
              </label>
            )
          })}

          <label
            className={cn(
              "flex items-start gap-2 p-2 rounded-md border border-[var(--border)] border-dashed cursor-pointer transition-colors",
              alsoMarkdown
                ? "bg-[var(--primary)]/5 border-[var(--primary)]/40"
                : "hover:bg-[var(--accent)]"
            )}
          >
            <Checkbox
              checked={alsoMarkdown}
              onCheckedChange={(v) => setAlsoMarkdown(v === true)}
              className="mt-1 shrink-0"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 text-xs">
                <FileText size={12} className="text-[var(--muted-foreground)]" />
                <span className="font-medium">Whole message as Markdown</span>
              </div>
              <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">
                Saves the full assistant reply (prose + code) as a single markdown artifact.
              </p>
            </div>
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={selectedCount === 0}
            onClick={() =>
              onConfirm({
                blockIndices: checked
                  .map((v, i) => (v ? i : -1))
                  .filter((i) => i >= 0),
                alsoSaveAsMarkdown: alsoMarkdown,
              })
            }
          >
            Save {selectedCount > 0 ? `${selectedCount} ` : ""}artifact
            {selectedCount === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

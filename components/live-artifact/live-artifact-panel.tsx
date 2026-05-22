"use client"

/**
 * Right-side sheet that hosts the live-artifact preview. Modelled on
 * `components/pdf-viewer/pdf-viewer.tsx` — same `Sheet` primitive,
 * same lazy-mount pattern via a host component that subscribes to
 * the Zustand store.
 *
 * Toolbar: Render / Code toggle, Refresh, dismiss. Default width
 * `w-[640px] sm:w-[55vw]` — wider than the PDF viewer because
 * artifact previews (especially landing-page mockups) need horizontal
 * real estate to look right.
 */

import { useState } from "react"
import { Code2, Eye, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { CodeHighlight } from "@/components/code-highlight"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useStore } from "@/client/hooks/use-store"
import { cn } from "@/shared/utils"

import { detectArtifactShell, type DetectResult } from "@/client/live-artifact/detect"
import { LiveArtifactFrameWithStatus } from "./live-artifact-frame"
import { useLiveArtifact, type LiveArtifactMode } from "./store"

export function LiveArtifactHost() {
  const target = useLiveArtifact((s) => s.target)
  const mode = useLiveArtifact((s) => s.mode)
  const setMode = useLiveArtifact((s) => s.setMode)
  const close = useLiveArtifact((s) => s.close)
  if (!target) return null
  return (
    <LiveArtifactPanel
      artifactId={target.artifactId}
      mode={mode}
      onModeChange={setMode}
      onClose={close}
    />
  )
}

interface PanelProps {
  artifactId: string
  mode: LiveArtifactMode
  onModeChange: (mode: LiveArtifactMode) => void
  onClose: () => void
}

function LiveArtifactPanel({ artifactId, mode, onModeChange, onClose }: PanelProps) {
  const artifact = useStore((s) => s.artifacts.find((a) => a.id === artifactId))
  const [refreshKey, setRefreshKey] = useState(0)

  // Re-run the detector on the live artifact content. We don't trust
  // the kind/language alone — the store may carry an artifact that
  // was previewable when opened but isn't anymore after an edit.
  const detected: DetectResult = artifact
    ? detectArtifactShell({
        language: artifact.language,
        content: artifact.content,
      })
    : { renderable: false, shell: null }

  return (
    <Sheet open={true} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent
        side="right"
        className="w-full sm:w-[55vw] sm:min-w-[400px] sm:max-w-[80vw] p-0 gap-0 flex flex-col"
      >
        <SheetHeader className="shrink-0 pl-4 pr-12 py-2.5 border-b border-[var(--border)] flex-row items-center justify-between gap-2 space-y-0">
          <SheetTitle
            className="text-sm font-medium truncate flex-1 min-w-0"
            title={artifact?.title ?? "Artifact"}
          >
            {artifact?.title ?? "Artifact"}
          </SheetTitle>
          <div className="flex items-center gap-1 shrink-0">
            {detected.renderable && (
              <>
                <ModeToggle mode={mode} onChange={onModeChange} />
                <span className="mx-1 h-4 w-px bg-[var(--border)]" />
                {mode === "render" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setRefreshKey((k) => k + 1)}
                    className="h-7 w-7"
                    aria-label="Refresh preview"
                    title="Refresh"
                  >
                    <RefreshCw size={14} />
                  </Button>
                )}
              </>
            )}
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-hidden bg-[var(--muted)]/30">
          {!artifact && (
            <div className="flex items-center justify-center h-32 text-sm text-[var(--muted-foreground)]">
              Artifact not found.
            </div>
          )}
          {artifact && (mode === "code" || !detected.renderable) && (
            <div className="h-full overflow-auto p-3">
              <CodeHighlight code={artifact.content} language={artifact.language ?? ""} />
            </div>
          )}
          {artifact && detected.renderable && detected.shell && mode === "render" && (
            <LiveArtifactFrameWithStatus
              shell={detected.shell}
              content={artifact.content}
              refreshKey={refreshKey}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: LiveArtifactMode
  onChange: (mode: LiveArtifactMode) => void
}) {
  // Two-state pill. Render is the default; Code is the escape hatch
  // for power users who want to see the source the model produced.
  return (
    <div className="flex items-center rounded-md border border-[var(--border)] p-0.5 h-7">
      <ToggleButton active={mode === "render"} onClick={() => onChange("render")}>
        <Eye size={12} />
        Render
      </ToggleButton>
      <ToggleButton active={mode === "code"} onClick={() => onChange("code")}>
        <Code2 size={12} />
        Code
      </ToggleButton>
    </div>
  )
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 px-2 h-6 text-[11px] rounded transition-colors",
        active
          ? "bg-[var(--secondary)] text-[var(--foreground)]"
          : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      )}
    >
      {children}
    </button>
  )
}

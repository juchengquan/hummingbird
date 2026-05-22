"use client"

/**
 * Small in-bubble preview that renders below a code block in the
 * chat. Sized to ~200 px so it doesn't dominate the conversation
 * scroll; click the "Expand" affordance to escalate into the side
 * panel.
 *
 * Only used for **artifacts already in the store** — chat-message
 * passes the artifact id once auto-archive has run. Falls back to
 * "open in panel" button when the artifact isn't found (rare race
 * during a streaming archive).
 */

import { useState } from "react"
import { Maximize2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useStore } from "@/client/hooks/use-store"
import { cn } from "@/shared/utils"

import { detectArtifactShell } from "@/client/live-artifact/detect"
import { LiveArtifactFrameWithStatus } from "./live-artifact-frame"
import { openLiveArtifact } from "@/components/right-panel-slot"

export interface InlineLiveArtifactProps {
  artifactId: string
  className?: string
  /** Inline preview height in px. Defaults to 200 — short enough to
   *  keep the conversation scrollable, tall enough to render most
   *  small components legibly. */
  height?: number
}

export function InlineLiveArtifact({
  artifactId,
  className,
  height = 200,
}: InlineLiveArtifactProps) {
  const artifact = useStore((s) => s.artifacts.find((a) => a.id === artifactId))
  const [collapsed, setCollapsed] = useState(false)

  if (!artifact) {
    return (
      <button
        type="button"
        onClick={() => openLiveArtifact({ artifactId })}
        className="text-xs underline text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
      >
        Open preview
      </button>
    )
  }

  const detected = detectArtifactShell({
    language: artifact.language,
    content: artifact.content,
  })
  if (!detected.renderable || !detected.shell) return null

  return (
    <div
      className={cn(
        "relative rounded-md overflow-hidden border border-[var(--border)] bg-white",
        className
      )}
      style={{ height: collapsed ? 0 : height }}
    >
      <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1">
        <Button
          variant="secondary"
          size="icon"
          onClick={() => openLiveArtifact({ artifactId })}
          className="h-6 w-6 bg-white/90 hover:bg-white shadow-sm"
          aria-label="Open preview in side panel"
          title="Open in panel"
        >
          <Maximize2 size={12} />
        </Button>
      </div>
      {!collapsed && (
        <LiveArtifactFrameWithStatus
          shell={detected.shell}
          content={artifact.content}
        />
      )}
      {/* `collapsed` state isn't used in v1 — reserved for a future
       *  "hide preview" toggle next to the Expand button. Keeping the
       *  setter wired so adding the button is a one-line change. */}
      {collapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="hidden"
          aria-hidden
        />
      )}
    </div>
  )
}

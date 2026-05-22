"use client"

/**
 * Renders previews for any renderable artifacts auto-archived from
 * this assistant message. Mounted as a sibling of `MarkdownPreview`
 * in the chat-message bubble.
 *
 * Behaviour per artifact:
 *   - Small + renderable → inline `<InlineLiveArtifact>` (height 200)
 *   - Large + renderable → "Open preview" button that opens the side
 *     panel
 *   - Non-renderable → nothing here (the existing "Save as artifact"
 *     dropdown handles those)
 *
 * We re-run the detector even though auto-archive happened server-side
 * because the artifact `language` field can be `null` (unfenced blocks
 * fall through that path) and we still want to render `<!doctype html>`
 * content that the model produced without a fence.
 */

import { useMemo } from "react"
import { ExternalLink } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useStore } from "@/client/hooks/use-store"
import { cn } from "@/shared/utils"

import {
  detectArtifactShell,
  isSmallEnoughForInline,
} from "@/client/live-artifact/detect"
import { InlineLiveArtifact } from "./inline-preview"
import { openLiveArtifact } from "@/components/right-panel-slot"

export interface MessageLiveArtifactsProps {
  messageId: string
  className?: string
}

export function MessageLiveArtifacts({
  messageId,
  className,
}: MessageLiveArtifactsProps) {
  // Select the stable underlying slice — `.filter` inside the selector
  // would return a fresh array on every read, which trips React's
  // useSyncExternalStore equality check and produces an infinite
  // re-render ("getSnapshot should be cached"). Derive the per-message
  // subset in useMemo instead.
  const allArtifacts = useStore((s) => s.artifacts)
  const artifacts = useMemo(
    () =>
      allArtifacts.filter(
        (a) => a.messageId === messageId && a.kind === "code"
      ),
    [allArtifacts, messageId]
  )
  if (artifacts.length === 0) return null

  const renderable = artifacts.filter(
    (a) =>
      detectArtifactShell({ language: a.language, content: a.content }).renderable
  )
  if (renderable.length === 0) return null

  return (
    <div className={cn("mt-2 space-y-2", className)}>
      {renderable.map((a) =>
        isSmallEnoughForInline(a.content) ? (
          <InlineLiveArtifact key={a.id} artifactId={a.id} />
        ) : (
          <Button
            key={a.id}
            variant="outline"
            size="sm"
            onClick={() => openLiveArtifact({ artifactId: a.id })}
            className="h-7 text-xs gap-1.5"
          >
            <ExternalLink size={12} />
            Open preview
            <span className="text-[var(--muted-foreground)]">— {a.title}</span>
          </Button>
        )
      )}
    </div>
  )
}

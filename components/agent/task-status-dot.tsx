"use client"

import type { RunStatus } from "@/shared/agent/events"
import { cn } from "@/shared/utils"

interface TaskStatusDotProps {
  status: RunStatus
  /** Pulse while the run is active. */
  className?: string
}

/**
 * A small status indicator for a conversation row in the sidebar — the
 * cheap status channel. Green pulse while running, solid green when a
 * task finished while the user was elsewhere, red on failure.
 */
export function TaskStatusDot({ status, className }: TaskStatusDotProps) {
  const active = status === "running" || status === "queued"
  return (
    <span
      className={cn(
        "inline-block size-2 rounded-full",
        active && "bg-[var(--primary)] animate-pulse",
        status === "done" && "bg-[var(--primary)]",
        status === "failed" && "bg-[var(--destructive)]",
        status === "paused" && "bg-[var(--muted-foreground)]",
        status === "cancelled" && "bg-[var(--muted-foreground)]/50",
        className
      )}
      aria-label={`Task ${status}`}
      title={`Task ${status}`}
    />
  )
}

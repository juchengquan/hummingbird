"use client"

import { Clipboard, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ACTIONS_BY_KIND, chipLabel } from "@/lib/smart-paste/actions"
import type { PasteDetection } from "@/lib/smart-paste/detect"

interface SmartPasteChipProps {
  detection: PasteDetection
  /** Replace the chat input with this prompt (and refocus). */
  onApply: (prompt: string) => void
  /** Dismiss the chip without changing the input. */
  onDismiss: () => void
  className?: string
}

/**
 * Renders just below the active-skills chips when the user just pasted
 * recognizable content. Action buttons replace the input with a
 * templated prompt wrapping the snippet; × clears the chip.
 */
export function SmartPasteChip({
  detection,
  onApply,
  onDismiss,
  className,
}: SmartPasteChipProps) {
  const actions = ACTIONS_BY_KIND[detection.kind]
  if (!actions || actions.length === 0) return null
  return (
    <div
      className={cn(
        "inline-flex flex-wrap items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px]",
        "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        className
      )}
      role="region"
      aria-label="Smart paste suggestions"
    >
      <Clipboard size={10} className="shrink-0" />
      <span className="shrink-0 font-medium">{chipLabel(detection)}</span>
      <span className="shrink-0 opacity-50">·</span>
      {actions.map((action, idx) => (
        <Button
          key={action.id}
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            if (action.sideEffect) {
              action.sideEffect(detection)
              onDismiss()
              return
            }
            onApply(action.buildPrompt(detection))
          }}
          className={cn(
            "h-5 px-1.5 text-[10px] rounded-full",
            "text-amber-700 dark:text-amber-300 hover:bg-amber-500/15 hover:text-amber-700 dark:hover:text-amber-300",
            idx === 0 && "font-medium"
          )}
        >
          {action.label}
        </Button>
      ))}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss smart paste suggestions"
        title="Dismiss"
        className={cn(
          "inline-flex items-center justify-center w-3.5 h-3.5 rounded-full ml-0.5 shrink-0",
          "hover:bg-amber-500/20 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
        )}
      >
        <X size={9} />
      </button>
    </div>
  )
}

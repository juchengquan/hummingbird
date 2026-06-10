"use client"
import "client-only"

/**
 * ConfirmCard — yes/no inline confirm dialog. Resolves on a single
 * click to either button; the parent dispatches the answer through
 * the chat-send pipeline (auto-send) or the composer (prefill).
 *
 * Inert state (after the user answered): both buttons disabled, the
 * picked side highlighted.
 */

import { Check, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import type {
  ConfirmProps,
  UiAnswer,
} from "@/shared/generative-ui/schemas"
import { cn } from "@/shared/utils"

import type { UiPartHostProps } from "@/client/chat/generative-ui/registry"

export function ConfirmCard({
  props,
  inert,
  answer,
  onResolve,
}: UiPartHostProps) {
  const p = props as ConfirmProps
  const confirmLabel = p.confirmLabel ?? "Yes"
  const cancelLabel = p.cancelLabel ?? "Cancel"
  const picked =
    answer && answer.kind === "confirm"
      ? (answer as Extract<UiAnswer, { kind: "confirm" }>).confirmed
      : null

  return (
    <div
      className={cn(
        "my-3 rounded-lg border border-[var(--border)]",
        "bg-[var(--card)] text-[var(--card-foreground)]",
        "p-3 text-sm",
      )}
      aria-label="Confirmation"
    >
      <div className="mb-2 text-[var(--foreground)]">{p.prompt}</div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant={picked === true ? "default" : "outline"}
          disabled={inert}
          onClick={() => onResolve({ kind: "confirm", confirmed: true })}
          className="gap-1.5"
        >
          <Check size={13} />
          {confirmLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={picked === false ? "default" : "outline"}
          disabled={inert}
          onClick={() => onResolve({ kind: "confirm", confirmed: false })}
          className="gap-1.5"
        >
          <X size={13} />
          {cancelLabel}
        </Button>
      </div>
    </div>
  )
}

"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, ChevronDown, RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/shared/utils"
import { CHAT_MODELS, DEFAULT_CHAT_MODEL } from "@/shared/models"
import type { MessageError } from "@/shared/types"

const ERROR_TITLES: Record<string, string> = {
  auth: "Authentication failed",
  rate_limit: "Rate limited",
  context_window: "Conversation too long",
  invalid_model: "Model unavailable",
  provider: "Provider error",
  network: "Network error",
  unknown: "Something went wrong",
}

const RATE_LIMIT_COOLDOWN_S = 30

/**
 * Pick a fallback model id for one-click retry. Prefers
 * `DEFAULT_CHAT_MODEL` when it differs from the failed one, otherwise
 * the first different model in `CHAT_MODELS`. Returns null when no
 * different model exists (unreachable given the current list, but kept
 * for safety).
 */
function pickFallbackModel(
  failedModelId: string | undefined
): { id: string; label: string } | null {
  if (DEFAULT_CHAT_MODEL !== failedModelId) {
    const def = CHAT_MODELS.find((m) => m.id === DEFAULT_CHAT_MODEL)
    if (def) return { id: def.id, label: def.label }
  }
  const other = CHAT_MODELS.find((m) => m.id !== failedModelId)
  return other ? { id: other.id, label: other.label } : null
}

interface ErrorBubbleProps {
  error: MessageError
  /** Any text the assistant managed to stream before the error fired. */
  partialContent: string
  onRetry: () => void
  onChangeModel?: () => void
  /** Retry with a different model in one click. Surfaced for
   *  `invalid_model` / `provider` errors. */
  onTryFallback?: (modelId: string) => void
  onDelete: () => void
}

/**
 * Inline error bubble rendered in place of an assistant message that
 * failed mid-stream. Surfaces typed actions per error code:
 *
 *   - `auth`            → Dismiss + Change model (Retry hidden — same
 *                          setup will fail)
 *   - `rate_limit`      → Retry with a 30-second cooldown countdown
 *   - `invalid_model`   → Try {fallback} as the primary action; Retry
 *                          hidden (same model will fail again)
 *   - `provider`        → Retry + Try {fallback} + Change model
 *   - `network`         → Retry (no "Change model" since the network is
 *                          the issue, not the model)
 *   - `unknown`         → Retry + Change model + Dismiss
 *
 * The Details disclosure shows error code / HTTP / model so the user
 * can self-diagnose.
 */
export function ErrorBubble({
  error,
  partialContent,
  onRetry,
  onChangeModel,
  onTryFallback,
  onDelete,
}: ErrorBubbleProps) {
  const [showDetails, setShowDetails] = useState(false)
  // Rate-limit cooldown: retrying immediately just hits the same wall.
  // Soft-disable Retry for 30 s with a countdown so the user knows when
  // it's safe to try again.
  const [cooldown, setCooldown] = useState<number>(
    error.code === "rate_limit" ? RATE_LIMIT_COOLDOWN_S : 0
  )
  useEffect(() => {
    if (cooldown <= 0) return
    const id = setInterval(() => {
      setCooldown((s) => (s <= 1 ? 0 : s - 1))
    }, 1000)
    return () => clearInterval(id)
  }, [cooldown])

  const title = ERROR_TITLES[error.code] ?? ERROR_TITLES.unknown
  // `auth` means the API key is missing/invalid — retrying with the same
  // setup will hit the same wall. Hide Retry and let the user dismiss or
  // pick a different model. `context_window` means the conversation
  // overflowed; retrying same model + same history hits the same wall.
  const canRetrySameModel =
    error.code !== "auth" &&
    error.code !== "invalid_model" &&
    error.code !== "context_window"
  // Quick-fallback only makes sense when the model itself failed (invalid)
  // or the provider behind it returned an error. For rate_limit / network
  // / unknown, the same-model retry is the right primary action.
  // `context_window` offers a larger-context fallback model when one is
  // available so the user can recover in one click.
  const fallback =
    (error.code === "invalid_model" ||
      error.code === "provider" ||
      error.code === "context_window") &&
    onTryFallback
      ? pickFallbackModel(error.model)
      : null

  return (
    <div className="rounded-lg border border-[var(--destructive)]/40 bg-[var(--destructive)]/5 px-4 py-3 max-w-[90%] space-y-2">
      {partialContent && (
        <p className="text-sm whitespace-pre-wrap text-[var(--foreground)]">
          {partialContent}
        </p>
      )}
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="text-[var(--destructive)] mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-[var(--destructive)]">{title}</p>
          {error.detail && (
            <p className="text-xs text-[var(--muted-foreground)] mt-0.5 break-words">
              {error.detail}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {canRetrySameModel && (
          <Button
            size="sm"
            variant="secondary"
            onClick={onRetry}
            disabled={cooldown > 0}
            className="h-7 gap-1.5 text-xs"
            title={
              cooldown > 0
                ? `Wait ${cooldown}s before retrying — provider asked us to slow down.`
                : undefined
            }
          >
            <RotateCcw size={12} />
            {cooldown > 0 ? `Retry in ${cooldown}s` : "Retry"}
          </Button>
        )}
        {fallback && (
          <Button
            size="sm"
            variant={canRetrySameModel ? "ghost" : "secondary"}
            onClick={() => onTryFallback?.(fallback.id)}
            className="h-7 gap-1.5 text-xs"
            title={`Switch model and retry with ${fallback.label}`}
          >
            <RotateCcw size={12} />
            Try {fallback.label}
          </Button>
        )}
        {onChangeModel && error.code !== "network" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onChangeModel}
            className="h-7 gap-1.5 text-xs"
          >
            Change model
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={onDelete}
          className="h-7 gap-1.5 text-xs text-[var(--muted-foreground)]"
        >
          Dismiss
        </Button>
        {(error.status !== undefined || error.model) && (
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            Details
            <ChevronDown
              size={10}
              className={cn("transition-transform", showDetails && "rotate-180")}
            />
          </button>
        )}
      </div>
      {showDetails && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[10px] text-[var(--muted-foreground)] pt-1 border-t border-[var(--destructive)]/20">
          <dt>Code</dt>
          <dd className="font-mono">{error.code}</dd>
          {error.status !== undefined && (
            <>
              <dt>HTTP</dt>
              <dd className="font-mono">{error.status}</dd>
            </>
          )}
          {error.model && (
            <>
              <dt>Model</dt>
              <dd className="font-mono break-all">{error.model}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  )
}

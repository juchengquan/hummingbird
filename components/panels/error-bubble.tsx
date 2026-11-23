"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, ChevronDown, LogIn, RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { AUTH_REQUIRED_TITLE, openSignIn } from "@/client/auth/auth-required"
import {
  AUTH_REQUIRED_MESSAGE,
  INVALID_ATTACHMENT_MESSAGE,
} from "@/shared/api-errors"
import { cn } from "@/shared/utils"
import { pickFallbackModel, type ModelBackendKind } from "@/shared/backend-models"
import type { MessageError } from "@/shared/types"

const ERROR_TITLES: Record<string, string> = {
  auth: "Authentication failed",
  auth_required: AUTH_REQUIRED_TITLE,
  rate_limit: "Rate limited",
  context_window: "Conversation too long",
  invalid_model: "Model unavailable",
  unknown_model: "Model not available on this server",
  invalid_attachment: "Attachment can't be sent",
  provider: "Provider error",
  network: "Network error",
  answer_applied: "This answer was already acted on",
  unknown: "Something went wrong",
}

/** Optional one-line guidance shown under the title, for codes where
 *  the server's raw message alone doesn't tell the user what to do. */
const ERROR_HINTS: Record<string, string> = {
  auth_required: AUTH_REQUIRED_MESSAGE,
  unknown_model:
    "This model isn't available on this server — pick another model or add your own gateway key.",
  invalid_attachment: INVALID_ATTACHMENT_MESSAGE,
  answer_applied:
    "An earlier try used this answer before it stopped, so the question can't be answered again. Retry sends your message again.",
}

const RATE_LIMIT_COOLDOWN_S = 30

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
  /** Which models the serving backend accepts, for the fallback (Q40). */
  modelBackend?: ModelBackendKind
}

/**
 * Inline error bubble rendered in place of an assistant message that
 * failed mid-stream. Surfaces typed actions per error code:
 *
 *   - `auth`            → Dismiss + Change model (Retry hidden — same
 *                          setup will fail)
 *   - `auth_required`   → Sign in (primary) + Retry + Dismiss — the
 *                          server needs a signed-in caller
 *                          (REQUIRE_AUTH_FOR_AI); Retry works once
 *                          signed in. No Change model (not a model issue).
 *   - `rate_limit`      → Retry with a 30-second cooldown countdown
 *   - `invalid_model`   → Try {fallback} as the primary action; Retry
 *                          hidden (same model will fail again)
 *   - `unknown_model`   → same as `invalid_model`, plus a hint that the
 *                          model isn't in this server's catalogue (pick
 *                          another or bring your own gateway key)
 *   - `invalid_attachment` → Retry + Dismiss, with a hint to remove the
 *                          attachment first (Retry re-reads the chat's
 *                          attachments). No Change model.
 *   - `provider`        → Retry + Try {fallback} + Change model
 *   - `network`         → Retry (no "Change model" since the network is
 *                          the issue, not the model)
 *   - `answer_applied`  → Retry (sends the turn again — its question
 *                          can't be answered twice, Q63) + Dismiss
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
  modelBackend = "any",
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
  const hint = ERROR_HINTS[error.code]
  // `auth` means the API key is missing/invalid — retrying with the same
  // setup will hit the same wall. Hide Retry and let the user dismiss or
  // pick a different model. `context_window` means the conversation
  // overflowed; retrying same model + same history hits the same wall.
  const authRequired = error.code === "auth_required"
  const canRetrySameModel =
    error.code !== "auth" &&
    error.code !== "invalid_model" &&
    error.code !== "unknown_model" &&
    error.code !== "context_window"
  // Quick-fallback only makes sense when the model itself failed (invalid)
  // or the provider behind it returned an error. For rate_limit / network
  // / unknown, the same-model retry is the right primary action.
  // `context_window` offers a larger-context fallback model when one is
  // available so the user can recover in one click.
  const fallback =
    (error.code === "invalid_model" ||
      error.code === "unknown_model" ||
      error.code === "provider" ||
      error.code === "context_window") &&
    onTryFallback
      ? pickFallbackModel(error.model, modelBackend)
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
          {hint && (
            <p className="text-xs text-[var(--foreground)] mt-0.5 break-words">
              {hint}
            </p>
          )}
          {error.detail && (
            <p className="text-xs text-[var(--muted-foreground)] mt-0.5 break-words">
              {error.detail}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {authRequired && (
          <Button
            size="sm"
            variant="secondary"
            onClick={openSignIn}
            className="h-7 gap-1.5 text-xs"
          >
            <LogIn size={12} />
            Sign in
          </Button>
        )}
        {canRetrySameModel && (
          <Button
            size="sm"
            onClick={onRetry}
            disabled={cooldown > 0}
            variant={authRequired ? "ghost" : "secondary"}
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
        {onChangeModel &&
          error.code !== "network" &&
          error.code !== "invalid_attachment" &&
          error.code !== "answer_applied" &&
          !authRequired && (
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

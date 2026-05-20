"use client"

import { useMemo } from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { getChatModel } from "@/shared/models"
import {
  contextZone,
  estimateConversationTokens,
  formatTokenCount,
} from "@/shared/tokens"
import type { Message } from "@/shared/types"
import { cn } from "@/shared/utils"

interface ContextMeterProps {
  messages: Message[]
  modelId: string
}

const ZONE_CLASSES: Record<ReturnType<typeof contextZone>, string> = {
  ok: "text-[var(--muted-foreground)]",
  warn: "text-amber-600 dark:text-amber-500",
  danger: "text-red-600 dark:text-red-500",
}

/**
 * Compact "used / total" token meter rendered next to the model picker
 * in the chat header. Color shifts from muted → amber → red as the
 * conversation fills the model's context window, so the user gets a
 * heads-up before the model starts silently dropping early messages.
 *
 * The token count is a chars/4 heuristic — see `lib/shared/tokens.ts`
 * for the trade-off (cheap and ±20% accurate across model families vs
 * bundling per-family tokenizers at significant size cost).
 *
 * Hides itself when the model id is unknown or the conversation is
 * empty — no point taking up header real estate before there's
 * anything to measure.
 */
export function ContextMeter({ messages, modelId }: ContextMeterProps) {
  const model = getChatModel(modelId)

  const used = useMemo(() => estimateConversationTokens(messages), [messages])

  if (!model || messages.length === 0) return null

  const total = model.contextWindow
  const zone = contextZone(used, total)
  const pct = Math.min(100, Math.round((used / total) * 100))

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "text-[10px] tabular-nums select-none px-1.5 py-0.5 rounded-md hover:bg-[var(--secondary)] cursor-default shrink-0",
            ZONE_CLASSES[zone]
          )}
          aria-label={`Context: ${used} of ${total} tokens used (${pct}%)`}
          role="status"
        >
          {formatTokenCount(used)} / {formatTokenCount(total)}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-[260px]">
        <div className="font-medium">{model.label}</div>
        <div className="opacity-80">
          {formatTokenCount(used)} of {formatTokenCount(total)} tokens used
          ({pct}%).
        </div>
        {zone === "warn" && (
          <div className="opacity-80 mt-1">
            Approaching the context window. The model may start dropping
            older messages soon.
          </div>
        )}
        {zone === "danger" && (
          <div className="opacity-80 mt-1">
            Near the context limit. Older messages will be dropped silently.
          </div>
        )}
        <div className="opacity-60 mt-1 text-[10px]">
          Estimate — approximate to ±20% across model families.
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

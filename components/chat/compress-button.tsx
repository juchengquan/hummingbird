"use client"

import "client-only"

import { useState } from "react"
import { Archive, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { apiClient } from "@/client/api-client"
import { useStore } from "@/client/hooks/use-store"
import { pickCompressionRange } from "@/shared/compression"
import { contextZone, estimateConversationTokens } from "@/shared/tokens"
import { getChatModel } from "@/shared/models"
import type { Message } from "@/shared/types"
import { cn } from "@/shared/utils"

/**
 * "Compress" action surfaced next to the context meter. Only renders
 * when the meter is in the `warn` or `danger` zone AND the conversation
 * has enough eligible (un-compressed, non-recap, non-error) messages
 * to be worth compressing — see `pickCompressionRange`.
 *
 * Click opens a confirm dialog showing what will happen. On confirm,
 * runs a one-shot summarize call against the oldest ~60% of the
 * conversation; on success, atomically inserts a recap message and
 * marks the originals compressed. Failure → toast + dialog stays open
 * so the user can retry.
 */
export function CompressButton({
  conversationId,
  messages,
  modelId,
}: {
  conversationId: string
  messages: Message[]
  modelId: string
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const compressMessages = useStore((s) => s.compressMessages)

  const pick = pickCompressionRange(messages)
  const model = getChatModel(modelId)
  // Don't surface the button until the meter is at least warn-coloured.
  // Below that the conversation comfortably fits and there's no real
  // gain from compressing.
  const zone = model
    ? contextZone(estimateConversationTokens(messages), model.contextWindow)
    : "ok"
  if (!pick || zone === "ok") return null

  const handleConfirm = async () => {
    setBusy(true)
    try {
      const response = await apiClient.summarize.compress({
        mode: "compress",
        messages: pick.toCompress.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        model: modelId,
      })
      if (!response) {
        toast.error("Compression failed. Try again or change models.")
        setBusy(false)
        return
      }
      const result = compressMessages(
        conversationId,
        pick.toCompress.map((m) => m.id),
        response.recap
      )
      if (!result) {
        toast.error("Compression couldn't be applied — please retry.")
        setBusy(false)
        return
      }
      toast.success(
        `Compressed ${pick.toCompress.length} message${
          pick.toCompress.length === 1 ? "" : "s"
        } — undo on the recap card`
      )
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="Compress older messages"
        title="Compress older messages"
        className={cn(
          "h-7 px-2 gap-1.5 shrink-0",
          // Match the meter's zone colour so the affordance reads as
          // one composite control rather than two unrelated chips.
          zone === "danger"
            ? "text-red-600 dark:text-red-500 hover:bg-red-500/10"
            : "text-amber-600 dark:text-amber-500 hover:bg-amber-500/10"
        )}
      >
        <Archive size={12} />
        <span className="text-[11px] font-medium">Compress</span>
      </Button>

      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Compress older messages?</DialogTitle>
            <DialogDescription>
              The oldest{" "}
              <span className="font-medium text-[var(--foreground)]">
                {pick.toCompress.length}
              </span>{" "}
              message{pick.toCompress.length === 1 ? "" : "s"} will be
              summarised into a short recap. The last{" "}
              <span className="font-medium text-[var(--foreground)]">
                {pick.retainedCount}
              </span>{" "}
              stay as-is.
            </DialogDescription>
          </DialogHeader>

          <div className="text-xs text-[var(--muted-foreground)] space-y-1.5">
            <p>
              Originals stay on screen (collapsed) and you can undo from
              the recap card any time.
            </p>
            <p>
              The model only sees the recap on the next turn, freeing up
              room in the context window.
            </p>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={busy}
              className="gap-1.5"
            >
              {busy ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Compressing…
                </>
              ) : (
                <>
                  <Archive size={14} />
                  Compress
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

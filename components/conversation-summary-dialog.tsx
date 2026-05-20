"use client"

import { useEffect, useState } from "react"
import { Loader2, FileText, Send, Copy, Archive } from "lucide-react"
import { toast } from "sonner"
import { useStore } from "@/lib/hooks/use-store"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { copyText } from "@/lib/export"
import type { Conversation } from "@/lib/types"
import { apiClient } from "@/lib/api-client"
import type { ConversationSummarizeResponse } from "@/lib/api-schemas"

type ConversationSummaryResult = ConversationSummarizeResponse

interface ConversationSummaryDialogProps {
  conversation: Conversation | null
  onClose: () => void
}

function formatAsMarkdown(
  conv: Conversation,
  result: ConversationSummaryResult
): string {
  const lines: string[] = []
  lines.push(`# Summary — ${conv.title}`, "")
  lines.push(result.summary, "")
  if (result.keyPoints && result.keyPoints.length > 0) {
    lines.push("## Key points", "")
    for (const p of result.keyPoints) lines.push(`- ${p}`)
    lines.push("")
  }
  if (result.decisions && result.decisions.length > 0) {
    lines.push("## Decisions & action items", "")
    for (const d of result.decisions) lines.push(`- ${d}`)
    lines.push("")
  }
  return lines.join("\n")
}

export function ConversationSummaryDialog({
  conversation,
  onClose,
}: ConversationSummaryDialogProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [result, setResult] = useState<ConversationSummaryResult | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const createArtifact = useStore((s) => s.createArtifact)
  const setConversationDocument = useStore((s) => s.setConversationDocument)
  const requestEditorReload = useStore((s) => s.requestEditorReload)
  const setActiveView = useStore((s) => s.setActiveView)

  useEffect(() => {
    if (!conversation) return
    let cancelled = false
    setStatus("loading")
    setResult(null)
    setErrorMsg(null)

    const messages = conversation.messages
      .filter((m) => !m.error && m.content)
      .map((m) => ({ role: m.role, content: m.content }))

    if (messages.length === 0) {
      setStatus("error")
      setErrorMsg("This conversation is empty — nothing to summarise.")
      return
    }

    void (async () => {
      try {
        const data = await apiClient.summarize.conversation({
          mode: "conversation",
          messages,
        })
        if (cancelled) return
        if (!data) {
          setStatus("error")
          setErrorMsg("Summarisation failed.")
          return
        }
        setResult(data)
        setStatus("ready")
      } catch (err) {
        if (cancelled) return
        setStatus("error")
        setErrorMsg(err instanceof Error ? err.message : "Unknown error")
      }
    })()

    return () => {
      cancelled = true
    }
  }, [conversation])

  const handleCopy = async () => {
    if (!conversation || !result) return
    try {
      await copyText(formatAsMarkdown(conversation, result))
      toast.success("Summary copied")
    } catch {
      toast.error("Failed to copy summary")
    }
  }

  const handleSaveArtifact = () => {
    if (!conversation || !result) return
    createArtifact({
      conversationId: conversation.id,
      kind: "markdown",
      title: `Summary — ${conversation.title}`,
      content: formatAsMarkdown(conversation, result),
    })
    toast.success("Saved as artifact")
    onClose()
  }

  const handleSendToEditor = () => {
    if (!conversation || !result) return
    setConversationDocument(
      conversation.id,
      formatAsMarkdown(conversation, result)
    )
    requestEditorReload()
    setActiveView("editor")
    onClose()
  }

  return (
    <Dialog
      open={conversation !== null}
      onOpenChange={(v) => {
        if (!v) onClose()
      }}
    >
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-base">
            Summary — {conversation?.title ?? "conversation"}
          </DialogTitle>
          <DialogDescription>
            Auto-generated overview, key points, and decisions from this chat.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-auto rounded-md border border-[var(--border)] bg-[var(--background)] p-4">
          {status === "loading" && (
            <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
              <Loader2 size={14} className="animate-spin" />
              Summarising…
            </div>
          )}
          {status === "error" && (
            <div className="text-sm text-[var(--destructive)]">
              {errorMsg ?? "Failed to summarise."}
            </div>
          )}
          {status === "ready" && result && (
            <div className="space-y-4 text-sm">
              <p className="leading-relaxed text-[var(--foreground)]">
                {result.summary}
              </p>
              {result.keyPoints && result.keyPoints.length > 0 && (
                <div>
                  <h3 className="text-xs uppercase tracking-wide text-[var(--muted-foreground)] font-medium mb-2">
                    Key points
                  </h3>
                  <ul className="space-y-1.5 list-disc pl-5 text-[var(--foreground)]">
                    {result.keyPoints.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
              {result.decisions && result.decisions.length > 0 && (
                <div>
                  <h3 className="text-xs uppercase tracking-wide text-[var(--muted-foreground)] font-medium mb-2">
                    Decisions &amp; action items
                  </h3>
                  <ul className="space-y-1.5 list-disc pl-5 text-[var(--foreground)]">
                    {result.decisions.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={onClose}
            className="gap-1.5"
          >
            <FileText size={14} />
            Close
          </Button>
          <Button
            variant="ghost"
            onClick={handleCopy}
            disabled={status !== "ready"}
            className="gap-1.5"
          >
            <Copy size={14} />
            Copy
          </Button>
          <Button
            variant="ghost"
            onClick={handleSaveArtifact}
            disabled={status !== "ready"}
            className="gap-1.5"
          >
            <Archive size={14} />
            Save as artifact
          </Button>
          <Button
            variant="secondary"
            onClick={handleSendToEditor}
            disabled={status !== "ready"}
            className="gap-1.5"
          >
            <Send size={14} />
            Send to editor
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

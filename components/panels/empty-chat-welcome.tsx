"use client"

import { Sparkles, Paperclip, Archive, Command, PencilLine } from "lucide-react"
import { cn } from "@/lib/utils"

interface EmptyChatWelcomeProps {
  onPickSuggestion: (text: string) => void
}

const FEATURES: { icon: typeof Sparkles; label: string; detail: string }[] = [
  {
    icon: Paperclip,
    label: "Attach files for context",
    detail: "Drop PDFs, docs, or images via the + button — text gets extracted automatically.",
  },
  {
    icon: Archive,
    label: "Save what's worth keeping",
    detail: "Click the archive icon on an assistant message to save code or notes as an artifact.",
  },
  {
    icon: PencilLine,
    label: "Each conversation has its own editor",
    detail: "Use it as a scratchpad — changes auto-save to that conversation only.",
  },
  {
    icon: Command,
    label: "Jump anywhere with ⌘K",
    detail: "Switch workspace, switch conversation, or start a new chat in one keystroke.",
  },
]

const SUGGESTIONS: string[] = [
  "Help me draft an email about…",
  "Explain a code snippet I'll paste",
  "Summarize the PDF I'll attach",
  "Brainstorm names for…",
]

export function EmptyChatWelcome({ onPickSuggestion }: EmptyChatWelcomeProps) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-12 space-y-8">
      <div className="text-center space-y-2">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[var(--primary)]/10 text-[var(--primary)]">
          <Sparkles size={22} />
        </div>
        <h2 className="text-xl font-semibold text-[var(--foreground)]">
          Start a conversation
        </h2>
        <p className="text-sm text-[var(--muted-foreground)]">
          Ask anything, attach files, or pick a suggestion below.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {FEATURES.map(({ icon: Icon, label, detail }) => (
          <div
            key={label}
            className="flex items-start gap-3 rounded-md border border-[var(--border)] px-3 py-2.5 bg-[var(--background)]/60"
          >
            <Icon
              size={14}
              className="mt-0.5 shrink-0 text-[var(--muted-foreground)]"
            />
            <div className="min-w-0">
              <p className="text-xs font-medium text-[var(--foreground)]">{label}</p>
              <p className="text-[11px] text-[var(--muted-foreground)] mt-0.5">
                {detail}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <p className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)] font-medium">
          Try a prompt
        </p>
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onPickSuggestion(s)}
              className={cn(
                "text-xs px-3 py-1.5 rounded-full border border-[var(--border)]",
                "bg-[var(--background)]/60 text-[var(--foreground)]",
                "hover:bg-[var(--accent)] hover:border-[var(--ring)] transition-colors",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

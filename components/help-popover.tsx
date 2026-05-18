"use client"

import { HelpCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

interface Shortcut {
  keys: string[]
  label: string
}

const SHORTCUTS: Shortcut[] = [
  { keys: ["⌘", "K"], label: "Command palette (or Ctrl+K)" },
  { keys: ["⏎"], label: "Send message" },
  { keys: ["⇧", "⏎"], label: "New line in input" },
  { keys: ["Esc"], label: "Close dialogs / cancel editing" },
]

const TIPS: { title: string; detail: string }[] = [
  {
    title: "Attach files",
    detail: "Click + to upload to the workspace and attach to this chat.",
  },
  {
    title: "Save outputs",
    detail: "Hover an assistant message → archive icon saves code or markdown.",
  },
  {
    title: "Bookmark a reply",
    detail: "Hover → bookmark icon. Bookmarks live in the Notes tab.",
  },
  {
    title: "Per-workspace persona",
    detail: "Workspaces have a system prompt — set it on the workspaces tab.",
  },
]

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.5em] h-5 px-1 rounded border border-[var(--border)] bg-[var(--background)] text-[10px] font-mono text-[var(--foreground)]">
      {children}
    </kbd>
  )
}

export function HelpPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label="Shortcuts and tips"
          title="Shortcuts and tips"
        >
          <HelpCircle size={14} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="px-3 py-2 border-b border-[var(--border)]">
          <p className="text-xs font-medium">Shortcuts &amp; tips</p>
        </div>

        <div className="px-3 py-2 space-y-1.5">
          {SHORTCUTS.map((s) => (
            <div
              key={s.label}
              className="flex items-center justify-between gap-3 text-xs"
            >
              <span className="text-[var(--foreground)]">{s.label}</span>
              <span className="flex items-center gap-1 shrink-0">
                {s.keys.map((k, i) => (
                  <Key key={i}>{k}</Key>
                ))}
              </span>
            </div>
          ))}
        </div>

        <div className="border-t border-[var(--border)] px-3 py-2 space-y-2">
          {TIPS.map((t) => (
            <div key={t.title}>
              <p className="text-[11px] font-medium text-[var(--foreground)]">
                {t.title}
              </p>
              <p className="text-[11px] text-[var(--muted-foreground)] leading-snug">
                {t.detail}
              </p>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

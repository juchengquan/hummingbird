"use client"

import { useState, useEffect, useCallback } from "react"
import { LogIn, LogOut, Loader2, CloudOff, Cloud, HardDrive, Trash2, Sun, Moon, Monitor, Bot, Wand2, ShieldCheck, Sparkles, Brain } from "lucide-react"
import { toast } from "sonner"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { AuthDialog } from "@/components/auth/auth-dialog"
import { CustomInstructionsDialog } from "@/components/chat/custom-instructions-dialog"
import { MemoryPanel } from "@/components/chat/memory-panel"
import { useAuth } from "@/client/hooks/use-auth"
import { useSyncEnabled } from "@/client/hooks/use-sync-enabled"
import { writeMemoryEnabled } from "@/client/supabase/memory"
import { useStore } from "@/client/hooks/use-store"
import type { ChatBackend } from "@/client/hooks/store/slices/ui"
import { useSidebar } from "@/components/ui/sidebar"
import { cn } from "@/shared/utils"
import { clearAll, estimateUsage } from "@/client/files/local-store"
import { formatFileSize } from "@/client/file-utils"
import { isAgentPyConfigured, isAgentTsConfigured } from "@/client/api-client"

/**
 * Sidebar footer auth + local-mode surface.
 *
 * Five visual states:
 * 1. `loading`          → spinner.
 * 2. `unconfigured`     → "Local only" badge (Supabase isn't set up at all).
 * 3. `signed-out`       → "Sign in" button. Local mode is implicit.
 * 4. `signed-in`        → avatar + email, popover has sign-out + local-mode toggle.
 * 5. `signed-in` + opt-out → avatar + email + CloudOff icon, popover toggle reads "Resume cloud sync".
 */
export function AccountMenu() {
  const { status, user, signOut } = useAuth()
  const localOnlyMode = useStore((s) => s.localOnlyMode)
  const setLocalOnlyMode = useStore((s) => s.setLocalOnlyMode)
  const localFilesOnly = useStore((s) => s.localFilesOnly)
  const chatBackend = useStore((s) => s.chatBackend)
  const setChatBackend = useStore((s) => s.setChatBackend)
  const agentPyAvailable = isAgentPyConfigured()
  const agentTsAvailable = isAgentTsConfigured()
  const setLocalFilesOnly = useStore((s) => s.setLocalFilesOnly)
  const inlineComplete = useStore((s) => s.editorPrefs.inlineComplete)
  const setEditorPref = useStore((s) => s.setEditorPref)
  const verifyCitations = useStore((s) => s.verifyCitations)
  const setVerifyCitations = useStore((s) => s.setVerifyCitations)
  const memoryEnabled = useStore((s) => s.memoryEnabled)
  const setMemoryEnabled = useStore((s) => s.setMemoryEnabled)
  // Non-null only when signed in AND cloud sync is on — drives the
  // best-effort write-through of the toggle to the user's profile row.
  const { userId } = useSyncEnabled()
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const colorScheme = useStore((s) => s.colorScheme)
  const setColorScheme = useStore((s) => s.setColorScheme)
  const { state } = useSidebar()
  const collapsed = state === "collapsed"
  const [dialogOpen, setDialogOpen] = useState(false)
  const [ciOpen, setCiOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [usage, setUsage] = useState<number | null>(null)

  // Refresh storage usage whenever the menu opens.
  useEffect(() => {
    if (!menuOpen) return
    let cancelled = false
    void estimateUsage().then((est) => {
      if (!cancelled) setUsage(est?.usage ?? 0)
    })
    return () => {
      cancelled = true
    }
  }, [menuOpen])

  const handleToggleLocalFiles = useCallback(() => {
    const next = !localFilesOnly
    setLocalFilesOnly(next)
    if (!next) {
      toast.message("Files now sync to Supabase Storage", {
        description: "Existing local files stay on this device. New uploads will sync.",
      })
    } else {
      toast.message("New uploads will stay on this device", {
        description: "Extracted text still syncs — only the raw blob stays local.",
      })
    }
  }, [localFilesOnly, setLocalFilesOnly])

  // Toggle cross-conversation memory: update local state immediately,
  // then best-effort write-through to the user's profile row (mirrors the
  // custom-instructions write). Not awaited — local state is authoritative.
  const handleToggleMemory = useCallback(
    (next: boolean) => {
      setMemoryEnabled(next)
      if (userId) void writeMemoryEnabled(userId, next)
    },
    [setMemoryEnabled, userId]
  )

  const handleClearCache = useCallback(async () => {
    await clearAll()
    setUsage(0)
    toast.success("Cleared local file cache")
  }, [])

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center w-full h-7">
        <Loader2 size={14} className="animate-spin text-[var(--muted-foreground)]" />
      </div>
    )
  }

  // Local-first entry point — custom instructions apply to every chat
  // whether or not the user is signed in, so this row/trigger and its
  // dialog appear in every account-menu state (including unconfigured /
  // signed-out, where the data still lives in localStorage).
  const customInstructionsButton = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setCiOpen(true)}
      className="w-full justify-start gap-2 h-7 px-2 text-xs"
      aria-label="Custom instructions"
      title="Custom instructions applied to every chat"
    >
      <Sparkles size={14} />
      {!collapsed && <span>Custom instructions</span>}
    </Button>
  )

  if (status === "unconfigured") {
    // No Supabase configured at runtime — show a static badge so users know
    // their data isn't being synced anywhere.
    return (
      <>
        <div
          className="w-full inline-flex items-center gap-1.5 h-7 px-2 text-xs text-[var(--muted-foreground)]"
          title="Supabase isn't configured. All data stays in this browser."
        >
          <CloudOff size={14} />
          {!collapsed && <span>Local only</span>}
        </div>
        {customInstructionsButton}
        <CustomInstructionsDialog open={ciOpen} onClose={() => setCiOpen(false)} />
      </>
    )
  }

  if (status === "signed-out") {
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDialogOpen(true)}
          className="w-full justify-start gap-2 h-7 px-2 text-xs"
          aria-label="Sign in"
        >
          <LogIn size={14} />
          {!collapsed && <span>Sign in</span>}
        </Button>
        {customInstructionsButton}
        <AuthDialog open={dialogOpen} onOpenChange={setDialogOpen} />
        <CustomInstructionsDialog open={ciOpen} onClose={() => setCiOpen(false)} />
      </>
    )
  }

  const email = user?.email ?? "Account"
  const initial = email.charAt(0).toUpperCase()

  return (
    <>
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 h-7 px-2 text-xs"
          aria-label="Account menu"
          title={localOnlyMode ? "Local-only mode is on — cloud sync paused" : email}
        >
          <div className="relative shrink-0">
            <div className="w-5 h-5 rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] flex items-center justify-center text-[10px] font-semibold">
              {initial}
            </div>
            {localOnlyMode && (
              <span
                aria-hidden
                className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[var(--background)] flex items-center justify-center"
              >
                <CloudOff size={8} className="text-[var(--muted-foreground)]" />
              </span>
            )}
          </div>
          {!collapsed && (
            <span
              className={cn(
                "truncate",
                localOnlyMode && "text-[var(--muted-foreground)]"
              )}
            >
              {email}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-64 p-1">
        <div className="px-2 py-1.5 border-b mb-1">
          <p className="text-xs text-[var(--muted-foreground)]">Signed in as</p>
          <p className="text-sm truncate" title={email}>{email}</p>
          {localOnlyMode && (
            <p className="mt-1 text-[10px] text-[var(--muted-foreground)] inline-flex items-center gap-1">
              <CloudOff size={10} />
              Local only — cloud sync paused
            </p>
          )}
        </div>
        {/* Cloud sync toggle. `localOnlyMode === true` means sync is OFF,
            so the switch shows the inverse for clarity ("on" = sync on). */}
        <ToggleRow
          icon={localOnlyMode ? CloudOff : Cloud}
          label="Cloud sync"
          description={
            localOnlyMode
              ? "Paused — changes stay on this device"
              : "Workspaces, chats, files sync to Supabase"
          }
          checked={!localOnlyMode}
          onCheckedChange={(v) => setLocalOnlyMode(!v)}
          ariaLabel={
            localOnlyMode
              ? "Resume cloud sync"
              : "Pause cloud sync (use local only)"
          }
        />
        {/* File-blob sync. `localFilesOnly === true` means raw blobs
            stay local; extracted text still syncs either way. */}
        <ToggleRow
          icon={HardDrive}
          label="Sync files to cloud"
          description={
            localFilesOnly
              ? "Raw files stay on this device · extracted text still syncs"
              : "Raw files upload to Supabase Storage"
          }
          checked={!localFilesOnly}
          onCheckedChange={() => handleToggleLocalFiles()}
          ariaLabel={
            localFilesOnly
              ? "Resume uploading raw files to cloud"
              : "Stop uploading raw files (keep them on this device)"
          }
        />
        {/* Inline editor autocomplete (ghost text). Off by default per
            `docs/PLAN-inline-autocomplete.md` — ghost text is
            opinionated and adds per-keystroke cost. Plate's Copilot
            plugin honours this synchronously via its `triggerQuery`. */}
        <ToggleRow
          icon={Wand2}
          label="Inline autocomplete"
          description={
            inlineComplete
              ? "Editor shows ghost-text suggestions · Tab to accept"
              : "Editor stays quiet · enable for as-you-type suggestions"
          }
          checked={inlineComplete}
          onCheckedChange={(v) => setEditorPref("inlineComplete", v)}
          ariaLabel={
            inlineComplete
              ? "Disable editor inline autocomplete"
              : "Enable editor inline autocomplete"
          }
        />
        {/* Citation verification. Off by default — adds a cheap verifier
            model call on web-search turns. See
            docs/PLAN-citation-verifiability.md. Deep Research enables it
            regardless of this toggle. */}
        <ToggleRow
          icon={ShieldCheck}
          label="Verify citations"
          description={
            verifyCitations
              ? "Web-search answers are checked against their sources"
              : "Off · enable to flag claims unsupported by their sources"
          }
          checked={verifyCitations}
          onCheckedChange={(v) => setVerifyCitations(v)}
          ariaLabel={
            verifyCitations
              ? "Disable citation verification"
              : "Enable citation verification on web-search answers"
          }
        />
        {/* Cross-conversation memory opt-in. Off by default; signed-in
            only. When on, durable facts about the user are auto-distilled
            after each turn and injected into every chat. Manage them via
            the "Memory" entry below. See the memory Slice-1 plan. */}
        <ToggleRow
          icon={Brain}
          label="Enable memory"
          description={
            memoryEnabled
              ? "Durable facts are remembered across chats · manage below"
              : "Off · enable to let the assistant remember facts about you"
          }
          checked={memoryEnabled}
          onCheckedChange={(v) => handleToggleMemory(v)}
          ariaLabel={
            memoryEnabled
              ? "Disable cross-conversation memory"
              : "Enable cross-conversation memory"
          }
        />
        {/* Chat backend selector. Phase 4-2 of PLAN-agent-api +
            Phase 5 of PLAN-agent-ts — users can route their chat
            turns at the Python agent service OR the TypeScript
            agent service while the in-Next TS route stays live.
            Only surfaces when at least one remote service URL is
            configured; the segmented selector appears when both
            are. */}
        {(agentPyAvailable || agentTsAvailable) && (
          <ChatBackendSelector
            value={chatBackend}
            onChange={setChatBackend}
            agentPyAvailable={agentPyAvailable}
            agentTsAvailable={agentTsAvailable}
          />
        )}
        <div className="border-t my-1" />
        {/* Color scheme */}
        <div className="px-2 py-1">
          <p className="text-[10px] font-medium text-[var(--muted-foreground)] mb-1">Color scheme</p>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setColorScheme("default")}
              className={cn(
                "flex-1 h-7 rounded text-[10px] font-medium transition-colors border",
                colorScheme === "default"
                  ? "bg-[var(--primary)]/15 text-[var(--primary)] border-[var(--primary)]/40"
                  : "bg-transparent text-[var(--muted-foreground)] border-[var(--border)] hover:border-[var(--muted-foreground)]/40"
              )}
            >
              Default
            </button>
            <button
              type="button"
              onClick={() => setColorScheme("anthropic")}
              className={cn(
                "flex-1 h-7 rounded text-[10px] font-medium transition-colors border",
                colorScheme === "anthropic"
                  ? "bg-[var(--primary)]/15 text-[var(--primary)] border-[var(--primary)]/40"
                  : "bg-transparent text-[var(--muted-foreground)] border-[var(--border)] hover:border-[var(--muted-foreground)]/40"
              )}
            >
              Anthropic
            </button>
          </div>
        </div>
        {/* Theme */}
        <div className="px-2 py-1.5">
          <p className="text-[10px] font-medium text-[var(--muted-foreground)] mb-1">Theme</p>
          <div className="flex gap-1">
            {[
              { value: "light" as const, label: "Light", icon: Sun },
              { value: "dark" as const, label: "Dark", icon: Moon },
              { value: "system" as const, label: "System", icon: Monitor },
            ].map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setTheme(value)}
                className={cn(
                  "flex-1 h-7 rounded text-[10px] font-medium transition-colors border inline-flex items-center justify-center gap-1",
                  theme === value
                    ? "bg-[var(--primary)]/15 text-[var(--primary)] border-[var(--primary)]/40"
                    : "bg-transparent text-[var(--muted-foreground)] border-[var(--border)] hover:border-[var(--muted-foreground)]/40"
                )}
              >
                <Icon size={10} />
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="border-t my-1" />
        {/* Help */}
        <div className="px-2 py-1">
          <p className="text-[10px] font-medium text-[var(--muted-foreground)] mb-1">Help</p>
          <AccMenuShortcut keys={["⌘", "K"]} label="Command palette (or Ctrl+K)" />
          <AccMenuShortcut keys={["⏎"]} label="Send message" />
          <AccMenuShortcut keys={["⇧", "⏎"]} label="New line in input" />
          <AccMenuShortcut keys={["Esc"]} label="Close dialogs / cancel editing" />
          <div className="mt-1.5 space-y-0.5">
            {ACC_TIPS.map((t) => (
              <div key={t.title} className="text-[10px] leading-snug">
                <span className="font-medium text-[var(--foreground)]">{t.title}</span>
                <span className="text-[var(--muted-foreground)]"> — {t.detail}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="border-t my-1" />
        <div className="px-2 py-1.5">
          <div className="flex items-center justify-between text-[10px] text-[var(--muted-foreground)]">
            <span>Local file cache</span>
            <span title="Approximate IndexedDB usage for this origin.">
              {usage === null ? "—" : formatFileSize(usage)}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearCache}
            disabled={usage === 0}
            className="w-full justify-start gap-2 mt-1 h-7 text-xs"
            title="Delete every blob stored in this browser's IndexedDB. Files that are also in Supabase Storage stay reachable; local-only files become unrecoverable."
          >
            <Trash2 size={12} />
            <span>Clear local cache</span>
          </Button>
        </div>
        <div className="border-t my-1" />
        {/* Account-level custom instructions. Local-first — available
            signed-in or not. Close the popover first, then open the
            dialog as a sibling outside PopoverContent to avoid the
            focus/unmount conflict from opening a dialog inside the
            popover that is unmounting. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setMenuOpen(false)
            setCiOpen(true)
          }}
          className="w-full justify-start gap-2"
        >
          <Sparkles size={14} />
          <span>Custom instructions</span>
        </Button>
        {/* Manage cross-conversation memory. Signed-in only (this entry
            lives in the signed-in popover). Close the popover first, then
            open the dialog as a sibling outside PopoverContent — same
            focus/unmount dance as the custom-instructions entry. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setMenuOpen(false)
            setMemoryOpen(true)
          }}
          className="w-full justify-start gap-2"
        >
          <Brain size={14} />
          <span>Memory</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setMenuOpen(false)
            void signOut()
          }}
          className="w-full justify-start gap-2"
        >
          <LogOut size={14} />
          <span>Sign out</span>
        </Button>
      </PopoverContent>
    </Popover>
    <CustomInstructionsDialog open={ciOpen} onClose={() => setCiOpen(false)} />
    <MemoryPanel open={memoryOpen} onClose={() => setMemoryOpen(false)} />
    </>
  )
}

const ACC_TIPS: { title: string; detail: string }[] = [
  { title: "Attach files", detail: "Click + to upload to the workspace and attach to this chat." },
  { title: "Save outputs", detail: "Hover an assistant message → archive icon saves code or markdown." },
  { title: "Bookmark a reply", detail: "Hover → bookmark icon. Bookmarks live in the Notes tab." },
  { title: "Per-workspace persona", detail: "Workspaces have a system prompt — set it on the workspaces tab." },
]

function AccMenuShortcut({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[10px] py-0.5">
      <span className="text-[var(--foreground)]">{label}</span>
      <span className="flex items-center gap-0.5 shrink-0">
        {keys.map((k, i) => (
          <kbd key={i} className="inline-flex items-center justify-center min-w-[1.5em] h-4 px-1 rounded border border-[var(--border)] bg-[var(--background)] text-[9px] font-mono text-[var(--foreground)]">
            {k}
          </kbd>
        ))}
      </span>
    </div>
  )
}

/**
 * Row used inside the account popover for boolean settings: a leading
 * icon, a label + small description column, and a Switch on the right.
 * Whole row is clickable as a fallback for users who don't want to aim
 * at the switch handle (clicks delegate to the same toggle).
 */
function ToggleRow({
  icon: Icon,
  label,
  description,
  checked,
  onCheckedChange,
  ariaLabel,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  description: string
  checked: boolean
  onCheckedChange: (value: boolean) => void
  ariaLabel: string
}) {
  // The wrapper is a `<div>`, not a `<button>` — nesting the Switch
  // (a button) inside another button is invalid HTML and triggers a
  // hydration error. The Switch is the single focusable control per row
  // (proper `role="switch"`, keyboard support); the wrapper just adds
  // mouse convenience so users don't have to aim at the small handle.
  return (
    <div
      onClick={() => onCheckedChange(!checked)}
      role="presentation"
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left cursor-pointer",
        "hover:bg-[var(--accent)] transition-colors"
      )}
    >
      <Icon size={14} className="shrink-0 text-[var(--muted-foreground)]" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium leading-tight">{label}</p>
        <p className="text-[10px] text-[var(--muted-foreground)] leading-snug truncate">
          {description}
        </p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        // Stop the click from bubbling to the wrapper, otherwise the
        // wrapper's onClick would fire and re-toggle right after Switch
        // already toggled.
        onClick={(e) => e.stopPropagation()}
        aria-label={ariaLabel}
        className="shrink-0"
      />
    </div>
  )
}

/**
 * Chat-backend picker. Surfaces a 3-way segmented control when both
 * remote services are configured, or a one-row Switch when only one
 * is. The in-Next TS route is always available as the default and
 * shows up under "Next.js".
 */
function ChatBackendSelector({
  value,
  onChange,
  agentPyAvailable,
  agentTsAvailable,
}: {
  value: ChatBackend
  onChange: (next: ChatBackend) => void
  agentPyAvailable: boolean
  agentTsAvailable: boolean
}) {
  // When only Python is configured, keep the existing single-Switch
  // shape so the simple deploy stays visually unchanged.
  if (agentPyAvailable && !agentTsAvailable) {
    return (
      <ToggleRow
        icon={Bot}
        label="Python agent backend"
        description={
          value === "python"
            ? "Chat turns route to the Python agent service (experimental)"
            : "Chat turns use the Next.js route (default, full feature set)"
        }
        checked={value === "python"}
        onCheckedChange={(v) => onChange(v ? "python" : "ts")}
        ariaLabel={
          value === "python"
            ? "Switch back to the Next.js chat backend"
            : "Switch to the Python agent chat backend"
        }
      />
    )
  }
  // Same shape, just for the TS-service-only deploy.
  if (agentTsAvailable && !agentPyAvailable) {
    return (
      <ToggleRow
        icon={Bot}
        label="TS agent service backend"
        description={
          value === "ts-service"
            ? "Chat turns route to the TypeScript agent service"
            : "Chat turns use the Next.js route (default, full feature set)"
        }
        checked={value === "ts-service"}
        onCheckedChange={(v) => onChange(v ? "ts-service" : "ts")}
        ariaLabel={
          value === "ts-service"
            ? "Switch back to the Next.js chat backend"
            : "Switch to the TypeScript agent service backend"
        }
      />
    )
  }
  // Both remote services configured → segmented picker.
  return (
    <div
      className={cn(
        "w-full flex flex-col gap-1 px-2 py-1.5 rounded-md",
        "hover:bg-[var(--accent)] transition-colors"
      )}
    >
      <div className="flex items-center gap-2">
        <Bot size={14} className="shrink-0 text-[var(--muted-foreground)]" />
        <p className="text-xs font-medium leading-tight">Chat backend</p>
      </div>
      <div
        role="radiogroup"
        aria-label="Choose which chat backend handles your chat turns"
        className="flex gap-0.5 mt-1 rounded-md border border-[var(--border)] p-0.5"
      >
        {(
          [
            { id: "ts", label: "Next.js", desc: "in-process (default)" },
            { id: "ts-service", label: "TS service", desc: "agent-ts" },
            { id: "python", label: "Python", desc: "agent-py" },
          ] as const
        ).map((opt) => (
          <button
            key={opt.id}
            role="radio"
            aria-checked={value === opt.id}
            aria-label={`Use the ${opt.label} chat backend — ${opt.desc}`}
            type="button"
            onClick={() => onChange(opt.id)}
            className={cn(
              "flex-1 text-[10px] leading-tight px-2 py-1 rounded-sm",
              "transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]",
              value === opt.id
                ? "bg-[var(--background)] font-medium shadow-sm"
                : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

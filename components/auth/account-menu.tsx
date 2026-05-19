"use client"

import { useState } from "react"
import { LogIn, LogOut, Loader2, CloudOff, Cloud } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { AuthDialog } from "@/components/auth/auth-dialog"
import { useAuth } from "@/lib/hooks/use-auth"
import { useStore } from "@/lib/hooks/use-store"
import { useSidebar } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

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
  const { state } = useSidebar()
  const collapsed = state === "collapsed"
  const [dialogOpen, setDialogOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center w-full h-7">
        <Loader2 size={14} className="animate-spin text-[var(--muted-foreground)]" />
      </div>
    )
  }

  if (status === "unconfigured") {
    // No Supabase configured at runtime — show a static badge so users know
    // their data isn't being synced anywhere.
    return (
      <div
        className="w-full inline-flex items-center gap-1.5 h-7 px-2 text-xs text-[var(--muted-foreground)]"
        title="Supabase isn't configured. All data stays in this browser."
      >
        <CloudOff size={14} />
        {!collapsed && <span>Local only</span>}
      </div>
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
        <AuthDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      </>
    )
  }

  const email = user?.email ?? "Account"
  const initial = email.charAt(0).toUpperCase()

  return (
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
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setMenuOpen(false)
            setLocalOnlyMode(!localOnlyMode)
          }}
          className="w-full justify-start gap-2"
          title={
            localOnlyMode
              ? "Resume syncing this browser's changes to Supabase."
              : "Keep working locally — pause syncing this browser's changes to Supabase."
          }
        >
          {localOnlyMode ? <Cloud size={14} /> : <CloudOff size={14} />}
          <span>{localOnlyMode ? "Resume cloud sync" : "Use local only"}</span>
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
  )
}

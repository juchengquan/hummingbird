"use client"

import { useState } from "react"
import { LogIn, LogOut, User as UserIcon, Loader2 } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { AuthDialog } from "@/components/auth/auth-dialog"
import { useAuth } from "@/lib/hooks/use-auth"
import { useSidebar } from "@/components/ui/sidebar"

export function AccountMenu() {
  const { status, user, signOut } = useAuth()
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
    return null
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
        >
          <div className="w-5 h-5 rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] flex items-center justify-center text-[10px] font-semibold shrink-0">
            {initial}
          </div>
          {!collapsed && <span className="truncate">{email}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-56 p-1">
        <div className="px-2 py-1.5 border-b mb-1">
          <p className="text-xs text-[var(--muted-foreground)]">Signed in as</p>
          <p className="text-sm truncate" title={email}>{email}</p>
        </div>
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
        <Button
          variant="ghost"
          size="sm"
          disabled
          className="w-full justify-start gap-2 opacity-50"
          title="Coming soon"
        >
          <UserIcon size={14} />
          <span>Account settings</span>
        </Button>
      </PopoverContent>
    </Popover>
  )
}

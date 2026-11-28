"use client"

import { useState } from "react"
import { LogIn, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAuth } from "@/client/hooks/use-auth"

interface AuthDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AuthDialog({ open, onOpenChange }: AuthDialogProps) {
  const { status, signIn } = useAuth()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedEmail = email.trim()
    if (!trimmedEmail || !password) return
    setSubmitting(true)
    setError(null)
    const { error: signInError } = await signIn(trimmedEmail, password)
    setSubmitting(false)
    if (signInError) {
      setError(signInError)
      return
    }
    // useAuth's onAuthStateChange will flip status to 'signed-in' and the
    // surrounding components (sidebar, sync, reconciliation) react from there.
    onOpenChange(false)
    setEmail("")
    setPassword("")
  }

  const handleClose = (next: boolean) => {
    if (!next) {
      setError(null)
      setPassword("")
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Sign in to Hummingbird</DialogTitle>
          <DialogDescription>
            Sync your workspaces, conversations, and files across devices.
          </DialogDescription>
        </DialogHeader>

        {status === "unconfigured" ? (
          <p className="text-sm text-[var(--muted-foreground)]">
            Sign-in is not enabled. Set{" "}
            <code className="text-xs">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
            <code className="text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to
            enable.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="auth-email" className="text-sm font-medium">
                Email
              </label>
              <Input
                id="auth-email"
                type="email"
                required
                autoFocus
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="auth-password" className="text-sm font-medium">
                Password
              </label>
              <Input
                id="auth-password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
            </div>
            {error && (
              <p
                role="alert"
                className="text-xs text-[var(--destructive)] -mt-1"
              >
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={submitting} className="gap-2">
                {submitting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <LogIn size={14} />
                )}
                Sign in
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

"use client"

import { useState } from "react"
import { Mail, Loader2, CheckCircle2 } from "lucide-react"
import { toast } from "sonner"
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
import { useAuth } from "@/lib/hooks/use-auth"

interface AuthDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AuthDialog({ open, onOpenChange }: AuthDialogProps) {
  const { status, signIn } = useAuth()
  const [email, setEmail] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = email.trim()
    if (!trimmed) return
    setSubmitting(true)
    const { error } = await signIn(trimmed)
    setSubmitting(false)
    if (error) {
      toast.error(error)
      return
    }
    setSent(true)
  }

  const handleClose = (next: boolean) => {
    if (!next) {
      setSent(false)
      setEmail("")
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
            We&apos;ll email you a one-time sign-in link.
          </DialogDescription>
        </DialogHeader>

        {status === "unconfigured" ? (
          <p className="text-sm text-[var(--muted-foreground)]">
            Sign-in is not enabled. Set{" "}
            <code className="text-xs">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
            <code className="text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to
            enable.
          </p>
        ) : sent ? (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <CheckCircle2 size={32} className="text-[var(--primary)]" />
            <p className="text-sm font-medium">Check your inbox</p>
            <p className="text-xs text-[var(--muted-foreground)]">
              We sent a magic link to <strong>{email}</strong>.
            </p>
          </div>
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
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={submitting} className="gap-2">
                {submitting ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Mail size={14} />
                )}
                Send magic link
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

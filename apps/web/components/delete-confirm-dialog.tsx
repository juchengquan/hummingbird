"use client"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

interface DeleteConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Heading; usually ends in a `?` (e.g. "Delete this note?"). */
  title: React.ReactNode
  /** Body copy. Can be rich JSX — most call sites embed the item name
   *  in bold or supply additional warnings. */
  description: React.ReactNode
  /** Fires after the user confirms. The dialog closes itself on the
   *  same tick — callers don't need to flip `open` manually. */
  onConfirm: () => void
  /** Override the confirm button label (default "Delete"). */
  confirmLabel?: string
  /** Override the cancel button label (default "Cancel"). */
  cancelLabel?: string
}

/**
 * Centralised destructive-action confirmation. Wraps the
 * Cancel / Delete AlertDialog pattern that appears across the
 * conversation, workspace, file, and note delete flows so each call
 * site collapses to a few props.
 */
export function DeleteConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
}: DeleteConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="outline">{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              onConfirm()
              onOpenChange(false)
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

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

export type ReconcileChoice = "use-cloud" | "overwrite-cloud"

interface Props {
  open: boolean
  /** Counts shown so the user knows what's at stake on either side. */
  cloudCounts: { workspaces: number; conversations: number }
  localCounts: { workspaces: number; conversations: number }
  /** The local data was created under a different account (shared
   *  machine). Changes the copy so "keep local" reads as what it is:
   *  copying someone else's data into this account. */
  localFromOtherAccount?: boolean
  onChoose: (choice: ReconcileChoice) => void
}

export function ReconcileDialog({
  open,
  cloudCounts,
  localCounts,
  localFromOtherAccount = false,
  onChoose,
}: Props) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {localFromOtherAccount
              ? "This device has another account's data"
              : "You have data on both sides"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            We found {cloudCounts.workspaces} workspace
            {cloudCounts.workspaces === 1 ? "" : "s"} and {cloudCounts.conversations}{" "}
            chat{cloudCounts.conversations === 1 ? "" : "s"} in your cloud
            account, and {localCounts.workspaces} workspace
            {localCounts.workspaces === 1 ? "" : "s"} and {localCounts.conversations}{" "}
            chat{localCounts.conversations === 1 ? "" : "s"} on this device.
            {localFromOtherAccount
              ? " The data on this device was created while signed in to a different account; keeping it copies it into this account."
              : ""}{" "}
            Pick which set to keep.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onChoose("overwrite-cloud")}>
            Keep local · overwrite cloud
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => onChoose("use-cloud")}>
            Use cloud · discard local
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

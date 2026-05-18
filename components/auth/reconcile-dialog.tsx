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
  onChoose: (choice: ReconcileChoice) => void
}

export function ReconcileDialog({ open, cloudCounts, localCounts, onChoose }: Props) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>You have data on both sides</AlertDialogTitle>
          <AlertDialogDescription>
            We found {cloudCounts.workspaces} workspace
            {cloudCounts.workspaces === 1 ? "" : "s"} and {cloudCounts.conversations}{" "}
            chat{cloudCounts.conversations === 1 ? "" : "s"} in your cloud
            account, and {localCounts.workspaces} workspace
            {localCounts.workspaces === 1 ? "" : "s"} and {localCounts.conversations}{" "}
            chat{localCounts.conversations === 1 ? "" : "s"} on this device.
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

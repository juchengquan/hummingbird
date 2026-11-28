import { format } from "date-fns"

import { MarkdownPreview } from "@/components/markdown-preview"

import { SharedFooter } from "./shared-conversation-view"

/** The fields of a resolved document share the page renders (see
 *  `SharedConversationViewData` for the two sources). */
export interface SharedDocumentViewData {
  documentTitle: string
  documentContent: string
  createdAt: string
}

/** Read-only rendering of a shared document. */
export function SharedDocumentView({ share }: { share: SharedDocumentViewData }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-6 pb-4 border-b border-[var(--border)]">
        <p className="text-xs text-[var(--muted-foreground)]">
          Shared document · {format(new Date(share.createdAt), "MMM d, yyyy")}
        </p>
        <h1 className="text-2xl font-semibold mt-1">{share.documentTitle}</h1>
      </header>

      {share.documentContent.trim() ? (
        <MarkdownPreview content={share.documentContent} className="text-sm" />
      ) : (
        <p className="text-sm text-[var(--muted-foreground)] italic">
          This document is empty.
        </p>
      )}

      <SharedFooter />
    </main>
  )
}

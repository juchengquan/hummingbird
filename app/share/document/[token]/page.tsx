import { notFound } from "next/navigation"

import { resolveShare } from "@/lib/share/resolve"
import { MarkdownPreview } from "@/components/markdown-preview"
import { format } from "date-fns"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface PageProps {
  params: Promise<{ token: string }>
}

export default async function SharedDocumentPage({ params }: PageProps) {
  const { token } = await params
  const share = await resolveShare(token)
  if (!share || share.kind !== "document") notFound()

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-6 pb-4 border-b border-[var(--border)]">
        <p className="text-xs text-[var(--muted-foreground)]">
          Shared document · {format(new Date(share.createdAt), "MMM d, yyyy")}
        </p>
        <h1 className="text-2xl font-semibold mt-1">{share.conversationTitle}</h1>
      </header>

      {share.documentContent.trim() ? (
        <MarkdownPreview content={share.documentContent} className="text-sm" />
      ) : (
        <p className="text-sm text-[var(--muted-foreground)] italic">
          This document is empty.
        </p>
      )}

      <footer className="mt-12 pt-4 border-t border-[var(--border)] text-[11px] text-[var(--muted-foreground)] text-center">
        Read-only view · Shared via Hummingbird
      </footer>
    </main>
  )
}

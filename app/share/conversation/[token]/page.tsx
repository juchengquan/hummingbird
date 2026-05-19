import { notFound } from "next/navigation"

import { resolveShare } from "@/lib/share/resolve"
import { MarkdownPreview } from "@/components/markdown-preview"
import { format } from "date-fns"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface PageProps {
  params: Promise<{ token: string }>
}

export default async function SharedConversationPage({ params }: PageProps) {
  const { token } = await params
  const share = await resolveShare(token)
  if (!share || share.kind !== "conversation") notFound()

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-6 pb-4 border-b border-[var(--border)]">
        <p className="text-xs text-[var(--muted-foreground)]">
          Shared conversation · {format(new Date(share.createdAt), "MMM d, yyyy")}
        </p>
        <h1 className="text-2xl font-semibold mt-1">{share.conversationTitle}</h1>
      </header>

      <div className="space-y-6">
        {share.messages.length === 0 ? (
          <p className="text-sm text-[var(--muted-foreground)] italic">
            This conversation is empty.
          </p>
        ) : (
          share.messages.map((m) => (
            <article key={m.id} className="flex flex-col gap-1">
              <p className="text-[10px] uppercase tracking-wider text-[var(--muted-foreground)]">
                {m.role}
              </p>
              {m.reasoning && (
                <details className="text-xs text-[var(--muted-foreground)] border border-[var(--border)] rounded px-2 py-1 mb-1">
                  <summary className="cursor-pointer select-none">Thinking</summary>
                  <pre className="whitespace-pre-wrap mt-2 leading-relaxed">{m.reasoning}</pre>
                </details>
              )}
              {m.role === "assistant" ? (
                <MarkdownPreview content={m.content} className="text-sm" />
              ) : (
                <p className="text-sm whitespace-pre-wrap">{m.content}</p>
              )}
            </article>
          ))
        )}
      </div>

      <footer className="mt-12 pt-4 border-t border-[var(--border)] text-[11px] text-[var(--muted-foreground)] text-center">
        Read-only view · Shared via Hummingbird
      </footer>
    </main>
  )
}

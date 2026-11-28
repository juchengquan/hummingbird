import { format } from "date-fns"

import { MarkdownPreview } from "@/components/markdown-preview"

/** The fields of a resolved conversation share the page renders. Both
 *  sources satisfy it: `resolveShare` (server path) and
 *  `GET /v1/share/{token}` (backend path, `apiClient.share.resolve`). */
export interface SharedConversationViewData {
  conversationTitle: string
  createdAt: string
  messages: {
    id: string
    role: "user" | "assistant"
    content: string
    reasoning?: string | null
  }[]
}

/** Read-only rendering of a shared conversation. Renders on the server
 *  (server path) or the client (backend path) — no hooks of its own. */
export function SharedConversationView({ share }: { share: SharedConversationViewData }) {
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

      <SharedFooter />
    </main>
  )
}

export function SharedFooter() {
  return (
    <footer className="mt-12 pt-4 border-t border-[var(--border)] text-[11px] text-[var(--muted-foreground)] text-center">
      Read-only view · Shared via Hummingbird
    </footer>
  )
}

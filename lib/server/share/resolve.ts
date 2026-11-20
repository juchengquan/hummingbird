import "server-only"
/**
 * Server-side share resolver. Uses the service-role client so the public
 * page can render without an authenticated session, but reads are scoped
 * to the single row matched by the opaque token (which we treat as a
 * capability — anyone who has it can read the content).
 *
 * Returns null when:
 *   - Service role isn't configured (env missing)
 *   - Token doesn't match any row
 *   - The share has been revoked
 *   - The share's target isn't owned by the share's creator
 *
 * Owner scoping: the service-role client bypasses RLS, so every target
 * read is filtered by `user_id = share.user_id` (and messages by both the
 * conversation and that owner). A `shares` row pointing at someone else's
 * conversation/document — e.g. one written straight to PostgREST, around
 * the `/api/share` ownership check — therefore resolves to nothing rather
 * than publishing the other user's content. Migration
 * `0031_rls_fk_ownership.sql` closes the same hole at the DB layer; this
 * filter is the belt to that braces (and covers rows written before it).
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { getSupabaseAdminClient } from "@/server/supabase/admin"
import type { Database } from "@/shared/supabase/types"

export interface ResolvedConversationShare {
  kind: "conversation"
  conversationTitle: string
  messages: {
    id: string
    role: "user" | "assistant"
    content: string
    reasoning?: string | null
    position: number
  }[]
  createdAt: string
}

export interface ResolvedDocumentShare {
  kind: "document"
  /** Title of the shared document. Used as the displayed page title. */
  documentTitle: string
  documentContent: string
  createdAt: string
}

export type ResolvedShare = ResolvedConversationShare | ResolvedDocumentShare

/**
 * @param admin Service-role client. Defaults to the shared admin client;
 *   injectable so the owner-scoping can be unit-tested with a fake.
 */
export async function resolveShare(
  token: string,
  admin: SupabaseClient<Database> | null = getSupabaseAdminClient(),
): Promise<ResolvedShare | null> {
  if (!admin) return null

  const { data: share, error: shareError } = await admin
    .from("shares")
    .select("user_id, kind, conversation_id, document_id, created_at, revoked_at")
    .eq("token", token)
    .maybeSingle()
  if (shareError || !share) return null
  if (share.revoked_at) return null
  if (!share.user_id) return null

  if (share.kind === "document") {
    if (!share.document_id) return null
    const { data: doc, error: docError } = await admin
      .from("documents")
      .select("title, content")
      .eq("id", share.document_id)
      .eq("user_id", share.user_id)
      .maybeSingle()
    if (docError || !doc) return null
    return {
      kind: "document",
      documentTitle: doc.title || "Untitled",
      documentContent: doc.content,
      createdAt: share.created_at,
    }
  }

  if (!share.conversation_id) return null
  const { data: conv, error: convError } = await admin
    .from("conversations")
    .select("title")
    .eq("id", share.conversation_id)
    .eq("user_id", share.user_id)
    .maybeSingle()
  if (convError || !conv) return null

  const { data: messages, error: msgError } = await admin
    .from("messages")
    .select("id, role, content, reasoning, position")
    .eq("conversation_id", share.conversation_id)
    .eq("user_id", share.user_id)
    .order("position", { ascending: true })
  if (msgError) return null

  return {
    kind: "conversation",
    conversationTitle: conv.title,
    messages: (messages ?? []).map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
      reasoning: m.reasoning,
      position: m.position,
    })),
    createdAt: share.created_at,
  }
}

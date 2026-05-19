/**
 * Server-side share resolver. Uses the service-role client so the public
 * page can render without an authenticated session, but reads are scoped
 * to the single row matched by the opaque token (which we treat as a
 * capability — anyone who has it can read the content).
 *
 * Returns null in three cases:
 *   - Service role isn't configured (env missing)
 *   - Token doesn't match any row
 *   - The share has been revoked
 */

import { getSupabaseAdminClient } from "@/lib/supabase/admin"

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
  conversationTitle: string
  documentContent: string
  createdAt: string
}

export type ResolvedShare = ResolvedConversationShare | ResolvedDocumentShare

export async function resolveShare(token: string): Promise<ResolvedShare | null> {
  const admin = getSupabaseAdminClient()
  if (!admin) return null

  const { data: share, error: shareError } = await admin
    .from("shares")
    .select("kind, conversation_id, created_at, revoked_at")
    .eq("token", token)
    .maybeSingle()
  if (shareError || !share) return null
  if (share.revoked_at) return null

  const { data: conv, error: convError } = await admin
    .from("conversations")
    .select("title, document_content")
    .eq("id", share.conversation_id)
    .maybeSingle()
  if (convError || !conv) return null

  if (share.kind === "document") {
    return {
      kind: "document",
      conversationTitle: conv.title,
      documentContent: conv.document_content,
      createdAt: share.created_at,
    }
  }

  const { data: messages, error: msgError } = await admin
    .from("messages")
    .select("id, role, content, reasoning, position")
    .eq("conversation_id", share.conversation_id)
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

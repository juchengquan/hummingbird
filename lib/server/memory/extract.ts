import "server-only"

import { generateStructured } from "@/server/ai/structured"
import { getSupabaseServerClient } from "@/server/supabase/server"

import { mergeFacts } from "./merge"
import { ExtractionSchema, type MemoryFact } from "./types"

// Cheap structured-output model. Mirrors the default used by the other
// `generateStructured` call sites in this repo (extract-table, verify,
// suggestions all default to `google/gemini-2.5-flash`). Overridable via env.
const MODEL = process.env.MEMORY_EXTRACT_MODEL || "google/gemini-2.5-flash"

const PROMPT = (turn: string, existing: MemoryFact[]) =>
  [
    "You maintain a durable memory of stable facts about a user from their chats.",
    "From the conversation turn below, extract ONLY durable, stable facts worth",
    "remembering long-term (role, tech stack, recurring preferences, ongoing",
    "projects). Skip ephemeral/task-specific details. Return `facts: []` if the",
    "turn has nothing durable (this is common).",
    "",
    "For each fact, emit an op: `add` for a new fact, or `update` with the `id`",
    "of an existing fact it revises/replaces. Do NOT duplicate an existing fact.",
    "",
    "Existing facts (id — fact):",
    existing.length ? existing.map((f) => `${f.id} — ${f.fact}`).join("\n") : "(none)",
    "",
    "Conversation turn:",
    turn,
  ].join("\n")

/** Extract + merge + upsert durable facts for the signed-in user. Gated +
 *  best-effort: returns silently on any failure. Conversation/message ids
 *  are optional provenance. */
export async function extractFacts(input: {
  turnText: string
  conversationId?: string
}): Promise<void> {
  try {
    const supabase = await getSupabaseServerClient()
    if (!supabase) return
    const { data: prof } = await supabase
      .from("profiles")
      .select("memory_enabled")
      .single()
    if (!prof?.memory_enabled) return
    const { data: userRes } = await supabase.auth.getUser()
    const userId = userRes?.user?.id
    if (!userId) return

    const { data: rows } = await supabase
      .from("user_memories")
      .select("id, fact, category")
      .eq("status", "active")
    const existing: MemoryFact[] = (rows ?? []).map((r) => ({
      id: r.id as string,
      fact: r.fact as string,
      category: (r.category as string) ?? null,
    }))

    let extraction
    try {
      extraction = await generateStructured({
        modelId: MODEL,
        schema: ExtractionSchema,
        prompt: PROMPT(input.turnText, existing),
        temperature: 0,
        maxOutputTokens: 800,
      })
    } catch {
      return // model/config failure → skip
    }

    const plan = mergeFacts(existing, extraction.facts)
    if (plan.inserts.length) {
      await supabase.from("user_memories").insert(
        plan.inserts.map((i) => ({
          user_id: userId,
          fact: i.fact,
          category: i.category,
          source_conversation_id: input.conversationId ?? null,
        })),
      )
    }
    for (const u of plan.updates) {
      await supabase
        .from("user_memories")
        .update({
          fact: u.fact,
          category: u.category,
          updated_at: new Date().toISOString(),
        })
        .eq("id", u.id)
    }
  } catch {
    // Best-effort: extraction never blocks or surfaces to the chat flow.
  }
}

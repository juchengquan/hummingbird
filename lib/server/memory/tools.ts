import "server-only"

import { tool } from "ai"
import { z } from "zod"

import { getSupabaseServerClient } from "@/server/supabase/server"

import { matchFactsToForget } from "./forget-match"

/** System-prompt nudge shown whenever the tools are offered (even with no
 *  facts yet, so "remember" works from empty). */
export const MEMORY_TOOLS_NOTE =
  "When the user asks you to remember something about them, call `rememberFact`. " +
  "When they ask you to forget something, call `forgetFact` with the exact text " +
  "of the listed memory."

export function buildMemoryTools(ctx: { conversationId?: string | null }) {
  const rememberFact = tool({
    description:
      "Save a durable fact about the user to long-term memory (used across future chats). Call when the user asks you to remember something.",
    inputSchema: z.object({
      fact: z.string().min(1).max(500),
      category: z.string().max(40).optional(),
    }),
    async execute({ fact, category }) {
      try {
        const supabase = await getSupabaseServerClient()
        if (!supabase) return { ok: false, error: "not signed in" }
        const { data: userRes } = await supabase.auth.getUser()
        const userId = userRes?.user?.id
        if (!userId) return { ok: false, error: "not signed in" }
        await supabase.from("user_memories").insert({
          user_id: userId,
          fact,
          category: category ?? null,
          source_conversation_id: ctx.conversationId ?? null,
        })
        return { ok: true }
      } catch {
        return { ok: false, error: "could not save" }
      }
    },
  })

  const forgetFact = tool({
    description:
      "Remove a remembered fact from long-term memory. Pass the exact text of the memory as shown in the listed memories.",
    inputSchema: z.object({ fact: z.string().min(1).max(500) }),
    async execute({ fact }) {
      try {
        const supabase = await getSupabaseServerClient()
        if (!supabase) return { ok: false, removed: 0, error: "not signed in" }
        const { data } = await supabase
          .from("user_memories")
          .select("id, fact")
          .eq("status", "active")
        const rows = (data ?? []).map((r) => ({ id: r.id as string, fact: r.fact as string }))
        const ids = matchFactsToForget(rows, fact)
        if (ids.length === 0) return { ok: true, removed: 0, note: "No matching memory found." }
        await supabase.from("user_memories").delete().in("id", ids)
        return { ok: true, removed: ids.length }
      } catch {
        return { ok: false, removed: 0, error: "could not remove" }
      }
    },
  })

  return { rememberFact, forgetFact }
}

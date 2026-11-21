import "server-only"

import type { MemoryFact } from "./types"

/**
 * The memory-extraction prompt (`extractFacts` in `./extract.ts`). Pure,
 * in its own module so its exact text can be pinned: agent-py's
 * `/v1/memory/extract` ports it verbatim (`agent_py.memory_extract`), and
 * `scripts/__tests__/agent-py-parity.test.ts` fails when the two drift.
 */
export function buildMemoryExtractPrompt(turn: string, existing: MemoryFact[]): string {
  return [
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
}

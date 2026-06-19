import "server-only"

import { MEMORY_FACT_CAP, type FactOp, type MemoryFact } from "./types"

export interface MergePlan {
  inserts: { fact: string; category: string | null }[]
  updates: { id: string; fact: string; category: string | null }[]
}

/** Turn the extractor's ops into a concrete insert/update plan against the
 *  user's existing facts. Pure: validates `update` ids, drops unknowns,
 *  and caps total active facts. No embeddings / similarity. */
export function mergeFacts(existing: MemoryFact[], ops: FactOp[]): MergePlan {
  const ids = new Set(existing.map((f) => f.id))
  const inserts: MergePlan["inserts"] = []
  const updates: MergePlan["updates"] = []
  let activeCount = existing.length
  for (const op of ops) {
    const category = op.category ?? null
    if (op.op === "update") {
      if (op.id && ids.has(op.id)) updates.push({ id: op.id, fact: op.fact, category })
      // unknown id → drop (the model hallucinated an id)
      continue
    }
    // op === "add"
    if (activeCount >= MEMORY_FACT_CAP) continue
    activeCount++
    inserts.push({ fact: op.fact, category })
  }
  return { inserts, updates }
}

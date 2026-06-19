import "server-only"

import { z } from "zod"

/** A stored fact row (subset used by the helpers). */
export interface MemoryFact {
  id: string
  fact: string
  category: string | null
}

/** Soft cap on active facts per user. */
export const MEMORY_FACT_CAP = 100

/** The extractor's structured output: a list of ops against the user's
 *  existing facts. `add` = new fact; `update` = revise an existing fact
 *  by id. (No `delete` from extraction — users delete via the panel.) */
export const FactOpSchema = z.object({
  op: z.enum(["add", "update"]),
  id: z.string().optional(), // required for "update"
  fact: z.string().min(1).max(500),
  category: z.string().max(40).optional(),
})
export type FactOp = z.infer<typeof FactOpSchema>

export const ExtractionSchema = z.object({ facts: z.array(FactOpSchema).max(20) })
export type Extraction = z.infer<typeof ExtractionSchema>

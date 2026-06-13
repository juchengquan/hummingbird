import "server-only"

/**
 * File embedding orchestration (`docs/PLAN-local-rag.md` PR 2 — populate).
 * Chunks a file's extracted text, embeds the chunks, and writes them to
 * the `file_sections` vector table created in `0023_file_embeddings.sql`.
 *
 * Pure orchestration: the Supabase client and the embed function are
 * injected, so this is unit-tested with fakes (no DB, no model). The
 * route (`app/api/embed/route.ts`) owns the env gate
 * (`isEmbeddingConfigured()`) and resolves the authed client + user id
 * before calling in — keeping this layer free of `process.env` and
 * `next/headers`.
 *
 * Idempotent: a file that already has sections is skipped unless `force`
 * is set (which drops and rebuilds). The embedding query vector is the
 * app's job at search time (`embedText`); this is the write half.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "@/shared/supabase/types"
import { chunkText, type ChunkOptions } from "@/server/embeddings/chunk"
import { embedTexts } from "@/server/embeddings/provider"

type FileSectionInsert =
  Database["public"]["Tables"]["file_sections"]["Insert"]

/** Postgres foreign-key-violation SQLSTATE. Surfaced when the `files`
 *  row referenced by `file_id` isn't in Supabase yet — the metadata
 *  upsert hasn't flushed through the sync queue. The caller retries. */
const FK_VIOLATION = "23503"

export type IndexFileReason =
  | "empty"
  | "already_indexed"
  | "file_not_found"

export interface IndexFileResult {
  status: "indexed" | "skipped"
  /** Chunks written (`indexed`) or already present (`already_indexed`). */
  sections: number
  reason?: IndexFileReason
}

export interface IndexFileArgs {
  client: SupabaseClient<Database>
  /** Owner — stamped on every row so own-rows RLS accepts the insert. */
  userId: string
  fileId: string
  text: string
  /** Re-index even if sections already exist (drop + rebuild). */
  force?: boolean
  /** Override chunk sizing (defaults in `chunk.ts`). */
  chunkOptions?: ChunkOptions
  /** Injected for tests; defaults to the real provider. */
  embed?: (texts: string[]) => Promise<number[][]>
}

/**
 * Chunk → embed → write one file's text into `file_sections`. Returns a
 * structured outcome rather than throwing on the expected "nothing to do"
 * cases (empty text, already indexed, file not yet synced). Genuine I/O
 * failures (a failed insert that isn't an FK violation) still throw.
 */
export async function indexFileSections(
  args: IndexFileArgs
): Promise<IndexFileResult> {
  const { client, userId, fileId, text, force = false } = args
  const embed = args.embed ?? embedTexts

  const chunks = chunkText(text, args.chunkOptions)
  if (chunks.length === 0) {
    return { status: "skipped", sections: 0, reason: "empty" }
  }

  if (force) {
    // Rebuild: clear existing sections so re-index doesn't collide with
    // the (file_id, section_index) unique constraint.
    await client.from("file_sections").delete().eq("file_id", fileId)
  } else {
    // Idempotency: a file already chunked is left alone. Steady-state
    // re-uploads of the same file thus cost one HEAD count, no embed.
    const { count, error } = await client
      .from("file_sections")
      .select("id", { count: "exact", head: true })
      .eq("file_id", fileId)
    if (!error && (count ?? 0) > 0) {
      return { status: "skipped", sections: count ?? 0, reason: "already_indexed" }
    }
  }

  const embeddings = await embed(chunks)

  const rows: FileSectionInsert[] = chunks.map((content, i) => ({
    user_id: userId,
    file_id: fileId,
    section_index: i,
    content,
    // pgvector accepts its text representation (`"[0.1,0.2,…]"`); the
    // generated column type is `string | null`. A missing vector (short
    // batch) stays null — `match_file_sections` skips null embeddings.
    embedding: embeddings[i] ? JSON.stringify(embeddings[i]) : null,
  }))

  const { error } = await client.from("file_sections").insert(rows)
  if (error) {
    if (error.code === FK_VIOLATION) {
      return { status: "skipped", sections: 0, reason: "file_not_found" }
    }
    throw new Error(`file_sections insert failed: ${error.message}`)
  }

  return { status: "indexed", sections: rows.length }
}

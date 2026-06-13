import "client-only"

/**
 * Client trigger for the file-embedding populate path
 * (`docs/PLAN-local-rag.md` PR 2). Called fire-and-forget from
 * `runExtraction` once a file's text is available. Sends the text to
 * `POST /api/embed`, which chunks + embeds it into `file_sections`.
 *
 * Best-effort and self-gating:
 *  - No-op for anonymous / local-only users (no Supabase session) — the
 *    vector table is signed-in-only, mirroring FTS file search.
 *  - Never throws; indexing is background decoration on top of the
 *    already-usable file row.
 *
 * FK race: the `files` row is written to Supabase via the (queued)
 * metadata sync, which may not have flushed when extraction finishes.
 * The route reports `reason: 'file_not_found'` in that window; we retry
 * with a short backoff so a fast-extracting small file still lands once
 * its row syncs.
 */

import { apiClient } from "@/client/api-client"
import { getSupabaseBrowserClient } from "@/client/supabase/client"
import { useStore } from "@/client/hooks/use-store"

/** Backoff (ms) for the FK race — the `files` row syncing after a fast
 *  extraction. Bounded; gives up quietly after the last attempt. */
const FK_RETRY_DELAYS = [800, 1600, 3200]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function indexFileEmbeddings(
  fileId: string,
  text: string
): Promise<void> {
  if (!text.trim()) return
  // Local-only users never sync to Supabase, so there's no row to attach
  // sections to — skip the round-trip entirely.
  if (useStore.getState().localOnlyMode) return

  const client = getSupabaseBrowserClient()
  if (!client) return
  try {
    const { data } = await client.auth.getUser()
    if (!data.user?.id) return
  } catch {
    return
  }

  for (let attempt = 0; ; attempt++) {
    const result = await apiClient.embed.file({ fileId, text })
    // null = transport/HTTP failure (incl. 401 for anonymous). Stop.
    if (!result) return
    if (result.reason !== "file_not_found") return
    if (attempt >= FK_RETRY_DELAYS.length) return
    await sleep(FK_RETRY_DELAYS[attempt])
  }
}

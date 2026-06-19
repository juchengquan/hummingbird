import "server-only"

import { getSupabaseServerClient } from "@/server/supabase/server"

/**
 * Download a user-owned file's bytes for sandbox mounting.
 *
 * SECURITY: uses the request's **authenticated, user-scoped** Supabase
 * client (the same cookies-based server client `searchFiles` uses), NOT
 * a service-role client. RLS on `files` (0002) evaluates against the
 * caller's `auth.uid()`, and the `user-files` Storage bucket is
 * likewise RLS-bounded — so a forged `fileId` pointing at another
 * user's file resolves to zero rows / a denied download and returns
 * null. Never widen this to a service-role client: that would be a
 * cross-user data leak.
 *
 * Best-effort: returns null (never throws) on any miss — signed-out,
 * not the user's file, no `storage_path` (local-only file), or a
 * download error.
 */
export async function downloadUserFileBytes(
  fileId: string
): Promise<Uint8Array | null> {
  const supabase = await getSupabaseServerClient()
  if (!supabase) return null
  try {
    const { data: row } = await supabase
      .from("files")
      .select("storage_path")
      .eq("id", fileId)
      .single()
    const path = row?.storage_path
    if (!path) return null
    const { data, error } = await supabase.storage
      .from("user-files")
      .download(path)
    if (error || !data) return null
    return new Uint8Array(await data.arrayBuffer())
  } catch {
    return null
  }
}

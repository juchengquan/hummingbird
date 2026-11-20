"use client"
import "client-only"

/**
 * Read side of an image / file artifact's bytes (store v34).
 *
 * `Artifact.storagePath` may be a signed / Storage URL, an inline `data:`
 * URL, or an `hb-blob:` reference into the message-blob IndexedDB store
 * (shared with the generated item it was created from — see the artifact
 * section of `client/messages/message-blobs.ts`). A reference is never a
 * loadable URL: every reader goes through these helpers so one can never
 * reach an `<img src>`, an `href` or the editor.
 */

import { citationTableMarkerMarkdown } from "@/shared/artifacts/citation-table-md"
import { isMessageBlobRef } from "@/shared/message-blob-ref"
import type { Artifact } from "@/shared/types"

import { resolveMessageBlobUrl } from "@/client/messages/message-blobs"
import {
  useMessageBlobUrl,
  type MessageBlobUrlState,
} from "@/client/messages/use-message-blob-url"

/** The raw (possibly reference) source of an image / file artifact. */
export function artifactAssetSource(artifact: Pick<Artifact, "storagePath" | "content">): string {
  return artifact.storagePath ?? artifact.content
}

/**
 * A loadable URL for the artifact's bytes: plain URLs as-is, a reference
 * resolved through the session cache, then IndexedDB. `undefined` when
 * the bytes are gone. Never returns a reference. Never rejects.
 */
export async function resolveArtifactAssetUrl(
  artifact: Pick<Artifact, "storagePath" | "content">
): Promise<string | undefined> {
  const url = await resolveMessageBlobUrl(artifactAssetSource(artifact))
  return url && !isMessageBlobRef(url) ? url : undefined
}

/**
 * React accessor: `ready` with a loadable URL, `loading` while a
 * reference resolves, `missing` when its bytes are gone. Callers render a
 * skeleton / unavailable state for anything but `ready`.
 */
export function useArtifactAssetUrl(
  artifact: Pick<Artifact, "storagePath" | "content">
): MessageBlobUrlState {
  return useMessageBlobUrl(artifactAssetSource(artifact))
}

/**
 * Markdown for "Send to editor". Image artifacts embed their resolved
 * URL; `null` when an image's bytes can't be resolved (the caller tells
 * the user instead of inserting a broken / placeholder link).
 */
export async function artifactMarkdownForEditor(artifact: Artifact): Promise<string | null> {
  if (artifact.kind === "code") {
    return `\`\`\`${artifact.language ?? ""}\n${artifact.content}\n\`\`\``
  }
  if (artifact.kind === "json") {
    let pretty = artifact.content
    try {
      pretty = JSON.stringify(JSON.parse(artifact.content), null, 2)
    } catch {
      /* leave raw */
    }
    return `\`\`\`json\n${pretty}\n\`\`\``
  }
  if (artifact.kind === "image") {
    const src = await resolveArtifactAssetUrl(artifact)
    if (!src) return null
    return artifact.content
      ? `![${artifact.content.slice(0, 60)}](${src})`
      : `![](${src})`
  }
  if (artifact.kind === "table") {
    return citationTableMarkerMarkdown(artifact.id)
  }
  return artifact.content
}

import "client-only"

/**
 * Canvas node → "open the underlying thing" dispatch.
 *
 * Each node kind reuses an existing focus surface rather than inventing
 * a new one:
 *   - chat-message → switch to the Chat view on the source conversation
 *     and scroll the message into view (same DOM-id scroll the Notes
 *     tab's "jump to message" uses)
 *   - artifact     → the live-artifact preview panel
 *   - url-bookmark → the URL preview drawer
 *   - file         → the type-specific viewer (image / docx / text / csv)
 *   - note         → jump to its anchored message if it has one, else a
 *                    toast (notes have no standalone viewer)
 *   - sticky       → no-op (edited in place on the canvas)
 */

import { toast } from "sonner"

import { useStore } from "@/client/hooks/use-store"
import { useLiveArtifact } from "@/components/live-artifact/store"
import { useUrlPreview } from "@/components/url-viewer/types"
import { useImageViewer } from "@/components/image-viewer/types"
import { useDocxViewer } from "@/components/docx-viewer/types"
import { useTextViewer } from "@/components/text-viewer/types"
import { useCsvViewer } from "@/components/csv-viewer/types"
import type { CanvasNodeKind } from "@/shared/canvas/types"

/** Scroll a chat message into view by its DOM id. Mirrors the Notes
 *  tab helper — the message row renders `id="chat-message-<id>"`. */
function scrollToMessage(messageId: string) {
  // Two RAFs: the Chat panel may have just mounted from a view switch,
  // so wait for layout before querying the node.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const el = document.getElementById(`chat-message-${messageId}`)
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" })
    })
  })
}

/** Open the source conversation at a specific message (view switch +
 *  scroll). Returns false when the message can't be located. */
function focusMessage(messageId: string): boolean {
  const state = useStore.getState()
  const conv = state.conversations.find((c) =>
    c.messages.some((m) => m.id === messageId)
  )
  if (!conv) return false
  state.setActiveConversation(conv.id)
  state.setActiveView("chat")
  scrollToMessage(messageId)
  return true
}

export function focusCanvasNode(kind: CanvasNodeKind, refId: string): void {
  const state = useStore.getState()
  switch (kind) {
    case "chat-message": {
      if (!focusMessage(refId)) toast.error("Message no longer exists")
      return
    }
    case "artifact": {
      const artifact = state.artifacts.find((a) => a.id === refId)
      if (!artifact) {
        toast.error("Artifact no longer exists")
        return
      }
      useLiveArtifact.getState().open({ artifactId: refId })
      return
    }
    case "url-bookmark": {
      const bookmark = state.urlBookmarks.find((b) => b.id === refId)
      if (!bookmark || bookmark.deletedAt) {
        toast.error("Bookmark no longer exists")
        return
      }
      useUrlPreview.getState().open({ bookmarkId: refId })
      return
    }
    case "note": {
      const note = state.notes.find((n) => n.id === refId)
      if (!note) {
        toast.error("Note no longer exists")
        return
      }
      // Notes have no standalone viewer — jump to the anchored message
      // when there is one, otherwise just surface the body.
      if (note.messageId && focusMessage(note.messageId)) return
      toast(note.body.slice(0, 200) || "(empty note)")
      return
    }
    case "file": {
      const file = state.files.find((f) => f.id === refId)
      if (!file || file.deletedAt) {
        toast.error("File no longer exists")
        return
      }
      const type = file.type ?? ""
      const name = file.name ?? ""
      if (type.startsWith("image/")) {
        // The image viewer takes loadable items, not a fileId. Uploaded
        // images carry their bytes in `imageDataUrl`; without it there's
        // nothing to render.
        if (!file.imageDataUrl) {
          toast.error("Image preview not available on this device")
          return
        }
        useImageViewer.getState().open({
          images: [
            {
              id: file.id,
              url: file.imageDataUrl,
              alt: file.name,
              filename: file.name,
              sizeBytes: file.size,
            },
          ],
        })
      } else if (type.includes("wordprocessingml") || name.endsWith(".docx")) {
        useDocxViewer.getState().open({ fileId: refId })
      } else if (
        type === "text/csv" ||
        name.endsWith(".csv") ||
        type.includes("spreadsheet") ||
        name.endsWith(".xlsx")
      ) {
        useCsvViewer.getState().open({ fileId: refId })
      } else {
        // Plain text / markdown / json / code / pdf-extracted, etc.
        useTextViewer.getState().open({ fileId: refId })
      }
      return
    }
    case "sticky":
      // Sticky notes are edited in place; nothing to open.
      return
  }
}

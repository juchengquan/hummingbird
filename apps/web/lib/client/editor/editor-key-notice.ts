import "client-only"

/**
 * Wave 12 (Q124): the editor's own AI Gateway key setting is removed —
 * agent-py never takes a user's key (Q103), and the Next route bills the
 * deploy's. The key was never persisted (it lived in the settings dialog's
 * state and the editor plugins' options for the page's lifetime), so there
 * is nothing to migrate out of storage (no store version bump). Instead the
 * user sees **one** note saying so, the first time the editor settings open
 * (where the field was — so only someone looking for it sees the note), and
 * never again: remembered under `EDITOR_KEY_REMOVED_NOTICE_KEY` in
 * localStorage, or for the page when storage is unavailable.
 */

import { toast } from "sonner"

export const EDITOR_KEY_REMOVED_NOTICE =
  "The editor's AI now uses this deploy's models. The AI Gateway API key setting was removed."

export const EDITOR_KEY_REMOVED_NOTICE_KEY = "humm.editorKeyRemovedNotice"

/** The storage seam (tests pass a stand-in). */
export interface NoticeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): NoticeStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

/** A notice that shows `EDITOR_KEY_REMOVED_NOTICE` at most once per
 *  browser (once per page without storage). */
export function createEditorKeyNotice({
  storage = defaultStorage,
  show = (message: string) => void toast.info(message),
}: {
  storage?: () => NoticeStorage | null
  show?: (message: string) => void
} = {}): () => void {
  let shownHere = false
  return () => {
    if (shownHere) return
    const store = storage()
    try {
      if (store?.getItem(EDITOR_KEY_REMOVED_NOTICE_KEY) === "1") return
    } catch {
      // Unreadable: fall back to once per page.
    }
    shownHere = true
    try {
      store?.setItem(EDITOR_KEY_REMOVED_NOTICE_KEY, "1")
    } catch {
      // Private mode / quota — once per page, then.
    }
    show(EDITOR_KEY_REMOVED_NOTICE)
  }
}

/** The app's notice (the editor settings dialog calls it on open). */
export const noticeEditorKeyRemoved = createEditorKeyNotice()

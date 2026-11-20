"use client"
import "client-only"

import { useEffect, useSyncExternalStore } from "react"

import { parseMessageBlobRef } from "@/shared/message-blob-ref"

import {
  getCachedMessageBlob,
  isMessageBlobMissing,
  resolveMessageBlobUrl,
  subscribeMessageBlobs,
} from "./message-blobs"

export type MessageBlobUrlState =
  | { status: "ready"; url: string }
  | { status: "loading"; url?: undefined }
  | { status: "missing"; url?: undefined }

const LOADING: MessageBlobUrlState = { status: "loading" }
const MISSING: MessageBlobUrlState = { status: "missing" }

/**
 * Resolve a generated image / file URL for rendering. Plain URLs
 * (http(s), signed, inline `data:`) are `ready` immediately; a store-v33
 * placeholder reference (`hb-blob:…`) is `loading` until the session
 * cache / IndexedDB answers, then `ready` — or `missing` when the bytes
 * are gone. Callers must never put a non-`ready` URL into an `<img>` /
 * `href`: show a skeleton (loading) or an "unavailable" tile (missing).
 */
export function useMessageBlobUrl(url: string | undefined): MessageBlobUrlState {
  const key = parseMessageBlobRef(url)
  const cached = useSyncExternalStore(
    subscribeMessageBlobs,
    () => (key ? getCachedMessageBlob(key) : undefined),
    () => undefined
  )
  const gone = useSyncExternalStore(
    subscribeMessageBlobs,
    () => (key ? isMessageBlobMissing(key) : false),
    () => false
  )

  useEffect(() => {
    if (!key || !url || cached) return
    void resolveMessageBlobUrl(url)
  }, [key, url, cached])

  if (!url) return MISSING
  if (!key) return { status: "ready", url }
  if (cached) return { status: "ready", url: cached }
  return gone ? MISSING : LOADING
}

import "client-only"

import { isSafeImageUrl, planImageOpen } from "@/shared/safe-url"

import { triggerDownload } from "./download"

/** How long a blob URL opened in a new tab stays valid. The new tab
 *  has loaded the image long before this; revoking frees the memory. */
const BLOB_URL_TTL_MS = 60_000

function blobFromPlan(plan: {
  mime: string
  base64: boolean
  payload: string
}): Blob {
  if (plan.base64) {
    const bin = atob(plan.payload.replace(/\s+/g, ""))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: plan.mime })
  }
  return new Blob([decodeURIComponent(plan.payload)], { type: plan.mime })
}

/**
 * Open an image URL in a new tab, safely. http(s)/relative URLs open
 * directly; raster `data:` images open via a short-lived blob URL
 * (browsers block top-level `data:` navigation); anything else
 * (`javascript:`, SVG data URLs, unknown schemes) is refused.
 * Always `noopener,noreferrer`. Returns false when refused / failed.
 */
export function openImageInNewTab(url: string): boolean {
  const plan = planImageOpen(url)
  if (plan.kind === "blocked") return false
  if (plan.kind === "direct") {
    window.open(plan.url, "_blank", "noopener,noreferrer")
    return true
  }
  try {
    const objectUrl = URL.createObjectURL(blobFromPlan(plan))
    window.open(objectUrl, "_blank", "noopener,noreferrer")
    setTimeout(() => URL.revokeObjectURL(objectUrl), BLOB_URL_TTL_MS)
    return true
  } catch {
    return false
  }
}

/** Download an image via a transient anchor. Refuses URLs that fail
 *  `isSafeImageUrl` — a `javascript:` href would run on click. */
export function downloadImage(url: string, name: string): boolean {
  if (!isSafeImageUrl(url)) return false
  return triggerDownload(url, name)
}

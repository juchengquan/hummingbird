import "client-only"

import { isSafeDownloadUrl } from "@/shared/safe-url"

/** Programmatic download via a transient anchor — used after an async
 *  re-sign, when the original click was prevented. Refuses URLs that
 *  fail `isSafeDownloadUrl` (a `javascript:` href would run on click);
 *  returns whether the download was started. */
export function triggerDownload(url: string, name: string): boolean {
  if (!isSafeDownloadUrl(url)) return false
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  // Detach on the next tick — some browsers (older WebKit/Safari) cancel a
  // download whose initiating anchor is removed in the same tick as click().
  a.click()
  setTimeout(() => a.remove(), 0)
  return true
}

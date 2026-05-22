"use client"

/**
 * Right-side panel slot coordinator.
 *
 * Three viewers compete for the right side of the screen — PDF
 * viewer, URL bookmark drawer, live-artifact preview. Stacking
 * `Sheet`s is bad UX; we want one at a time. Each viewer keeps its
 * own Zustand store (so the mount-point components stay simple); this
 * module is the thin facade that knows about all three and closes
 * the others when one opens.
 *
 * Call these instead of the raw `useFooViewer.getState().open(...)`
 * — that way the share-the-slot rule is enforced in one place. The
 * raw stores are still used internally by the host components to
 * subscribe to their own target/close.
 */

import {
  useLiveArtifact,
  type LiveArtifactTarget,
} from "@/components/live-artifact/store"
import { useImageViewer, type ImageViewerTarget } from "@/components/image-viewer/types"
import { usePdfViewer, type PdfViewerTarget } from "@/components/pdf-viewer/types"
import { useUrlPreview, type UrlPreviewTarget } from "@/components/url-viewer/types"

type Slot = "pdf" | "url" | "artifact" | "image"

function closeOthers(except: Slot) {
  if (except !== "pdf") usePdfViewer.getState().close()
  if (except !== "url") useUrlPreview.getState().close()
  if (except !== "artifact") useLiveArtifact.getState().close()
  if (except !== "image") useImageViewer.getState().close()
}

export function openPdf(target: PdfViewerTarget) {
  closeOthers("pdf")
  usePdfViewer.getState().open(target)
}

export function openUrlPreview(target: UrlPreviewTarget) {
  closeOthers("url")
  useUrlPreview.getState().open(target)
}

export function openLiveArtifact(target: LiveArtifactTarget) {
  closeOthers("artifact")
  useLiveArtifact.getState().open(target)
}

export function openImageViewer(target: ImageViewerTarget) {
  closeOthers("image")
  useImageViewer.getState().open(target)
}

export function closeRightPanel() {
  usePdfViewer.getState().close()
  useUrlPreview.getState().close()
  useLiveArtifact.getState().close()
  useImageViewer.getState().close()
}

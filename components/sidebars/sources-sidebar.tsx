"use client"

import * as React from "react"
import { ChevronsLeft } from "lucide-react"
import { useStore } from "@/lib/hooks/use-store"
import { SlidingSidebar } from "./sliding-sidebar"
import { ResourcePanel } from "../panels/sources"

export function SourcesSidebar() {
  const { sourcesPanelOpen, toggleSourcesPanel } = useStore()

  return (
    <SlidingSidebar
      isOpen={sourcesPanelOpen}
      onClose={toggleSourcesPanel}
      closeButtonIcon={<ChevronsLeft size={20} className="text-[var(--foreground)]" />}
      closeButtonLabel="Close sources"
      width={"20vw"}
    >
      <ResourcePanel />
    </SlidingSidebar>
  )
}

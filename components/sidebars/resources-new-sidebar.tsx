"use client"

import * as React from "react"
import { ChevronsLeft } from "lucide-react"
import { useStore } from "@/lib/hooks/use-store"
import { SlidingSidebar } from "./sliding-sidebar"
import { ResourcePanel } from "../panels/resource"

export function ResourcesNewSidebar() {
  const { resourcesNewPanelOpen, toggleResourcesNewPanel } = useStore()

  return (
    <SlidingSidebar
      isOpen={resourcesNewPanelOpen}
      onClose={toggleResourcesNewPanel}
      closeButtonIcon={<ChevronsLeft size={20} className="text-[var(--foreground)]" />}
      closeButtonLabel="Close resources new"
    >
      <ResourcePanel />
    </SlidingSidebar>
  )
}

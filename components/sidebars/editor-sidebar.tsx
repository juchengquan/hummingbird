"use client"

import * as React from "react"
import { X } from "lucide-react"
import { useStore } from "@/lib/hooks/use-store"
import { useSidebar } from "@/components/ui/sidebar"

// Sidebar width constants
const SIDEBAR_EXPANDED_WIDTH = 256
const SIDEBAR_COLLAPSED_WIDTH = 48

export function EditorSidebar() {
  const { editorPanelOpen, toggleEditorPanel } = useStore()
  const { state: sidebarState } = useSidebar()
  const [isVisible, setIsVisible] = React.useState(false)
  const [isOpen, setIsOpen] = React.useState(false)
  const divRef = React.useRef<HTMLDivElement>(null)

  // Calculate sidebar offset based on sidebar state
  const sidebarWidth = sidebarState === "expanded" ? SIDEBAR_EXPANDED_WIDTH : SIDEBAR_COLLAPSED_WIDTH

  // Handle animation end
  const handleAnimationEnd = React.useCallback(() => {
    if (!isOpen) {
      setIsVisible(false)
    }
  }, [isOpen])

  React.useEffect(() => {
    if (editorPanelOpen) {
      setIsVisible(true)
      setIsOpen(true)
    } else {
      setIsOpen(false)
    }
  }, [editorPanelOpen])

  if (!isVisible) {
    return null
  }

  return (
    <div
      ref={divRef}
      onAnimationEnd={handleAnimationEnd}
      className={`
        fixed top-0 h-full z-90
        w-[1300px] border-l border-[var(--border)]
        bg-[var(--background)]
        ${isOpen ? "animate-slide-in-right" : "animate-slide-out-right"}
      `}
      style={{ left: `${sidebarWidth}px` }}
    >
      <div className="flex flex-col h-full">
        {/* Header with close button */}
        <div className="flex items-center justify-end p-2 border-b border-[var(--border)]">
          <button
            onClick={toggleEditorPanel}
            className="p-1 hover:bg-[var(--accent)] rounded-md transition-colors"
            aria-label="Close editor"
          >
            <X size={18} className="text-[var(--foreground)]" />
          </button>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-hidden p-4">
          {/* Empty panel - will be populated later with full-editor component */}
        </div>
      </div>
    </div>
  )
}

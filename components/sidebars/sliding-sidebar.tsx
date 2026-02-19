"use client"

import * as React from "react"
import { useSidebar } from "@/components/ui/sidebar"

// Sidebar width constants (from ui/sidebar.tsx)
const SIDEBAR_EXPANDED_WIDTH = 256
const SIDEBAR_COLLAPSED_WIDTH = 48

interface SlidingSidebarProps {
  isOpen: boolean
  onClose: () => void
  children: React.ReactNode
  closeButtonIcon: React.ReactNode
  closeButtonLabel: string
  className?: string
}

export function SlidingSidebar({
  isOpen,
  onClose,
  children,
  closeButtonIcon,
  closeButtonLabel,
  className = "",
}: SlidingSidebarProps) {
  const { state: sidebarState } = useSidebar()
  const [isVisible, setIsVisible] = React.useState(false)
  const [wasOpen, setWasOpen] = React.useState(isOpen)

  // Calculate sidebar offset based on sidebar state
  const sidebarWidth = sidebarState === "expanded" ? SIDEBAR_EXPANDED_WIDTH : SIDEBAR_COLLAPSED_WIDTH

  // Handle animation end
  const handleAnimationEnd = React.useCallback(() => {
    if (!isOpen && wasOpen) {
      setIsVisible(false)
      setWasOpen(false)
    }
  }, [isOpen, wasOpen])

  React.useEffect(() => {
    if (isOpen) {
      setIsVisible(true)
      setWasOpen(true)
    }
  }, [isOpen])

  if (!isVisible) {
    return null
  }

  // Determine animation class based on whether we're opening or closing
  const animationClass = isOpen ? "animate-slide-in-right" : "animate-slide-out-right"

  return (
    <div
      onAnimationEnd={handleAnimationEnd}
      className={`
        fixed top-0 h-full z-50
        border-l border-[var(--border)]
        bg-[var(--background)]
        ${animationClass}
        ${className}
      `}
      style={{
        left: `${sidebarWidth}px`,
        width: `calc(100vw - ${sidebarWidth}px)`,
      }}
    >
      <div className="flex flex-col h-full">
        {/* Header with close button */}
        <div className="flex items-center justify-end p-1 border-b border-[var(--border)]">
          <button
            onClick={onClose}
            className="p-1 hover:bg-[var(--accent)] rounded-md transition-colors"
            aria-label={closeButtonLabel}
          >
            {closeButtonIcon}
          </button>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  )
}

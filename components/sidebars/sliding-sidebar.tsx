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
  width?: string | number
}

export function SlidingSidebar({
  isOpen,
  onClose,
  children,
  closeButtonIcon,
  closeButtonLabel,
  className = "",
  width,
}: SlidingSidebarProps) {
  const { state: sidebarState } = useSidebar()
  const [mounted, setMounted] = React.useState(false)
  const [isVisible, setIsVisible] = React.useState(false)
  const [wasOpen, setWasOpen] = React.useState(isOpen)

  // Track mount state to avoid hydration mismatch
  React.useEffect(() => {
    setMounted(true)
  }, [])

  // Calculate sidebar offset - use default to match server initially
  const sidebarWidth = mounted && sidebarState === "collapsed"
    ? SIDEBAR_COLLAPSED_WIDTH
    : SIDEBAR_EXPANDED_WIDTH

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

  // Only apply animation after mount to avoid hydration mismatch
  const animationClass = mounted
    ? (isOpen ? "animate-slide-in-right" : "animate-slide-out-right")
    : ""

  // Only render when mounted and visible (keeps editor mounted after first open)
  const shouldRender = mounted && (isVisible || isOpen)

  // On server or initial render, always show to match
  const visibilityClass = mounted && !shouldRender ? 'invisible' : ''

  // Use consistent pointerEvents - always auto when not mounted to match server
  const pointerEventsValue = mounted ? (isOpen ? 'auto' : 'none') : 'auto'

  return (
    <div
      onAnimationEnd={handleAnimationEnd}
      className={`
        fixed top-0 h-full z-50
        border-l border-[var(--border)]
        bg-[var(--background)]
        ${animationClass}
        ${className}
        ${visibilityClass}
      `}
      style={{
        left: `${sidebarWidth}px`,
        width: width ?? `calc(100vw - ${sidebarWidth}px)`,
        pointerEvents: pointerEventsValue,
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

        {/* Content area - always rendered to keep editor mounted */}
        <div className="flex-1 overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  )
}

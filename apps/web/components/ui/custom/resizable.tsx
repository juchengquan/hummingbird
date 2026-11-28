"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { cn } from "@/shared/utils"

interface ThreePanelResizableProps {
  firstPanel: React.ReactNode
  secondPanel: React.ReactNode
  thirdPanel: React.ReactNode
  showFirstPanel?: boolean
  defaultFirstWidth?: number
  defaultSecondWidth?: number
  minFirstWidth?: number
  minSecondWidth?: number
  maxFirstWidth?: number
  maxSecondWidth?: number
  offset?: number  // Sidebar width as percentage (e.g., 20 for 20%)
}

export function ResizablePanelGroup({
  firstPanel,
  secondPanel,
  thirdPanel,
  showFirstPanel = true,
  defaultFirstWidth = 20,
  defaultSecondWidth = 40,
  minFirstWidth = 10,
  minSecondWidth = 20,
  maxFirstWidth = 40,
  maxSecondWidth = 60,
  offset = 0,
}: ThreePanelResizableProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState<"first" | "second" | null>(null)
  const [mounted, setMounted] = useState(false)

  // Use fixed widths until mounted to avoid hydration mismatch
  const isFirstPanelVisible = showFirstPanel

  // Start with default widths, update after mount
  const [firstWidth, setFirstWidth] = useState(defaultFirstWidth)
  const [secondWidth, setSecondWidth] = useState(defaultSecondWidth)

  useEffect(() => {
    setMounted(true)
  }, [])

  // After mount, sync with any prop changes
  useEffect(() => {
    if (mounted) {
      setFirstWidth(defaultFirstWidth)
      setSecondWidth(defaultSecondWidth)
    }
  }, [defaultFirstWidth, defaultSecondWidth, mounted])

  const handleMouseDown = useCallback((handle: "first" | "second") => (e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(handle)
  }, [])

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!containerRef.current || !isDragging) return

      const containerRect = containerRef.current.getBoundingClientRect()
      const containerWidth = containerRect.width
      const mouseX = e.clientX - containerRect.left
      const mousePercent = (mouseX / containerWidth) * 100

      if (isDragging === "first" && isFirstPanelVisible) {
        const newFirstWidth = Math.min(
          Math.max(mousePercent, minFirstWidth),
          maxFirstWidth
        )

        const currentSecondWidth = secondWidth
        const displayThirdWidth = 100 - newFirstWidth - currentSecondWidth

        if (displayThirdWidth >= minSecondWidth) {
          setFirstWidth(newFirstWidth)
        } else {
          const maxFirstWithCurrentSecond = 100 - currentSecondWidth - minSecondWidth
          const clampedFirstWidth = Math.min(newFirstWidth, maxFirstWithCurrentSecond)
          setFirstWidth(clampedFirstWidth)
        }
      } else if (isDragging === "second") {
        const firstPanelWidth = isFirstPanelVisible ? firstWidth : 0
        const availableSpace = 100 - firstPanelWidth - minSecondWidth

        let newSecondWidth = mousePercent - firstPanelWidth
        newSecondWidth = Math.max(minSecondWidth, Math.min(newSecondWidth, maxSecondWidth))

        if (!isFirstPanelVisible) {
          newSecondWidth = Math.min(Math.max(mousePercent, minSecondWidth), maxSecondWidth)
        } else {
          newSecondWidth = Math.min(newSecondWidth, availableSpace)
        }

        setSecondWidth(newSecondWidth)
      }
    },
    [isDragging, isFirstPanelVisible, firstWidth, secondWidth, minFirstWidth, minSecondWidth, maxFirstWidth, maxSecondWidth]
  )

  const handleMouseUp = useCallback(() => {
    setIsDragging(null)
  }, [])

  useEffect(() => {
    if (isDragging) {
      document.addEventListener("mousemove", handleMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove)
      document.removeEventListener("mouseup", handleMouseUp)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
  }, [isDragging, handleMouseMove, handleMouseUp])

  // Use default widths before mount to ensure server/client match
  const widthsReady = mounted

  // Calculate widths with offset support
  // When offset is applied (e.g., sidebar visible), we scale all panels proportionally
  // to fit within the available width (100 - offset)%
  const availableWidth = 100 - offset

  const maxSecondWhenFirstHidden = 100 - minSecondWidth
  const baseSecondWidth = widthsReady ? secondWidth : defaultSecondWidth
  const displaySecondWidth = isFirstPanelVisible
    ? baseSecondWidth
    : Math.min(baseSecondWidth, maxSecondWhenFirstHidden)

  // Show/hide first panel - no animation
  const baseFirstWidth = widthsReady ? firstWidth : defaultFirstWidth
  const displayFirstWidth = isFirstPanelVisible ? baseFirstWidth : 0

  // Calculate third panel width (before offset scaling)
  const baseThirdWidth = Math.max(100 - displayFirstWidth - displaySecondWidth, 0)

  // Apply offset scaling to maintain ratios when sidebar is toggled
  // If offset = 20 (sidebar expanded), we scale from 100% to 80% available
  const displayThirdWidth = baseThirdWidth * (availableWidth / 100)
  const scaledFirstWidth = displayFirstWidth * (availableWidth / 100)
  const scaledSecondWidth = displaySecondWidth * (availableWidth / 100)

  // Common transition style for smooth animation (300ms with ease-out curve)
  const transitionStyle = {
    transitionProperty: "width, left",
    transitionDuration: "300ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)"
  }

  // Show loading state before mount to avoid hydration mismatch
  if (!mounted) {
    const loadingFirstWidth = isFirstPanelVisible ? defaultFirstWidth : 0
    const loadingSecondWidth = isFirstPanelVisible ? defaultSecondWidth : Math.min(defaultSecondWidth, maxSecondWhenFirstHidden)
    const loadingThirdWidth = 100 - loadingFirstWidth - loadingSecondWidth

    // Apply offset scaling to loading state
    const scaledLoadingFirstWidth = loadingFirstWidth * (availableWidth / 100)
    const scaledLoadingSecondWidth = loadingSecondWidth * (availableWidth / 100)
    const scaledLoadingThirdWidth = loadingThirdWidth * (availableWidth / 100)

    return (
      <div ref={containerRef} className="flex items-stretch h-full w-full relative">
        <div className="h-full overflow-hidden" style={{ width: `${scaledLoadingFirstWidth}%` }}>
          <div className="h-full" />
        </div>
        {isFirstPanelVisible && (
          <div className="w-1 h-full cursor-col-resize flex items-center justify-center absolute top-0 bottom-0 z-10" style={{ left: `${scaledLoadingFirstWidth}%`, transform: "translateX(-50%)" }}>
            <div className="w-1 h-12 bg-border rounded-full" />
          </div>
        )}
        <div className="h-full overflow-hidden" style={{ width: `${scaledLoadingSecondWidth}%` }} />
        <div className="w-1 h-full cursor-col-resize flex items-center justify-center absolute top-0 bottom-0 z-10" style={{ left: `${scaledLoadingFirstWidth + scaledLoadingSecondWidth}%`, transform: "translateX(-50%)" }}>
          <div className="w-1 h-12 bg-border rounded-full" />
        </div>
        <div className="h-full overflow-hidden flex-1" style={{ width: `${scaledLoadingThirdWidth}%` }} />
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex items-stretch h-full w-full relative">
      {/* First Panel (Resources) */}
      <>
        <div
          className="h-full overflow-hidden"
          style={{ width: `${scaledFirstWidth}%`, ...(!isDragging ? transitionStyle : {}) }}
        >
          <div className="mx-1 h-full">
            {firstPanel}
          </div>
        </div>

        {/* First Resize Handle - only show when panel is visible */}
        {isFirstPanelVisible && (
          <div
            className={cn(
              "w-1 h-full cursor-col-resize flex items-center justify-center",
              "hover:bg-primary/30 transition-colors",
              "absolute top-0 bottom-0 z-10",
              isDragging === "first" && "bg-primary/50"
            )}
            style={{
              left: `${scaledFirstWidth}%`,
              transform: "translateX(-50%)",
              ...(!isDragging ? transitionStyle : {})
            }}
            onMouseDown={handleMouseDown("first")}
          >
            <div className="w-1 h-12 bg-border rounded-full hover:bg-primary/50 transition-colors" />
          </div>
        )}
      </>

      {/* Second Panel (Chat) */}
      <div
        className="h-full overflow-hidden"
        style={{ width: `${scaledSecondWidth}%`, ...(!isDragging ? transitionStyle : {}) }}
      >
        <div className="mx-1 h-full">
          {secondPanel}
        </div>
      </div>

      {/* Second Resize Handle */}
      <div
        className={cn(
          "w-1 h-full cursor-col-resize flex items-center justify-center",
          "hover:bg-primary/30 transition-colors",
          "absolute top-0 bottom-0 z-10",
          isDragging === "second" && "bg-primary/50"
        )}
        style={{
          left: `${scaledFirstWidth + scaledSecondWidth}%`,
          transform: "translateX(-50%)",
          ...(!isDragging ? transitionStyle : {})
        }}
        onMouseDown={handleMouseDown("second")}
      >
        <div className="w-1 h-12 bg-border rounded-full hover:bg-primary/50 transition-colors" />
      </div>

      {/* Third Panel (Editor) */}
      <div
        className="h-full overflow-hidden"
        style={{ width: `${displayThirdWidth}%`, ...(!isDragging ? transitionStyle : {}) }}
      >
        <div className="mx-1 h-full">
          {thirdPanel}
        </div>
      </div>
    </div>
  )
}

"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

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
}: ThreePanelResizableProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState<"first" | "second" | null>(null)

  const isFirstPanelVisible = showFirstPanel

  // Use state with lazy initializer - only runs once on mount
  const [firstWidth, setFirstWidth] = useState(() => defaultFirstWidth)
  const [secondWidth, setSecondWidth] = useState(() => defaultSecondWidth)

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
        const thirdWidth = 100 - newFirstWidth - currentSecondWidth

        if (thirdWidth >= minSecondWidth) {
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

  // Calculate widths
  const maxSecondWhenFirstHidden = 100 - minSecondWidth
  const displaySecondWidth = isFirstPanelVisible ? secondWidth : Math.min(secondWidth, maxSecondWhenFirstHidden)

  // Show/hide first panel - no animation
  const displayFirstWidth = isFirstPanelVisible ? firstWidth : 0

  // Calculate third panel width
  let thirdWidth = 100 - displayFirstWidth - displaySecondWidth
  thirdWidth = Math.max(thirdWidth, 0)

  return (
    <div ref={containerRef} className="flex h-full w-full relative">
      {/* First Panel (Resources) */}
      <>
        <div
          className="h-full overflow-hidden"
          style={{ width: `${displayFirstWidth}%` }}
        >
          <div className="h-full">
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
              left: `${displayFirstWidth}%`,
              transform: "translateX(-50%)"
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
        style={{ width: `${displaySecondWidth}%` }}
      >
        {secondPanel}
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
          left: `${displayFirstWidth + displaySecondWidth}%`,
          transform: "translateX(-50%)"
        }}
        onMouseDown={handleMouseDown("second")}
      >
        <div className="w-1 h-12 bg-border rounded-full hover:bg-primary/50 transition-colors" />
      </div>

      {/* Third Panel (Editor) */}
      <div
        className="h-full overflow-hidden flex-1"
        style={{ width: `${thirdWidth}%` }}
      >
        {thirdPanel}
      </div>
    </div>
  )
}

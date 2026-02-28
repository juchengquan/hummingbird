"use client"

import * as React from "react"
import { ResourcePanel } from "@/components/panels/sources"
import { useStore } from "@/lib/hooks/use-store"

export function ResourcesSidebar() {
  const { resourcesPanelOpen } = useStore()
  const [isVisible, setIsVisible] = React.useState(false)
  const [isAnimating, setIsAnimating] = React.useState(false)

  React.useEffect(() => {
    if (resourcesPanelOpen) {
      setIsVisible(true)
      requestAnimationFrame(() => {
        setIsAnimating(true)
      })
    } else {
      setIsAnimating(false)
      const timer = setTimeout(() => setIsVisible(false), 300)
      return () => clearTimeout(timer)
    }
  }, [resourcesPanelOpen])

  if (!isVisible) {
    return null
  }

  return (
    <div
      className={`
        fixed left-0 top-0 h-full z-40
        w-[280px] border-r border-[var(--border)]
        bg-[var(--background)]
        ${isAnimating ? "animate-slide-in-left" : "animate-slide-out-left"}
      `}
    >
      <div className="flex-1 overflow-hidden h-full">
        <ResourcePanel />
      </div>
    </div>
  )
}

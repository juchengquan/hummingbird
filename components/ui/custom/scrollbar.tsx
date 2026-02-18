"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

interface CustomScrollbarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Height of the scroll container */
  height?: string | number
  /** Whether to enable horizontal scrolling */
  horizontal?: boolean
  /** Custom className for inner content */
  innerClassName?: string
  /** Whether this should fill remaining flex space */
  flex?: boolean
}

function CustomScrollbar({
  className,
  children,
  height,
  horizontal = false,
  innerClassName,
  flex = false,
  style,
  ...props
}: CustomScrollbarProps) {
  const scrollStyles: React.CSSProperties = {
    ...style,
    ...(height ? { height } : {}),
  }

  return (
    <div
      className={cn(
        "overflow-y-auto overflow-x-hidden",
        horizontal && "overflow-x-auto overflow-y-hidden",
        flex && "flex-1",
        className
      )}
      style={scrollStyles}
      {...props}
    >
      <div className={cn("min-w-0", innerClassName)}>{children}</div>
    </div>
  )
}

export { CustomScrollbar }

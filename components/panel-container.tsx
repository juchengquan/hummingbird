"use client"

import { cn } from "@/lib/utils"
import { ReactNode } from "react"

interface PanelContainerProps {
  title: string
  children: ReactNode
  actions?: ReactNode
  className?: string
  headerClassName?: string
  side?: "left" | "right"
  width?: string
}

export function PanelContainer({
  title,
  children,
  actions,
  className,
  headerClassName,
  side = "left",
  width = "100%",
}: PanelContainerProps) {
  return (
    <div
      className={cn(
        "panel-container h-full flex flex-col",
        // side === "left" ? "border-r" : "border-l",
        className
      )}
      style={{ width, minWidth: width }}
    >
      <div className={cn("panel-header shrink-0", headerClassName)}>
        {/* <h2 className="text-sm font-semibold text-[var(--foreground)] truncate">
          {title}
        </h2> */}
        {actions && <div className="flex items-center gap-1">{actions}</div>}
      </div>
      <div className="panel-content flex-1 overflow-hidden">{children}</div>
    </div>
  )
}

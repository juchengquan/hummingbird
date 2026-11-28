"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/shared/utils"

/**
 * Shadcn-style switch, wired to Radix. Use this anywhere a binary
 * on/off control is needed (Skills row, future settings panels, etc.).
 * `data-state=checked` styling drives the track + thumb visuals so the
 * markup is just a Root + Thumb and the consumer doesn't pass extra
 * className-juggling for state.
 */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full",
        "border border-transparent shadow-xs transition-all outline-none",
        "focus-visible:ring-[3px] focus-visible:ring-[var(--ring)]/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-[var(--primary)] data-[state=unchecked]:bg-[var(--input)]",
        "dark:data-[state=unchecked]:bg-[var(--input)]/80",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 rounded-full ring-0",
          "transition-transform",
          "bg-[var(--background)] dark:bg-[var(--foreground)]",
          "data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }

"use client"

import { Sun, Moon, Monitor, Check } from "lucide-react"
import { useStore } from "@/client/hooks/use-store"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/shared/utils"

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

export function ThemeToggle() {
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)

  // Icon on the trigger reflects the *picked* setting, not the resolved one.
  // (Resolved theme is what's actually rendered; user picked is what they
  // chose. Showing what they picked is clearer.)
  const TriggerIcon =
    theme === "light" ? Sun : theme === "dark" ? Moon : Monitor

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle theme"
          className="h-7 w-7 shrink-0"
        >
          <TriggerIcon size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem
            key={value}
            onClick={() => setTheme(value)}
            className="gap-2 cursor-pointer"
          >
            <Icon size={14} />
            <span className="flex-1">{label}</span>
            <Check
              size={12}
              className={cn(
                "transition-opacity",
                theme === value ? "opacity-100" : "opacity-0"
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

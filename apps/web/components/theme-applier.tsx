"use client"

import { useEffect } from "react"
import { useStore } from "@/client/hooks/use-store"

/**
 * Reads the store's `theme` value and toggles the `.dark` class on
 * `<html>` so Tailwind's `dark:` variant works (see `globals.css`:
 * `@custom-variant dark (&:is(.dark *))`).
 *
 * A small inline script in `app/layout.tsx` applies the same logic
 * pre-hydration to avoid a light → dark flash on first paint.
 */
export function ThemeApplier() {
  const theme = useStore((s) => s.theme)
  const colorScheme = useStore((s) => s.colorScheme)

  useEffect(() => {
    if (typeof window === "undefined") return
    const root = document.documentElement

    const resolveDark = (): boolean => {
      if (theme === "light") return false
      if (theme === "dark") return true
      return window.matchMedia("(prefers-color-scheme: dark)").matches
    }

    const apply = () => {
      root.classList.toggle("dark", resolveDark())
    }

    apply()

    if (theme !== "system") return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    mq.addEventListener("change", apply)
    return () => mq.removeEventListener("change", apply)
  }, [theme])

  useEffect(() => {
    if (typeof window === "undefined") return
    const root = document.documentElement
    root.classList.toggle("anthropic", colorScheme === "anthropic")
  }, [colorScheme])

  return null
}

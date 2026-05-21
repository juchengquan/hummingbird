import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Format a byte count as a short human-readable string ("512 B",
 * "1.5 KB", "2.3 MB"). Uses 1024-based units; trailing zeros are
 * dropped so 5120 renders as "5 KB" rather than "5.0 KB".
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i]
}

/**
 * Coerce a `Date | string` into an ISO 8601 string. Zustand-persist
 * rehydrates Date fields as strings (no reviver), so any code path
 * that touches a date from the store may receive either type — this
 * helper lets the call site stop caring.
 */
export function toISO(d: Date | string): string {
  return typeof d === "string" ? d : d.toISOString()
}

"use client"
import "client-only"

/**
 * MiniFormCard — 1–4 short labelled text/number/select fields.
 * Default resolution is composer prefill (the user reviews the
 * formatted text in the composer before sending — `defaultResolution
 * For("mini-form") === "prefill"`).
 */

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type {
  MiniFormProps,
  UiAnswer,
} from "@/shared/generative-ui/schemas"
import { cn } from "@/shared/utils"

import type { UiPartHostProps } from "@/client/chat/generative-ui/registry"

export function MiniFormCard({
  props,
  inert,
  answer,
  onResolve,
}: UiPartHostProps) {
  const p = props as MiniFormProps
  const submitted =
    answer && answer.kind === "mini-form"
      ? (answer as Extract<UiAnswer, { kind: "mini-form" }>).values
      : null

  const [values, setValues] = useState<Record<string, string>>(() =>
    submitted ?? {},
  )

  const setValue = (id: string, v: string) =>
    setValues((prev) => ({ ...prev, [id]: v }))

  const submit = () => {
    onResolve({ kind: "mini-form", values })
  }

  const submitLabel = p.submitLabel ?? "Submit"
  const allValues = inert && submitted ? submitted : values

  return (
    <div
      className={cn(
        "my-3 rounded-lg border border-[var(--border)]",
        "bg-[var(--card)] text-[var(--card-foreground)]",
        "p-3 text-sm",
      )}
      aria-label="Form"
    >
      {p.prompt ? (
        <div className="mb-2 text-[var(--foreground)]">{p.prompt}</div>
      ) : null}
      <div className="flex flex-col gap-2">
        {p.fields.map((f) => {
          const id = `mini-form-${f.id}`
          if (f.type === "select") {
            return (
              <div key={f.id} className="flex flex-col gap-1">
                <label
                  htmlFor={id}
                  className="text-xs text-[var(--muted-foreground)]"
                >
                  {f.label}
                </label>
                <select
                  id={id}
                  className={cn(
                    "h-8 rounded border border-[var(--border)] bg-[var(--background)]",
                    "px-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--ring)]",
                    inert && "opacity-70",
                  )}
                  disabled={inert}
                  value={allValues[f.id] ?? ""}
                  onChange={(e) => setValue(f.id, e.target.value)}
                >
                  <option value="">—</option>
                  {f.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            )
          }
          return (
            <div key={f.id} className="flex flex-col gap-1">
              <label
                htmlFor={id}
                className="text-xs text-[var(--muted-foreground)]"
              >
                {f.label}
              </label>
              <Input
                id={id}
                type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                placeholder={f.type !== "date" ? f.placeholder : undefined}
                value={allValues[f.id] ?? ""}
                onChange={(e) => setValue(f.id, e.target.value)}
                disabled={inert}
                {...(f.type === "text" && f.maxLength
                  ? { maxLength: f.maxLength }
                  : {})}
                {...(f.type === "number" && f.min !== undefined
                  ? { min: f.min }
                  : {})}
                {...(f.type === "number" && f.max !== undefined
                  ? { max: f.max }
                  : {})}
                className="h-8 text-sm"
              />
            </div>
          )
        })}
        {!inert && (
          <div className="mt-1">
            <Button type="button" size="sm" onClick={submit}>
              {submitLabel}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

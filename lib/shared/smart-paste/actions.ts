/**
 * Action sets per paste kind. Each action provides:
 *   - id        : stable string for keys
 *   - label     : button text shown on the chip
 *   - buildPrompt(detection) : the string the chat input is replaced with
 *
 * Pure functions; no React, no fetch. The chip component invokes
 * buildPrompt and writes the result to the input value.
 */

import type { PasteDetection, PasteKind } from "./detect"

export interface PasteAction {
  id: string
  label: string
  buildPrompt: (detection: PasteDetection) => string
  /**
   * When true, the action is a non-prompt side effect (e.g. opening a
   * URL). The chip handler runs `sideEffect()` and dismisses the chip
   * without touching the input value.
   */
  sideEffect?: (detection: PasteDetection) => void
}

function fence(snippet: string, lang?: string): string {
  return "```" + (lang ?? "") + "\n" + snippet + "\n```"
}

export const ACTIONS_BY_KIND: Record<PasteKind, PasteAction[]> = {
  url: [
    {
      id: "summarize",
      label: "Summarize",
      buildPrompt: (d) => `Summarize this URL: ${d.url ?? d.snippet}`,
    },
    {
      id: "open",
      label: "Open",
      buildPrompt: () => "",
      sideEffect: (d) => {
        const url = d.url ?? d.snippet
        if (typeof window !== "undefined") {
          window.open(url, "_blank", "noopener,noreferrer")
        }
      },
    },
  ],
  json: [
    {
      id: "explain",
      label: "Format & explain",
      buildPrompt: (d) =>
        `Pretty-print this JSON and explain its shape:\n${fence(d.snippet, "json")}`,
    },
    {
      id: "types",
      label: "Generate TS types",
      buildPrompt: (d) =>
        `Generate TypeScript types matching this JSON. Use \`interface\` for objects and \`type\` for unions/literals.\n${fence(
          d.snippet,
          "json"
        )}`,
    },
  ],
  csv: [
    {
      id: "summarize",
      label: "Summarize columns",
      buildPrompt: (d) =>
        `Look at this CSV (${d.lineCount} rows) and tell me what the columns mean and what's interesting:\n${fence(
          d.snippet
        )}`,
    },
    {
      id: "plot",
      label: "Suggest a chart",
      buildPrompt: (d) =>
        `Suggest a chart for this CSV: what kind of chart, what's on each axis, and one or two interesting cuts. Return as a small markdown table.\n${fence(
          d.snippet
        )}`,
    },
  ],
  code: [
    {
      id: "explain",
      label: "Explain",
      buildPrompt: (d) =>
        `Explain this${d.language ? ` ${d.language}` : ""} code:\n${fence(d.snippet, d.language)}`,
    },
    {
      id: "refactor",
      label: "Refactor",
      buildPrompt: (d) =>
        `Refactor this code for clarity. Keep behavior identical. Briefly note what changed and why.\n${fence(
          d.snippet,
          d.language
        )}`,
    },
    {
      id: "bugs",
      label: "Find bugs",
      buildPrompt: (d) =>
        `Find bugs or sharp edges in this code. List them in order of likely impact. If it looks correct, say so.\n${fence(
          d.snippet,
          d.language
        )}`,
    },
  ],
  longText: [
    {
      id: "summarize",
      label: "Summarize",
      buildPrompt: (d) => `Summarize this in 3 bullet points:\n\n${d.snippet}`,
    },
    {
      id: "translate",
      label: "Translate to English",
      buildPrompt: (d) =>
        `Translate this to natural English. Preserve paragraph breaks.\n\n${d.snippet}`,
    },
    {
      id: "rewrite",
      label: "Rewrite concisely",
      buildPrompt: (d) =>
        `Rewrite this more concisely while preserving meaning and tone.\n\n${d.snippet}`,
    },
  ],
}

export function chipLabel(detection: PasteDetection): string {
  switch (detection.kind) {
    case "url":
      return "URL detected"
    case "json":
      return `JSON · ${detection.length.toLocaleString()} chars`
    case "csv":
      return `CSV · ${detection.lineCount} rows`
    case "code":
      return detection.language
        ? `Code · ${detection.language}`
        : `Code · ${detection.lineCount} lines`
    case "longText":
      return `Long text · ${detection.length.toLocaleString()} chars`
  }
}

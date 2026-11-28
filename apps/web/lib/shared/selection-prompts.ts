/**
 * Prompt templates for selection-driven AI actions (Explain, etc.).
 *
 * Lives in `lib/shared` because the prompt is pure data — no React, no
 * fetch, no browser API. Keeping it isolated means the prompt can be
 * tuned by anyone in code review without touching the rendering
 * components, and is testable in isolation if we add unit tests later.
 */

/**
 * Build the user-turn content for explaining a passage in context.
 *
 * The selection is wrapped in triple-quotes so the model can clearly
 * separate "what we're asking about" from "how we're asking" — bare
 * inlined text has historically caused models to think the passage
 * is part of the instruction.
 *
 * Citation-marker instruction is included unconditionally; the chat
 * route's webSearch system note covers the actual cite-when-searching
 * behavior, so this just nudges consistent rendering when the model
 * decides to search.
 */
export function explainSelectionPrompt(selection: string): string {
  const trimmed = selection.trim()
  return [
    "Explain the following passage from the assistant message above,",
    "in plain language and in the context of this conversation.",
    "Keep it concise — 2-3 paragraphs at most. If you cite sources,",
    "use the [N] marker format matching webSearch result order.",
    "",
    `Passage: """${trimmed}"""`,
  ].join("\n")
}

/**
 * Truncate a selection for use as a label (popover header, palette
 * entry, etc.). Picks a sensible breakpoint and adds an ellipsis.
 */
export function truncateSelectionForLabel(
  selection: string,
  maxChars = 80
): string {
  const collapsed = selection.replace(/\s+/g, " ").trim()
  if (collapsed.length <= maxChars) return collapsed
  return collapsed.slice(0, maxChars - 1).trimEnd() + "…"
}

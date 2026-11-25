import dedent from 'dedent';

import { COMPLETE_PREFIX_MAX } from '@/shared/api-schemas';

/**
 * Pure prompt builder for the inline editor ghost-text autocomplete
 * route (`app/api/ai/complete/route.ts`). The output is a single
 * short continuation of `blockText`, biased by the preceding document
 * `prefix`. Plate's Copilot plugin renders the streamed completion as
 * grey ghost text; the user accepts with Tab.
 *
 * Trade-offs pinned in `docs/PLAN-inline-autocomplete.md`:
 * - Continuation-only — no preamble, no Markdown wrappers, no
 *   block-level structure (the suggestion stays in the same block).
 * - Tight token budget (the route caps `maxOutputTokens` at ~60), so
 *   the prompt asks for *up to the next punctuation mark*, not a full
 *   paragraph. Models reliably stop at a sensible boundary inside the
 *   budget rather than truncating mid-word.
 * - The `prefix` is truncated to its trailing slice — the bit closest
 *   to the cursor is what matters; older context is dropped first.
 */

/** Keep the trailing slice of the prefix — the chars closest to the
 *  cursor. The schema's `max` is the wire-level cap; this is the
 *  pre-prompt truncation so we never feed the model more context than
 *  the plan's pinned budget. */
function truncatePrefix(prefix: string): string {
  if (prefix.length <= COMPLETE_PREFIX_MAX) return prefix;
  return prefix.slice(prefix.length - COMPLETE_PREFIX_MAX);
}

export function getCompletePrompt({
  blockText,
  prefix,
}: {
  blockText: string;
  prefix?: string;
}): string {
  const trimmedPrefix = prefix ? truncatePrefix(prefix) : '';

  const rules = dedent`
    - Continue the user's text naturally from where it ends.
    - Output ONLY the continuation — no preamble, no quotes, no Markdown wrappers, no code fences.
    - Stop at the next punctuation mark (., ,, ;, :, ?, !) or end-of-clause.
    - Stay in the same block: do NOT start a new heading, list item, blockquote, or code block.
    - Maintain the existing tone, voice, and language.
    - Do NOT repeat any text already present in the block.
    - If no sensible continuation exists, return "0" with no other text.
  `;

  const context = trimmedPrefix
    ? dedent`
        <preceding_document>
        ${trimmedPrefix}
        </preceding_document>
      `
    : '';

  return dedent`
    You are an inline writing assistant. Predict the next few words that
    continue the user's text, like VS Code Copilot's ghost text.

    ${rules}

    ${context}

    <current_block>
    ${blockText}
    </current_block>

    Continuation:
  `;
}

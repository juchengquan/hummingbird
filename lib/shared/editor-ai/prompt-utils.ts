/**
 * The document the editor AI prompts read, as the browser sends it to
 * agent-py (`components/editor/ai/editor-ai-document.ts` builds it; Q101).
 * The prompts themselves live in agent-py
 * (`services/agent-py/src/agent_py/editor_ai/prompts.py`); their TypeScript
 * originals were deleted in wave 13 (Q141).
 */

/** The document as the prompts need it (Q101). `null` where the
 *  selection doesn't call for it. */
export type EditorAiDocument = {
  /** The selection is expanded (a range, not a caret). */
  isSelecting: boolean;
  /** `generate`'s `<context>` when selecting: the selected blocks'
   *  markdown, `<Selection>` marked inside one block. */
  generateContext: string | null;
  /** `edit`, when selecting: which edit prompt and its `<context>`. */
  edit: { kind: EditKind; context: string } | null;
  /** `comment`'s `<context>`: the blocks with their ids. */
  commentContext: string;
};

export type EditKind = 'multi-block' | 'selection' | 'table';

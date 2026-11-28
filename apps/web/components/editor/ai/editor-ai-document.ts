/**
 * The editor document as the editor AI prompts read it (Q101): the
 * Plate half of what used to be the `/api/ai/command` route's prompt
 * builders. Runs in the browser when agent-py serves the editor (agent-py
 * never sees a Plate value) and in the Next route for itself, so both
 * build their prompts from the same text.
 *
 * Every field is rendered on its own copy of the document: inserting the
 * `<Selection>` markers mutates the editor, and the route used to render
 * only the one prompt a request needed, on a fresh editor.
 */

import { getMarkdown } from '@platejs/ai';
import { serializeMd } from '@platejs/markdown';
import {
  type SlateEditor,
  type TRange,
  type Value,
  createSlateEditor,
  KEYS,
  RangeApi,
} from 'platejs';

import { BaseEditorKit } from '@/components/editor/editor-base-kit';
import type { EditKind, EditorAiDocument } from '@/shared/editor-ai/prompt-utils';

const SELECTION_START = '<Selection>';
const SELECTION_END = '</Selection>';

const addSelection = (editor: SlateEditor) => {
  if (!editor.selection) return;
  if (editor.api.isExpanded()) {
    const [start, end] = RangeApi.edges(editor.selection);

    editor.tf.withoutNormalizing(() => {
      editor.tf.insertText(SELECTION_END, {
        at: end,
      });

      editor.tf.insertText(SELECTION_START, {
        at: start,
      });
    });
  }
};

const removeEscapeSelection = (editor: SlateEditor, text: string) => {
  let newText = text
    .replace(`\\${SELECTION_START}`, SELECTION_START)
    .replace(`\\${SELECTION_END}`, SELECTION_END);

  // If the selection is on a void element, inserting the placeholder will fail, and the string must be replaced manually.
  if (!newText.includes(SELECTION_END)) {
    const [, end] = RangeApi.edges(editor.selection!);

    const node = editor.api.block({ at: end.path });

    if (!node) return newText;
    if (editor.api.isVoid(node[0])) {
      const voidString = serializeMd(editor, { value: [node[0]] });

      const idx = newText.lastIndexOf(voidString);

      if (idx !== -1) {
        newText =
          newText.slice(0, idx) +
          voidString.trimEnd() +
          SELECTION_END +
          newText.slice(idx + voidString.length);
      }
    }
  }

  return newText;
};

/** Check if the current selection fully covers all top-level blocks. */
const isMultiBlocks = (editor: SlateEditor) => {
  const blocks = editor.api.blocks({ mode: 'lowest' });

  return blocks.length > 1;
};

/** Get markdown with selection markers */
const getMarkdownWithSelection = (editor: SlateEditor) =>
  removeEscapeSelection(editor, getMarkdown(editor, { type: 'block' }));

/** Check if the current selection is inside a table cell */
const isSelectionInTable = (editor: SlateEditor): boolean => {
  if (!editor.selection) return false;

  const tableEntry = editor.api.block({
    at: editor.selection,
    match: { type: KEYS.table },
  });

  return !!tableEntry;
};

/** Check if selection is within a single table cell */
const isSingleCellSelection = (editor: SlateEditor): boolean => {
  if (!editor.selection) return false;

  // Get all td blocks in selection
  const cells = Array.from(
    editor.api.nodes({
      at: editor.selection,
      match: { type: KEYS.td },
    })
  );

  return cells.length === 1;
};

const copyOf = (children: Value, selection: TRange | null): SlateEditor =>
  createSlateEditor({
    plugins: BaseEditorKit,
    selection: selection ?? null,
    value: children,
  });

/** `ctx.children` + `ctx.selection` (Plate's AI submit) → the prompts' inputs. */
export function buildEditorAiDocument(
  children: Value,
  selection: TRange | null | undefined
): EditorAiDocument {
  const fresh = () => copyOf(children, selection ?? null);
  const base = fresh();
  const isSelecting = base.api.isExpanded();

  let generateContext: string | null = null;
  let edit: EditorAiDocument['edit'] = null;

  if (isSelecting) {
    // generate: the selection marked unless it spans blocks.
    const forGenerate = fresh();
    if (!isMultiBlocks(forGenerate)) addSelection(forGenerate);
    generateContext = getMarkdownWithSelection(forGenerate);

    // edit: table cells, several blocks, or a span inside one block.
    const forEdit = fresh();
    let kind: EditKind;
    let context: string;
    if (isSelectionInTable(forEdit) && !isSingleCellSelection(forEdit)) {
      kind = 'table';
      context = getMarkdown(forEdit, { type: 'tableCellWithId' });
    } else if (isMultiBlocks(forEdit)) {
      kind = 'multi-block';
      context = getMarkdownWithSelection(forEdit);
    } else {
      kind = 'selection';
      addSelection(forEdit);
      context = getMarkdownWithSelection(forEdit);
    }
    edit = { kind, context };
  }

  return {
    commentContext: getMarkdown(fresh(), { type: 'blockWithBlockId' }),
    edit,
    generateContext,
    isSelecting,
  };
}

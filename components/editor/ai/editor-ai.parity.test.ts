/**
 * Editor AI parity fixture for agent-py's port (wave 9, Q101).
 *
 * The browser renders the document into `EditorAiDocument` (Plate, here
 * `buildEditorAiDocument`); the prompts are built from that text
 * (`lib/shared/editor-ai/prompt/`) — by the Next route, and by agent-py's
 * port (`services/agent-py/src/agent_py/editor_ai/prompts.py`). This test
 * runs the real TS code over a fixed table of documents, selections and
 * message histories, plus the completion prompt and the markdown joiner
 * the text stream goes through, and compares the result with the committed
 * fixture `services/agent-py/tests/fixtures/editor_ai_parity.json`, which
 * `services/agent-py/tests/test_editor_ai_prompts.py` replays against the
 * Python port.
 *
 * A failure here means the prompts, the document rendering or the case
 * table changed: regenerate the fixture, then make the Python test pass.
 *
 *   EDITOR_AI_PARITY_WRITE=1 bun test components/editor/ai/editor-ai.parity.test.ts
 *
 * Texts are BMP only: JS measures lengths in UTF-16 code units.
 *
 * **Bun quirk.** Under Bun (this test), a template literal's *raw* text
 * has its non-ASCII characters escaped (`String.raw\`→\`` is `"\\u2192"`);
 * Node — where Next runs the SWC-compiled route — keeps `→`. `dedent`
 * reads the raw text, so the prompts' `→`, `—` and the Chinese example
 * come out escaped here but not in production. The fixture records what
 * production sends: `unBun` turns those escapes back. A canary below
 * fails once Bun stops doing it, and the workaround can go.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';
import type { TRange, Value } from 'platejs';

import { MarkdownJoiner } from '@/shared/markdown-joiner-transform';
import {
  buildEditTableMultiCellPrompt,
  getChooseToolPrompt,
  getCommentPrompt,
  getCompletePrompt,
  getEditPrompt,
  getGeneratePrompt,
} from '@/shared/editor-ai/prompt';
import type { EditorAiMessage } from '@/shared/editor-ai/prompt-utils';

import { buildEditorAiDocument } from './editor-ai-document';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../services/agent-py/tests/fixtures/editor_ai_parity.json', import.meta.url)
);

const msg = (role: string, ...texts: string[]): EditorAiMessage => ({
  role,
  parts: texts.map((text) => ({ type: 'text', text })),
});
const user = (text: string) => msg('user', text);
const asst = (text: string) => msg('assistant', text);
const p = (id: string, ...children: object[]) => ({ type: 'p', id, children });
const t = (text: string, marks: object = {}) => ({ text, ...marks });
const cell = (id: string, text: string) => ({
  type: 'td',
  id,
  children: [p(`${id}p`, t(text))],
});
const at = (path: number[], offset: number) => ({ path, offset });

const DOC = [
  { type: 'h1', id: 'h', children: [t('Report')] },
  p('p1', t('AI systems are '), t('transforming', { bold: true }), t(' modern workplaces.')),
  p('p2', t('They automate routine tasks and free up time.')),
  {
    type: 'table',
    id: 'tb',
    children: [
      { type: 'tr', id: 'r1', children: [cell('c11', 'Name'), cell('c12', 'City')] },
      { type: 'tr', id: 'r2', children: [cell('c21', 'John'), cell('c22', 'New york')] },
    ],
  },
  p('p3', t('Closing words.')),
];

const LIST_DOC = [
  { type: 'h2', id: 'h2', children: [t('Steps')] },
  { type: 'p', id: 'l1', indent: 1, listStyleType: 'disc', children: [t('Install the app')] },
  { type: 'p', id: 'l2', indent: 1, listStyleType: 'disc', children: [t('Open '), t('settings', { italic: true })] },
  { type: 'blockquote', id: 'q', children: [t('Quoted <tag> & "text"')] },
  p('p9', t('See '), { type: 'a', url: 'https://example.com', children: [t('the docs')] }, t('.')),
];

interface DocCase {
  name: string;
  value: object[];
  selection: TRange | null;
  messages: EditorAiMessage[];
}

function docCases(): DocCase[] {
  return [
    { name: 'caret', value: DOC, selection: { anchor: at([1, 0], 3), focus: at([1, 0], 3) }, messages: [user('Write a paragraph about AI ethics')] },
    { name: 'no selection', value: DOC, selection: null, messages: [user('Write a poem')] },
    { name: 'inside one block', value: DOC, selection: { anchor: at([1, 1], 0), focus: at([1, 1], 12) }, messages: [user('Improve word choice.')] },
    {
      name: 'across two blocks, with history',
      value: DOC,
      selection: { anchor: at([1, 0], 0), focus: at([2, 0], 10) },
      messages: [user('Fix grammar.'), asst('Done.'), msg('assistant'), user('  Make it more concise.  ')],
    },
    { name: 'across table cells', value: DOC, selection: { anchor: at([3, 0, 0, 0, 0], 0), focus: at([3, 1, 1, 0, 0], 3) }, messages: [user('Translate to French')] },
    { name: 'inside one cell', value: DOC, selection: { anchor: at([3, 1, 1, 0, 0], 0), focus: at([3, 1, 1, 0, 0], 8) }, messages: [user('Fix grammar')] },
    { name: 'whole document', value: DOC, selection: { anchor: at([0, 0], 0), focus: at([4, 0], 14) }, messages: [user('Can you review this text and give me feedback?')] },
    { name: 'backwards selection', value: DOC, selection: { anchor: at([2, 0], 20), focus: at([2, 0], 5) }, messages: [user('Simplify')] },
    { name: 'list items', value: LIST_DOC, selection: { anchor: at([1, 0], 0), focus: at([2, 1], 4) }, messages: [msg('system', 'ignored'), msg('user', 'Translate', ' into German')] },
    { name: 'quote and link', value: LIST_DOC, selection: { anchor: at([3, 0], 7), focus: at([3, 0], 12) }, messages: [user('Explain the meaning')] },
    { name: 'no user message', value: LIST_DOC, selection: null, messages: [asst('hello')] },
  ];
}

/** Undo Bun's raw-template escaping (see the header). The prompt
 *  templates hold no literal `\\u`, and the case documents none. */
const unBun = (text: string): string =>
  text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

const unBunAll = <T extends Record<string, string | null>>(prompts: T): T =>
  Object.fromEntries(
    Object.entries(prompts).map(([key, value]) => [key, value === null ? null : unBun(value)])
  ) as T;

function renderCase(c: DocCase) {
  const document = buildEditorAiDocument(c.value as Value, c.selection);
  const { messages } = c;
  return {
    name: c.name,
    messages,
    document,
    expected: unBunAll({
      choose: getChooseToolPrompt({ isSelecting: document.isSelecting, messages }),
      generate: getGeneratePrompt({ context: document.generateContext, messages }),
      edit: document.edit ? getEditPrompt({ ...document.edit, messages }) : null,
      comment: getCommentPrompt({ context: document.commentContext, messages }),
      table:
        document.edit?.kind === 'table'
          ? buildEditTableMultiCellPrompt({ context: document.edit.context, messages })
          : null,
    }),
  };
}

const COMPLETE_CASES = [
  { blockText: 'The quick brown' },
  { blockText: 'fox', prefix: '# Title\n\nSome text.' },
  { blockText: 'x', prefix: 'p'.repeat(40_000) },
  { blockText: '  indented\nline', prefix: '' },
];

const JOINER_CASES: string[][] = [
  ['Hello **bo', 'ld** world'],
  ['- item one\n', '- item two\n'],
  ['1. first\n2', '. second\n'],
  ['- [ ] todo\n', '- [x] done\n'],
  ['```py\nprint(1)\n', '```\nafter'],
  ['| a | b |\n|---|---|\n| 1 | 2 |\n', 'plain text after the table'],
  ['See [the docs](https://exa', 'mple.com) now'],
  ['<u>under', 'lined</u> and *x', ' not closed'.repeat(4)],
  ['*'.concat('y'.repeat(40)), '\nnext'],
  ['*'.concat('z'.repeat(34)), ' tail'],
  ['word '.repeat(520), '**bold** tail'],
  ['trailing [unfinished'],
];

function renderJoiner(chunks: string[]) {
  const joiner = new MarkdownJoiner();
  const out = chunks.map((chunk) => ({ text: joiner.processText(chunk), delayInMs: joiner.delayInMs }));
  return { chunks, outputs: out, flush: joiner.flush() };
}

function buildFixture() {
  return {
    documents: docCases().map(renderCase),
    complete: COMPLETE_CASES.map((c) => ({ ...c, expected: unBun(getCompletePrompt(c)) })),
    joiner: JOINER_CASES.map(renderJoiner),
  };
}

describe('editor AI parity fixture', () => {
  test('matches the committed fixture (agent-py replays it)', () => {
    const fixture = buildFixture();
    if (process.env.EDITOR_AI_PARITY_WRITE === '1') {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))).toEqual(fixture);
  });

  test("canary: Bun still escapes raw template text (else drop `unBun`)", () => {
    expect(String.raw`→`).toBe('\\u2192');
  });

  test('every edit kind and both selecting states are covered', () => {
    const documents = docCases().map(renderCase).map((c) => c.document);
    const kinds = new Set(documents.map((d) => d.edit?.kind ?? 'none'));
    expect([...kinds].sort()).toEqual(['multi-block', 'none', 'selection', 'table']);
  });
});

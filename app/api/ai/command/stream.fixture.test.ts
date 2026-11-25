/**
 * The Next editor AI route's streams, recorded with a scripted model
 * (wave 9, Q104): agent-py's `/v1/ai/command` must emit the same parts for
 * the same model output — `services/agent-py/tests/test_editor_ai_route.py`
 * replays `services/agent-py/tests/fixtures/editor_ai_streams.json`.
 *
 * Each scenario drives `handleAiCommand` end to end (request body → Plate
 * document → prompt → model → AI SDK UI message stream) with a mock model
 * that answers from the scenario's script, and records:
 *
 * * `request` — the body Plate's AI menu sends Next;
 * * `script` — what the model says: the tool choice, the text deltas, the
 *   comment / cell elements;
 * * `prompts` — what the route asked the model, per call (agent-py asks
 *   the same);
 * * `parts` — the stream, ids normalised (`<id>`).
 *
 *   EDITOR_AI_STREAMS_WRITE=1 bun test app/api/ai/command/stream.fixture.test.ts
 *
 * Prompts here come from Bun, which escapes non-ASCII in raw template text
 * (see `components/editor/ai/editor-ai.parity.test.ts`); the scenarios'
 * prompts are ASCII apart from that, so `unBun` restores production's text.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test';
import { NextRequest } from 'next/server';

import { handleAiCommand } from './handler';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../../../services/agent-py/tests/fixtures/editor_ai_streams.json', import.meta.url)
);

type Script = {
  choice?: 'comment' | 'edit' | 'generate';
  text?: string[];
  elements?: { chunks: string[] };
};

interface Scenario {
  name: string;
  request: Record<string, unknown>;
  script: Script;
}

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const t = (text: string, marks: object = {}) => ({ text, ...marks });
const p = (id: string, ...children: object[]) => ({ type: 'p', id, children });
const cell = (id: string, text: string) => ({ type: 'td', id, children: [p(`${id}p`, t(text))] });
const at = (path: number[], offset: number) => ({ path, offset });
const user = (text: string) => ({ id: 'u1', role: 'user', parts: [{ type: 'text', text }] });

const DOC = [
  p('p1', t('AI systems are transforming modern workplaces.')),
  p('p2', t('They automate routine tasks.')),
  {
    type: 'table',
    id: 'tb',
    children: [
      { type: 'tr', id: 'r1', children: [cell('c11', 'Name'), cell('c12', 'City')] },
      { type: 'tr', id: 'r2', children: [cell('c21', 'John'), cell('c22', 'New york')] },
    ],
  },
];
const IN_BLOCK = { anchor: at([0, 0], 15), focus: at([0, 0], 27) };
const TWO_BLOCKS = { anchor: at([0, 0], 0), focus: at([1, 0], 10) };
const CELLS = { anchor: at([2, 0, 0, 0, 0], 0), focus: at([2, 1, 1, 0, 0], 3) };

const body = (toolName: string | undefined, selection: object | null, instruction: string) => ({
  ctx: { children: DOC, selection, ...(toolName ? { toolName } : {}) },
  messages: [user(instruction)],
});

function scenarios(): Scenario[] {
  return [
    {
      name: 'generate, nothing selected',
      request: body('generate', null, 'Write a short intro'),
      script: { text: ['Hello **wo', 'rld** and\n', '- item one\n', '- item two'] },
    },
    {
      name: 'edit, inside one block',
      request: body('edit', IN_BLOCK, 'Improve word choice.'),
      script: { text: ['reshap', 'ing'] },
    },
    {
      name: 'edit, across two blocks',
      request: body('edit', TWO_BLOCKS, 'Make it formal.'),
      script: { text: ['AI systems are reshaping workplaces.\n\n', 'They automate tasks.'] },
    },
    {
      name: 'free text, the model picks edit',
      request: body(undefined, IN_BLOCK, 'make this punchier'),
      script: { choice: 'edit', text: ['revolutionising'] },
    },
    {
      name: 'free text, the model picks generate',
      request: body(undefined, null, 'a haiku about spring'),
      script: { choice: 'generate', text: ['Blossoms ', 'drift'] },
    },
    {
      name: 'comment',
      request: body('comment', TWO_BLOCKS, 'Review this.'),
      script: {
        elements: {
          chunks: [
            '{"elements":[{"blockId":"p1","comment":"Name the sys',
            'tems.","content":"AI systems"},{"blockId":"p2",',
            '"comment":"Which tasks?","content":"routine tasks"}]}',
          ],
        },
      },
    },
    {
      name: 'edit, across table cells',
      request: body('edit', CELLS, 'Fix capitalisation'),
      script: {
        elements: {
          chunks: ['{"elements":[{"content":"New York","id":"c22"}', ',{"content":"NAME","id":"c11"}]}'],
        },
      },
    },
  ];
}

const unBun = (text: string): string =>
  text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

/** The user text of a model call's prompt (the route sends one user message). */
function promptText(prompt: unknown): string {
  const messages = prompt as { role: string; content: string | { type: string; text?: string }[] }[];
  return messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('')
    )
    .join('\n');
}

function scriptedModel(script: Script, prompts: { kind: string; prompt: string }[]) {
  const stream = (chunks: object[]) => ({
    stream: simulateReadableStream({
      chunks: [{ type: 'stream-start', warnings: [] }, ...chunks] as never[],
    }),
  });
  const text = (deltas: string[]) => [
    { type: 'text-start', id: 't' },
    ...deltas.map((delta) => ({ type: 'text-delta', id: 't', delta })),
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: 'stop', usage },
  ];
  return new MockLanguageModelV2({
    doGenerate: async (options) => {
      prompts.push({ kind: 'choose', prompt: unBun(promptText(options.prompt)) });
      return {
        content: [{ type: 'text', text: JSON.stringify({ result: script.choice }) }],
        finishReason: 'stop',
        usage,
        warnings: [],
      } as never;
    },
    doStream: async (options) => {
      const toolChoice = options.toolChoice as { type: string; toolName?: string } | undefined;
      if (toolChoice?.type === 'tool') {
        // The route's first call: forced onto the comment / table tool.
        return stream([
          { type: 'tool-call', toolCallId: 'call-1', toolName: toolChoice.toolName, input: '{}' },
          { type: 'finish', finishReason: 'tool-calls', usage },
        ]) as never;
      }
      if (options.responseFormat?.type === 'json') {
        prompts.push({ kind: 'elements', prompt: unBun(promptText(options.prompt)) });
        return stream(text(script.elements!.chunks)) as never;
      }
      prompts.push({ kind: 'text', prompt: unBun(promptText(options.prompt)) });
      return stream(text(script.text!)) as never;
    },
  });
}

function parseStream(raw: string): unknown[] {
  return raw
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const data = frame.replace(/^data: /, '');
      if (data === '[DONE]') return '[DONE]';
      const part = JSON.parse(data) as Record<string, unknown>;
      if ('messageId' in part) part.messageId = '<id>';
      if (typeof part.type === 'string' && part.type.startsWith('data-') && 'id' in part) part.id = '<id>';
      return part;
    });
}

async function record(scenario: Scenario) {
  const prompts: { kind: string; prompt: string }[] = [];
  const model = scriptedModel(scenario.script, prompts);
  const req = new NextRequest('http://localhost/api/ai/command', {
    method: 'POST',
    body: JSON.stringify(scenario.request),
  });
  const res = await handleAiCommand(req, { selectModel: () => model });
  return {
    ...scenario,
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type'),
      'x-vercel-ai-ui-message-stream': res.headers.get('x-vercel-ai-ui-message-stream'),
    },
    prompts,
    parts: parseStream(await res.text()),
  };
}

describe('the editor AI route streams (agent-py replays them)', () => {
  test('match the committed fixture', async () => {
    const recorded = [];
    for (const scenario of scenarios()) recorded.push(await record(scenario));
    if (process.env.EDITOR_AI_STREAMS_WRITE === '1') {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(recorded, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))).toEqual(recorded);
  }, 30_000);

  test('every path ends without an error part (ai@5: no Output.choice / Output.array)', async () => {
    for (const scenario of scenarios()) {
      const { parts } = await record(scenario);
      const types = parts.map((part) => (typeof part === 'string' ? part : (part as { type: string }).type));
      expect(types.filter((type) => /error/.test(type))).toEqual([]);
      expect(types.at(-1)).toBe('[DONE]');
    }
  }, 30_000);
});

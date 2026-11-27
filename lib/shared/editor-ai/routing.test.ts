import { describe, expect, test } from 'bun:test';

import { ANTHROPIC_SERVICE_MODELS, CHAT_MODELS } from '@/shared/models';

import { editorAiAgentModels, editorAiBackend, editorAiModelFor, editorAiModels } from './routing';

describe('editorAiBackend (Q103, Q105)', () => {
  const base = { agentPyConfigured: true, signedIn: true } as const;

  test('agent-py serves the editor where it serves chat', () => {
    expect(editorAiBackend({ ...base, chatBackend: 'python-runs' })).toBe('agent-py');
    expect(editorAiBackend({ ...base, chatBackend: 'python-runs', signedIn: false })).toBe('agent-py');
    expect(editorAiBackend({ ...base, chatBackend: 'python' })).toBe('agent-py');
    expect(editorAiBackend({ ...base, chatBackend: 'python', signedIn: false })).toBe('next');
  });

  test('the Next route for ts, for agent-ts (frozen), and without agent-py', () => {
    expect(editorAiBackend({ ...base, chatBackend: 'ts' })).toBe('next');
    expect(editorAiBackend({ ...base, chatBackend: 'ts-service' })).toBe('next');
    expect(editorAiBackend({ ...base, chatBackend: 'python-runs', agentPyConfigured: false })).toBe('next');
  });

  test('no own-key branch any more (Q124): a stray key never keeps the editor on Next', () => {
    for (const chatBackend of ['python', 'python-runs'] as const) {
      // An old caller still passing the removed flag: ignored.
      const withKey = { ...base, chatBackend, ownKey: true } as unknown as Parameters<typeof editorAiBackend>[0];
      expect(editorAiBackend(withKey)).toBe('agent-py');
    }
  });
});

describe('editorAiModelFor (Q102)', () => {
  const [accepted] = [...ANTHROPIC_SERVICE_MODELS.keys()];

  test('no model: agent-py picks its own default', () => {
    expect(editorAiModelFor(undefined)).toEqual({ model: null, switchedFrom: null });
    expect(editorAiModelFor('')).toEqual({ model: null, switchedFrom: null });
  });

  test('an accepted model goes as it is', () => {
    expect(editorAiModelFor(accepted)).toEqual({ model: accepted!, switchedFrom: null });
  });

  test('another model is switched to an accepted one, and says from what', () => {
    const out = editorAiModelFor('google/gemini-2.5-flash');
    expect(out.switchedFrom).toBe('google/gemini-2.5-flash');
    expect(ANTHROPIC_SERVICE_MODELS.has(out.model!)).toBe(true);
  });

  test('the settings list offers only what agent-py runs', () => {
    const ids = editorAiAgentModels().map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => ANTHROPIC_SERVICE_MODELS.has(id))).toBe(true);
  });
});

describe('editorAiModels (Q124)', () => {
  test("on agent-py: what agent-py runs; on Next: the deploy's catalog, not the gateway's whole list", () => {
    expect(editorAiModels('agent-py').map((m) => m.id)).toEqual(editorAiAgentModels().map((m) => m.id));
    expect(editorAiModels('next').map((m) => m.id)).toEqual(CHAT_MODELS.map((m) => m.id));
  });
});

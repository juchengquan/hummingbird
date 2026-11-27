import { describe, expect, test } from 'bun:test';

import { ANTHROPIC_SERVICE_MODELS, AUTO_MODEL_ID } from '@/shared/models';

import { editorAiModelFor, editorAiModels } from './routing';

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

  test('auto is switched: the editor routes never resolve it', () => {
    const out = editorAiModelFor(AUTO_MODEL_ID);
    expect(out.switchedFrom).toBe(AUTO_MODEL_ID);
    expect(ANTHROPIC_SERVICE_MODELS.has(out.model!)).toBe(true);
  });
});

describe('editorAiModels (Q124)', () => {
  test('the settings list offers only what agent-py runs', () => {
    const ids = editorAiModels().map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => ANTHROPIC_SERVICE_MODELS.has(id))).toBe(true);
  });
});

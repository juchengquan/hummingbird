import { describe, expect, test } from 'bun:test';

import { asPlateCompletion } from './plate-completion';

describe('asPlateCompletion', () => {
  test("a streamed text answer becomes the { text } JSON Plate's copilot reads", async () => {
    const res = await asPlateCompletion(new Response(' jumped.', { headers: { 'Content-Type': 'text/plain' } }));
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ text: ' jumped.' });
  });

  test('the raw text answer is what Plate could not read', async () => {
    await expect(new Response(' jumped.').json()).rejects.toThrow();
  });

  test('an error response passes through untouched', async () => {
    const refused = new Response(JSON.stringify({ code: 'rate_limit' }), { status: 429 });
    const res = await asPlateCompletion(refused);
    expect(res).toBe(refused);
  });
});

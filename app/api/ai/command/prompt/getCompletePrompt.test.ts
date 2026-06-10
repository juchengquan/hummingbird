import { describe, expect, test } from 'bun:test';

import { COMPLETE_PREFIX_MAX } from '@/shared/api-schemas';

import { getCompletePrompt } from './getCompletePrompt';

describe('getCompletePrompt', () => {
  test('interpolates the current block', () => {
    const prompt = getCompletePrompt({
      blockText: 'The quick brown fox jumps over the',
    });

    expect(prompt).toContain('<current_block>');
    expect(prompt).toContain('The quick brown fox jumps over the');
    expect(prompt).toContain('</current_block>');
  });

  test('omits the <preceding_document> block when no prefix is supplied', () => {
    const prompt = getCompletePrompt({ blockText: 'Hello' });

    expect(prompt).not.toContain('<preceding_document>');
  });

  test('includes the prefix in <preceding_document> when supplied', () => {
    const prompt = getCompletePrompt({
      blockText: 'And then',
      prefix: 'Earlier in the document, the author wrote about ravens.',
    });

    expect(prompt).toContain('<preceding_document>');
    expect(prompt).toContain('the author wrote about ravens');
    expect(prompt).toContain('</preceding_document>');
  });

  test('instructs the model to output only the continuation', () => {
    const prompt = getCompletePrompt({ blockText: 'x' });

    expect(prompt).toMatch(/Output ONLY the continuation/);
    expect(prompt).toMatch(/no preamble/);
  });

  test('instructs the model to stay in the same block (no new headings / lists / code fences)', () => {
    const prompt = getCompletePrompt({ blockText: 'x' });

    expect(prompt).toMatch(/same block/);
    expect(prompt).toMatch(/heading, list item, blockquote, or code block/);
  });

  test('instructs the model to stop at the next punctuation mark', () => {
    const prompt = getCompletePrompt({ blockText: 'x' });

    expect(prompt).toMatch(/next punctuation mark/);
  });

  test('instructs the model to return "0" when no continuation is sensible', () => {
    const prompt = getCompletePrompt({ blockText: 'x' });

    expect(prompt).toMatch(/return "0"/);
  });

  test('truncates an over-long prefix to its trailing slice', () => {
    // Build a prefix that's clearly past the cap. Each line is unique
    // so we can assert the *trailing* slice survived (and the head
    // didn't).
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(`line-${i}: lorem ipsum dolor sit amet`);
    }
    const longPrefix = lines.join('\n');
    expect(longPrefix.length).toBeGreaterThan(COMPLETE_PREFIX_MAX);

    const prompt = getCompletePrompt({
      blockText: 'The end is near',
      prefix: longPrefix,
    });

    // Trailing lines (closest to the cursor) must survive — that's the
    // pinned truncation policy (drop the head, keep the tail).
    expect(prompt).toContain('line-4999');
    // The head must be gone.
    expect(prompt).not.toContain('line-0:');
  });

  test('shorter prefixes pass through unchanged', () => {
    const prompt = getCompletePrompt({
      blockText: 'b',
      prefix: 'short prefix',
    });

    expect(prompt).toContain('short prefix');
  });
});

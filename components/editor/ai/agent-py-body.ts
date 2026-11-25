/**
 * The `/v1/ai/command` body agent-py takes (contract `EditorAiCommandRequest`,
 * Q101): Plate's AI menu body (`ctx` with the whole Plate value, AI SDK UI
 * messages) with the document rendered to text in the browser. Messages
 * keep their role and text parts only — the only parts the prompts read —
 * so an assistant turn's data parts (comments, cell edits) don't travel.
 */

import type { TRange, Value } from 'platejs';

import type { components } from '@/shared/contract/openapi.generated';

import { buildEditorAiDocument } from './editor-ai-document';

export type EditorAiCommandRequest = components['schemas']['EditorAiCommandRequest'];

/** What Plate's `aiChat.submit` + `DefaultChatTransport` POST (the parts we read). */
export interface PlateCommandBody {
  ctx: {
    children: unknown[];
    selection?: TRange | null;
    toolName?: 'comment' | 'edit' | 'generate' | null;
  };
  messages: { role: string; parts: { type: string; text?: string }[] }[];
  model?: string | null;
}

export function toAgentPyCommandBody(
  body: PlateCommandBody,
  model: string | null
): EditorAiCommandRequest {
  return {
    document: buildEditorAiDocument(body.ctx.children as Value, body.ctx.selection ?? null),
    messages: body.messages.map((message) => ({
      parts: message.parts
        .filter((part) => part.type === 'text')
        .map((part) => ({ text: part.text ?? '', type: 'text' })),
      role: message.role as 'assistant' | 'system' | 'user',
    })),
    model,
    toolName: body.ctx.toolName ?? null,
  };
}

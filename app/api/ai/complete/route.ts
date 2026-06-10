import type { NextRequest } from 'next/server';

import { streamText } from 'ai';
import { NextResponse } from 'next/server';

import { categorizeError } from '@/shared/api-errors';
import { CompleteRequestSchema } from '@/shared/api-schemas';
import {
  ProviderUnavailableError,
  selectModel,
} from '@/server/model-provider';
import { createSlidingWindow, rateLimitKey } from '@/server/rate-limit';

import { getCompletePrompt } from '../command/prompt';

/**
 * Inline editor ghost-text autocomplete.
 *
 * POST `{ prefix?: string, blockText: string, model?: string }` → a
 * streamed plain-text continuation of `blockText`. Plate's Copilot
 * plugin (`components/editor/plugins/copilot-kit.tsx`) renders the
 * stream as grey ghost text the user accepts with Tab.
 *
 * Why a separate route from `/api/ai/command`:
 * - That route negotiates a discriminated tool call (generate / edit /
 *   comment) and streams a `UIMessageStream` for the editor's
 *   per-block UI. This route is one short continuation, streamed as
 *   plain text — much lower overhead.
 * - Cost: tight `maxOutputTokens` (~60) + a per-IP sliding-window
 *   gate keep a misbehaving client from racking up calls during a
 *   long typing session. Latency: `streamText` emits the first token
 *   while the model is still producing the rest.
 *
 * See `docs/PLAN-inline-autocomplete.md`.
 */

/** Per-IP gate. Generous (60/min) — a typist who pauses every 2s for
 *  a minute hits ~30 suggestions. Anything past 60 is hammering. */
const completeRateLimit = createSlidingWindow({ windowMs: 60_000, max: 60 });

export async function POST(req: NextRequest) {
  const limit = completeRateLimit.consume(rateLimitKey(req));
  if (!limit.allowed) {
    return NextResponse.json(
      {
        code: 'rate_limit',
        message: `Too many completion requests. Retry in ${limit.retryAfterSec}s.`,
      },
      {
        status: 429,
        headers: { 'Retry-After': String(limit.retryAfterSec) },
      }
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'invalid_request', message: 'Body must be JSON.' },
      { status: 400 }
    );
  }
  const parsed = CompleteRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        code: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'Invalid request body.',
      },
      { status: 400 }
    );
  }
  const { blockText, model, prefix } = parsed.data;

  try {
    const result = streamText({
      abortSignal: req.signal,
      maxOutputTokens: 60,
      model: selectModel(model || 'google/gemini-2.5-flash'),
      prompt: getCompletePrompt({ blockText, prefix }),
      temperature: 0.2,
    });

    return result.toTextStreamResponse();
  } catch (error) {
    if (error instanceof ProviderUnavailableError) {
      return NextResponse.json(
        { code: 'auth', message: error.message },
        { status: 401 }
      );
    }
    const { status, code, message } = categorizeError(error);
    return NextResponse.json({ code, message }, { status });
  }
}

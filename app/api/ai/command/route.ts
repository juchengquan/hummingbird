import type { NextRequest } from 'next/server';

import { handleAiCommand } from './handler';

/** Plate's AI menu: generate / edit / comment over the editor document.
 *  The logic lives in `handler.ts` (injectable model, for its tests). */
export async function POST(req: NextRequest) {
  return handleAiCommand(req);
}

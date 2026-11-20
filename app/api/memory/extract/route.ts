import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireAiAuth } from '@/server/auth/require-ai-auth'
import { extractFacts } from '@/server/memory/extract'
import {
  MemoryExtractRequestSchema,
  type MemoryExtractResponse,
} from '@/shared/api-schemas'

/** Test seam: the extractor the route delegates to. */
export const memoryExtractDeps = { extractFacts }

export async function POST(req: NextRequest) {
  // REQUIRE_AUTH_FOR_AI gate. extractFacts already no-ops for anonymous
  // callers; with the flag on they get an explicit 401 instead.
  const aiAuth = await requireAiAuth()
  if (!aiAuth.ok) return aiAuth.response
  const parsed = MemoryExtractRequestSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  // A tainted turn (it read attachments / web / MCP / file content) is
  // refused: extracting from it could turn injected text into a durable
  // memory. Same `{ ok: true }` answer — extraction is best-effort.
  if (parsed.data.tainted) {
    return NextResponse.json({ ok: true } satisfies MemoryExtractResponse)
  }
  // extractFacts self-gates (sign-in + memory_enabled) and never throws.
  await memoryExtractDeps.extractFacts({
    turnText: parsed.data.turnText,
    conversationId: parsed.data.conversationId,
  })
  return NextResponse.json({ ok: true } satisfies MemoryExtractResponse)
}

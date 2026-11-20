import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireAiAuth } from '@/server/auth/require-ai-auth'
import { extractFacts } from '@/server/memory/extract'
import {
  MemoryExtractRequestSchema,
  type MemoryExtractResponse,
} from '@/shared/api-schemas'

export async function POST(req: NextRequest) {
  // REQUIRE_AUTH_FOR_AI gate. extractFacts already no-ops for anonymous
  // callers; with the flag on they get an explicit 401 instead.
  const aiAuth = await requireAiAuth()
  if (!aiAuth.ok) return aiAuth.response
  const parsed = MemoryExtractRequestSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  // extractFacts self-gates (sign-in + memory_enabled) and never throws.
  await extractFacts(parsed.data)
  return NextResponse.json({ ok: true } satisfies MemoryExtractResponse)
}

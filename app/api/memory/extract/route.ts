import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { extractFacts } from '@/server/memory/extract'
import {
  MemoryExtractRequestSchema,
  type MemoryExtractResponse,
} from '@/shared/api-schemas'

export async function POST(req: NextRequest) {
  const parsed = MemoryExtractRequestSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  // extractFacts self-gates (sign-in + memory_enabled) and never throws.
  await extractFacts(parsed.data)
  return NextResponse.json({ ok: true } satisfies MemoryExtractResponse)
}

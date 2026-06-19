import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { extractFacts } from '@/server/memory/extract'

const BodySchema = z.object({
  turnText: z.string().min(1).max(50_000),
  conversationId: z.string().max(64).optional(),
})

export async function POST(req: NextRequest) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  // extractFacts self-gates (sign-in + memory_enabled) and never throws.
  await extractFacts(parsed.data)
  return NextResponse.json({ ok: true })
}

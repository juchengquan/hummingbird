import type { NextRequest } from 'next/server'

import { generateText } from 'ai'
import { NextResponse } from 'next/server'

import { categorizeError } from '@/shared/api-errors'
import { requireAiAuth } from '@/server/auth/require-ai-auth'
import {
  ExtractionSchema,
  buildExtractTablePrompt,
  extractionToCitationTable,
  type Extraction,
} from '@/shared/artifacts/extract-table'
import { ExtractTableRequestSchema } from '@/shared/api-schemas'
import { modelSupportsStructuredOutput } from '@/shared/models'
import { generateStructured } from '@/server/ai/structured'
import {
  ProviderUnavailableError,
  rejectUnknownModel,
  selectModel,
} from '@/server/model-provider'
import { jsonBodyError, readJsonCapped } from '@/server/read-body-capped'

export const runtime = 'nodejs'

const DEFAULT_EXTRACT_TABLE_MODEL = 'google/gemini-2.5-flash'

function stripJsonFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim()
}

/** Body cap: `reportText` ≤ 100k chars + ≤ 100 sources (~4.3k chars
 *  each) at ≤ 3 UTF-8 bytes per char, plus headroom. */
const EXTRACT_TABLE_BODY_MAX = 2 * 1024 * 1024

export async function POST(req: NextRequest) {
  // REQUIRE_AUTH_FOR_AI gate — before the body is read or any model
  // work starts. No-op when the flag is off / Supabase is unset.
  const aiAuth = await requireAiAuth()
  if (!aiAuth.ok) return aiAuth.response
  const read = await readJsonCapped(req, EXTRACT_TABLE_BODY_MAX)
  if (!read.ok) return jsonBodyError(read)
  const raw = read.value
  const parsed = ExtractTableRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        code: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'Invalid request body.',
      },
      { status: 400 },
    )
  }

  const { reportText, sources, model, columnHints } = parsed.data
  const modelId = model ?? DEFAULT_EXTRACT_TABLE_MODEL
  const unknownModel = rejectUnknownModel(modelId)
  if (unknownModel) return unknownModel
  const numbered = sources.map((s, i) => ({ id: `s${i + 1}`, ...s }))
  // The wire schema accepts both string[] (legacy) and { label, type? }[].
  // buildExtractTablePrompt handles both shapes; passing it through.
  const prompt = buildExtractTablePrompt(reportText, numbered, columnHints)

  try {
    let extraction: Extraction | null = null

    if (modelSupportsStructuredOutput(modelId)) {
      try {
        extraction = await generateStructured({
          modelId,
          schema: ExtractionSchema,
          prompt,
          abortSignal: req.signal,
          maxOutputTokens: 4000,
          temperature: 0.2,
        })
      } catch (error) {
        if (error instanceof ProviderUnavailableError) throw error
        // fall through to the lenient text path
      }
    }

    if (!extraction) {
      const result = await generateText({
        abortSignal: req.signal,
        model: selectModel(modelId),
        prompt: `${prompt}\n\nReturn ONLY JSON matching the schema.`,
        maxOutputTokens: 4000,
        temperature: 0.2,
      })
      const cleaned = stripJsonFences(result.text)
      let json: unknown
      try {
        json = JSON.parse(cleaned)
      } catch {
        return NextResponse.json(
          {
            code: 'provider',
            message: 'Extraction model did not return valid JSON.',
          },
          { status: 502 },
        )
      }
      const reparsed = ExtractionSchema.safeParse(json)
      if (!reparsed.success) {
        return NextResponse.json(
          {
            code: 'provider',
            message: 'Extraction model output did not match the schema.',
          },
          { status: 502 },
        )
      }
      extraction = reparsed.data
    }

    const table = extractionToCitationTable(extraction, numbered)
    return NextResponse.json(table)
  } catch (error) {
    if (error instanceof ProviderUnavailableError) {
      return NextResponse.json(
        { code: 'auth', message: error.message },
        { status: 401 },
      )
    }
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }
}

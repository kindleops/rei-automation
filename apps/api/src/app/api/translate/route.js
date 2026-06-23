import { NextResponse } from 'next/server.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const body = await request.json().catch(() => ({}))

  return NextResponse.json({
    ok: false,
    route: 'translate',
    action: 'translate',
    error: 'TRANSLATION_NOT_WIRED',
    message: 'Translation is not wired to a launch-safe backend service yet.',
    received: {
      source_language: body?.source_language ?? body?.sourceLanguage ?? body?.from ?? null,
      target_language: body?.target_language ?? body?.targetLanguage ?? body?.to ?? null,
      has_text: Boolean(body?.text || body?.message || body?.body),
    },
  }, { status: 501 })
}

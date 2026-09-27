import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, handleOptionsResponse } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function OPTIONS(request) {
  return handleOptionsResponse(request)
}

const LANG = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/

/**
 * Translate a draft into the seller's language (or a seller's message into
 * the operator's). Behind the operator session like every cockpit route; the
 * public /api/translate stub stays 501. Provider: the same Google translate
 * endpoint the dashboard's dev server has always used. Returns text only.
 */
export async function POST(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const body = await request.json().catch(() => ({}))
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 2000) : ''
  const target = String(body?.targetLanguage ?? body?.target_language ?? 'en').trim().toLowerCase()
  const source = String(body?.sourceLanguage ?? body?.source_language ?? 'auto').trim().toLowerCase()
  if (!text) return NextResponse.json({ ok: false, error: 'missing_text' }, { status: 400, headers: cors })
  if (!LANG.test(target) || (source !== 'auto' && !LANG.test(source))) {
    return NextResponse.json({ ok: false, error: 'invalid_language' }, { status: 400, headers: cors })
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const upstream = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`,
      { signal: controller.signal },
    )
    clearTimeout(timer)
    if (!upstream.ok) {
      return NextResponse.json({ ok: false, error: `provider_${upstream.status}` }, { status: 502, headers: cors })
    }
    const data = await upstream.json()
    const translatedText = Array.isArray(data?.[0]) ? data[0].map((part) => (Array.isArray(part) ? part[0] ?? '' : '')).join('') : ''
    const detectedLanguage = typeof data?.[2] === 'string' ? data[2] : null
    if (!translatedText.trim()) {
      return NextResponse.json({ ok: false, error: 'empty_translation' }, { status: 502, headers: cors })
    }
    return NextResponse.json({ ok: true, translatedText, detectedLanguage, targetLanguage: target }, { headers: cors })
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.name === 'AbortError' ? 'provider_timeout' : 'provider_unreachable' }, { status: 502, headers: cors })
  }
}

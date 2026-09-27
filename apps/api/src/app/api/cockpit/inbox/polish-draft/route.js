import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, handleOptionsResponse } from '../../_shared.js'
import { polishDraft } from '@/lib/domain/inbox/draft-polish.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function OPTIONS(request) {
  return handleOptionsResponse(request)
}

/**
 * Clean up an operator's draft (dictated or typed). Returns text only — it
 * never sends, queues or stores anything.
 */
export async function POST(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const body = await request.json().catch(() => ({}))
  const text = typeof body?.text === 'string' ? body.text.slice(0, 1600) : ''
  if (!text.trim()) {
    return NextResponse.json({ ok: false, error: 'missing_text' }, { status: 400, headers: cors })
  }
  const result = await polishDraft(text, { allowModel: body?.model !== false })
  return NextResponse.json({ ok: true, polishedText: result.polishedText, source: result.source }, { headers: cors })
}

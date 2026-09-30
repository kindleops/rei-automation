import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, unauthorizedJson } from '../../../_shared.js'
import { getClosingDocuments } from '@/lib/domain/closings/closing-execution-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

/**
 * GET /api/cockpit/closing-desk/execution/:id/documents
 * Stored files for one closing (email attachments routed to the case or on its
 * title/buyer threads), with short-lived signed preview links. Loaded lazily by
 * the room's Documents section. Read-only.
 */
export async function GET(request, { params }) {
  const headers = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return unauthorizedJson(auth.response, headers)
  try {
    const { id } = await params
    const data = await getClosingDocuments(decodeURIComponent(String(id || '')))
    if (!data) return NextResponse.json({ ok: false, error: 'closing_not_found' }, { status: 404, headers })
    return NextResponse.json({ ok: true, data }, { status: 200, headers })
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || 'closing_documents_failed' }, { status: 500, headers })
  }
}

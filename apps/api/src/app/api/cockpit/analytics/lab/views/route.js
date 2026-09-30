/**
 * ANALYTICS LAB — saved views (operator UI state). GET lists; POST saves a
 * validated context. Both report `store: 'unavailable'` until the proposed
 * analytics_saved_views table is approved and applied.
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../../_shared.js'
import { listSavedViews, saveView } from '@/lib/domain/analytics/lab/saved-views.js'
import { ContractError } from '@/lib/domain/analytics/lab/query-contract.js'
import { handle, options } from '../_lab-route.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const OPTIONS = options

export async function GET(request) {
  return handle(request, async () => listSavedViews(), { needsContext: false })
}

export async function POST(request) {
  const headers = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  try {
    const body = await request.json().catch(() => ({}))
    const data = await saveView({ label: body?.label, description: body?.description, context: body?.context, isPinned: body?.isPinned, createdBy: auth.auth?.user?.email || null })
    return NextResponse.json({ ok: data.store === 'server', data }, { status: data.store === 'server' ? 201 : 503, headers })
  } catch (error) {
    if (error instanceof ContractError) return NextResponse.json({ ok: false, errorType: 'contract_error', error: error.message }, { status: 400, headers })
    console.error('analytics.lab_view_save_failed', error)
    return NextResponse.json({ ok: false, errorType: 'save_failed', error: error?.message || 'save_failed' }, { status: 500, headers })
  }
}

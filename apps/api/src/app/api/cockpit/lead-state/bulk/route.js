/**
 * BULK LEAD-STATE — stage / status / follow-up date / snooze / read for many
 * conversations, one canonical write per item. See
 * lib/domain/lead-state/bulk-lead-state-service.js.
 *
 *   POST { action, ids: [+1…], value?, reason? } → { ok, action, summary, partial, results: [{ id, ok, outcome, reason?, message? }] }
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import {
  BulkLeadStateError,
  createBulkLeadStateService,
  createDefaultBulkLeadStatePorts,
  parseBulkLeadStateRequest,
} from '@/lib/domain/lead-state/bulk-lead-state-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

let service = null
const getService = async () => {
  if (!service) service = createBulkLeadStateService(await createDefaultBulkLeadStatePorts())
  return service
}

const operatorIdOf = (headers) => {
  const v = headers?.get?.('x-ops-user-id')
  const id = typeof v === 'string' ? v.trim() : ''
  return id && id.length <= 128 ? id : null
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' }
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const operatorId = operatorIdOf(request.headers)
  if (!operatorId) return NextResponse.json({ ok: false, error: 'operator_unknown', message: 'The signed-in operator could not be identified.' }, { status: 401, headers })
  try {
    const parsed = parseBulkLeadStateRequest(await request.json().catch(() => null))
    const result = await (await getService()).run(parsed, operatorId)
    return NextResponse.json({ ok: true, ...result }, { status: 200, headers })
  } catch (error) {
    if (error instanceof BulkLeadStateError) return NextResponse.json({ ok: false, error: error.code, message: error.message }, { status: error.status, headers })
    console.error('bulk_lead_state.failed', error?.message || error)
    return NextResponse.json({ ok: false, error: 'bulk_lead_state_failed', message: 'The bulk action could not run right now.', retryable: true }, { status: 500, headers })
  }
}

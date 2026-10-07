import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { runTestCampaignCheckpoint } from '@/lib/domain/campaigns/ranking-v2/screener-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * TEST CAMPAIGN CHECKPOINT — test arm vs control arm per funnel stage with
 * Newcombe CIs, pre-registered verdicts and contamination checks.
 * READ-ONLY, behind SELLER_SCREENER (default OFF).
 *   GET ?cohort_key=…&checkpoint=24h|72h|7d|14d|21d
 * Reads the frozen cohort from campaign_test_cohorts / _members (PROPOSED
 * migration (a)); until that is applied it answers 503 cohort_store_not_applied
 * and the script scripts/acq-os/test-campaign-checkpoint.mjs is the path.
 */
function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const p = new URL(request.url).searchParams
  const cohortKey = String(p.get('cohort_key') || '').trim()
  if (!cohortKey) return withCors(request, { ok: false, error: 'cohort_key_required' }, 400)
  try {
    const { queryWithTimeout } = await import('@/lib/postgres/client.js')
    const db = { query: (sql, params) => queryWithTimeout(sql, params, 30_000) }
    let head
    try {
      head = await db.query('select cohort_key, preregistration, launched_at from public.campaign_test_cohorts where cohort_key = $1', [cohortKey])
    } catch (error) {
      if (String(error?.code) === '42P01') return withCors(request, { ok: false, error: 'cohort_store_not_applied', message: 'Migration (a) PROPOSED_20261007090000 is not applied; use scripts/acq-os/test-campaign-checkpoint.mjs.' }, 503)
      throw error
    }
    const row = head.rows[0]
    if (!row) return withCors(request, { ok: false, error: 'cohort_not_found' }, 404)
    if (!row.launched_at) return withCors(request, { ok: false, error: 'cohort_not_launched' }, 409)
    const { rows } = await db.query('select property_id, arm from public.campaign_test_cohort_members where cohort_key = $1', [cohortKey])
    const arms = { test: rows.filter((r) => r.arm === 'test').map((r) => r.property_id), control: rows.filter((r) => r.arm === 'control').map((r) => r.property_id) }
    const result = await runTestCampaignCheckpoint({ arms, preregistration: row.preregistration }, { checkpoint: p.get('checkpoint') || '24h', launched_at: row.launched_at }, { db })
    return withCors(request, result, result.ok === false ? Number(result.status || 500) : 200)
  } catch (error) {
    console.error('campaigns.test_checkpoint_failed', error)
    return withCors(request, { ok: false, error: 'test_checkpoint_failed', message: error?.message || String(error) }, 500)
  }
}

/**
 * ONE LAUNCH PER CAMPAIGN — decided by the database, not by a server process.
 *
 * claim  public.campaign_launch_claim (supabase/migrations/20261002190000, applied 2026-10-03): the campaign
 *        row lock + status in (draft, built) + the durable ledger claim, in one
 *        transaction. Until that migration is applied, the fallback uses the
 *        ledger function already in production — public.idempotency_begin
 *        ('campaign_launch', <campaign_id>) — whose INSERT … ON CONFLICT (scope,
 *        key) is atomic across processes. In the fallback the status read is a
 *        separate statement (the lifecycle's own edge check is the guard there).
 * finish public.campaign_launch_finish (fenced on the claim token); fallback
 *        idempotency_complete / idempotency_fail (unfenced — documented gap).
 *
 * Every claim outcome is explicit. A database that can't be reached is a
 * refusal (fail closed), never "proceed without protection".
 */
import crypto from 'node:crypto'

export const LAUNCH_SCOPE = 'campaign_launch'
export const LAUNCH_LEASE_MS = 30 * 60_000
const clean = (v) => String(v ?? '').trim()
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

const missingFunction = (error) => {
  const m = clean(error?.message).toLowerCase()
  return error?.code === 'PGRST202' || error?.code === '42883' || m.includes('could not find the function') || (m.includes('function') && m.includes('does not exist'))
}

/**
 * TRANSPORT FAILURES ARE RETRIED ONCE (2026-10-12). From ~20:30 to 20:56Z the
 * container's outbound fetches to Supabase intermittently failed ("TypeError:
 * fetch failed", no 5xx on the database side) and a Composer launch was refused
 * launch_claim_unavailable. A transport failure — the message says so and the
 * error carries no PG/PostgREST code — is retried once after a short delay with
 * the SAME claim token: campaign_launch_claim and idempotency_begin are
 * ON CONFLICT (scope, key), so the retry is idempotent. A real refusal
 * (d.ok === false, a duplicate, anything carrying a PG code) is never retried,
 * and a second transport failure still fails closed.
 */
export const LAUNCH_CLAIM_RETRY_DELAY_MS = 750
const TRANSPORT_FAILURE = /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network/i
export function isTransportFailure(error) {
  if (!error) return false
  if (clean(error.code)) return false
  return TRANSPORT_FAILURE.test(clean(error.message ?? error))
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Run one supabase call ({ data, error }); a thrown error is the same as a returned one. Retried once on transport failure. */
async function callWithTransportRetry(call, delayMs) {
  const once = async () => {
    try { return await call() } catch (error) { return { data: null, error } }
  }
  const first = await once()
  if (!isTransportFailure(first?.error)) return first
  await sleep(delayMs)
  return once()
}

/**
 * @returns {Promise<{ claimed: boolean, reason: string, token?: string, launch_key?: string|null, result?: object|null, status?: string|null, mode: 'function'|'ledger', error?: string }>}
 */
export async function claimCampaignLaunch(supabase, { campaignId, launchKey, leaseMs = LAUNCH_LEASE_MS, token = crypto.randomUUID(), retryDelayMs = LAUNCH_CLAIM_RETRY_DELAY_MS }) {
  const { data, error } = await callWithTransportRetry(() => supabase.rpc('campaign_launch_claim', {
    p_campaign_id: campaignId,
    p_launch_key: launchKey,
    p_claim_token: token,
    p_lease_ms: leaseMs,
  }), retryDelayMs)
  if (!error) {
    const d = obj(data)
    if (d.ok === false) return { claimed: false, reason: clean(d.reason) || 'claim_refused', mode: 'function' }
    return { claimed: d.claimed === true, reason: clean(d.reason), token, launch_key: d.launch_key ?? null, result: d.result ?? null, status: d.status ?? null, mode: 'function' }
  }
  if (!missingFunction(error)) return { claimed: false, reason: 'launch_claim_unavailable', error: clean(error.message ?? error), mode: 'function' }

  // Fallback: the production ledger (atomic ON CONFLICT claim).
  const { data: campaign, error: readError } = await callWithTransportRetry(() => supabase.from('campaigns').select('status').eq('id', campaignId).maybeSingle(), retryDelayMs)
  if (readError) return { claimed: false, reason: 'launch_claim_unavailable', error: clean(readError.message ?? readError), mode: 'ledger' }
  if (!campaign) return { claimed: false, reason: 'campaign_not_found', mode: 'ledger' }
  const { data: begun, error: beginError } = await callWithTransportRetry(() => supabase.rpc('idempotency_begin', {
    p_scope: LAUNCH_SCOPE,
    p_key: campaignId,
    p_claim_token: token,
    p_summary: 'composer launch',
    p_metadata: { launch_key: launchKey },
    p_lease_ms: leaseMs,
    p_payload_hash: null,
  }), retryDelayMs)
  if (beginError) return { claimed: false, reason: 'launch_claim_unavailable', error: clean(beginError.message ?? beginError), mode: 'ledger' }
  const b = obj(begun)
  const meta = obj(b.meta)
  const status = clean(campaign.status).toLowerCase()
  if (b.duplicate === true) {
    if (b.reason === 'duplicate_event_ignored') return { claimed: false, reason: 'already_launched', launch_key: meta.launch_key ?? null, result: meta.result ?? null, status, mode: 'ledger' }
    return { claimed: false, reason: 'launch_in_progress', launch_key: meta.launch_key ?? null, status, mode: 'ledger' }
  }
  if (b.ok === false) return { claimed: false, reason: clean(b.reason) || 'claim_refused', mode: 'ledger' }
  if (!['draft', 'built'].includes(status)) {
    // Claimed the ledger row but the campaign has already moved on: release it.
    await supabase.rpc('idempotency_fail', { p_scope: LAUNCH_SCOPE, p_key: campaignId, p_error: `campaign_not_launchable:${status}`, p_metadata: {}, p_skip_content_fields: false })
    return { claimed: false, reason: 'campaign_not_launchable', status, mode: 'ledger' }
  }
  return { claimed: true, reason: clean(b.reason) || 'event_claimed', token, status, mode: 'ledger' }
}

export async function finishCampaignLaunch(supabase, { campaignId, token, mode, outcome, result = {}, error = null }) {
  if (mode === 'function') {
    const { data, error: rpcError } = await supabase.rpc('campaign_launch_finish', {
      p_campaign_id: campaignId,
      p_claim_token: token,
      p_outcome: outcome,
      p_result: result,
      p_error: error,
    })
    if (rpcError) return { ok: false, error: clean(rpcError.message) }
    return { ok: obj(data).ok === true, fenced: obj(data).fenced === true }
  }
  const fn = outcome === 'completed' ? 'idempotency_complete' : 'idempotency_fail'
  const args = outcome === 'completed'
    ? { p_scope: LAUNCH_SCOPE, p_key: campaignId, p_summary: 'composer launch', p_metadata: { result }, p_skip_content_fields: false }
    : { p_scope: LAUNCH_SCOPE, p_key: campaignId, p_error: clean(error) || 'launch_refused', p_metadata: { result }, p_skip_content_fields: false }
  const { error: rpcError } = await supabase.rpc(fn, args)
  return rpcError ? { ok: false, error: clean(rpcError.message) } : { ok: true, fenced: false }
}

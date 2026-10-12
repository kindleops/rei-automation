/**
 * 2026-10-12 20:30–20:56Z: outbound fetches to Supabase intermittently failed
 * ("TypeError: fetch failed") and a Composer launch was refused
 * launch_claim_unavailable. A transport failure is retried ONCE with the SAME
 * claim token; a real refusal or a PG-coded error never is; two transport
 * failures still fail closed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { claimCampaignLaunch, isTransportFailure } from '../../src/lib/domain/campaigns/campaign-launch-claim.js'

const FETCH_FAILED = { message: 'TypeError: fetch failed', details: '', hint: '', code: '' }
const CLAIMED = { data: { ok: true, claimed: true, reason: 'claimed', launch_key: 'k', status: 'built' }, error: null }

/** rpc/from answer from per-name scripts; every call is recorded with its args. */
function fakeSupabase(scripts) {
  const calls = []
  const next = (name, args) => {
    calls.push({ name, args })
    const script = scripts[name] || []
    const step = script.length ? script.shift() : { data: null, error: { message: `unscripted ${name}`, code: 'XX000' } }
    if (step instanceof Error) return Promise.reject(step)
    return Promise.resolve(step)
  }
  return {
    calls,
    rpc: (name, args) => next(name, args),
    from: (table) => ({ select: () => ({ eq: () => ({ maybeSingle: () => next(`from:${table}`, null) }) }) }),
  }
}
const claim = (sb) => claimCampaignLaunch(sb, { campaignId: 'c1', launchKey: 'k', token: 'tok-1', retryDelayMs: 1 })

test('transport detection: message match and no PG/PostgREST code', () => {
  assert.equal(isTransportFailure(FETCH_FAILED), true)
  assert.equal(isTransportFailure(new TypeError('fetch failed')), true)
  assert.equal(isTransportFailure({ message: 'read ECONNRESET' }), true)
  assert.equal(isTransportFailure({ message: 'connect ETIMEDOUT 1.2.3.4:443' }), true)
  assert.equal(isTransportFailure({ message: 'socket hang up' }), true)
  assert.equal(isTransportFailure({ message: 'fetch failed', code: '57014' }), false)
  assert.equal(isTransportFailure({ message: 'duplicate key value', code: '23505' }), false)
  assert.equal(isTransportFailure(null), false)
})

test('a transport error then success → claimed, retried once with the SAME token', async () => {
  const sb = fakeSupabase({ campaign_launch_claim: [{ data: null, error: FETCH_FAILED }, CLAIMED] })
  const r = await claim(sb)
  assert.equal(r.claimed, true)
  assert.equal(r.token, 'tok-1')
  assert.equal(sb.calls.length, 2)
  assert.deepEqual(sb.calls.map((c) => c.args.p_claim_token), ['tok-1', 'tok-1'])
})

test('a thrown fetch failure then success → claimed', async () => {
  const sb = fakeSupabase({ campaign_launch_claim: [new TypeError('fetch failed'), CLAIMED] })
  assert.equal((await claim(sb)).claimed, true)
})

test('two transport errors → launch_claim_unavailable (fail closed), no third try', async () => {
  const sb = fakeSupabase({ campaign_launch_claim: [{ data: null, error: FETCH_FAILED }, { data: null, error: FETCH_FAILED }, CLAIMED] })
  const r = await claim(sb)
  assert.equal(r.claimed, false)
  assert.equal(r.reason, 'launch_claim_unavailable')
  assert.equal(sb.calls.length, 2)
})

test('a PG-coded error is never retried', async () => {
  const sb = fakeSupabase({ campaign_launch_claim: [{ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }, CLAIMED] })
  const r = await claim(sb)
  assert.equal(r.reason, 'launch_claim_unavailable')
  assert.equal(sb.calls.length, 1)
})

test('a real refusal (ok:false) is never retried', async () => {
  const sb = fakeSupabase({ campaign_launch_claim: [{ data: { ok: false, reason: 'campaign_not_launchable' }, error: null }, CLAIMED] })
  const r = await claim(sb)
  assert.equal(r.claimed, false)
  assert.equal(r.reason, 'campaign_not_launchable')
  assert.equal(sb.calls.length, 1)
})

const MISSING_FN = { data: null, error: { message: 'Could not find the function public.campaign_launch_claim', code: 'PGRST202' } }
test('fallback: the status read and idempotency_begin each retry a transport failure once (same token)', async () => {
  const sb = fakeSupabase({
    campaign_launch_claim: [MISSING_FN],
    'from:campaigns': [{ data: null, error: FETCH_FAILED }, { data: { status: 'built' }, error: null }],
    idempotency_begin: [{ data: null, error: FETCH_FAILED }, { data: { ok: true, reason: 'event_claimed' }, error: null }],
  })
  const r = await claim(sb)
  assert.equal(r.claimed, true)
  assert.equal(r.mode, 'ledger')
  const begins = sb.calls.filter((c) => c.name === 'idempotency_begin')
  assert.deepEqual(begins.map((c) => c.args.p_claim_token), ['tok-1', 'tok-1'])
  assert.equal(sb.calls.filter((c) => c.name === 'from:campaigns').length, 2)
})

test('fallback: a duplicate is a refusal, never retried; two begin transport failures fail closed', async () => {
  const dup = fakeSupabase({
    campaign_launch_claim: [MISSING_FN],
    'from:campaigns': [{ data: { status: 'built' }, error: null }],
    idempotency_begin: [{ data: { ok: true, duplicate: true, reason: 'duplicate_event_ignored', meta: {} }, error: null }],
  })
  assert.equal((await claim(dup)).reason, 'already_launched')
  assert.equal(dup.calls.filter((c) => c.name === 'idempotency_begin').length, 1)
  const down = fakeSupabase({
    campaign_launch_claim: [MISSING_FN],
    'from:campaigns': [{ data: { status: 'built' }, error: null }],
    idempotency_begin: [{ data: null, error: FETCH_FAILED }, { data: null, error: FETCH_FAILED }],
  })
  const r = await claim(down)
  assert.equal(r.claimed, false)
  assert.equal(r.reason, 'launch_claim_unavailable')
})

// rc-8.5.21 blind-eval RUN-09 — a worker crash AFTER the claim but BEFORE the provider call. On a
// DISPOSABLE PostgreSQL 17 (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it) with
// the REAL §11 ledger (apps/api/supabase/migrations/20260904090000 + 20260904190000: the logical
// communications, the numbered attempts, seller_communication_attempt_allocate) and the REAL queue
// runner item path. The crash is REAL: a child process SIGKILLs itself mid-dispatch.
//   PROVABLY unsent (killed before the §11 seam: no attempt, no provider evidence) ⇒ the lease reaper
//     re-dispatches the row EXACTLY ONCE (queued again, retry_count untouched) ⇒ the next claim sends
//     exactly once through the simulated provider. A second crash after that re-dispatch is NEVER
//     re-dispatched again (manual review, zero sends).
//   AMBIGUOUS (killed inside the provider call: the attempt's provider_request_started marker is
//     committed) ⇒ held for manual review exactly as before; zero second sends.
// Both reapers are covered: reconcileCanonicalQueueLifecycle (the canonical reconcile) and the queue
// tick's recovery step (recoverExpiredProcessingLeases).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

import { pgAvailable, skipReason, API_DIR } from '../pg/agent-pg-harness.mjs'
import { lifecycleDb, seedWorld, seedThread, planNurture, materialize, trapTransport, simProvider, claimRow, dispatchRow, rowsOf, sel, lawfulNowIso, applyS11Ledger } from '../helpers/followup-lifecycle-pg.mjs'
import { createSellerCommunicationStore } from '../../src/lib/domain/communications/seller-communication-store.js'
import { reconcileCanonicalQueueLifecycle } from '../../src/lib/supabase/sms-engine.js'
import { recoverExpiredProcessingLeases, evaluateExpiredProcessingLease, LEASE_MANUAL_REVIEW_REASON } from '../../src/lib/domain/queue/processing-lease-recovery.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'

__setAutomationHoldResolverForTests(null)
const skip = pgAvailable() ? false : skipReason

async function s11Db() {
  const env = await lifecycleDb()
  await applyS11Ledger(env.pool)
  await seedWorld(env.pool)
  return env
}

/** A ready, nonempty follow-up row (the lifecycle's real writer + materializer), then the runner's claim. */
async function claimedRow(env, phone) {
  const { inboundId } = await seedThread(env.pool, { phone })
  const planned = await planNurture(env.sb, phone, { inboundId })
  assert.equal(planned.ok, true, JSON.stringify(planned))
  const m = await materialize(env)
  assert.equal(m.counts.materialized, 1, JSON.stringify(m))
  const [row] = await rowsOf(env.pool, phone)
  const claimed = await claimRow(env.pool, row.id)
  assert.ok(claimed)
  return claimed
}

/** A REAL crash: the child runs the real runner item path and SIGKILLs itself at `point`. */
function crash(env, claimed, point) {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', '--import', './tests/register-aliases.mjs', 'tests/helpers/lease-crash-child.mjs', env.db.url, claimed.row.id, claimed.token, point, lawfulNowIso(Date.parse(claimed.row.scheduled_for))],
    { cwd: API_DIR, env: process.env, encoding: 'utf8', timeout: 120_000 })
  assert.equal(child.signal, 'SIGKILL', `child: ${child.status} ${child.stdout} ${String(child.stderr).slice(-1500)}`)
  return child.stdout
}

/** The dead worker renews nothing: its lease expires on the DB clock. */
const expireLease = (env, id) => env.pool.query(`update public.send_queue set locked_at = now() - interval '11 minutes', metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('processing_timeout_at', (now() - interval '1 minute')::text) where id = $1`, [id])
const rowOf = async (env, id) => (await sel(env.pool, 'select * from public.send_queue where id = $1', [id]))[0]
const attemptsOf = (env, id) => sel(env.pool, 'select * from public.seller_communication_attempts where queue_row_id = $1', [String(id)])
const reconcile = (env) => reconcileCanonicalQueueLifecycle({ supabase: env.sb, queue_emergency_stop_at: '', queue_processor_mode: 'live', caller_route: 'test' })

test('PG RUN-09 (REAL SIGKILL, provably unsent): killed after the claim and before the §11 seam ⇒ the reaper re-dispatches EXACTLY ONCE (retry_count untouched) ⇒ ONE simulated provider send; a replayed reaper does nothing', { skip }, async () => {
  const env = await s11Db()
  const net = trapTransport()
  try {
    const phone = '+13125550701'
    const claimed = await claimedRow(env, phone)
    const retry_before = Number(claimed.row.retry_count || 0)
    assert.match(crash(env, claimed, 'before_seam'), /KILL_BEFORE_SEAM/)
    let row = await rowOf(env, claimed.row.id)
    assert.equal(row.queue_status, 'processing', 'the dead worker left the row claimed')
    assert.equal((await attemptsOf(env, row.id)).length, 0, 'no §11 attempt: provably no provider call')
    await expireLease(env, row.id)

    const r = await reconcile(env)
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300))
    row = await rowOf(env, claimed.row.id)
    assert.equal(row.queue_status, 'queued', JSON.stringify({ status: row.queue_status, reason: row.failed_reason }))
    assert.equal(row.is_locked, false)
    assert.equal(row.lock_token, null)
    assert.equal(Number(row.retry_count || 0), retry_before, 'a provable no-send re-dispatch is never an (ambiguous) retry')
    assert.equal(row.metadata.lease_redispatch_count, 1)
    assert.equal(row.metadata.lease_redispatch.expired_lock_token, claimed.token)
    // a replayed reaper (both of them) finds nothing to do
    await reconcile(env)
    assert.equal((await recoverExpiredProcessingLeases(env.sb, [row])).redispatched.length, 0)
    assert.equal((await rowOf(env, row.id)).queue_status, 'queued')

    const provider = simProvider()
    const again = await claimRow(env.pool, row.id)
    assert.ok(again, 'claimable once more')
    const out = await dispatchRow(env, again, { provider, now: lawfulNowIso(Date.parse(row.scheduled_for)), store: createSellerCommunicationStore({ supabase: env.sb }) })
    assert.equal(provider.accepted(), 1, `exactly one provider send (${JSON.stringify(out).slice(0, 300)})`)
    assert.equal(provider.sent.length, 1)
    const attempts = await attemptsOf(env, row.id)
    assert.equal(attempts.length, 1)
    assert.ok(attempts[0].provider_request_started_at && attempts[0].provider_message_id)
    assert.equal(await claimRow(env.pool, row.id), null, 'never claimable again')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG RUN-09 (REAL SIGKILL): a SECOND crash after the one re-dispatch is never re-dispatched again ⇒ manual review, zero sends', { skip }, async () => {
  const env = await s11Db()
  const net = trapTransport()
  try {
    const phone = '+13125550702'
    const first = await claimedRow(env, phone)
    crash(env, first, 'before_seam')
    await expireLease(env, first.row.id)
    await reconcile(env)
    assert.equal((await rowOf(env, first.row.id)).queue_status, 'queued')
    const second = await claimRow(env.pool, first.row.id)
    crash(env, second, 'before_seam')
    await expireLease(env, first.row.id)
    // the queue tick's recovery step this time (the other reaper)
    const stuck = await sel(env.pool, `select id,queue_status,lock_token,locked_at,provider_message_id,textgrid_message_id,sent_at,delivered_at,metadata from public.send_queue where id = $1`, [first.row.id])
    const rec = await recoverExpiredProcessingLeases(env.sb, stuck)
    assert.deepEqual([rec.redispatched.length, rec.manual_review.length], [0, 1], JSON.stringify(rec))
    const row = await rowOf(env, first.row.id)
    assert.deepEqual([row.queue_status, row.failed_reason], ['expired', LEASE_MANUAL_REVIEW_REASON])
    assert.ok(row.metadata.lease_recovery.blockers.includes('lease_redispatch_exhausted'))
    assert.equal(await claimRow(env.pool, row.id), null)
    assert.equal((await attemptsOf(env, row.id)).length, 0, 'never reached the provider')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG RUN-09 (REAL SIGKILL, ambiguous): killed INSIDE the provider call (the §11 provider_request_started marker is committed) ⇒ held for manual review by BOTH reapers; zero second sends', { skip }, async () => {
  const env = await s11Db()
  const net = trapTransport()
  try {
    const phone = '+13125550703'
    const claimed = await claimedRow(env, phone)
    assert.match(crash(env, claimed, 'in_provider'), /KILL_IN_PROVIDER/)
    const attempts = await attemptsOf(env, claimed.row.id)
    assert.equal(attempts.length, 1)
    assert.ok(attempts[0].provider_request_started_at, 'the marker was committed before the network call')
    assert.equal(attempts[0].completed_at, null)
    await expireLease(env, claimed.row.id)
    // the tick's recovery step: ambiguous ⇒ manual review
    const stuck = await sel(env.pool, `select id,queue_status,lock_token,locked_at,provider_message_id,textgrid_message_id,sent_at,delivered_at,metadata from public.send_queue where id = $1`, [claimed.row.id])
    const v = evaluateExpiredProcessingLease(stuck[0], { attempts_readable: true, attempts })
    assert.equal(v.action, 'manual_review')
    assert.ok(v.blockers.includes('attempt_provider_request_started'))
    await reconcile(env)
    const row = await rowOf(env, claimed.row.id)
    assert.deepEqual([row.queue_status, row.failed_reason], ['expired', LEASE_MANUAL_REVIEW_REASON])
    assert.equal(await claimRow(env.pool, row.id), null, 'not claimable: no second send can follow')
    // even a forced second dispatch of the same row is refused by the §11 allocation (unresolved sibling)
    const provider = simProvider()
    const forced = await dispatchRow(env, { row: { ...row, queue_status: 'processing', lock_token: 'forced' }, token: 'forced' }, { provider, store: createSellerCommunicationStore({ supabase: env.sb }) }).catch((e) => ({ error: e.message }))
    assert.equal(provider.sent.length, 0, JSON.stringify(forced).slice(0, 300))
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('RUN-09 (pure): the verdict — any provider evidence, an unreadable ledger, any unresolved / started / possibly-sent attempt, or a prior re-dispatch ⇒ manual review; only a provable no-send re-dispatches', () => {
  const base = { id: 'r1', queue_status: 'processing', lock_token: 't', metadata: {} }
  assert.equal(evaluateExpiredProcessingLease(base, { attempts_readable: true, attempts: [] }).action, 'redispatch')
  for (const [label, row, ev] of [
    ['row provider id', { ...base, provider_message_id: 'SM1' }, { attempts_readable: true }],
    ['row sent_at', { ...base, sent_at: '2026-10-18T00:00:00Z' }, { attempts_readable: true }],
    ['metadata sid', { ...base, metadata: { provider_message_sid: 'SM2' } }, { attempts_readable: true }],
    ['ledger unreadable', base, { attempts_readable: false }],
    ['allocated, unmarked attempt', base, { attempts_readable: true, attempts: [{ completed_at: null }] }],
    ['started attempt', base, { attempts_readable: true, attempts: [{ provider_request_started_at: 'x', completed_at: null }] }],
    ['completed, may have been sent', base, { attempts_readable: true, attempts: [{ provider_request_started_at: 'x', completed_at: 'y', delivery_possibility: 'may_have_been_sent' }] }],
    ['already re-dispatched once', { ...base, metadata: { lease_redispatch_count: 1 } }, { attempts_readable: true }],
  ]) assert.equal(evaluateExpiredProcessingLease(row, ev).action, 'manual_review', label)
  // a completed, definitely-not-sent attempt is not evidence of a call
  assert.equal(evaluateExpiredProcessingLease(base, { attempts_readable: true, attempts: [{ provider_request_started_at: 'x', completed_at: 'y', delivery_possibility: 'definitely_not_sent', http_status: 400 }] }).action, 'redispatch')
})

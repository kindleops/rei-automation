// rc-8.5.21 FINAL directive, phase 1 — SENDER CONTINUITY (owner P0), on a DISPOSABLE PostgreSQL 17
// (AGENT_PG_TEST_DB_URL; skipped — reported, never vacuous — without it). The provider is SIMULATED (fetch
// and TextGrid credentials are trapped). THE authority is delivery/sender-continuity.js, read for real
// (the critical-test seam is cleared): inbox_thread_state.our_number, else the last seller-seen outbound.
//
//   concurrency   the sender turns unhealthy AFTER planning / materialization and BEFORE dispatch, while 4
//                 workers race to claim and dispatch the row ⇒ one claim; the row stays bound to the thread
//                 sender and lands in a VISIBLE hold (blocked_sender_ineligible / sender_unavailable); zero
//                 provider calls; the healthy fallback number appears nowhere; our_number unchanged
//   recovery      health recovers ⇒ releaseSenderContinuityHolds revalidates (conversation, suppression,
//                 holds, eligibility, duplicates) and only then re-queues ⇒ exactly ONE send, from the thread
//                 sender. Newer seller activity ⇒ SUPERSEDED (never sent); STOP ⇒ blocked; a hold ⇒ held;
//                 an already-dispatched attempt ⇒ superseded (duplicate protection)
//   adversarial   a forged from_phone_number is refused at the writer, at claim (stamp), at dispatch, and —
//                 bypassing all of those — at the FINAL check inside the transport seam (no attempt, no
//                 provider call); a retry after a REAL crash keeps the sender; the router (Sender Routing
//                 2.0 gate ON, a graph that would move the thread) cannot substitute another number
//   reassignment  only an explicit, audited operator action moves a thread's sender; automated actors refused
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

import { pgAvailable, skipReason, API_DIR } from '../pg/agent-pg-harness.mjs'
import { isoPool } from '../helpers/pg-supabase.mjs'
import { lifecycleDb, seedWorld, seedThread, planNurture, materialize, trapTransport, simProvider, claimRow, dispatchRow, itemDeps, rowsOf, intentsOf, sel, lawfulNowIso, applyS11Ledger, registryHoldCheck, OURS, FALLBACK_SENDER } from '../helpers/followup-lifecycle-pg.mjs'
import { createSellerCommunicationStore } from '../../src/lib/domain/communications/seller-communication-store.js'
import { dispatchSellerQueueRow } from '../../src/lib/domain/communications/dispatch-seller-queue-row.js'
import { insertSupabaseSendQueueRow, validateSendQueueRowPreclaim, selectAvailableTextgridNumber, reconcileCanonicalQueueLifecycle } from '../../src/lib/supabase/sms-engine.js'
import { __setSenderContinuityResolverForTests, reassignThreadSender, loadEstablishedSender, SENDER_REASSIGNED_EVENT } from '../../src/lib/domain/delivery/sender-continuity.js'
import { releaseSenderContinuityHolds, SENDER_HOLD_SUPERSEDED_REASON, SENDER_HOLD_NEWER_OUTBOUND_REASON } from '../../src/lib/domain/queue/release-sender-continuity-holds.js'
import { resolveStickyThreadSender } from '../../src/lib/domain/delivery/thread-sender.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'

__setAutomationHoldResolverForTests(null)
__setSenderContinuityResolverForTests(null)
const skip = pgAvailable() ? false : skipReason
const OP = 'a2ee0ffe-6f27-475b-a795-ee617c9472c6'

async function world({ s11 = true } = {}) {
  const env = await lifecycleDb()
  if (s11) await applyS11Ledger(env.pool)
  await seedWorld(env.pool)
  await env.pool.query(`create table if not exists public.automation_events (id uuid primary key default gen_random_uuid(), event_type text, source text, conversation_thread_id text, payload jsonb, created_at timestamptz default now())`)
  return env
}
const rowOf = async (env, id) => (await sel(env.pool, 'select * from public.send_queue where id = $1', [id]))[0]
const ourNumber = async (env, phone) => (await sel(env.pool, 'select our_number from public.inbox_thread_state where thread_key = $1', [phone]))[0]?.our_number ?? null
const setHealth = (env, phone, status, health) => env.pool.query('update public.textgrid_numbers set status = $2, health_state = $3 where phone_number = $1', [phone, status, health])
const attemptsOf = (env, id) => sel(env.pool, 'select * from public.seller_communication_attempts where queue_row_id = $1', [String(id)])

/** A ready follow-up row (the REAL writer + materializer: the thread sender resolved, the row stamped). */
async function readyRow(env, phone) {
  const { inboundId } = await seedThread(env.pool, { phone })
  const planned = await planNurture(env.sb, phone, { inboundId })
  assert.equal(planned.ok, true, JSON.stringify(planned))
  const m = await materialize(env)
  assert.equal(m.counts.materialized, 1, JSON.stringify(m))
  const [row] = await rowsOf(env.pool, phone)
  assert.equal(row.from_phone_number, OURS)
  assert.equal(row.metadata.sender_continuity?.sender, OURS, 'the canonical writer stamped the established sender')
  return row
}
const at = (row) => lawfulNowIso(Date.parse(row.scheduled_for))
const releaseDeps = (env, now) => {
  const d = itemDeps(env, { provider: simProvider(), now })
  return { supabase: env.sb, now, getSystemValue: d.getSystemValue, loadOutboundNumberByPhone: d.loadOutboundNumberByPhone, holdCheck: registryHoldCheck(env.sb), runSendTimeContactGuard: d.runSendTimeContactGuard }
}

test('PG continuity (concurrency): the sender turns COOLING after materialization while 4 workers race the row ⇒ ONE claim, the row stays bound to the thread sender in a VISIBLE hold (sender_unavailable); zero provider calls; the fallback appears nowhere', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const phone = '+13125550801'
    const row = await readyRow(env, phone)
    const provider = simProvider()
    const now = at(row)
    // the race: 4 workers (own pools) claim + dispatch while the health flip lands between materialization and dispatch
    const pools = Array.from({ length: 4 }, () => env.db.trackPool(isoPool(env.db.url, 2)))
    const flip = setHealth(env, OURS, 'cooling', 'cooling')
    const results = await Promise.all(pools.map(async (p) => {
      await flip
      const claimed = await claimRow(p, row.id)
      if (!claimed) return { claimed: false }
      return { claimed: true, out: await dispatchRow(env, claimed, { provider, now, store: createSellerCommunicationStore({ supabase: env.sb }) }) }
    }))
    assert.equal(results.filter((r) => r.claimed).length, 1, 'exactly one worker claims the row')
    assert.equal(provider.sent.length, 0, 'zero provider calls')
    const after = await rowOf(env, row.id)
    assert.deepEqual([after.queue_status, after.guard_reason], ['blocked_sender_ineligible', 'sender_unavailable'], JSON.stringify({ s: after.queue_status, g: after.guard_reason }))
    assert.equal(after.from_phone_number, OURS, 'bound to the thread sender')
    assert.equal(after.metadata.sender_continuity_hold.established_sender, OURS)
    assert.equal(after.metadata.sender_continuity_hold.sender_reason, 'outbound_number_health_cooling')
    assert.ok(!JSON.stringify(after).includes(FALLBACK_SENDER.slice(-10)), 'the healthy fallback number appears nowhere on the row')
    assert.equal(await ourNumber(env, phone), OURS, 'the thread sender is not switched')
    const [intent] = await intentsOf(env.pool, phone)
    assert.equal(intent.state, 'held', 'the follow-up intent is held (visible), never failed')
    assert.equal((await attemptsOf(env, row.id)).length, 0)
    assert.equal(await claimRow(env.pool, row.id), null, 'a held row is not claimable')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG continuity (recovery): health recovers ⇒ the release REVALIDATES and re-queues ⇒ exactly ONE send from the thread sender; still cooling ⇒ stays held; the release is BORN OFF in the runner (dry run unless sender_continuity_release_mode=live)', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const phone = '+13125550802'
    const row = await readyRow(env, phone)
    const now = at(row)
    await setHealth(env, OURS, 'cooling', 'cooling')
    const provider = simProvider()
    await dispatchRow(env, await claimRow(env.pool, row.id), { provider, now, store: createSellerCommunicationStore({ supabase: env.sb }) })
    assert.equal((await rowOf(env, row.id)).guard_reason, 'sender_unavailable')
    // still cooling ⇒ the release keeps it held, recording why
    let rel = await releaseSenderContinuityHolds({}, releaseDeps(env, now))
    assert.deepEqual([rel.released, rel.still_held], [0, 1], JSON.stringify(rel.outcomes))
    assert.match(rel.outcomes[0].reason, /^sender_still_unavailable:outbound_number_health_cooling/)
    // dry run (the runner's default while the mode is not 'live') writes nothing
    await setHealth(env, OURS, 'active', 'healthy')
    rel = await releaseSenderContinuityHolds({ dry_run: true }, releaseDeps(env, now))
    assert.equal(rel.outcomes[0].action, 'release')
    assert.equal((await rowOf(env, row.id)).queue_status, 'blocked_sender_ineligible', 'a dry run changes nothing')
    rel = await releaseSenderContinuityHolds({}, releaseDeps(env, now))
    assert.equal(rel.released, 1, JSON.stringify(rel.outcomes))
    const released = await rowOf(env, row.id)
    assert.deepEqual([released.queue_status, released.from_phone_number], ['queued', OURS])
    assert.equal((await intentsOf(env.pool, phone))[0].state, 'ready', 'the intent is ready again')
    await dispatchRow(env, await claimRow(env.pool, row.id), { provider, now, store: createSellerCommunicationStore({ supabase: env.sb }) })
    assert.equal(provider.accepted(), 1, 'exactly one send')
    assert.ok(JSON.stringify(provider.sent[0]).includes(OURS.slice(-10)), 'from the thread sender')
    assert.ok(!JSON.stringify(provider.sent).includes(FALLBACK_SENDER.slice(-10)))
    assert.equal(await claimRow(env.pool, row.id), null)
    // replaying the release finds nothing to do
    assert.equal((await releaseSenderContinuityHolds({}, releaseDeps(env, now))).examined, 0)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG continuity (recovery): health recovers but the SELLER WROTE AGAIN ⇒ superseded, never sent; STOP ⇒ blocked; an automation hold ⇒ still held; another path already continued the conversation ⇒ superseded (duplicate protection)', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const provider = simProvider()
    const hold = async (phone) => {
      const row = await readyRow(env, phone)
      await setHealth(env, OURS, 'cooling', 'cooling')
      await dispatchRow(env, await claimRow(env.pool, row.id), { provider, now: at(row), store: createSellerCommunicationStore({ supabase: env.sb }) })
      assert.equal((await rowOf(env, row.id)).guard_reason, 'sender_unavailable')
      await setHealth(env, OURS, 'active', 'healthy')
      return row
    }
    // a) newer seller activity after the row was planned
    const a = await hold('+13125550803')
    await env.pool.query(`update public.inbox_thread_state set last_inbound_at = now() + interval '1 minute' where thread_key = $1`, ['+13125550803'])
    // b) STOP recorded for the seller
    const b = await hold('+13125550804')
    await env.pool.query(`insert into public.sms_suppression_list (phone_e164, phone_number, is_active, suppression_type, reason) values ($1, $1, true, 'opt_out', 'STOP')`, ['+13125550804'])
    // c) an operator automation hold on the thread
    const c = await hold('+13125550805')
    await env.pool.query(`insert into public.automation_holds (hold_key, hold_type, thread_key, reason, set_by, approval_ref) values ('sc:c', 'operator_hold', $1, 'operator review', 'op', 'SC-C')`, ['+13125550805'])
    // d) duplicate protection: the conversation was already continued by another path after the row was planned
    const d = await hold('+13125550806')
    await env.pool.query(`insert into public.send_queue (queue_key, queue_status, message_body, to_phone_number, from_phone_number, thread_key, created_at, sent_at, type, metadata)
                          values ($1, 'sent', 'Hi Dana, following up on 12 Oak St.', $2::text, $3::text, $2::text, now(), now() + interval '30 seconds', 'outbound', '{}'::jsonb)`, [`other:${crypto.randomUUID()}`, '+13125550806', OURS])
    const rel = await releaseSenderContinuityHolds({}, releaseDeps(env, at(a)))
    const byId = Object.fromEntries(rel.outcomes.map((o) => [String(o.id), o]))
    assert.deepEqual([byId[a.id].action, byId[a.id].reason], ['supersede', SENDER_HOLD_SUPERSEDED_REASON])
    assert.equal(byId[b.id].action, 'block', JSON.stringify(byId[b.id]))
    assert.match(byId[b.id].reason, /^send_time_guard:/)
    assert.equal(byId[c.id].action, 'hold', JSON.stringify(byId[c.id]))
    assert.match(byId[c.id].reason, /^automation_hold:/)
    assert.deepEqual([byId[d.id].action, byId[d.id].reason], ['supersede', SENDER_HOLD_NEWER_OUTBOUND_REASON])
    assert.equal((await rowOf(env, d.id)).queue_status, 'cancelled')
    // documented terminal states; the follow-up intents agree
    assert.equal((await rowOf(env, a.id)).queue_status, 'cancelled')
    assert.equal((await intentsOf(env.pool, '+13125550803'))[0].state, 'superseded')
    assert.equal((await rowOf(env, b.id)).queue_status, 'blocked')
    assert.equal((await rowOf(env, c.id)).queue_status, 'blocked_sender_ineligible')
    // nothing is claimable and nothing was sent
    for (const r of [a, b, c, d]) assert.equal(await claimRow(env.pool, r.id), null)
    assert.equal(provider.sent.length, 0)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG continuity (adversarial): a FORGED from_phone_number on an established thread is refused at the writer, at claim (stamp), at dispatch selection, and — bypassing all three — at the FINAL check inside the transport seam (no attempt, no provider call)', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const phone = '+13125550807'
    const row = await readyRow(env, phone)
    const now = at(row)
    // 1. the canonical writer refuses a conversation row naming another number
    const forgedInsert = await insertSupabaseSendQueueRow({ queue_key: `forged:${crypto.randomUUID()}`, queue_status: 'queued', thread_key: phone, to_phone_number: phone, from_phone_number: FALLBACK_SENDER, message_body: 'Hi Dana, following up on 12 Oak St.', type: 'auto_reply', source: 'auto_reply', metadata: { source: 'auto_reply' } }, { supabase: env.sb })
    assert.deepEqual([forgedInsert.ok, forgedInsert.reason], [false, 'sender_continuity_mismatch'])
    assert.equal(forgedInsert.sender_continuity.established_sender, OURS)
    assert.equal((await sel(env.pool, `select count(*)::int n from public.send_queue where from_phone_number = $1`, [FALLBACK_SENDER]))[0].n, 0, 'never written')
    // 2. a row rewritten after insertion (forged in the DB) is refused at claim: its stamp names the thread sender
    await env.pool.query(`update public.send_queue set from_phone_number = $2 where id = $1`, [row.id, FALLBACK_SENDER])
    const forged = await rowOf(env, row.id)
    assert.equal(validateSendQueueRowPreclaim(forged, now).reason, 'sender_continuity_mismatch')
    // 3. dispatch selection refuses it (held visibly, never sent, never "corrected")
    const provider = simProvider()
    await dispatchRow(env, await claimRow(env.pool, row.id), { provider, now, store: createSellerCommunicationStore({ supabase: env.sb }) })
    let after = await rowOf(env, row.id)
    assert.deepEqual([after.queue_status, after.guard_reason, after.from_phone_number], ['blocked_sender_ineligible', 'sender_continuity_mismatch', FALLBACK_SENDER])
    assert.equal(provider.sent.length, 0)
    // 4. the FINAL check: the seam itself, called directly with the forged sender (every earlier layer bypassed)
    const store = createSellerCommunicationStore({ supabase: env.sb })
    const sent = []
    const direct = await dispatchSellerQueueRow({ ...forged, queue_status: 'processing' }, { to: phone, from: FALLBACK_SENDER, body: forged.message_body }, {
      supabase: env.sb, store, now, getSystemValue: itemDeps(env, { provider }).getSystemValue,
      loadOutboundNumberByPhone: itemDeps(env, { provider }).loadOutboundNumberByPhone,
      sendProvider: async (m) => { sent.push(m); return { ok: true, sid: 'SMforged' } },
    })
    assert.deepEqual([direct.ok, direct.provider_invoked, direct.stage, direct.reason], [false, false, 'runtime_authority', 'sender_continuity_mismatch'])
    assert.equal(direct.sender_continuity.established_sender, OURS)
    assert.equal(sent.length, 0, 'the provider is never called with a substituted sender')
    assert.equal((await attemptsOf(env, row.id)).length, 0, 'no attempt is allocated')
    // the same seam with the thread's own sender but that sender unhealthy ⇒ sender_unavailable at the final check
    await setHealth(env, OURS, 'cooling', 'cooling')
    const unhealthy = await dispatchSellerQueueRow({ ...forged, from_phone_number: OURS, queue_status: 'processing' }, { to: phone, from: OURS, body: forged.message_body }, {
      supabase: env.sb, store, now, getSystemValue: itemDeps(env, { provider }).getSystemValue, loadOutboundNumberByPhone: itemDeps(env, { provider }).loadOutboundNumberByPhone,
      sendProvider: async (m) => { sent.push(m); return { ok: true, sid: 'SMx' } },
    })
    assert.deepEqual([unhealthy.provider_invoked, unhealthy.reason, unhealthy.sender_continuity.sender_reason], [false, 'sender_unavailable', 'outbound_number_health_cooling'])
    assert.equal(sent.length, 0)
    after = await rowOf(env, row.id)
    assert.equal(await ourNumber(env, phone), OURS)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

/** A REAL crash: the child runs the real runner item path and SIGKILLs itself before the seam. */
function crash(env, claimed) {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', '--import', './tests/register-aliases.mjs', 'tests/helpers/lease-crash-child.mjs', env.db.url, claimed.row.id, claimed.token, 'before_seam', lawfulNowIso(Date.parse(claimed.row.scheduled_for))],
    { cwd: API_DIR, env: process.env, encoding: 'utf8', timeout: 120_000 })
  assert.equal(child.signal, 'SIGKILL', `child: ${child.status} ${child.stdout} ${String(child.stderr).slice(-800)}`)
}
const expireLease = (env, id) => env.pool.query(`update public.send_queue set locked_at = now() - interval '11 minutes', metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('processing_timeout_at', (now() - interval '1 minute')::text) where id = $1`, [id])

test('PG continuity (adversarial): a RETRY after a REAL crash keeps the sender — re-dispatched with the thread sender and sent once from it; the sender went bad during the outage ⇒ the retry holds visibly, never another number', { skip }, async () => {
  for (const goesBad of [false, true]) {
    const env = await world()
    const net = trapTransport()
    try {
      const phone = goesBad ? '+13125550809' : '+13125550808'
      const row = await readyRow(env, phone)
      const claimed = await claimRow(env.pool, row.id)
      crash(env, claimed)
      await expireLease(env, row.id)
      const r = await reconcileCanonicalQueueLifecycle({ supabase: env.sb, queue_emergency_stop_at: '', queue_processor_mode: 'live', caller_route: 'test' })
      assert.equal(r.ok, true)
      const recovered = await rowOf(env, row.id)
      assert.deepEqual([recovered.queue_status, recovered.from_phone_number], ['queued', OURS], 'recovery never touches the sender')
      if (goesBad) await setHealth(env, OURS, 'cooling', 'cooling')
      const provider = simProvider()
      await dispatchRow(env, await claimRow(env.pool, row.id), { provider, now: at(row), store: createSellerCommunicationStore({ supabase: env.sb }) })
      const after = await rowOf(env, row.id)
      if (goesBad) {
        assert.equal(provider.sent.length, 0)
        assert.deepEqual([after.queue_status, after.guard_reason, after.from_phone_number], ['blocked_sender_ineligible', 'sender_unavailable', OURS])
      } else {
        assert.equal(provider.accepted(), 1)
        assert.ok(JSON.stringify(provider.sent[0]).includes(OURS.slice(-10)))
      }
      assert.ok(!JSON.stringify(provider.sent).includes(FALLBACK_SENDER.slice(-10)))
      assert.equal(await ourNumber(env, phone), OURS)
      assert.deepEqual(net.hits, [])
    } finally { net.restore(); await env.db.drop() }
  }
})

test('PG continuity (adversarial): the ROUTER cannot substitute — Sender Routing 2.0 gate ON with a graph that routes the market to the fallback; legacy sticky fallback offered; the established thread keeps its sender (healthy) or holds (unhealthy)', { skip }, async () => {
  const env = await world({ s11: false })
  try {
    const phone = '+13125550810'
    const row = await readyRow(env, phone)
    const fleet = (await sel(env.pool, 'select * from public.textgrid_numbers')).map((r) => ({ ...r, messages_sent_today: 0, registration_status: 'registered', metadata: { sms_webhook_status: 'verified' } }))
    const fb = fleet.find((r) => r.phone_number === FALLBACK_SENDER)
    // a graph whose only pool for the market holds the FALLBACK number (the thread number is in no pool ⇒ the policy would reroute)
    const graphRows = { markets: [{ id: 'chi', display_name: 'Chicago, IL', state: 'IL' }], pools: [{ pool_key: 'chi_local', name: 'Chicago local', home_market_id: 'chi' }], pool_numbers: [{ pool_key: 'chi_local', textgrid_number_id: fb.id, phone_number: FALLBACK_SENDER, status: 'active' }], routes: [{ id: 'r1', market_id: 'chi', pool_key: 'chi_local', priority: 1, affinity_tier: 'primary', enabled: true }], version: 'test-1', source: 'test' }
    const routerDeps = (extra = {}) => ({
      supabase: env.sb, env: { SENDER_ROUTING_V2_ENABLED: 'true' }, readSystemFlag: async () => 'true', loadGraphRows: async () => graphRows,
      loadTextgridFleet: async () => fleet, loadOutboundNumberByPhone: async (p) => fleet.find((r) => r.phone_number === p) || null,
      getSystemValue: async () => null, loadPropertyMarketId: async () => 'chi', blocked_sender_numbers: new Set(), now: at(row), ...extra,
    })
    // an AUTO-REPLY on the same thread (not a pinned follow-up: the gated router is consulted for it)
    const { followup_intent_id: _fi, ...plainMeta } = row.metadata
    const reply = { ...row, type: 'auto_reply', source: 'auto_reply', queue_key: `inbound_auto_reply:x:t:${phone}`, metadata: { ...plainMeta, source: 'auto_reply' } }
    // control: a NEW conversation (nothing established) — the gated router may choose
    const control = await selectAvailableTextgridNumber(reply, routerDeps({ loadEstablishedSender: async () => null }))
    assert.equal(control.from_phone_number, FALLBACK_SENDER, `control: with no established sender the gated router moves the row (proves the graph would reroute): ${JSON.stringify(control).slice(0, 300)}`)
    // the established thread: continuity decides before any router (the reply and the follow-up alike)
    for (const r of [reply, row]) {
      const kept = await selectAvailableTextgridNumber(r, routerDeps())
      assert.deepEqual([kept.ok, kept.from_phone_number, kept.reason], [true, OURS, 'sender_continuity_thread_sender_revalidated'])
    }
    fleet.find((r) => r.phone_number === OURS).health_state = 'cooling'
    for (const r of [reply, row]) {
      const held = await selectAvailableTextgridNumber(r, routerDeps())
      assert.deepEqual([held.ok, held.reason, held.from_phone_number], [false, 'sender_unavailable', OURS])
    }
    // the legacy sticky resolver, offered a routing fallback, refuses to move the thread (nothing persisted)
    const persisted = []
    const sticky = await resolveStickyThreadSender({ thread_key: phone }, { supabase: env.sb, loadDispatchBlockedSenders: async () => new Set(), loadOutboundNumberByPhone: async (p) => fleet.find((r) => r.phone_number === p) || null, routeThreadFallback: async () => ({ phone: FALLBACK_SENDER, via: 'campaign_router' }), persistThreadSenderChange: async (c) => { persisted.push(c); return { ok: true } } })
    assert.deepEqual([sticky.ok, sticky.reason, sticky.thread_sender], [false, 'sender_unavailable', OURS])
    assert.deepEqual(persisted, [])
    assert.equal(await ourNumber(env, phone), OURS)
  } finally { await env.db.drop() }
})

test('PG continuity (reassignment): only an explicit, AUDITED operator action moves a thread sender — automated actors, missing reason / approval and an ineligible target are refused; the held rows are re-bound and released only through revalidation', { skip }, async () => {
  const env = await world()
  const net = trapTransport()
  try {
    const phone = '+13125550811'
    const row = await readyRow(env, phone)
    await setHealth(env, OURS, 'retired', 'blocked')
    const provider = simProvider()
    await dispatchRow(env, await claimRow(env.pool, row.id), { provider, now: at(row), store: createSellerCommunicationStore({ supabase: env.sb }) })
    assert.equal((await rowOf(env, row.id)).guard_reason, 'sender_unavailable')
    const deps = { supabase: env.sb, loadBlockedSenders: async () => new Set(), now: at(row) }
    for (const actor of ['', 'system', 'auto', 'router', 'sender_continuity', 'cron:nightly', 'ai']) {
      const r = await reassignThreadSender({ thread_key: phone, to: FALLBACK_SENDER, actor, reason: 'number retired', approval_ref: 'APR-1' }, deps)
      assert.deepEqual([r.ok, r.reason], [false, 'reassignment_requires_named_operator'], actor)
    }
    assert.equal((await reassignThreadSender({ thread_key: phone, to: FALLBACK_SENDER, actor: OP, reason: '', approval_ref: 'APR-1' }, deps)).reason, 'reassignment_reason_required')
    assert.equal((await reassignThreadSender({ thread_key: phone, to: FALLBACK_SENDER, actor: OP, reason: 'number retired', approval_ref: '' }, deps)).reason, 'reassignment_approval_required')
    await setHealth(env, FALLBACK_SENDER, 'paused', 'healthy')
    assert.equal((await reassignThreadSender({ thread_key: phone, to: FALLBACK_SENDER, actor: OP, reason: 'number retired', approval_ref: 'APR-1' }, deps)).reason, 'reassignment_target_ineligible')
    assert.equal(await ourNumber(env, phone), OURS, 'no refused attempt moved anything')
    assert.equal((await sel(env.pool, 'select count(*)::int n from public.automation_events')).at(0).n, 0, 'and none was audited as a move')
    await setHealth(env, FALLBACK_SENDER, 'active', 'healthy')
    const ok = await reassignThreadSender({ thread_key: phone, to: FALLBACK_SENDER, actor: OP, reason: 'number retired by carrier', approval_ref: 'APR-1' }, deps)
    assert.deepEqual([ok.ok, ok.from, ok.to, ok.rebound_held_rows], [true, OURS, FALLBACK_SENDER, 1], JSON.stringify(ok))
    const ev = await sel(env.pool, 'select event_type, payload from public.automation_events')
    assert.deepEqual(ev.map((e) => [e.event_type, e.payload.actor, e.payload.from_phone_number, e.payload.to_phone_number, e.payload.approval_ref]), [[SENDER_REASSIGNED_EVENT, OP, OURS, FALLBACK_SENDER, 'APR-1']])
    assert.equal(await ourNumber(env, phone), FALLBACK_SENDER)
    assert.equal((await loadEstablishedSender({ thread_key: phone }, { supabase: env.sb })).sender, FALLBACK_SENDER)
    let held = await rowOf(env, row.id)
    assert.deepEqual([held.queue_status, held.from_phone_number, held.metadata.sender_reassignment.actor], ['blocked_sender_ineligible', FALLBACK_SENDER, OP], 'still held: re-bound, not sent')
    const rel = await releaseSenderContinuityHolds({}, releaseDeps(env, at(row)))
    assert.equal(rel.released, 1, JSON.stringify(rel.outcomes))
    await dispatchRow(env, await claimRow(env.pool, row.id), { provider, now: at(row), store: createSellerCommunicationStore({ supabase: env.sb }) })
    assert.equal(provider.accepted(), 1)
    assert.ok(JSON.stringify(provider.sent[0]).includes(FALLBACK_SENDER.slice(-10)), 'after the approved reassignment the thread speaks from its NEW established number')
    held = await rowOf(env, row.id)
    assert.notEqual(held.queue_status, 'blocked_sender_ineligible')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

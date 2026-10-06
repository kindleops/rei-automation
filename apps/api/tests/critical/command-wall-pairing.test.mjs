/**
 * Command Wall — pairing codes, display credentials, revocation, rotation,
 * heartbeat throttling (owner brief §6, §8, §29, §58, §61).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createMemoryWallStore } from '@/lib/domain/command-wall/wall-store.js'
import { createRateLimiter, WALL_LIMITS } from '@/lib/domain/command-wall/wall-rate-limit.js'
import { normalizePairingCode, PAIRING_CODE_PATTERN, looksLikeDisplayToken, hashSecret } from '@/lib/domain/command-wall/wall-crypto.js'
import {
  startPairing, claimPairing, pollPairing, createDisplayAuthenticator, recordHeartbeat, revokeDisplay, requireRepair,
  updateDisplayConfig, sendViewCommand, displaySession, publicDisplay,
  PAIRING_TTL_MS, ROTATE_AFTER_MS, PREVIOUS_TOKEN_GRACE_MS, HEARTBEAT_WRITE_MIN_MS, TOKEN_TTL_MS,
} from '@/lib/domain/command-wall/wall-auth.js'

function clock(start = Date.parse('2026-10-06T08:00:00Z')) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

async function pairOne({ store = createMemoryWallStore(), c = clock(), limiter = createRateLimiter({ now: () => c.now() }) } = {}) {
  const deps = { now: c.now, limiter }
  const start = await startPairing(store, { clientKey: 'tv-1', hint: { browser: 'Tizen 6', width: 1920, height: 1080 } }, deps)
  const claim = await claimPairing(store, { code: start.code, operatorId: 'op-1', name: 'Living Room TV' }, deps)
  const poll = await pollPairing(store, { pairingId: start.pairing_id, pollSecret: start.poll_secret }, deps)
  return { store, c, limiter, deps, start, claim, poll }
}

test('pairing code shape is human-safe and normalises operator typing', () => {
  assert.match('ABCD-2345', PAIRING_CODE_PATTERN)
  assert.equal(normalizePairingCode(' abcd 2345 '), 'ABCD-2345')
  assert.equal(normalizePairingCode('abcd-2345'), 'ABCD-2345')
  assert.equal(normalizePairingCode('ABCD-1234'), null, '0/1 are excluded — ambiguous on a TV font')
  assert.equal(normalizePairingCode('OBCD-2345'), null, 'O is excluded')
  assert.equal(normalizePairingCode('ABC-2345'), null)
})

test('full pairing hands the token over exactly once, and stores only hashes', async () => {
  const { store, start, claim, poll } = await pairOne()
  assert.match(start.code, PAIRING_CODE_PATTERN)
  assert.equal(claim.display.status, 'awaiting_handoff')
  assert.equal(poll.paired, true)
  assert.ok(looksLikeDisplayToken(poll.token))
  const dump = store._dump()
  const serialized = JSON.stringify(dump)
  assert.ok(!serialized.includes(poll.token), 'raw token never stored')
  assert.ok(!serialized.includes(start.code), 'raw pairing code never stored')
  assert.ok(!serialized.includes(start.poll_secret), 'raw poll secret never stored')
  assert.equal(dump.displays[0].token_hash, hashSecret(poll.token))
  assert.equal(dump.pairings[0].status, 'consumed')
  // the operator projection and the TV session never carry hashes
  assert.ok(!JSON.stringify(publicDisplay(dump.displays[0])).includes(dump.displays[0].token_hash))
  assert.ok(!JSON.stringify(displaySession(dump.displays[0])).includes(dump.displays[0].token_hash))
  // new displays default to PRIVACY and OLED Low
  assert.equal(poll.display.config.privacy_mode, 'privacy')
  assert.equal(poll.display.config.oled_protection, 'low')
})

test('a pairing is single-use: a second poll and a second claim both fail', async () => {
  const { store, deps, start } = await pairOne()
  await assert.rejects(pollPairing(store, { pairingId: start.pairing_id, pollSecret: start.poll_secret }, deps), { code: 'pairing_consumed', status: 410 })
  await assert.rejects(claimPairing(store, { code: start.code, operatorId: 'op-2', name: 'Thief' }, deps), { code: 'code_already_used' })
})

test('concurrent polls of one claimed pairing mint exactly one token', async () => {
  const store = createMemoryWallStore()
  const c = clock()
  const deps = { now: c.now, limiter: createRateLimiter({ now: c.now }) }
  const start = await startPairing(store, { clientKey: 'tv' }, deps)
  await claimPairing(store, { code: start.code, operatorId: 'op', name: 'TV' }, deps)
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => pollPairing(store, { pairingId: start.pairing_id, pollSecret: start.poll_secret }, deps)))
  assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value.paired).length, 1)
})

test('pairing codes expire after 10 minutes, for both the TV and the operator', async () => {
  const store = createMemoryWallStore()
  const c = clock()
  const deps = { now: c.now, limiter: createRateLimiter({ now: c.now }) }
  const start = await startPairing(store, { clientKey: 'tv' }, deps)
  assert.equal(Date.parse(start.expires_at) - c.now(), PAIRING_TTL_MS)
  c.advance(PAIRING_TTL_MS + 1)
  await assert.rejects(claimPairing(store, { code: start.code, operatorId: 'op', name: 'TV' }, deps), { code: 'code_expired', status: 410 })
  await assert.rejects(pollPairing(store, { pairingId: start.pairing_id, pollSecret: start.poll_secret }, deps), { code: 'pairing_expired' })
})

test('a claimed pairing that is never picked up also expires', async () => {
  const store = createMemoryWallStore()
  const c = clock()
  const deps = { now: c.now, limiter: createRateLimiter({ now: c.now }) }
  const start = await startPairing(store, { clientKey: 'tv' }, deps)
  await claimPairing(store, { code: start.code, operatorId: 'op', name: 'TV' }, deps)
  c.advance(2 * PAIRING_TTL_MS + 1)
  await assert.rejects(pollPairing(store, { pairingId: start.pairing_id, pollSecret: start.poll_secret }, deps), { code: 'pairing_expired' })
})

test('the poll secret is required: a pairing id alone cannot collect the token', async () => {
  const store = createMemoryWallStore()
  const c = clock()
  const deps = { now: c.now, limiter: createRateLimiter({ now: c.now }) }
  const start = await startPairing(store, { clientKey: 'tv' }, deps)
  await claimPairing(store, { code: start.code, operatorId: 'op', name: 'TV' }, deps)
  await assert.rejects(pollPairing(store, { pairingId: start.pairing_id, pollSecret: 'guess' }, deps), { code: 'pairing_not_found' })
  const ok = await pollPairing(store, { pairingId: start.pairing_id, pollSecret: start.poll_secret }, deps)
  assert.equal(ok.paired, true)
})

test('claiming requires an operator identity', async () => {
  const store = createMemoryWallStore()
  const c = clock()
  const deps = { now: c.now, limiter: createRateLimiter({ now: c.now }) }
  const start = await startPairing(store, { clientKey: 'tv' }, deps)
  await assert.rejects(claimPairing(store, { code: start.code, operatorId: '', name: 'TV' }, deps), { code: 'operator_required', status: 401 })
})

test('rate limits: pair start per client, claim attempts per operator, global claim failures', async () => {
  const store = createMemoryWallStore()
  const c = clock()
  const limiter = createRateLimiter({ now: c.now })
  const deps = { now: c.now, limiter }
  for (let i = 0; i < WALL_LIMITS.pair_start_per_client.limit; i += 1) await startPairing(store, { clientKey: 'same-tv' }, deps)
  await assert.rejects(startPairing(store, { clientKey: 'same-tv' }, deps), { code: 'rate_limited', status: 429 })
  // brute force on codes: bounded per operator…
  for (let i = 0; i < WALL_LIMITS.claim_per_operator.limit; i += 1) {
    await assert.rejects(claimPairing(store, { code: 'ZZZZ-9999', operatorId: 'op-a', name: 'x' }, deps), { code: 'code_not_found' })
  }
  await assert.rejects(claimPairing(store, { code: 'ZZZZ-9999', operatorId: 'op-a', name: 'x' }, deps), { code: 'rate_limited' })
  // …and globally across operators
  let limited = false
  for (let i = 0; i < WALL_LIMITS.claim_failures_global.limit + 5 && !limited; i += 1) {
    try { await claimPairing(store, { code: 'ZZZZ-9999', operatorId: `op-${i}`, name: 'x' }, deps) } catch (e) { if (e.code === 'rate_limited') limited = true }
  }
  assert.ok(limited, 'global failure limit engages')
  // windows slide
  c.advance(WALL_LIMITS.pair_start_per_client.windowMs + 1)
  await startPairing(store, { clientKey: 'same-tv' }, deps)
})

test('pending pairings are capped so the code space cannot be flooded', async () => {
  const store = createMemoryWallStore()
  const c = clock()
  const deps = { now: c.now, limiter: createRateLimiter({ now: c.now }) }
  let capped = false
  for (let i = 0; i < 30 && !capped; i += 1) {
    try { await startPairing(store, { clientKey: `tv-${i}` }, deps) } catch (e) { capped = e.code === 'too_many_pending_pairings' }
  }
  assert.ok(capped)
})

test('authenticator: valid token passes; garbage, revoked and expired tokens are refused', async () => {
  const { store, c, poll } = await pairOne()
  const authn = createDisplayAuthenticator(store, { now: c.now })
  const ok = await authn.authenticate(poll.token)
  assert.equal(ok.display.status, 'active')
  await assert.rejects(authn.authenticate('not-a-token'), { code: 'display_unpaired' })
  await assert.rejects(authn.authenticate(`lcw_${'x'.repeat(43)}`), { code: 'display_unpaired' })
  await revokeDisplay(store, ok.display.id, { operatorId: 'op', now: c.now, authenticator: authn })
  await assert.rejects(authn.authenticate(poll.token), { code: 'display_unpaired' }, 'revocation is immediate in-process (hash cleared)')
  // expiry
  const p2 = await pairOne()
  const a2 = createDisplayAuthenticator(p2.store, { now: p2.c.now, cacheMs: 0 })
  p2.c.advance(TOKEN_TTL_MS + 1)
  await assert.rejects(a2.authenticate(p2.poll.token), { code: 'display_token_expired' })
})

test('regenerate pairing kills the credential; re-pairing the same display issues a new one', async () => {
  const { store, c, poll, deps } = await pairOne()
  const authn = createDisplayAuthenticator(store, { now: c.now })
  const { display } = await authn.authenticate(poll.token)
  await requireRepair(store, display.id, { operatorId: 'op', now: c.now, authenticator: authn })
  await assert.rejects(authn.authenticate(poll.token))
  const start = await startPairing(store, { clientKey: 'tv-1' }, deps)
  await claimPairing(store, { code: start.code, operatorId: 'op', displayId: display.id }, deps)
  const again = await pollPairing(store, { pairingId: start.pairing_id, pollSecret: start.poll_secret }, deps)
  assert.notEqual(again.token, poll.token)
  assert.equal(again.display.id, display.id)
  assert.equal((await authn.authenticate(again.token)).display.id, display.id)
})

test('heartbeat writes at most once a minute and rotates a 30-day-old credential with a grace window', async () => {
  const { store, c, poll } = await pairOne()
  const authn = createDisplayAuthenticator(store, { now: c.now, cacheMs: 0 })
  let auth = await authn.authenticate(poll.token)
  c.advance(HEARTBEAT_WRITE_MIN_MS)
  const first = await recordHeartbeat(store, auth, { build: 'abc', render_mode: 'lite', connection: 'live' }, { now: c.now })
  assert.equal(first.written, true)
  auth = await authn.authenticate(poll.token)
  c.advance(10_000)
  const second = await recordHeartbeat(store, auth, { build: 'abc' }, { now: c.now })
  assert.equal(second.written, false, 'throttled')
  // build change writes immediately and is audited
  const third = await recordHeartbeat(store, auth, { build: 'def' }, { now: c.now })
  assert.equal(third.written, true)
  assert.ok(store._dump().audit.some((a) => a.action === 'version_changed'))
  // rotation
  c.advance(ROTATE_AFTER_MS)
  auth = await authn.authenticate(poll.token)
  const rot = await recordHeartbeat(store, auth, { build: 'def' }, { now: c.now })
  assert.ok(rot.rotated?.token && rot.rotated.token !== poll.token)
  assert.equal((await authn.authenticate(rot.rotated.token)).via, 'current')
  assert.equal((await authn.authenticate(poll.token)).via, 'previous', 'old token works during the grace window')
  c.advance(PREVIOUS_TOKEN_GRACE_MS + 1)
  await assert.rejects(authn.authenticate(poll.token), { code: 'display_token_rotated' })
})

test('operator config patches accept view fields only; remote view commands change the view only', async () => {
  const { store, c, poll } = await pairOne()
  const authn = createDisplayAuthenticator(store, { now: c.now, cacheMs: 0 })
  const { display } = await authn.authenticate(poll.token)
  const out = await updateDisplayConfig(store, display.id, { preset: 'acquisition_pulse', theme: 'true_black', privacy_mode: 'operations', send_sms: true, queue_status: 'paused', token_hash: 'x' }, { operatorId: 'op', now: c.now })
  assert.equal(out.display.config.preset, 'acquisition_pulse')
  assert.equal(out.display.config.theme, 'true_black')
  const row = store._dump().displays[0]
  assert.ok(!('send_sms' in row) && !('queue_status' in row) && !('send_sms' in (row.settings_json || {})), 'unknown keys dropped')
  assert.notEqual(row.token_hash, 'x')
  await assert.rejects(updateDisplayConfig(store, display.id, { preset: 'launch_campaign' }, { operatorId: 'op' }), { code: 'empty_patch' })
  const v = await sendViewCommand(store, display.id, { preset: 'market_intelligence', market: 'dallas-tx', hold_minutes: 20 }, { operatorId: 'op', now: c.now })
  assert.equal(v.display.view_command.market, 'dallas-tx')
  await assert.rejects(sendViewCommand(store, display.id, { market: 'DROP TABLE' }, { operatorId: 'op' }), { code: 'bad_market' })
  await assert.rejects(sendViewCommand(store, display.id, {}, { operatorId: 'op' }), { code: 'empty_command' })
  const audit = store._dump().audit.map((a) => a.action)
  for (const action of ['paired', 'connected', 'config_changed', 'view_sent']) assert.ok(audit.includes(action), action)
  assert.ok(!JSON.stringify(store._dump().audit).includes(poll.token), 'no credentials in the audit log')
})

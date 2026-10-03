/**
 * TxDOT still pass-through (INTERNAL USE, pending a TxDOT data-sharing
 * agreement): operator-gated, never cached (no-store, re-fetched every time),
 * JPEG-only and size-capped, rate-limited per operator + globally, and every
 * failure is a JSON reason — never a broken image. No network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { handleCameraSnapshotRequest } from '@/app/api/cockpit/map/cameras/[id]/snapshot/route.js'
import { decodeTxdotSnippet, parseTxdotTimestamp, TXDOT_STILL_MAX_BYTES } from '@/lib/domain/map/cameras/adapters/txdot-its.js'
import { _resetCameraMemoryStore } from '@/lib/domain/map/cameras/camera-memory-store.js'
import { _resetSnapshotCache, snapshotCacheStats } from '@/lib/domain/map/cameras/camera-media.js'
import { _resetSnapshotLimits, operatorKeyFor, PASSTHROUGH_LIMITS, takePassthroughSlot } from '@/lib/domain/map/cameras/camera-snapshot-limits.js'
import { fetchCameraSnapshot, getCamerasInView } from '@/lib/domain/map/cameras/camera-network-service.js'

const TX_DAL = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/cameras/tx_txdot_its/cctv_status_list_dal.json', import.meta.url)), 'utf8'))
const NOW = Date.parse('2026-10-03T21:30:00Z')
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 9), Buffer.from([0xff, 0xd9])])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(200, 1)])
const res = (text, status = 200) => ({ ok: status < 300, status, url: '', headers: { get: () => null }, text: async () => text })

function harness(snapshotReply) {
  _resetCameraMemoryStore()
  _resetSnapshotCache()
  _resetSnapshotLimits()
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.includes('GetCctvStatusListByDistrict?districtCode=DAL')) return res(JSON.stringify(TX_DAL))
    if (url.includes('GetCctvStatusListByDistrict')) return res(JSON.stringify({ roadwayCctvStatuses: {} }))
    if (url.includes('GetCctvSnapshotByIcdId')) return snapshotReply()
    throw new Error(`unexpected fetch ${url}`)
  }
  return { calls, deps: { store: 'memory', fetchImpl, env: {}, now: NOW } }
}
const okSnap = () => res(JSON.stringify({ icd_Id: 'IH20 @ Dallas-Tarrant CL', snippet: JPEG.toString('base64'), timestampFormatted: '10/3/2026 4:18 PM' }))
async function firstTxCamera(deps) {
  const v = await getCamerasInView({ bbox: '-97.3,32.5,-96.5,33.1', zoom: 11 }, deps)
  return v.cameras.find((c) => c.provider === 'TxDOT ITS').id
}
const req = (headers = {}) => new Request('http://localhost/api/cockpit/map/cameras/x/snapshot', { headers })

test('auth: the route refuses without the operator gate and never touches TxDOT', async () => {
  const { calls, deps } = harness(okSnap)
  const denied = new Response(JSON.stringify({ ok: false }), { status: 401 })
  const r = await handleCameraSnapshotRequest(req(), { id: 'tx_txdot_its:DAL-x' }, { ensureAuth: () => ({ ok: false, response: denied }), snapshotDeps: deps })
  assert.equal(r.status, 401)
  assert.equal(calls.length, 0)
})

test('a still streams with Cache-Control: no-store, is labelled internal, and is fetched fresh every time (no cache)', async () => {
  const { calls, deps } = harness(okSnap)
  const id = await firstTxCamera(deps)
  const ok = () => ({ ok: true })
  const a = await handleCameraSnapshotRequest(req({ authorization: 'Bearer op-1' }), { id }, { ensureAuth: ok, snapshotDeps: deps })
  assert.equal(a.status, 200)
  assert.equal(a.headers.get('content-type'), 'image/jpeg')
  assert.equal(a.headers.get('cache-control'), 'no-store')
  assert.equal(a.headers.get('x-camera-use'), 'internal')
  assert.equal(a.headers.get('x-camera-cache'), 'miss')
  assert.equal(a.headers.get('x-camera-captured-at'), '2026-10-03T21:18:00.000Z', 'CDT is UTC−5')
  assert.deepEqual(Buffer.from(await a.arrayBuffer()), JPEG)
  await handleCameraSnapshotRequest(req({ authorization: 'Bearer op-1' }), { id }, { ensureAuth: ok, snapshotDeps: deps })
  assert.equal(calls.filter((u) => u.includes('GetCctvSnapshotByIcdId')).length, 2, 'every open/refresh is a new fetch')
  assert.equal(snapshotCacheStats().entries, 0, 'nothing held in memory')
  assert.ok(calls.filter((u) => u.includes('GetCctvSnapshotByIcdId')).every((u) => u.startsWith('https://its.txdot.gov/') && u.includes('districtCode=DAL')))
})

test('size and type: oversized or non-JPEG stills are refused with a JSON reason (no-store)', async () => {
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(TXDOT_STILL_MAX_BYTES + 10)])
  assert.equal(decodeTxdotSnippet(big.toString('base64')).reason, 'image_too_large')
  assert.equal(decodeTxdotSnippet(PNG.toString('base64')).reason, 'upstream_not_a_jpeg')
  assert.equal(decodeTxdotSnippet('<<not base64>>').reason, 'still_not_base64')
  assert.equal(decodeTxdotSnippet('').reason, 'no_still_in_response')
  assert.equal(decodeTxdotSnippet(JPEG.toString('base64')).ok, true)

  const { deps } = harness(() => res(JSON.stringify({ snippet: PNG.toString('base64') })))
  const id = await firstTxCamera(deps)
  const r = await handleCameraSnapshotRequest(req(), { id }, { ensureAuth: () => ({ ok: true }), snapshotDeps: deps })
  assert.equal(r.status, 502)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.equal((await r.json()).reason, 'upstream_not_a_jpeg')
})

test('fallback: upstream error or a non-JSON answer is a reason, never an image', async () => {
  for (const [reply, reason] of [[() => res('<html>maintenance</html>'), 'upstream_not_json'], [() => res('oops', 500), 'upstream_unreachable'], [() => res(JSON.stringify([1, 2])), 'upstream_not_json'], [() => res(JSON.stringify({ snippet: null })), 'no_still_in_response']]) {
    const { deps } = harness(reply)
    const id = await firstTxCamera(deps)
    const got = await fetchCameraSnapshot(id, { ...deps, operatorKey: 'k' })
    assert.equal(got.ok, false, reason)
    assert.equal(got.reason, reason)
    assert.equal(got.no_store, true)
    assert.ok(!('bytes' in got))
  }
})

test('rate limit: per operator, then a global cap; the route says 429 with Retry-After', async () => {
  _resetSnapshotLimits()
  for (let i = 0; i < PASSTHROUGH_LIMITS.perOperator; i += 1) assert.equal(takePassthroughSlot('a', NOW + i).ok, true)
  const blocked = takePassthroughSlot('a', NOW + 100)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.scope, 'operator')
  assert.ok(blocked.retry_after_sec >= 1)
  assert.equal(takePassthroughSlot('a', NOW + PASSTHROUGH_LIMITS.windowMs + 1).ok, true, 'window slides')
  _resetSnapshotLimits()
  let n = 0
  for (let op = 0; n < PASSTHROUGH_LIMITS.global; op += 1) for (let i = 0; i < 4 && n < PASSTHROUGH_LIMITS.global; i += 1, n += 1) assert.equal(takePassthroughSlot(`op${op}`, NOW).ok, true)
  const g = takePassthroughSlot('fresh-operator', NOW)
  assert.equal(g.ok, false)
  assert.equal(g.scope, 'global')

  const { deps } = harness(okSnap)
  const id = await firstTxCamera(deps)
  const ok = () => ({ ok: true })
  let last
  for (let i = 0; i <= PASSTHROUGH_LIMITS.perOperator; i += 1) last = await handleCameraSnapshotRequest(req({ authorization: 'Bearer same-op' }), { id }, { ensureAuth: ok, snapshotDeps: deps })
  assert.equal(last.status, 429)
  assert.ok(Number(last.headers.get('retry-after')) >= 1)
  assert.equal(last.headers.get('cache-control'), 'no-store')
  assert.notEqual(operatorKeyFor(req({ authorization: 'Bearer a' })), operatorKeyFor(req({ authorization: 'Bearer b' })))
  assert.ok(!operatorKeyFor(req({ authorization: 'Bearer secret-token' })).includes('secret'))
})

test('TxDOT timestamps: district Central time, DST-aware; junk is null', () => {
  assert.equal(parseTxdotTimestamp('10/3/2026 4:18 PM'), '2026-10-03T21:18:00.000Z')
  assert.equal(parseTxdotTimestamp('1/15/2026 12:05 AM'), '2026-01-15T06:05:00.000Z')
  assert.equal(parseTxdotTimestamp('yesterday'), null)
})

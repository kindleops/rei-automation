// rc-8.5.21 blind-eval RUN-06 — the QUEUE RUNNER judges a touch on the SAME recipient evidence the
// recipient-window scheduler planned it with, mailing included. The defect: the scheduler refused a
// campaign touch at 08:30 ET for an NY-area-code seller with a Seattle (WA) mailing address (next
// permitted 11:00 ET, the ET ∩ PT intersection) while the dispatcher allowed it — the runner never
// passed mailing geography and unstamped campaign rows carry only area-code and property zones.
//
// Grid: 48 h of quarter-hours × profiles (incl. NY area code + WA mailing) × campaign / follow-up. At
// every instant the scheduler verdict equals BOTH runner verdicts, through the functions the runner
// really calls:
//   pre-claim  loadRunnableSendQueueRows (shouldRunSendQueueRow → preclaim validity → evaluateDispatchWindow,
//              mailing loaded from properties.owner_address_state by the runner itself)
//   pre-send   processSendQueueItem (its own mailing read → evaluateDispatchWindow); a row carrying
//              provider-SID evidence stops at the idempotency guard right after the window branch, so a
//              window pass is proven without any provider call
// for (a) an UNSTAMPED legacy campaign row exactly as the campaign writer used to produce it, and (b) the
// same row through the canonical writer's recipient-zone stamp (stampRecipientWindowEvidence).
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadRunnableSendQueueRows, normalizeSendQueueRow, stampRecipientWindowEvidence, evaluateRecipientWindowForEntry } from '../../src/lib/supabase/sms-engine.js'
import { processSendQueueItem } from '../../src/lib/domain/queue/process-send-queue.js'
import { resolveRecipientWindowZones, evaluateMessagingWindow, MESSAGING_CATEGORIES } from '../../src/lib/domain/queue/recipient-window-policy.js'

const START = Date.parse('2026-10-19T04:00:00.000Z') // 00:00 ET Monday
const INSTANTS = Array.from({ length: 192 }, (_, i) => START + i * 15 * 60_000)
const iso = (ms) => new Date(ms).toISOString()
const SENDER = '+15005550001'

const PROFILES = [
  { name: 'NY area code + WA (Seattle) mailing + NY property', phone: '+12125550123', property: { state: 'NY', zip: '10001' }, mailing: { state: 'WA', zip: null }, timezone: 'America/New_York' },
  { name: 'NY area code + WA mailing + CA property', phone: '+12125550124', property: { state: 'CA', zip: '94110' }, mailing: { state: 'WA', zip: null }, timezone: 'America/Los_Angeles' },
  { name: 'PT area code + FL mailing + TX property', phone: '+14155550125', property: { state: 'TX', zip: '75201' }, mailing: { state: 'FL', zip: null }, timezone: 'America/Chicago' },
  { name: 'non-geographic phone + AZ mailing + CO property', phone: '+15005550126', property: { state: 'CO', zip: '80202' }, mailing: { state: 'AZ', zip: null }, timezone: 'America/Denver' },
  { name: 'local CT seller + TX mailing', phone: '+12145550127', property: { state: 'TX', zip: '75201' }, mailing: { state: 'TX', zip: null }, timezone: 'America/Chicago' },
  { name: 'NY area code, no mailing on file (control)', phone: '+12125550128', property: { state: 'NY', zip: '10001' }, mailing: null, timezone: 'America/New_York' },
]

/** THE scheduler verdict: the recipient-window policy over the full evidence (phone, mailing, property). */
function schedulerAllows(p, kind, at) {
  const r = resolveRecipientWindowZones({ recipientPhone: p.phone, mailingGeography: p.mailing, propertyGeography: p.property })
  const category = kind === 'campaign' ? MESSAGING_CATEGORIES.CAMPAIGN : MESSAGING_CATEGORIES.SCHEDULED_FOLLOWUP
  const v = evaluateMessagingWindow({ category, at, zones: r.zones, jurisdictions: r.jurisdictions })
  // the plan-time entry point (the campaign feeder's check) answers the same
  const entry = evaluateRecipientWindowForEntry({ entry: kind, recipient_phone: p.phone, timezone: p.timezone, property_geography: p.property, mailing_geography: p.mailing, now: iso(at) })
  assert.equal(Boolean(entry.allowed), Boolean(v.lawful), `entry point vs policy ${p.name} ${kind} ${iso(at)}`)
  return Boolean(v.lawful)
}

/** A row as the campaign writer produced it BEFORE the stamp: area code + property zone + stored zone only. */
function legacyRow(p, kind, i) {
  const id = `rw-${kind}-${i}`
  const base = {
    id, queue_key: kind === 'campaign' ? `campaign:c1:${id}` : `acq-followup:${id}:s2`, queue_id: id,
    queue_status: 'queued', type: kind === 'campaign' ? 'campaign' : 'followup', message_type: kind === 'campaign' ? 'Cold Outbound' : 'Follow-Up',
    timezone: p.timezone, created_at: iso(START - 3_600_000), scheduled_for: iso(START - 3_600_000), scheduled_for_utc: iso(START - 3_600_000),
    to_phone_number: p.phone, from_phone_number: SENDER, thread_key: p.phone, seller_first_name: 'Rosa',
    template_id: '3001', selected_template_id: '3001', message_body: 'Hi Rosa, this is Helen. Do you still own the house on Oak St?',
    property_id: `prop-${i}`, property_address_state: p.property.state, property_address_zip: p.property.zip, master_owner_id: `mo-${i}`,
    retry_count: 0, max_retries: 3,
  }
  return {
    ...base,
    metadata: kind === 'campaign'
      ? { source: 'campaign', send_kind: 'campaign', campaign_target_id: `ct-${i}`, candidate_snapshot: { touch_number: 1, seller_first_name: 'Rosa', property_address_zip: p.property.zip } }
      : { source: 'seller_followup_scheduler', followup_reason: 's2_no_answer_24h', candidate_snapshot: { seller_first_name: 'Rosa' } },
  }
}

/** A minimal supabase: send_queue rows for the loader, properties (geography + the owner's mailing state). */
function fakeSupabase({ rows = [], properties = new Map() } = {}) {
  const reads = []
  return {
    reads,
    from(table) {
      const st = { table, cols: '', ids: null }
      const q = {
        select(cols) { st.cols = String(cols || ''); return q },
        in(field, values) { if (field === 'property_id') st.ids = values; return q },
        not() { return q }, order() { return q }, eq() { return q },
        limit() { return Promise.resolve({ data: table === 'send_queue' ? rows.map((r) => normalizeSendQueueRow(r)) : [], error: null }) },
        then(res, rej) {
          if (table !== 'properties') return Promise.reject(new Error(`unexpected_table:${table}`)).then(res, rej)
          reads.push(st.cols)
          const data = (st.ids || []).map((id) => properties.get(id)).filter(Boolean).map((p) => ({
            property_id: p.property_id, property_address_state: p.state, property_address_zip: p.zip, ...(st.cols.includes('owner_address_state') ? { owner_address_state: p.owner_address_state } : {}),
          }))
          return Promise.resolve({ data, error: null }).then(res, rej)
        },
        update() { return { or() { return this }, eq() { return this }, lt() { return { select: async () => ({ data: [], error: null }) } } } },
      }
      return q
    },
  }
}

const propsFor = (p, i, { mailingOnFile = true } = {}) => new Map([[`prop-${i}`, { property_id: `prop-${i}`, state: p.property.state, zip: p.property.zip, owner_address_state: mailingOnFile ? p.mailing?.state || null : null }]])

async function preclaimAllows(row, supabase, at) {
  const r = await loadRunnableSendQueueRows(10, { now: iso(at), stale_lock_recovery_enabled: false, supabaseClient: supabase, getSystemValue: async () => null, pauseInvalidQueueRow: async (n, x) => ({ ...n, ...x }), warn: () => {} })
  const runnable = r.rows.some((x) => x.id === row.id)
  if (!runnable) {
    const s = r.skipped.find((x) => x.id === row.id)
    assert.ok(s && /window|timezone/.test(String(s.reason)), `pre-claim refused ${row.id} for a non-window reason: ${JSON.stringify(s?.reason)} (${r.skipped.map((x) => x.reason).join(',')})`)
  }
  return runnable
}

async function presendAllows(row, supabase, at) {
  // provider-SID evidence stops the row at the idempotency guard right after the window branch: a window
  // pass is proven with zero provider calls
  const claimed = normalizeSendQueueRow({ ...row, queue_status: 'processing', is_locked: true, lock_token: 'lock-rw', metadata: { ...row.metadata, provider_message_sid: 'SMevidence-rw' } })
  let provider_calls = 0
  const out = await processSendQueueItem(claimed, {
    now: iso(at), claimedLockToken: 'lock-rw',
    getSystemValue: async (key) => (key === 'queue_processor_mode' ? 'live' : key === 'queue_execution_mode' ? 'normal' : null),
    loadOutboundNumberByPhone: async (phone_number) => ({ id: `fleet-${phone_number}`, phone_number, status: 'active', health_state: 'unverified', daily_limit: 800, messages_sent_today: 0 }),
    loadCampaignStatus: async () => 'active',
    updateQueueRow: async (id, payload) => ({ ok: true, id, payload }),
    updateSendQueueRowWithLock: async (id, _lock, payload) => normalizeSendQueueRow({ ...claimed, id, ...payload }),
    sendTextgridSMS: async () => { provider_calls += 1; return { sid: 'SM_must_never_send' } },
    runSendTimeContactGuard: async () => ({ blocked: false }),
    info: () => {}, warn: () => {},
    supabase,
  })
  assert.equal(provider_calls, 0)
  if (out.reason === 'deferred_contact_window') return false
  assert.equal(out.reason, 'idempotency_blocked_sid_exists', `pre-send stopped ${row.id} before/after the window for another reason: ${out.reason}`)
  return true
}

async function quiet(fn) {
  const log = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = log }
}

test('RUN-06: the defect instant — NY area code + WA mailing, campaign at 08:30 ET: the scheduler refuses (next 11:00 ET) and so do the runner\'s pre-claim and pre-send checks, for an UNSTAMPED legacy row', async () => {
  const p = PROFILES[0]
  const at = Date.parse('2026-10-19T12:30:00.000Z') // 08:30 EDT = 05:30 PDT
  assert.equal(schedulerAllows(p, 'campaign', at), false)
  const row = legacyRow(p, 'campaign', 0)
  assert.equal(row.metadata.recipient_zones, undefined, 'unstamped')
  const sb = fakeSupabase({ rows: [row], properties: propsFor(p, 0) })
  assert.equal(await quiet(() => preclaimAllows(row, sb, at)), false)
  assert.equal(await quiet(() => presendAllows(row, sb, at)), false)
  assert.ok(sb.reads.some((c) => c.includes('owner_address_state')), 'the runner read the owner mailing state itself')
  // 11:00 ET = 08:00 PT: the intersection opens; every layer agrees
  const open = Date.parse('2026-10-19T15:00:00.000Z')
  assert.equal(schedulerAllows(p, 'campaign', open), true)
  assert.equal(await quiet(() => preclaimAllows(row, sb, open)), true)
  assert.equal(await quiet(() => presendAllows(row, sb, open)), true)
})

test('RUN-06: the canonical writer stamps recipient evidence (phone + mailing) on the row; nothing at all ⇒ no stamp (the dispatcher still holds)', () => {
  const p = PROFILES[0]
  const row = legacyRow(p, 'campaign', 1)
  row.metadata.candidate_snapshot.owner_address_state = 'WA'
  const m = stampRecipientWindowEvidence(row)
  assert.deepEqual([...m.recipient_zones].sort(), ['America/Los_Angeles', 'America/New_York'])
  assert.equal(m.recipient_zone_certainty, 'multiple')
  assert.equal(m.recipient_zone_policy, 'recipient-window.v1')
  // an evidence-less row (non-geographic phone, no property, no mailing, no stored zone) is never stamped
  const bare = { to_phone_number: '+15005550199', metadata: {} }
  assert.equal(stampRecipientWindowEvidence(bare).recipient_zones, undefined)
})

for (const kind of ['campaign', 'followup']) {
  test(`RUN-06 grid (${kind}): scheduler == runner pre-claim == runner pre-send at every quarter-hour over 48 h × ${PROFILES.length} profiles, for the unstamped legacy row AND the writer-stamped row`, async () => {
    let compared = 0
    const mismatches = []
    await quiet(async () => {
      for (const [pi, p] of PROFILES.entries()) {
        const legacy = legacyRow(p, kind, pi)
        // (a) legacy, unstamped: the runner must load the mailing evidence itself
        const sbLegacy = fakeSupabase({ rows: [legacy], properties: propsFor(p, pi) })
        // (b) stamped by the canonical writer from the row's own evidence (the snapshot carries the mailing
        //     state); the properties table no longer has it, so only the stamp can carry it
        const stampedRow = { ...legacy, metadata: { ...legacy.metadata, candidate_snapshot: { ...legacy.metadata.candidate_snapshot, owner_address_state: p.mailing?.state || null } } }
        stampedRow.metadata = stampRecipientWindowEvidence(stampedRow)
        const sbStamped = fakeSupabase({ rows: [stampedRow], properties: propsFor(p, pi, { mailingOnFile: false }) })
        for (const at of INSTANTS) {
          const want = schedulerAllows(p, kind, at)
          const got = [
            ['legacy_preclaim', await preclaimAllows(legacy, sbLegacy, at)],
            ['legacy_presend', await presendAllows(legacy, sbLegacy, at)],
            ['stamped_preclaim', await preclaimAllows(stampedRow, sbStamped, at)],
            ['stamped_presend', await presendAllows(stampedRow, sbStamped, at)],
          ]
          for (const [path, v] of got) {
            compared += 1
            if (v !== want) mismatches.push([p.name, path, iso(at), want, v])
          }
        }
      }
    })
    assert.equal(mismatches.length, 0, JSON.stringify(mismatches.slice(0, 6)))
    assert.equal(compared, PROFILES.length * INSTANTS.length * 4)
    console.log(`runner grid (${kind}): ${compared} comparisons, 0 mismatches`)
  })
}

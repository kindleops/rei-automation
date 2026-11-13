// rc-8.5.21 FINAL directive, phase 2 — TIMEZONE CONSISTENCY ACROSS ALL FOUR SURFACES.
// The campaign feeder (plan-time check AND next-schedulable), the scheduler / delay planner, the queue
// materializer (follow-up lifecycle) and the final dispatcher must call THE recipient-window policy with
// the SAME evidence and reach the SAME verdict. Evidence precedence (recipient evidence first): verified
// timezone > current mailing / residential > location history > area code > property (narrowing only).
// Conflicting evidence ⇒ the conservative policy (the window must be open in EVERY plausible zone), never
// the earlier send.
//
// Matrix: scenario × instant × message kind, each surface fed the identical evidence through its own
// production entry point:
//   feeder       evaluateRecipientWindowForEntry (plan) + computeNextSchedulableTime (next)
//   scheduler    evaluateReplyTiming (category verdict) + planReplyDelay (reply delay planner)
//   materializer withLifecycleHelpers().recipientZones/lawful + planSendInstant (the follow-up send instant)
//   dispatcher   evaluateContactWindow / evaluateDispatchWindow on the row the writer produces — both the
//                unstamped row (evidence re-read) and the row stamped by the canonical writer
// Scenarios: DST fall back (2026-11-01) and spring forward (2027-03-14); conflicting mailing vs area code;
// unknown zone (property only) and no evidence at all; campaign schedule rollover past the window end;
// a late-night active conversation (category 1 allowed at any hour); a nurture and a campaign at the same
// instant (both deferred to the same open). Zero mismatches.
import test from 'node:test'
import assert from 'node:assert/strict'

import { computeNextSchedulableTime } from '../../src/lib/domain/outbound/supabase-candidate-feeder.js'
import { evaluateContactWindow, evaluateDispatchWindow, evaluateRecipientWindowForEntry, stampRecipientWindowEvidence } from '../../src/lib/supabase/sms-engine.js'
import { evaluateReplyTiming, resolveRecipientZones } from '../../src/lib/domain/queue/reply-timing.js'
import { planReplyDelay } from '../../src/lib/domain/conversation-ai/turns/delay-planner.js'
import { planSendInstant, withLifecycleHelpers } from '../../src/lib/domain/followups/followup-lifecycle.js'
import { resolveRecipientWindowZones } from '../../src/lib/domain/queue/recipient-window-policy.js'

const Q = 15 * 60_000
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()
const grid = (startIso, hours, step = Q) => Array.from({ length: Math.round((hours * 3_600_000) / step) }, (_, i) => Date.parse(startIso) + i * step)
const localHM = (ms, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms))

// ── the identical evidence every surface receives ──────────────────────────────────────────────────
// { phone, mailing, property, storedTimezone, verifiedTimezone, locationHistory }
const SCENARIOS = [
  // DST: Chicago / New York / Los Angeles sellers, and Arizona (no DST) against a Central property
  { id: 'dst_fall_back_ct', window: ['2026-10-31T00:00:00.000Z', 72], e: { phone: '+13125550101', property: { state: 'IL', zip: '60601' }, storedTimezone: 'America/Chicago' } },
  { id: 'dst_fall_back_et_pt_mailing', window: ['2026-10-31T00:00:00.000Z', 72], e: { phone: '+12125550102', mailing: { state: 'WA' }, property: { state: 'NY', zip: '10001' }, storedTimezone: 'America/New_York' } },
  { id: 'dst_fall_back_az_phone_ct_property', window: ['2026-10-31T00:00:00.000Z', 72], e: { phone: '+16025550103', property: { state: 'TX', zip: '75201' }, storedTimezone: 'America/Chicago' } },
  { id: 'dst_spring_forward_ct', window: ['2027-03-13T00:00:00.000Z', 72], e: { phone: '+13125550104', property: { state: 'IL', zip: '60601' }, storedTimezone: 'America/Chicago' } },
  { id: 'dst_spring_forward_pt_et_mailing', window: ['2027-03-13T00:00:00.000Z', 72], e: { phone: '+14155550105', mailing: { state: 'FL' }, property: { state: 'CA', zip: '94110' }, storedTimezone: 'America/Los_Angeles' } },
  { id: 'dst_spring_forward_az', window: ['2027-03-13T00:00:00.000Z', 72], e: { phone: '+14805550106', property: { state: 'AZ', zip: '85004' }, storedTimezone: 'America/Phoenix' } },
  // conflicting mailing vs area code (both directions) — the intersection, never the earlier send
  { id: 'conflict_ct_phone_wa_mailing', window: ['2026-10-20T04:00:00.000Z', 48], e: { phone: '+13125550107', mailing: { state: 'WA' }, property: { state: 'IL', zip: '60601' }, storedTimezone: 'America/Chicago' } },
  { id: 'conflict_pt_phone_ny_mailing', window: ['2026-10-20T04:00:00.000Z', 48], e: { phone: '+12065550108', mailing: { state: 'NY' }, property: { state: 'WA', zip: '98101' }, storedTimezone: 'America/Los_Angeles' } },
  // the precedence inputs: a verified timezone / location history are recipient evidence too (conservative union)
  { id: 'verified_tz_conflicts_area_code', window: ['2026-10-20T04:00:00.000Z', 48], e: { phone: '+13125550109', verifiedTimezone: 'America/Los_Angeles', property: { state: 'IL', zip: '60601' } } },
  { id: 'location_history_conflicts_area_code', window: ['2026-10-20T04:00:00.000Z', 48], e: { phone: '+16175550110', locationHistory: ['America/Denver'], property: { state: 'MA', zip: '02108' } } },
  // unknown zone: a non-geographic phone with a property (narrowing only ⇒ the conservative intersection)
  { id: 'unknown_nongeo_phone_tx_property', window: ['2026-10-20T04:00:00.000Z', 48], e: { phone: '+15005550111', property: { state: 'TX', zip: '75201' }, storedTimezone: 'America/Chicago' } },
  { id: 'unknown_nongeo_phone_no_property', window: ['2026-10-20T04:00:00.000Z', 48], e: { phone: '+15005550112' } },
  // nothing at all places the recipient ⇒ every surface holds
  { id: 'no_evidence', window: ['2026-10-20T04:00:00.000Z', 24], e: { phone: null }, noEvidence: true },
]

// campaign rollover past the window end: the minutes around 21:00 local (and well past it)
const ROLLOVER = [
  { id: 'rollover_ct', tz: 'America/Chicago', e: { phone: '+13125550120', property: { state: 'IL', zip: '60601' } }, day: '2026-10-21' },
  { id: 'rollover_et_pt_mailing', tz: 'America/New_York', e: { phone: '+12125550121', mailing: { state: 'CA' }, property: { state: 'NY', zip: '10001' } }, day: '2026-10-21' },
  { id: 'rollover_dst_eve_ct', tz: 'America/Chicago', e: { phone: '+13125550122', property: { state: 'IL', zip: '60601' } }, day: '2026-10-31' },
]

// ── surface adapters (production entry points) ─────────────────────────────────────────────────────
const metaOf = (e) => ({
  ...(e.verifiedTimezone ? { recipient_verified_timezone: e.verifiedTimezone } : {}),
  ...(e.locationHistory ? { recipient_location_history_zones: e.locationHistory } : {}),
})
const entryArgs = (e) => ({
  recipient_phone: e.phone || null, timezone: e.storedTimezone || null,
  property_geography: e.property || null, mailing_geography: e.mailing ? { state: e.mailing.state, zip: null } : null,
  metadata: metaOf(e),
})
const evidence = (e) => ({ recipientPhone: e.phone || null, propertyGeography: e.property || null, mailingGeography: e.mailing ? { state: e.mailing.state, zip: null } : null, storedTimezone: e.storedTimezone || null, verifiedTimezone: e.verifiedTimezone || null, locationHistory: e.locationHistory || null })
const candidateOf = (e) => ({ canonical_e164: e.phone || null, timezone: e.storedTimezone || null, property_address_state: e.property?.state || null, property_zip: e.property?.zip || null, owner_address_state: e.mailing?.state || null, ...metaOf(e) })

/** The row the canonical writer produces for this touch (kind campaign | nurture), unstamped. */
function rowOf(e, kind, at) {
  return {
    to_phone_number: e.phone || null, timezone: e.storedTimezone || null,
    property_address_state: e.property?.state || null, property_address_zip: e.property?.zip || null,
    owner_address_state: e.mailing?.state || null,
    scheduled_for: iso(at), scheduled_for_utc: iso(at), created_at: iso(at),
    type: kind === 'campaign' ? 'campaign' : 'followup',
    metadata: { ...metaOf(e), send_kind: kind === 'campaign' ? 'campaign' : 'followup', ...(kind === 'nurture' ? { followup_intent_id: 'fi-1' } : { campaign_target_id: 'ct-1' }) },
  }
}

const SURFACES = {
  feederPlan: (e, at) => {
    const v = evaluateRecipientWindowForEntry({ entry: 'campaign', ...entryArgs(e), scheduled_for: iso(at), now: iso(at) }, { now: iso(at) })
    return { allowed: v.allowed === true, hold: v.hold === true, next: v.allowed ? iso(at) : v.next_open_at || null }
  },
  feederNext: (e, at) => computeNextSchedulableTime(candidateOf(e), iso(at)),
  scheduler: (e, at, kind) => {
    const r = resolveRecipientZones(evidence(e))
    const v = evaluateReplyTiming({ purpose: kind === 'campaign' ? 'campaign' : 'followup', at: iso(at), zones: r.zones, jurisdictions: r.jurisdictions })
    return { allowed: r.has_evidence !== false && v.lawful, hold: r.has_evidence === false, next: r.has_evidence === false ? null : v.next_permitted_at }
  },
  materializer: async (e, at) => {
    const deps = await withLifecycleHelpers({})
    const r = deps.recipientZones({ row: rowOf(e, 'nurture', at), propertyGeography: e.property || null, mailingGeography: e.mailing ? { state: e.mailing.state, zip: null } : null })
    if (!r.zones.length || r.has_evidence === false) return { allowed: false, hold: true, next: null }
    const w = deps.lawful(iso(at), r.zones, { jurisdictions: r.jurisdictions || [] })
    const when = planSendInstant({ due: at, now: at, zones: r.zones, others: [], lawful: (a, z) => deps.lawful(a, z, { jurisdictions: r.jurisdictions || [] }) })
    return { allowed: w.lawful, hold: !when.ok, next: when.ok ? when.at : null }
  },
  dispatcher: (e, at, kind) => {
    const v = evaluateContactWindow(rowOf(e, kind, at), { now: iso(at), mailingGeography: e.mailing ? { state: e.mailing.state, zip: null } : null, propertyGeography: e.property || null })
    return { allowed: v.allowed === true, hold: v.hold === true, next: v.allowed ? iso(at) : v.next_open_at || null }
  },
  dispatcherStamped: (e, at, kind) => {
    const row = rowOf(e, kind, at)
    const stamped = { ...row, metadata: stampRecipientWindowEvidence(row) }
    const v = evaluateContactWindow(stamped, { now: iso(at) })
    return { allowed: v.allowed === true, hold: v.hold === true, next: v.allowed ? iso(at) : v.next_open_at || null }
  },
}

/** One instant, one kind: every surface's verdict; returns the list of disagreements. */
async function compare(e, at, kind) {
  const out = {
    scheduler: SURFACES.scheduler(e, at, kind),
    dispatcher: SURFACES.dispatcher(e, at, kind),
    dispatcherStamped: SURFACES.dispatcherStamped(e, at, kind),
  }
  if (kind === 'campaign') {
    out.feederPlan = SURFACES.feederPlan(e, at)
    const n = SURFACES.feederNext(e, at)
    // nothing places the recipient ⇒ the feeder returns `now` and the dispatcher holds the row
    out.feederNext = { next: out.dispatcher.hold ? null : n }
  } else {
    out.materializer = await SURFACES.materializer(e, at)
  }
  const ref = out.dispatcher
  const bad = []
  for (const [name, v] of Object.entries(out)) {
    if ('allowed' in v && v.allowed !== ref.allowed) bad.push({ name, field: 'allowed', got: v.allowed, want: ref.allowed })
    if ('hold' in v && v.hold !== ref.hold) bad.push({ name, field: 'hold', got: v.hold, want: ref.hold })
    if ((v.next || null) !== (ref.next || null)) bad.push({ name, field: 'next', got: v.next || null, want: ref.next || null })
  }
  // the next instant itself is lawful at the dispatcher, and is the EARLIEST (one minute before is not)
  if (ref.next && !ref.hold) {
    const nx = Date.parse(ref.next)
    if (!SURFACES.dispatcher(e, nx, kind).allowed) bad.push({ name: 'dispatcher@next', field: 'allowed', got: false, want: true })
    if (nx > at && SURFACES.dispatcher(e, nx - MIN, kind).allowed) bad.push({ name: 'dispatcher@next-1m', field: 'allowed', got: true, want: false })
  }
  return { out, bad }
}

const counts = { comparisons: 0, mismatches: 0, by_scenario: {} }

test('phase 2 matrix: DST, conflicts, verified / location evidence, unknown and no evidence — feeder, scheduler, materializer and dispatcher agree at every quarter-hour (campaign + nurture)', async () => {
  const mismatches = []
  for (const s of SCENARIOS) {
    let n = 0
    for (const at of grid(...s.window)) {
      for (const kind of ['campaign', 'nurture']) {
        const { out, bad } = await compare(s.e, at, kind)
        n += Object.keys(out).length
        if (s.noEvidence) assert.equal(out.dispatcher.hold, true, `${s.id}: nothing places the recipient ⇒ hold`)
        for (const b of bad) mismatches.push({ scenario: s.id, kind, at: iso(at), ...b })
      }
    }
    counts.by_scenario[s.id] = n
    counts.comparisons += n
  }
  counts.mismatches += mismatches.length
  assert.deepEqual(mismatches.slice(0, 8), [], `${mismatches.length} mismatches`)
})

test('phase 2 matrix: DST transitions are honoured by wall clock — the window opens at 08:00 local on both sides of 2026-11-01 and 2027-03-14 (never a fixed UTC offset)', () => {
  const cases = [
    ['+13125550101', 'America/Chicago', '2026-10-31', '2026-10-31T13:00:00.000Z'], // CDT
    ['+13125550101', 'America/Chicago', '2026-11-01', '2026-11-01T14:00:00.000Z'], // CST (fall back)
    ['+13125550104', 'America/Chicago', '2027-03-13', '2027-03-13T14:00:00.000Z'], // CST
    ['+13125550104', 'America/Chicago', '2027-03-14', '2027-03-14T13:00:00.000Z'], // CDT (spring forward)
    ['+14805550106', 'America/Phoenix', '2027-03-14', '2027-03-14T15:00:00.000Z'], // Arizona: no DST
  ]
  for (const [phone, tz, day, open] of cases) {
    const e = { phone, property: null }
    const from = Date.parse(`${day}T06:00:00.000Z`)
    const want = open
    assert.equal(SURFACES.dispatcher(e, from, 'nurture').next, want, `dispatcher ${tz} ${day}`)
    assert.equal(SURFACES.feederNext(e, from), want, `feeder ${tz} ${day}`)
    assert.equal(SURFACES.scheduler(e, from, 'nurture').next, want, `scheduler ${tz} ${day}`)
    assert.equal(localHM(Date.parse(want), tz), '08:00')
    counts.comparisons += 3
  }
})

test('phase 2 matrix: campaign schedule rollover past the window end — 20:45 / 20:59 / 21:00 / 23:59 local roll to the next 08:00 open of the intersection on every surface', async () => {
  const mismatches = []
  for (const r of ROLLOVER) {
    for (const hm of ['20:45', '20:59', '21:00', '21:01', '23:59']) {
      // the UTC instant of `hm` local on r.day
      let at = Date.parse(`${r.day}T00:00:00.000Z`)
      for (let i = 0; i < 48 * 60 && localHM(at, r.tz) !== hm; i += 1) at += MIN
      for (const kind of ['campaign', 'nurture']) {
        const { out, bad } = await compare(r.e, at, kind)
        counts.comparisons += Object.keys(out).length
        for (const b of bad) mismatches.push({ scenario: r.id, hm, kind, ...b })
        if (hm !== '20:45' && hm !== '20:59') {
          assert.equal(out.dispatcher.allowed, false, `${r.id} ${hm}: outside the window`)
          const next = Date.parse(out.dispatcher.next)
          assert.ok(next > at && next - at <= 15 * 3_600_000, `${r.id} ${hm}: rolls to the next morning (${out.dispatcher.next})`)
          assert.equal(localHM(next, r.e.mailing ? 'America/Los_Angeles' : r.tz), '08:00', `${r.id} ${hm}: opens 08:00 in the latest zone`)
        }
      }
    }
  }
  counts.mismatches += mismatches.length
  assert.deepEqual(mismatches, [])
})

test('phase 2 matrix: a late-night ACTIVE conversation (category 1) — feeder entry, scheduler, delay planner and dispatcher all allow a reply at 23:30 local; out of session the same reply is deferred to the same open', () => {
  const sellers = [
    { phone: '+13125550130', property: { state: 'IL', zip: '60601' }, storedTimezone: 'America/Chicago', tz: 'America/Chicago' },
    { phone: '+12125550131', mailing: { state: 'WA' }, property: { state: 'NY', zip: '10001' }, tz: 'America/New_York' },
    { phone: '+15005550132', property: { state: 'TX', zip: '75201' }, tz: 'America/Chicago' },
  ]
  const mismatches = []
  for (const s of sellers) {
    for (const day of ['2026-10-20', '2026-11-01', '2027-03-14']) {
      let inbound = Date.parse(`${day}T00:00:00.000Z`)
      for (let i = 0; i < 48 * 60 && localHM(inbound, s.tz) !== '23:30'; i += 1) inbound += MIN
      for (const [label, ageMin, inSession] of [['in_session', 4, true], ['out_of_session', 180, false]]) {
        const inAt = inbound - (ageMin - 4) * MIN
        const at = inAt + ageMin * MIN
        const replyRow = {
          to_phone_number: s.phone, timezone: s.storedTimezone || null, property_address_state: s.property?.state || null, property_address_zip: s.property?.zip || null, owner_address_state: s.mailing?.state || null,
          created_at: iso(at), scheduled_for: iso(at), type: 'auto_reply',
          metadata: { type: 'reply', inbound_message_event_id: 'in-1', inbound_received_at: iso(inAt), conversational_reply: { queued_at: iso(at) } },
        }
        const disp = evaluateDispatchWindow(replyRow, { now: iso(at), mailingGeography: s.mailing ? { state: s.mailing.state, zip: null } : null })
        const entry = evaluateRecipientWindowForEntry({ entry: 'reply', ...entryArgs(s), inbound_message_event_id: 'in-1', inbound_received_at: iso(inAt), now: iso(at) })
        const r = resolveRecipientZones(evidence(s))
        const timing = evaluateReplyTiming({ purpose: 'reply', at: iso(at), queuedAt: iso(at), inboundId: 'in-1', inboundAt: iso(inAt), zones: r.zones, jurisdictions: r.jurisdictions })
        counts.comparisons += 3
        if (disp.allowed !== inSession) mismatches.push({ s: s.phone, day, label, surface: 'dispatcher', got: disp.allowed })
        if (entry.allowed !== inSession) mismatches.push({ s: s.phone, day, label, surface: 'feeder_entry', got: entry.allowed })
        if (timing.lawful !== inSession) mismatches.push({ s: s.phone, day, label, surface: 'scheduler', got: timing.lawful })
        // the delay planner, planning this reply right after the inbound
        const plan = planReplyDelay({ seed: `t-${s.phone}-${day}`, now: iso(inAt + 60_000), lastInboundAt: iso(inAt), inboundId: 'in-1', recipientZones: r, policy: {} })
        counts.comparisons += 1
        if (plan.action !== 'schedule') mismatches.push({ s: s.phone, day, label, surface: 'delay_planner', got: plan.action })
        else {
          const due = Date.parse(plan.due_at)
          const dueRow = { ...replyRow, created_at: plan.due_at, scheduled_for: plan.due_at, metadata: { ...replyRow.metadata, conversational_reply: { queued_at: plan.due_at } } }
          const atDue = evaluateDispatchWindow(dueRow, { now: plan.due_at, mailingGeography: s.mailing ? { state: s.mailing.state, zip: null } : null })
          counts.comparisons += 1
          if (!atDue.allowed) mismatches.push({ s: s.phone, day, label, surface: 'dispatcher@planner_due', due: plan.due_at })
          if (plan.window.deferred) {
            // deferred: never before the dispatcher's own next open for the same evidence
            const open = Date.parse(evaluateContactWindow({ ...replyRow, type: 'followup', metadata: {} }, { now: iso(inAt + 60_000), mailingGeography: s.mailing ? { state: s.mailing.state, zip: null } : null }).next_open_at || '')
            if (!(due >= open)) mismatches.push({ s: s.phone, day, label, surface: 'delay_planner_before_open', due: plan.due_at, open: iso(open) })
          }
        }
      }
    }
  }
  counts.mismatches += mismatches.length
  assert.deepEqual(mismatches, [])
})

test('phase 2 matrix: a NURTURE and a CAMPAIGN touch at the same out-of-window instant are both deferred, to the SAME next open, on every surface', async () => {
  const mismatches = []
  for (const s of [SCENARIOS[0], SCENARIOS[1], SCENARIOS[6], SCENARIOS[10]]) {
    for (const hm of ['22:00', '06:30', '07:59']) {
      const tz = s.e.mailing?.state === 'WA' ? 'America/Los_Angeles' : 'America/Chicago'
      let at = Date.parse('2026-10-22T00:00:00.000Z')
      for (let i = 0; i < 48 * 60 && localHM(at, tz) !== hm; i += 1) at += MIN
      const c = await compare(s.e, at, 'campaign')
      const n = await compare(s.e, at, 'nurture')
      counts.comparisons += Object.keys(c.out).length + Object.keys(n.out).length
      for (const b of [...c.bad, ...n.bad]) mismatches.push({ s: s.id, hm, ...b })
      if (c.out.dispatcher.allowed || n.out.dispatcher.allowed) mismatches.push({ s: s.id, hm, why: 'not_deferred' })
      if (c.out.dispatcher.next !== n.out.dispatcher.next) mismatches.push({ s: s.id, hm, why: 'different_next', campaign: c.out.dispatcher.next, nurture: n.out.dispatcher.next })
      if (c.out.feederNext.next !== n.out.materializer.next) mismatches.push({ s: s.id, hm, why: 'feeder_vs_materializer', feeder: c.out.feederNext.next, materializer: n.out.materializer.next })
    }
  }
  counts.mismatches += mismatches.length
  assert.deepEqual(mismatches, [])
})

test('phase 2 matrix: evidence precedence — verified timezone > mailing > location history > area code name the primary zone; the property only narrows; every conflict is the intersection', () => {
  const r1 = resolveRecipientWindowZones({ recipientPhone: '+13125550140', verifiedTimezone: 'America/Los_Angeles', mailingGeography: { state: 'NY', zip: null }, locationHistory: ['America/Denver'], propertyGeography: { state: 'IL', zip: '60601' } })
  assert.equal(r1.primary_zone, 'America/Los_Angeles', 'verified timezone first')
  assert.deepEqual([...r1.zones].sort(), ['America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/New_York'].sort(), 'every plausible zone: the intersection')
  const r2 = resolveRecipientWindowZones({ recipientPhone: '+13125550140', mailingGeography: { state: 'NY', zip: null }, locationHistory: ['America/Denver'] })
  assert.equal(r2.primary_zone, 'America/New_York', 'mailing before location history and the area code')
  const r3 = resolveRecipientWindowZones({ recipientPhone: '+13125550140', locationHistory: ['America/Denver'] })
  assert.equal(r3.primary_zone, 'America/Denver', 'location history before the area code')
  const r4 = resolveRecipientWindowZones({ recipientPhone: '+15005550140', propertyGeography: { state: 'IL', zip: '60601' } })
  assert.equal(r4.certainty, 'unknown', 'the property never makes the zone known')
  assert.equal(r4.primary_zone, null)
  counts.comparisons += 4
})

test('phase 2 matrix: totals', () => {
  console.log(`timezone cross-surface matrix: ${counts.comparisons} comparisons, ${counts.mismatches} mismatches; by scenario ${JSON.stringify(counts.by_scenario)}`)
  assert.ok(counts.comparisons > 5000)
  assert.equal(counts.mismatches, 0)
})

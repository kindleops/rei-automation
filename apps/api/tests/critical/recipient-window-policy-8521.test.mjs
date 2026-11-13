// rc-8.5.21 S3 + owner ruling 2026-10-18 — ONE recipient-timezone + messaging-category policy
// (queue/recipient-window-policy.js). The delay planner / R3 (reply-timing.js), the follow-up lifecycle
// and the queue dispatcher (sms-engine#evaluateDispatchWindow / #evaluateContactWindow, pre-claim AND
// pre-send) call the same classifier, resolver and verdict, so they agree at every instant per category.
// The property ZIP alone is never the recipient's zone; unknown ⇒ the continental intersection
// (11:00–21:00 ET). Category 1 (active seller conversation) has no universal after-hours block.
// Pure; fictional 555 / non-geographic numbers only.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveRecipientWindowZones, evaluateMessagingWindow, classifyMessagingCategory, recipientEvidenceFromRow, recipientZoneStamp, localHoursOpen,
  UNKNOWN_ZONE_FALLBACK, RECIPIENT_WINDOW_POLICY_VERSION, MESSAGING_CATEGORIES as CAT, CATEGORY_BASE_HOURS,
} from '../../src/lib/domain/queue/recipient-window-policy.js'
import { MESSAGING_RESTRICTIONS, validateMessagingRestrictions } from '../../src/lib/domain/queue/messaging-restrictions.js'
import { evaluateReplyTiming, evaluateRowReplyTiming } from '../../src/lib/domain/queue/reply-timing.js'
import { planReplyDelay } from '../../src/lib/domain/conversation-ai/turns/delay-planner.js'
import { evaluateContactWindow, evaluateDispatchWindow } from '../../src/lib/supabase/sms-engine.js'
import { evaluateSendTimeContactGuard } from '../../src/lib/domain/queue/send-time-contact-guard.js'
import { materializeClaimedIntent, withLifecycleHelpers, MATERIALIZE_CODES as M } from '../../src/lib/domain/followups/followup-lifecycle.js'
import { FOLLOWUP_EXECUTION_MODE_KEY } from '../../src/lib/domain/followups/followup-execution.js'

const ET = 'America/New_York'; const CT = 'America/Chicago'; const MT = 'America/Denver'; const PT = 'America/Los_Angeles'
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()
const etMinutes = (ms) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms))
  return (Number(p.find((x) => x.type === 'hour').value) % 24) * 60 + Number(p.find((x) => x.type === 'minute').value)
}
const NON_GEO = '+15005550100' // +1 500: no area-code zone
const DENVER = { state: 'CO', zip: '80202' }
const CALIF = { state: 'CA', zip: '90011' }
// the category-3 verdict over a zone set (what the follow-up lifecycle asks)
const evaluateRecipientWindow = ({ at, zones }) => evaluateMessagingWindow({ category: CAT.SCHEDULED_FOLLOWUP, at, zones })

// ── precedence ──────────────────────────────────────────────────────────────
test('precedence: non-geographic phone + property-only evidence ⇒ UNKNOWN ⇒ the continental intersection (never the property zone alone)', () => {
  const r = resolveRecipientWindowZones({ recipientPhone: NON_GEO, propertyGeography: DENVER })
  assert.equal(r.certainty, 'unknown')
  assert.equal(r.timezone_known, false)
  assert.equal(r.recipient_local, false)
  assert.equal(r.primary_zone, null)
  assert.deepEqual([...r.zones].sort(), [...UNKNOWN_ZONE_FALLBACK].sort(), 'Denver is already inside the fallback set')
  // the S3a instant: 2026-10-19T14:00Z = 08:00 MT / 07:00 PT / 10:00 ET ⇒ NOT lawful
  assert.equal(evaluateRecipientWindow({ at: '2026-10-19T14:00:00.000Z', zones: r.zones }).lawful, false)
  const v = evaluateRecipientWindow({ at: '2026-10-19T14:00:00.000Z', zones: r.zones })
  assert.equal(v.next_permitted_at, '2026-10-19T15:00:00.000Z', '11:00 ET = 08:00 PT')
  assert.equal(evaluateRecipientWindow({ at: '2026-10-20T00:59:00.000Z', zones: r.zones }).lawful, true, '20:59 ET')
  assert.equal(evaluateRecipientWindow({ at: '2026-10-20T01:00:00.000Z', zones: r.zones }).lawful, false, '21:00 ET')
  // a stored row zone is not recipient evidence either
  const stored = resolveRecipientWindowZones({ recipientPhone: NON_GEO, storedTimezone: 'Mountain' })
  assert.equal(stored.certainty, 'unknown')
  // no evidence at all: the conservative window, never a guess, and flagged so the dispatcher holds
  const none = resolveRecipientWindowZones({ recipientPhone: NON_GEO })
  assert.deepEqual([none.zones, none.has_evidence], [[...UNKNOWN_ZONE_FALLBACK], false])
  assert.equal(r.has_evidence, true)
})

test('precedence: ET area code + California property ⇒ ET ∩ PT (no 21:00–24:00 ET, no 08:00–11:00 ET)', () => {
  const r = resolveRecipientWindowZones({ recipientPhone: '+12125550100', propertyGeography: CALIF })
  assert.deepEqual([r.certainty, r.primary_zone, r.basis, r.timezone_known], ['multiple', ET, 'recipient_area_code', true])
  assert.deepEqual([...r.zones].sort(), [ET, PT].sort())
  const day = Date.parse('2026-10-14T04:00:00.000Z') // 00:00 ET
  for (let q = 0; q < 96; q += 1) {
    const t = day + q * 15 * MIN
    const m = etMinutes(t)
    assert.equal(evaluateRecipientWindow({ at: t, zones: r.zones }).lawful, m >= 11 * 60 && m < 21 * 60, `${iso(t)} (${m} ET minutes)`)
  }
})

test('precedence: a known single zone; mailing evidence is recipient evidence; the property only narrows', () => {
  const single = resolveRecipientWindowZones({ recipientPhone: '+13125550100', propertyGeography: { state: 'IL', zip: '60601' } })
  assert.deepEqual([single.zones, single.certainty, single.primary_zone], [[CT], 'single', CT])
  const mailing = resolveRecipientWindowZones({ recipientPhone: NON_GEO, mailingGeography: { state: 'CA' }, propertyGeography: DENVER })
  assert.deepEqual([mailing.certainty, mailing.primary_zone, mailing.basis], ['multiple', PT, 'mailing_geography'])
  assert.deepEqual([...mailing.zones].sort(), [MT, PT].sort())
  // the straddling code keeps both zones
  assert.deepEqual([...resolveRecipientWindowZones({ recipientPhone: '+18505550100' }).zones].sort(), [CT, ET].sort())
})

test('precedence: zones STAMPED by this policy are recipient evidence; a legacy stamp (no marker) only narrows; stamped unknown stays unknown', () => {
  const stamp = recipientZoneStamp(resolveRecipientWindowZones({ recipientPhone: NON_GEO, mailingGeography: { state: 'CA' } }))
  assert.equal(stamp.recipient_zone_policy, RECIPIENT_WINDOW_POLICY_VERSION)
  const row = { to_phone_number: NON_GEO, property_id: 'p1', metadata: { ...stamp } }
  const fromStamp = resolveRecipientWindowZones(recipientEvidenceFromRow(row, { propertyGeography: DENVER }))
  assert.deepEqual([fromStamp.certainty, fromStamp.primary_zone, fromStamp.basis], ['multiple', PT, 'stamped_recipient_zones'])
  assert.deepEqual([...fromStamp.zones].sort(), [MT, PT].sort())
  // a legacy stamp (the S3a row: property-derived ["America/Denver"], no marker) is NOT "known"
  const legacy = resolveRecipientWindowZones(recipientEvidenceFromRow({ to_phone_number: NON_GEO, metadata: { recipient_zones: [MT], recipient_zone_certainty: 'property_only' } }))
  assert.equal(legacy.certainty, 'unknown')
  assert.deepEqual([...legacy.zones].sort(), [...UNKNOWN_ZONE_FALLBACK].sort())
  // a stamp can never widen: the row's own area code still joins the set
  const narrow = resolveRecipientWindowZones(recipientEvidenceFromRow({ to_phone_number: '+12125550100', metadata: { recipient_zones: [PT], recipient_zone_policy: RECIPIENT_WINDOW_POLICY_VERSION, recipient_zone_certainty: 'single' } }))
  assert.deepEqual([...narrow.zones].sort(), [ET, PT].sort())
  const unk = resolveRecipientWindowZones(recipientEvidenceFromRow({ to_phone_number: NON_GEO, metadata: recipientZoneStamp(resolveRecipientWindowZones({ recipientPhone: NON_GEO })) }))
  assert.equal(unk.certainty, 'unknown')
})

test('the dispatcher (evaluateContactWindow) resolves recipient-first: ET area code + CA property is closed at 22:00 ET; unknown is the intersection, not a hold', () => {
  const at = '2026-10-15T02:00:00.000Z' // 22:00 ET, 19:00 PT
  const w = evaluateContactWindow({ id: 'r1', to_phone_number: '+12125550100', property_address_state: 'CA', property_address_zip: '90011', timezone: null }, { now: at })
  assert.equal(w.allowed, false)
  assert.equal(w.reason, 'outside_local_send_window')
  assert.equal(w.timezone, ET)
  assert.deepEqual([...w.zones].sort(), [ET, PT].sort())
  assert.equal(w.next_open_at, '2026-10-15T15:00:00.000Z', '11:00 ET = 08:00 PT')
  const u = evaluateContactWindow({ id: 'r2', to_phone_number: NON_GEO, property_id: 'p1' }, { now: '2026-10-19T14:00:00.000Z', propertyGeography: DENVER })
  assert.deepEqual([u.allowed, u.hold === true, u.timezone, u.timezone_certainty], [false, false, null, 'unknown'])
  assert.equal(u.next_open_at, '2026-10-19T15:00:00.000Z')
})

// ── the property grid: scheduler verdict ≡ dispatcher verdict ───────────────
const SPEC = (phone) => ({
  thread_key: phone, to_phone_number: phone, from_phone_number: '+13125550199', property_id: 'p1', master_owner_id: 'm1',
  type: 'followup', message_type: 'followup', use_case_template: 'nurture_not_interested', language: 'English', seller_first_name: 'Dana',
  metadata: { intent: 'not_interested', source: 'seller_inbound_orchestrator', followup_reason: 'nurture_followup:not_interested' },
})
const intentFor = (phone, due) => ({ id: '11111111-1111-4111-8111-111111111111', intent_key: 'fi1.x', thread_key: phone, property_id: 'p1', master_owner_id: 'm1', kind: 'not_interested_nurture', intent: 'not_interested',
  due_at: due, created_at: '2026-09-20T16:00:00.000Z', state: 'materializing', lease_token: 'tok', attempts: 1, materialize_seq: 1, row_spec: SPEC(phone) })

async function lifecycleDeps({ now, geo, mailing = null, enqueued }) {
  return withLifecycleHelpers({
    now: () => now,
    readSwitch: async (k) => (k === FOLLOWUP_EXECUTION_MODE_KEY ? 'live' : null),
    transition: async () => ({ ok: true }),
    loadThread: async () => ({ is_suppressed: false, last_inbound_at: '2026-09-20T15:00:00.000Z' }),
    holdCheck: async () => ({ held: false }),
    guard: async () => ({ blocked: false }),
    alreadySent: async () => false,
    languageFor: async () => 'English',
    templateCandidates: () => ['consider_selling_follow_up'],
    templatesAvailable: async () => true,
    render: async () => ({ ok: true, resolved: true, message_body: 'Hi Dana, Helen here again. Any change of plans on 12 Oak St?', template_id: 't1', use_case: 'consider_selling_follow_up', language: 'English' }),
    senderStatus: async () => 'active',
    propertyGeography: async () => (geo ? { ...geo, ...(mailing ? { mailing } : {}) } : (mailing ? { mailing } : null)),
    otherTexts: async () => [],
    validate: () => ({ ok: true }),
    enqueue: async (row) => { enqueued.push(row); return { ok: true, queue_row_id: 'q1' } },
  })
}

const PROFILES = [
  { name: 'ET area code + California property', phone: '+12125550100', geo: CALIF },
  { name: 'non-geographic + Denver property', phone: NON_GEO, geo: DENVER },
  { name: 'non-geographic + no property geography (nothing places the recipient)', phone: NON_GEO, geo: null, held: true },
  { name: 'CT area code + IL property (local owner)', phone: '+13125550100', geo: { state: 'IL', zip: '60601' } },
  { name: 'PT area code + NY property', phone: '+14155550100', geo: { state: 'NY', zip: '10001' } },
  { name: 'straddling 850 + FL panhandle property', phone: '+18505550100', geo: { state: 'FL', zip: '32501' } },
  { name: 'non-geographic + CA mailing + TX property', phone: NON_GEO, geo: { state: 'TX', zip: '75201' }, mailing: { state: 'CA', zip: null } },
  { name: 'Phoenix area code + Denver property', phone: '+16025550100', geo: DENVER },
]
const GRID_START = Date.parse('2026-10-19T04:00:00.000Z') // 00:00 ET Monday; spans 48 h
const INSTANTS = 192

test(`property grid: the follow-up scheduler and the queue dispatcher return IDENTICAL verdicts at every quarter-hour (${INSTANTS} instants × ${PROFILES.length} profiles)`, async () => {
  const mismatches = []
  let compared = 0
  let open = 0
  for (const p of PROFILES) {
    for (let q = 0; q < INSTANTS; q += 1) {
      const t = GRID_START + q * 15 * MIN
      const enqueued = []
      const deps = await lifecycleDeps({ now: iso(t), geo: p.geo, mailing: p.mailing, enqueued })
      const r = await materializeClaimedIntent(intentFor(p.phone, iso(t)), deps)
      if (p.held) {
        // nothing places this recipient: the scheduler holds and the dispatcher holds the same row
        assert.equal(r.code, M.HELD, `${p.name} ${JSON.stringify(r)}`)
        const w = evaluateContactWindow({ id: 'q3', to_phone_number: p.phone, property_id: 'p1' }, { now: iso(t), propertyGeography: p.geo })
        if (w.hold !== true || w.allowed !== false) mismatches.push({ p: p.name, t: iso(t), kind: 'hold', dispatcher: w })
        compared += 1
        continue
      }
      assert.equal(r.code, M.MATERIALIZED, `${p.name} ${iso(t)} ${JSON.stringify(r)}`)
      const row = enqueued[0]
      const scheduler = row.scheduled_for === iso(t) // the scheduler would send AT t
      if (scheduler) open += 1
      // the dispatcher on the materialized (stamped) row — its own property read, as process-send-queue does
      const stamped = evaluateContactWindow({ ...row, id: 'q1' }, { now: iso(t), propertyGeography: p.geo })
      // and on an UNSTAMPED row (campaign first touch shape: only the phone + property geography)
      const bare = evaluateContactWindow({ id: 'q2', to_phone_number: p.phone, property_id: 'p1', timezone: row.timezone || null }, { now: iso(t), propertyGeography: p.geo })
      // the pure verdict over the unstamped evidence (what a campaign scheduler asks)
      const pure = evaluateRecipientWindow({ at: t, zones: resolveRecipientWindowZones({ recipientPhone: p.phone, propertyGeography: p.geo }).zones }).lawful
      if (stamped.allowed !== scheduler) mismatches.push({ p: p.name, t: iso(t), kind: 'stamped', scheduler, dispatcher: stamped.allowed })
      if (!p.mailing && bare.allowed !== scheduler) mismatches.push({ p: p.name, t: iso(t), kind: 'unstamped', scheduler, dispatcher: bare.allowed })
      if (!p.mailing && pure !== scheduler) mismatches.push({ p: p.name, t: iso(t), kind: 'pure', scheduler, pure })
      // and when the scheduler defers, it defers to the dispatcher's own next open
      if (!scheduler) assert.equal(row.scheduled_for, stamped.next_open_at, `${p.name} ${iso(t)}`)
      compared += 1
    }
  }
  assert.equal(compared, INSTANTS * PROFILES.length)
  assert.ok(open > 0 && open < compared, `non-vacuous: ${open} open / ${compared - open} closed instants`)
  assert.deepEqual(mismatches, [], `0 mismatches expected over ${compared} instants`)
})

test('follow-up lifecycle: the S3a unknown-zone case (non-geographic phone, Denver property, due 2026-10-19T14:00Z) is scheduled inside 11:00–21:00 ET', async () => {
  const enqueued = []
  const due = '2026-10-19T14:00:00.000Z'
  const deps = await lifecycleDeps({ now: '2026-10-19T13:35:00.000Z', geo: DENVER, enqueued })
  const r = await materializeClaimedIntent(intentFor(NON_GEO, due), deps)
  assert.equal(r.code, M.MATERIALIZED, JSON.stringify(r))
  const row = enqueued[0]
  assert.equal(row.scheduled_for, '2026-10-19T15:00:00.000Z', '11:00 ET, not 08:00 MT')
  const m = etMinutes(Date.parse(row.scheduled_for))
  assert.ok(m >= 11 * 60 && m < 21 * 60)
  assert.equal(row.metadata.recipient_zone_certainty, 'unknown')
  assert.equal(row.metadata.recipient_zone_policy, RECIPIENT_WINDOW_POLICY_VERSION)
  assert.deepEqual([...row.metadata.recipient_zones].sort(), [...UNKNOWN_ZONE_FALLBACK].sort())
  assert.equal(row.metadata.followup_send_deferred, true)
  assert.ok(!row.timezone, 'no zone is stamped as the recipient zone when it is unknown')
  // every instant in a 48 h sweep the lifecycle picks for this seller is inside 11:00–21:00 ET
  for (let q = 0; q < INSTANTS; q += 1) {
    const t = GRID_START + q * 15 * MIN
    const out = []
    await materializeClaimedIntent(intentFor(NON_GEO, iso(t)), await lifecycleDeps({ now: iso(t), geo: DENVER, enqueued: out }))
    const mm = etMinutes(Date.parse(out[0].scheduled_for))
    assert.ok(mm >= 11 * 60 && mm < 21 * 60, `${iso(t)} → ${out[0].scheduled_for}`)
  }
})


// ── owner ruling 2026-10-18: THREE messaging categories, ONE classifier, ONE verdict ──
const NIGHT_CT = '2026-10-15T04:30:00.000Z' // 23:30 CT (00:30 ET, 21:30 PT)
const SELLER = '+13125550100' // Chicago area code
const IL = { state: 'IL', zip: '60601' }
// the row R3 writes for an AI reply (only the fields the timing layers read)
const aiRow = ({ inboundAt, queuedAt, phone = SELLER, geo = IL, zones = null }) => ({
  id: 'ai1', source: 'ai_conversation', type: 'ai_conversation', message_origin: 'ai_generated', inbound_message_id: 'i1', source_event_id: 'i1', created_at: queuedAt,
  to_phone_number: phone, property_id: 'p1', property_address_state: geo?.state || null, property_address_zip: geo?.zip || null, queue_key: 'ai_conversation:i1',
  metadata: {
    source: 'ai_conversation', type: 'reply', action_type: 'ai_conversation_reply', inbound_received_at: inboundAt, inbound_message_event_id: 'i1',
    conversational_reply: { stage: 'queued', at: queuedAt, queued_at: queuedAt, inbound_message_event_id: 'i1', inbound_received_at: inboundAt },
    ...(zones ? recipientZoneStamp(zones) : {}),
  },
})
const campaignRow = ({ phone = SELLER, geo = IL, inboundAt = null } = {}) => ({
  id: 'c1', queue_key: 'campaign:t1:1', type: 'campaign', campaign_target_id: 't1', touch_number: 1, to_phone_number: phone, property_id: 'p1',
  property_address_state: geo?.state || null, property_address_zip: geo?.zip || null,
  metadata: { candidate_snapshot: { touch_number: 1, seller_first_name: 'Dana' }, ...(inboundAt ? { inbound_message_event_id: 'i1', inbound_received_at: inboundAt } : {}) },
})
const nurtureRow = ({ phone = SELLER, geo = IL, inboundAt = null } = {}) => ({
  id: 'n1', queue_key: 'fui:x:m1', type: 'followup', message_type: 'followup', to_phone_number: phone, property_id: 'p1',
  property_address_state: geo?.state || null, property_address_zip: geo?.zip || null, created_at: inboundAt,
  metadata: { followup_intent_id: 'fi1', followup_reason: 'nurture_followup:not_interested', source: 'followup_lifecycle', ...(inboundAt ? { inbound_message_event_id: 'i1', inbound_received_at: inboundAt, conversational_reply: { queued_at: inboundAt } } : {}) },
})

test('categories: ONE classifier — an in-session reply is category 1; a campaign touch / nurture is never category 1, even inside an active session', () => {
  const inboundAt = '2026-10-15T04:25:00.000Z'
  const now = NIGHT_CT
  assert.equal(classifyMessagingCategory({ row: aiRow({ inboundAt, queuedAt: now }), now }).category, CAT.ACTIVE_CONVERSATION)
  assert.equal(classifyMessagingCategory({ row: aiRow({ inboundAt: '2026-10-15T03:40:00.000Z', queuedAt: now }), now }).category, CAT.SCHEDULED_FOLLOWUP, 'the session elapsed: no longer an active conversation')
  assert.equal(classifyMessagingCategory({ row: campaignRow({ inboundAt }), now }).category, CAT.CAMPAIGN_OUTREACH)
  assert.equal(classifyMessagingCategory({ row: nurtureRow({ inboundAt }), now }).category, CAT.SCHEDULED_FOLLOWUP)
  assert.equal(classifyMessagingCategory({ isReply: true, inSession: true }).category, CAT.ACTIVE_CONVERSATION)
  assert.equal(classifyMessagingCategory({ isReply: true, inSession: false }).category, CAT.SCHEDULED_FOLLOWUP)
  assert.equal(classifyMessagingCategory({ kind: 'campaign' }).category, CAT.CAMPAIGN_OUTREACH)
  // an unknown category is never category 1
  assert.equal(evaluateMessagingWindow({ category: 'weird', at: NIGHT_CT, zones: [CT] }).lawful, false)
  // base windows: none for category 1, 08:00–21:00 for categories 2 and 3
  assert.deepEqual([CATEGORY_BASE_HOURS[CAT.ACTIVE_CONVERSATION], CATEGORY_BASE_HOURS[CAT.CAMPAIGN_OUTREACH], CATEGORY_BASE_HOURS[CAT.SCHEDULED_FOLLOWUP]],
    [null, { start_hour: 8, end_hour: 21 }, { start_hour: 8, end_hour: 21 }])
})

test('restriction table: ships EMPTY (no invented legal rule), validates, and is the only hook that can bind category 1; an entry narrows, never widens', () => {
  assert.deepEqual([...MESSAGING_RESTRICTIONS], [])
  assert.equal(validateMessagingRestrictions(MESSAGING_RESTRICTIONS, Object.values(CAT)).ok, true)
  assert.equal(validateMessagingRestrictions([{ id: 'x', jurisdiction: 'FL', categories: [CAT.ACTIVE_CONVERSATION], hours: { start_hour: 8, end_hour: 20 } }]).ok, false, 'no citation / approval ⇒ invalid')
  assert.equal(evaluateMessagingWindow({ category: CAT.ACTIVE_CONVERSATION, at: NIGHT_CT, zones: [CT], jurisdictions: ['IL'] }).lawful, true, 'category 1 at 23:30, empty table')
  // the hook (a HYPOTHETICAL test entry, not a legal rule): binds only its jurisdiction × category
  const table = [{ id: 'test-only', jurisdiction: 'FL', categories: [CAT.ACTIVE_CONVERSATION], hours: { start_hour: 8, end_hour: 20 }, citation: 'test fixture', approved_by: 'test' }]
  const fl = evaluateMessagingWindow({ category: CAT.ACTIVE_CONVERSATION, at: '2026-10-15T03:30:00.000Z', zones: [ET], jurisdictions: ['FL'], restrictions: table })
  assert.deepEqual([fl.lawful, fl.restrictions_applied, fl.next_permitted_at], [false, ['test-only'], '2026-10-15T12:00:00.000Z'])
  assert.equal(evaluateMessagingWindow({ category: CAT.ACTIVE_CONVERSATION, at: '2026-10-15T03:30:00.000Z', zones: [ET], jurisdictions: ['GA'], restrictions: table }).lawful, true)
  assert.equal(evaluateMessagingWindow({ category: CAT.SCHEDULED_FOLLOWUP, at: '2026-10-15T00:30:00.000Z', zones: [ET], jurisdictions: ['FL'], restrictions: table }).lawful, true, '20:30 ET: the entry does not bind category 3')
  // jurisdictions come from the evidence (mailing + property states)
  assert.deepEqual(resolveRecipientWindowZones({ recipientPhone: SELLER, mailingGeography: { state: 'fl' }, propertyGeography: IL }).jurisdictions, ['FL', 'IL'])
})

test('an 11:30 PM seller inbound is answered THAT NIGHT within the adaptive delay (planner ⇒ R3 ⇒ row gate ⇒ dispatcher agree)', () => {
  for (const [phone, geo] of [[SELLER, IL], ['+12125550100', CALIF], [NON_GEO, DENVER]]) {
    const zones = resolveRecipientWindowZones({ recipientPhone: phone, propertyGeography: geo })
    const p = planReplyDelay({ seed: `night-${phone}`, now: NIGHT_CT, lastInboundAt: NIGHT_CT, inboundId: 'i1', recipientZones: zones })
    assert.equal(p.action, 'schedule', JSON.stringify(p))
    const due = Date.parse(p.due_at)
    assert.ok(due >= Date.parse(NIGHT_CT) + 3 * MIN && due <= Date.parse(NIGHT_CT) + 30 * MIN, `${phone}: queued that night (${p.due_at})`)
    assert.equal(p.window.deferred, false)
    assert.equal(p.window.lawful_basis, 'in_session')
    const r3 = evaluateReplyTiming({ at: p.due_at, queuedAt: p.due_at, inboundId: 'i1', inboundAt: NIGHT_CT, zones: zones.zones })
    assert.deepEqual([r3.lawful, r3.category], [true, CAT.ACTIVE_CONVERSATION])
    const row = aiRow({ inboundAt: NIGHT_CT, queuedAt: p.due_at, phone, geo, zones })
    assert.equal(evaluateRowReplyTiming(row, { now: p.due_at }).lawful, true)
    const d = evaluateDispatchWindow(row, { now: p.due_at, propertyGeography: geo })
    assert.deepEqual([d.allowed, d.category, d.contact_window.allowed], [true, CAT.ACTIVE_CONVERSATION, false], 'the window is closed; category 1 is not bound by it')
  }
})

test('at 11:30 PM a campaign first touch and a nurture to the SAME contact are deferred to their windows; an active session does not let them through', async () => {
  const inboundAt = '2026-10-15T04:25:00.000Z' // the seller texted at 23:25 CT: the session is live
  for (const r of [campaignRow({ inboundAt }), nurtureRow({ inboundAt })]) {
    const d = evaluateDispatchWindow(r, { now: NIGHT_CT, propertyGeography: IL })
    assert.equal(d.allowed, false, r.id)
    assert.notEqual(d.category, CAT.ACTIVE_CONVERSATION)
    assert.equal(d.active_conversation_lawful, false)
    assert.equal(d.contact_window.next_open_at, '2026-10-15T13:00:00.000Z', '08:00 CT')
  }
  // the same contact's in-session reply goes now
  assert.equal(evaluateDispatchWindow(aiRow({ inboundAt, queuedAt: NIGHT_CT }), { now: NIGHT_CT, propertyGeography: IL }).allowed, true)
  // the lifecycle plans that nurture for the next morning, not tonight
  const out = []
  const deps = await lifecycleDeps({ now: NIGHT_CT, geo: IL, enqueued: out })
  const r = await materializeClaimedIntent(intentFor(SELLER, NIGHT_CT), deps)
  assert.equal(r.code, M.MATERIALIZED)
  assert.equal(out[0].scheduled_for, '2026-10-15T13:00:00.000Z')
  // the runner's pre-claim: the reply is runnable, the nurture and the campaign touch are not
  const { loadRunnableSendQueueRows } = await import('../../src/lib/supabase/sms-engine.js')
  const { makeSendQueueRowsSupabase } = await import('../helpers/queue-run-test-harness.js')
  const reply = {
    id: 'sq-reply', queue_key: 'inbound_auto_reply:evt_1', queue_status: 'queued', type: 'auto_reply', scheduled_for: inboundAt, created_at: inboundAt,
    message_body: 'Hi John, this is Chris. Thanks for the reply about 123 Main St.', to_phone_number: SELLER, from_phone_number: '+16125092623', seller_first_name: 'John', template_id: '208481',
    property_address_state: 'IL', property_address_zip: '60601', source_event_id: 'evt_1',
    metadata: { source: 'auto_reply', inbound_message_event_id: 'evt_1', inbound_received_at: inboundAt, candidate_snapshot: { seller_first_name: 'John' } },
  }
  const nurture = { ...reply, id: 'sq-nurture', queue_key: 'followup:fi1:m1', type: 'followup', message_type: 'followup', metadata: { ...reply.metadata, source: 'followup_lifecycle', followup_reason: 'nurture_followup:not_interested' } }
  const res = await loadRunnableSendQueueRows(10, {
    now: NIGHT_CT, stale_lock_recovery_enabled: false, getSystemValue: async () => null,
    supabaseClient: makeSendQueueRowsSupabase([reply, nurture]),
    pauseInvalidQueueRow: async () => { throw new Error('nothing should be paused') },
  })
  assert.deepEqual(res.rows.map((x) => x.id), ['sq-reply'])
  assert.equal(res.preclaim_outside_window_excluded_count, 1)
})

test('STOP at night still suppresses immediately: the opt-out turn has no delay and no window; a suppressed contact is blocked even in an active session', () => {
  const p = planReplyDelay({ seed: 'stop', now: NIGHT_CT, lastInboundAt: NIGHT_CT, inboundId: 'i1', optOut: true, recipientZones: resolveRecipientWindowZones({ recipientPhone: SELLER }) })
  assert.deepEqual([p.action, p.due_at, p.delay_minutes], ['immediate', NIGHT_CT, 0])
  // an in-session reply whose window verdict is "allowed" is still refused by the send-time contact guard
  const row = aiRow({ inboundAt: '2026-10-15T04:25:00.000Z', queuedAt: NIGHT_CT })
  assert.equal(evaluateDispatchWindow(row, { now: NIGHT_CT, propertyGeography: IL }).allowed, true)
  const guard = evaluateSendTimeContactGuard(row, { suppressions: [{ phone_e164: SELLER, is_active: true, suppression_type: 'stop' }] }, { now: Date.parse(NIGHT_CT) })
  assert.equal(guard.blocked, true)
  assert.equal(guard.reason, 'sms_suppression_list_active')
})

test(`property grid, ALL THREE categories × absentee-owner zones: scheduler and dispatcher verdicts are IDENTICAL at every quarter-hour (${INSTANTS} instants × ${PROFILES.length} profiles × 5 shapes)`, () => {
  const mismatches = []
  const tally = { active: 0, active_open: 0, other_open: 0, total: 0 }
  for (const p of PROFILES) {
    const res = resolveRecipientWindowZones({ recipientPhone: p.phone, propertyGeography: p.geo })
    for (let q = 0; q < INSTANTS; q += 1) {
      const t = GRID_START + q * 15 * MIN
      const at = iso(t)
      const fresh = iso(t - 10 * MIN) // the seller texted 10 min ago (in session)
      const aged = iso(t - 45 * MIN) // the session elapsed
      const shapes = [
        // category 1: the planner / R3 verdict vs the dispatcher on the AI row
        ['active', evaluateReplyTiming({ at, queuedAt: at, inboundId: 'i1', inboundAt: fresh, zones: res.zones }).lawful, aiRow({ inboundAt: fresh, queuedAt: at, phone: p.phone, geo: p.geo, zones: res })],
        // a reply after the session: no longer category 1
        ['aged_reply', evaluateReplyTiming({ at, queuedAt: at, inboundId: 'i1', inboundAt: aged, zones: res.zones }).lawful, aiRow({ inboundAt: aged, queuedAt: at, phone: p.phone, geo: p.geo, zones: res })],
        // category 2: a campaign touch, also with a live session on the same contact
        ['campaign', evaluateReplyTiming({ purpose: 'campaign', at, zones: res.zones }).lawful, campaignRow({ phone: p.phone, geo: p.geo })],
        ['campaign_in_session', evaluateMessagingWindow({ category: CAT.CAMPAIGN_OUTREACH, at, zones: res.zones }).lawful, campaignRow({ phone: p.phone, geo: p.geo, inboundAt: fresh })],
        // category 3: a nurture inside a live session
        ['nurture_in_session', evaluateMessagingWindow({ category: CAT.SCHEDULED_FOLLOWUP, at, zones: res.zones }).lawful, nurtureRow({ phone: p.phone, geo: p.geo, inboundAt: fresh })],
      ]
      for (const [shape, scheduler, row] of shapes) {
        if (p.held && shape !== 'active' && shape !== 'aged_reply') continue // nothing places the recipient: held (above)
        if (p.mailing) continue // mailing evidence reaches the dispatcher only through the lifecycle stamp (grid above)
        const d = evaluateDispatchWindow(row, { now: at, propertyGeography: p.geo })
        if (d.allowed !== scheduler) mismatches.push({ p: p.name, shape, at, scheduler, dispatcher: d.allowed, category: d.category })
        if (shape === 'active') { tally.active += 1; if (scheduler) tally.active_open += 1 }
        else if (scheduler) tally.other_open += 1
        tally.total += 1
      }
    }
  }
  assert.deepEqual(mismatches.slice(0, 5), [], `${mismatches.length} mismatches over ${tally.total} comparisons`)
  assert.equal(tally.total, INSTANTS * (6 * 5 + 2), 'comparisons: 6 profiles × 5 shapes + the unplaceable profile × 2 reply shapes')
  assert.equal(tally.active_open, tally.active, 'category 1 is eligible at every hour (empty restriction table)')
  assert.ok(tally.other_open > 0 && tally.other_open < tally.total - tally.active, 'categories 2 / 3 are window-bound (non-vacuous)')
})

// rc-8.5.21 part A, Phase 5 — ONE scheduling policy. The planner (turns/delay-planner.js), the
// decision-time bridge, the R3 enqueue check and the dispatch-time row gate all ask
// queue/reply-timing.js; these tests prove they agree on every instant, that the owner's
// in-session rule is reused (not widened), and that recipient-local zone evidence is preferred
// with the property zone kept as a narrowing constraint. Pure; fictional 555 numbers only.
import test from 'node:test'
import assert from 'node:assert/strict'

import { planReplyDelay, inLocalWindow } from '../../src/lib/domain/conversation-ai/turns/delay-planner.js'
import { evaluateReplyTiming, evaluateRowReplyTiming, resolveRecipientZones, localHoursOpen, UNKNOWN_ZONE_FALLBACK } from '../../src/lib/domain/queue/reply-timing.js'
import { zonesForPhone, areaCodeOf, AREA_CODE_COUNT } from '../../src/lib/domain/queue/nanp-area-zones.js'
import { evaluateInSessionReply, DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES } from '../../src/lib/domain/queue/conversational-reply-window.js'
import { dryRunEligibility, hypotheticalReplyRow } from '../../src/lib/domain/conversation-ai/eligibility-bridge.js'
import { evaluateContactWindow } from '../../src/lib/supabase/sms-engine.js'

const ET = 'America/New_York'; const CT = 'America/Chicago'; const MT = 'America/Denver'; const PT = 'America/Los_Angeles'
const MIN = 60_000
const iso = (ms) => new Date(ms).toISOString()

test('area codes: recipient-local evidence; a straddling code lists every zone; unknown is unknown', () => {
  assert.ok(AREA_CODE_COUNT > 300)
  assert.deepEqual(zonesForPhone('+12125550100'), [ET])
  assert.deepEqual(zonesForPhone('(312) 555-0100'), [CT])
  assert.deepEqual(zonesForPhone('13035550100'), [MT])
  assert.deepEqual(zonesForPhone('+16025550100'), ['America/Phoenix'])
  assert.deepEqual(zonesForPhone('+14155550100'), [PT])
  assert.deepEqual(zonesForPhone('+19155550100'), [MT], 'El Paso is Mountain')
  assert.deepEqual([...zonesForPhone('+18505550100')].sort(), [CT, ET].sort(), 'FL panhandle straddles')
  assert.deepEqual([...zonesForPhone('+14235550100')].sort(), [CT, ET].sort(), 'TN 423 straddles')
  assert.equal(zonesForPhone('+18005550100'), null, 'toll-free is not a place')
  assert.equal(zonesForPhone('+15555550101'), null, '555 is not a geographic code')
  assert.equal(areaCodeOf('12'), null)
})

test('recipient zones: absentee owner ⇒ the recipient zone AND the property zone (intersection window); unknown ⇒ the conservative lower-48 window', () => {
  const absentee = resolveRecipientZones({ recipientPhone: '+14155550100', propertyGeography: { state: 'NY', zip: '10001' } })
  assert.deepEqual([...absentee.zones].sort(), [ET, PT].sort())
  assert.deepEqual([absentee.certainty, absentee.recipient_local], ['multiple', true])
  // 08:30 ET (05:30 PT) is NOT lawful for this seller; 11:30 ET (08:30 PT) is; 20:30 ET (17:30 PT) is
  const day = '2026-10-14'
  assert.equal(localHoursOpen(Date.parse(`${day}T12:30:00Z`), absentee.zones), false)
  assert.equal(localHoursOpen(Date.parse(`${day}T15:30:00Z`), absentee.zones), true)
  assert.equal(localHoursOpen(Date.parse(`${day}T00:30:00Z`), absentee.zones), true)
  const local = resolveRecipientZones({ recipientPhone: '+12125550100', propertyGeography: { state: 'NY', zip: '10001' } })
  assert.deepEqual([local.zones, local.certainty], [[ET], 'single'])
  // rc-8.5.21 S3: the property alone is never the recipient's zone ⇒ unknown ⇒ the continental intersection
  const propOnly = resolveRecipientZones({ recipientPhone: '+15555550101', propertyGeography: { state: 'TX', zip: '75201' } })
  assert.deepEqual([propOnly.zones, propOnly.certainty, propOnly.recipient_local], [[...UNKNOWN_ZONE_FALLBACK], 'unknown', false])
  const mailing = resolveRecipientZones({ recipientPhone: '+15555550101', mailingGeography: { state: 'CA' }, propertyGeography: { state: 'TX', zip: '75201' } })
  assert.deepEqual([[...mailing.zones].sort(), mailing.recipient_local], [[CT, PT].sort(), true])
  const stored = resolveRecipientZones({ recipientPhone: '+15555550101', storedTimezone: 'Central' })
  assert.deepEqual([stored.zones, stored.certainty], [[...UNKNOWN_ZONE_FALLBACK], 'unknown'])
  const unknown = resolveRecipientZones({ recipientPhone: null })
  assert.deepEqual([unknown.zones, unknown.certainty], [[...UNKNOWN_ZONE_FALLBACK], 'unknown'])
  // the unknown window is the intersection: open late morning Eastern, closed at 08:30 Eastern
  assert.equal(localHoursOpen(Date.parse(`${day}T12:30:00Z`), unknown.zones), false)
  assert.equal(localHoursOpen(Date.parse(`${day}T16:00:00Z`), unknown.zones), true)
})

test('in-session rule reused, never widened: a reply queued within the conversational window is lawful at any hour; beyond it the window applies', () => {
  const night = Date.parse('2026-10-15T04:30:00.000Z') // 23:30 CT
  const zones = [CT]
  const inS = evaluateReplyTiming({ at: iso(night + 10 * MIN), queuedAt: iso(night + 10 * MIN), inboundId: 'i1', inboundAt: iso(night), zones })
  assert.deepEqual([inS.lawful, inS.basis], [true, 'in_session'])
  const late = evaluateReplyTiming({ at: iso(night + 31 * MIN), queuedAt: iso(night + 31 * MIN), inboundId: 'i1', inboundAt: iso(night), zones })
  assert.deepEqual([late.lawful, late.basis], [false, null])
  assert.ok(inLocalWindow(Date.parse(late.next_permitted_at), CT, { start_hour: 8, end_hour: 21 }))
  // a caller may only shorten the session, never lengthen it past the existing window's cap
  const wide = evaluateReplyTiming({ at: iso(night + 200 * MIN), queuedAt: iso(night + 200 * MIN), inboundId: 'i1', inboundAt: iso(night), zones, sessionMinutes: 10_000 })
  assert.equal(wide.in_session, false)
  // outreach never gets a session
  assert.equal(evaluateReplyTiming({ purpose: 'outreach', at: iso(night + 5 * MIN), inboundId: 'i1', inboundAt: iso(night), zones }).lawful, false)
  assert.equal(DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES, 30)
})

// the row R3 would write for a reply decided at `due` (only the fields the timing layers read)
const aiRow = ({ inboundAt, due, zones, phone = '+13125550100', state = 'IL', zip = '60601' }) => ({
  id: 'row1', source: 'ai_conversation', type: 'ai_conversation', message_origin: 'ai_generated', inbound_message_id: 'i1', source_event_id: 'i1', created_at: due,
  to_phone_number: phone, property_address_state: state, property_address_zip: zip, queue_key: 'ai_conversation:i1',
  metadata: { source: 'ai_conversation', type: 'reply', action_type: 'ai_conversation_reply', inbound_received_at: inboundAt, inbound_message_event_id: 'i1', conversational_reply: { stage: 'queued', at: due, queued_at: due, inbound_message_event_id: 'i1', inbound_received_at: inboundAt }, recipient_zones: zones },
})

test('scheduler ⇔ enqueue ⇔ dispatch agreement: every planned due time is lawful for R3 and for the row gate, with the same basis, across zones / hours / evidence', () => {
  const evidence = [
    { phone: '+13125550100', geo: { state: 'IL', zip: '60601' } }, // single CT
    { phone: '+14155550100', geo: { state: 'NY', zip: '10001' } }, // absentee PT owner of an ET property
    { phone: '+18505550100', geo: { state: 'FL', zip: '32501' } }, // straddling code
    { phone: '+15555550101', geo: null }, // unknown ⇒ conservative
  ]
  let checked = 0
  const start = Date.parse('2026-10-14T00:00:00.000Z')
  for (const ev of evidence) {
    const zones = resolveRecipientZones({ recipientPhone: ev.phone, propertyGeography: ev.geo })
    for (let h = 0; h < 48; h += 1) {
      const inboundAt = iso(start + h * 37 * MIN)
      const p = planReplyDelay({ seed: `s${h}${ev.phone}`, now: inboundAt, lastInboundAt: inboundAt, inboundId: 'i1', recipientZones: zones })
      assert.equal(p.action, 'schedule', JSON.stringify(p))
      const due = p.due_at
      const r3 = evaluateReplyTiming({ at: due, queuedAt: due, inboundId: 'i1', inboundAt, zones: zones.zones })
      const gate = evaluateRowReplyTiming(aiRow({ inboundAt, due, zones: r3.zones, phone: ev.phone, state: ev.geo?.state, zip: ev.geo?.zip }), { now: due })
      assert.equal(r3.lawful, true, `${ev.phone} ${inboundAt} → ${due}`)
      assert.equal(gate.lawful, true, `${ev.phone} ${inboundAt} → ${due}`)
      assert.equal(gate.basis, r3.basis, JSON.stringify({ ev, inboundAt, due, gate, r3 }))
      // the planner's session ends a 2-min margin early (dispatch latency): its in-session verdict
      // implies the shared one; a planner local-hours verdict implies the window is open
      if (p.window.lawful_basis === 'in_session') assert.equal(r3.in_session, true)
      else assert.equal(r3.local_hours_open, true, JSON.stringify({ p: p.window, r3 }))
      // the runner's own in-session verdict (template path) agrees with the shared function
      const runnerSession = evaluateInSessionReply(aiRow({ inboundAt, due, zones: r3.zones }), { now: due }).in_session
      assert.equal(runnerSession, r3.in_session)
      // and when the reply is NOT in session, the generic property-first window allows it too
      if (!r3.in_session && ev.geo) assert.equal(evaluateContactWindow({ ...aiRow({ inboundAt, due, zones: r3.zones, phone: ev.phone, state: ev.geo.state, zip: ev.geo.zip }), timezone: null }, { now: due }).allowed, true, `${ev.phone} ${due}`)
      // and 1 minute before an out-of-session deferral target, nothing would have been lawful earlier than planned
      checked += 1
    }
  }
  assert.ok(checked >= 190)
})

test('the decision-time bridge reports the same verdict (outside_window is never null: unknown zone ⇒ conservative window)', async () => {
  const now = '2026-10-14T13:15:00.000Z' // 08:15 CT, 06:15 PT
  const row = hypotheticalReplyRow({ sellerPhone: '+14155550100', ourPhone: '+13125550199', threadKey: '+14155550100', propertyId: 'p1', inboundId: 'i1', inboundAt: '2026-10-14T12:00:00.000Z', now })
  const e = await dryRunEligibility({ row, facts: {}, geography: { state: 'IL', zip: '60601' }, now })
  assert.equal(e.outside_window, true, 'the PT recipient is at 06:15')
  assert.deepEqual([...e.timing.zones].sort(), [CT, PT].sort())
  const r3 = evaluateReplyTiming({ at: now, queuedAt: now, inboundId: 'i1', inboundAt: '2026-10-14T12:00:00.000Z', zones: e.timing.zones })
  assert.equal(r3.lawful, !e.outside_window)
  const unk = await dryRunEligibility({ row: { ...row, to_phone_number: '+15555550101' }, facts: {}, geography: null, now })
  assert.notEqual(unk.outside_window, null)
  assert.equal(unk.timing.certainty, 'unknown')
})

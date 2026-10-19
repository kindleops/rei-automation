// rc-8.5.21 — the campaign feeder's next-schedulable instant (computeNextSchedulableTime) comes from THE
// recipient-window policy, the same zones and verdict as its own plan-time window check and the
// dispatcher. The defect: it read ONE stored timezone (default America/Chicago), the wall clock instead of
// `now`, and fell back to a fixed 14:00 UTC next day, so a row could be scheduled into an instant the
// window check and the dispatcher both refuse (e.g. an NY-area-code seller with a WA mailing address).
//
// Grid: 48 h of quarter-hours × profiles. At every instant the scheduled time T satisfies:
//   - the plan-time check (evaluateRecipientWindowForEntry: the feeder's own window check, the stored zone
//     only narrowing) allows T, and THE policy (evaluateMessagingWindow) agrees over the zones it resolved;
//   - T is the EARLIEST such instant: no quarter-hour between now and T is allowed;
//   - a finer contact_window must hold in EVERY plausible zone at T;
//   - nothing places the recipient ⇒ T = now (the dispatcher HOLDS such a row; no guessed window).
import test from 'node:test'
import assert from 'node:assert/strict'

import { computeNextSchedulableTime } from '../../src/lib/domain/outbound/supabase-candidate-feeder.js'
import { evaluateRecipientWindowForEntry } from '../../src/lib/supabase/sms-engine.js'
import { evaluateMessagingWindow, MESSAGING_CATEGORIES } from '../../src/lib/domain/queue/recipient-window-policy.js'

const START = Date.parse('2026-10-19T04:00:00.000Z') // 00:00 ET Monday
const Q = 15 * 60_000
const INSTANTS = Array.from({ length: 192 }, (_, i) => START + i * Q)
const iso = (ms) => new Date(ms).toISOString()

const PROFILES = [
  { name: 'NY area code + WA mailing + NY property', canonical_e164: '+12125550123', property_address_state: 'NY', owner_address_state: 'WA', timezone: 'America/New_York' },
  { name: 'NY area code + WA mailing, stored zone Chicago (the old default)', canonical_e164: '+12125550124', property_address_state: 'NY', owner_address_state: 'WA', timezone: 'America/Chicago' },
  { name: 'PT area code + FL mailing + TX property', canonical_e164: '+14155550125', property_address_state: 'TX', owner_address_state: 'FL', timezone: 'America/Chicago' },
  { name: 'local CT seller', canonical_e164: '+12145550127', property_address_state: 'TX', owner_address_state: 'TX', timezone: 'America/Chicago' },
  { name: 'NY area code, no mailing (control)', canonical_e164: '+12125550128', property_address_state: 'NY', timezone: 'America/New_York' },
]

function entryAllows(c, at) {
  return evaluateRecipientWindowForEntry({
    entry: 'campaign', recipient_phone: c.canonical_e164, timezone: c.timezone,
    property_geography: c.property_address_state ? { state: c.property_address_state, zip: null } : null,
    mailing_geography: c.owner_address_state ? { state: c.owner_address_state, zip: null } : null,
    scheduled_for: iso(at), now: iso(at),
  }, { now: iso(at) })
}

test('RUN-06 / feeder: the defect instant — NY area code + WA mailing at 08:30 ET ⇒ scheduled at 11:00 ET (the ET ∩ PT open), never 08:30 or a fixed 14:00 UTC', () => {
  const now = '2026-10-19T12:30:00.000Z' // 08:30 ET, 05:30 PT
  const t = computeNextSchedulableTime(PROFILES[0], now)
  assert.equal(t, '2026-10-19T15:00:00.000Z')
  assert.equal(computeNextSchedulableTime(PROFILES[1], now), '2026-10-19T15:00:00.000Z', 'a stored Chicago zone never widens the window')
  assert.equal(entryAllows(PROFILES[0], Date.parse(t)).allowed, true)
  assert.equal(entryAllows(PROFILES[0], Date.parse(now)).allowed, false)
})

test('RUN-06 / feeder grid: at every quarter-hour over 48 h × profiles, the next-schedulable instant is the EARLIEST instant the plan-time check and the policy both allow', () => {
  let comparisons = 0
  const mismatches = []
  for (const c of PROFILES) {
    for (const now of INSTANTS) {
      const t = Date.parse(computeNextSchedulableTime(c, iso(now)))
      comparisons += 1
      const ent = entryAllows(c, t)
      // THE policy over the same zones the check resolved (phone, mailing, property, the stored zone narrowing)
      const pol = evaluateMessagingWindow({ category: MESSAGING_CATEGORIES.CAMPAIGN, at: t, zones: ent.zones || [], jurisdictions: ent.jurisdictions || [] }).lawful
      if (!(t >= now) || !pol || ent.allowed !== true) { mismatches.push({ c: c.name, now: iso(now), t: iso(t), pol, ent: ent.allowed }); continue }
      for (let q = now; q < t; q += Q) {
        // the search starts at `now` and jumps to the policy's next open; any allowed quarter-hour before T is a miss
        if (entryAllows(c, q).allowed === true) { mismatches.push({ c: c.name, now: iso(now), t: iso(t), earlier: iso(q) }); break }
      }
    }
  }
  console.log(`feeder next-schedulable grid: ${comparisons} comparisons, ${mismatches.length} mismatches`)
  assert.deepEqual(mismatches.slice(0, 5), [])
  assert.equal(comparisons, PROFILES.length * INSTANTS.length)
})

test('feeder: a finer contact_window holds in EVERY plausible zone at the scheduled instant', () => {
  const c = { ...PROFILES[0], contact_window: '2PM - 6PM' }
  for (const now of INSTANTS) {
    const t = Date.parse(computeNextSchedulableTime(c, iso(now)))
    assert.ok(t >= now)
    const { zones, allowed } = entryAllows(c, t)
    assert.equal(allowed, true, iso(t))
    assert.ok(zones.length >= 1)
    for (const zone of zones) {
      const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(t)))
      assert.ok(hour >= 14 && hour <= 18, `${zone} ${iso(t)}`)
    }
  }
})

test('feeder: nothing places the recipient ⇒ the instant itself (the dispatcher holds; no guessed window); `now` is honoured, never the wall clock', () => {
  const none = { canonical_e164: null, timezone: null }
  assert.equal(computeNextSchedulableTime(none, '2026-10-19T08:00:00.000Z'), '2026-10-19T08:00:00.000Z')
  // inside the window at `now` ⇒ `now` exactly (a past or future `now` is used as given)
  assert.equal(computeNextSchedulableTime(PROFILES[3], '2026-01-05T18:00:00.000Z'), '2026-01-05T18:00:00.000Z')
})

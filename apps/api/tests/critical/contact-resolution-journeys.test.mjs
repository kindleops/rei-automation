import assert from 'node:assert/strict'
import test from 'node:test'

import { runContactResolutionPhase } from '@/lib/domain/seller-flow/resolve-contact-outcome-phase.js'
import { RESOLUTION_ACTION, CONTACT_PROPERTY_ROLE } from '@/lib/domain/seller-flow/contact-resolution-waterfall.js'
import { ACQUISITION_LIFECYCLE_EVENTS as EV } from '@/lib/domain/seller-flow/acquisition-lifecycle-events.js'

/**
 * V2-1B — Journeys A–F through the wired phase.
 *
 * These exercise `runContactResolutionPhase`, which is what
 * process-seller-inbound-message.js actually calls, rather than the pure
 * resolver underneath it. The assertion carried through every journey is
 * `sends === 0`.
 */

const PROPERTY = 'prop-journey'
const OWNER = 'owner-journey'
const A = '+13050000001'
const B = '+13050000002'
const C = '+13050000003'

/** Minimal store standing in for the migrated table + phones graph. */
function makeSupabase({ phones = [], seed = [] } = {}) {
  const rows = new Map()
  for (const r of seed) rows.set(`${r.property_id}|${r.contact_phone_e164}`, r)
  const api = {
    writes: 0,
    _rows: rows,
    from(table) {
      if (table === 'phones') {
        return {
          select: () => ({
            eq: () => ({ range: async () => ({ data: phones, error: null }) }),
          }),
        }
      }
      if (table === 'contact_property_resolution') {
        return {
          select: () => ({
            eq: (col, val) => ({
              range: async () => ({ data: [...rows.values()].filter((r) => r[col] === val), error: null }),
              maybeSingle: async () => ({ data: [...rows.values()].find((r) => r[col] === val) ?? null, error: null }),
            }),
          }),
          upsert: (row) => ({
            select: () => ({
              maybeSingle: async () => {
                const key = `${row.property_id}|${row.contact_phone_e164}`
                const prior = rows.get(key)
                const merged = {
                  id: prior?.id ?? `r${rows.size + 1}`,
                  ...prior, ...row,
                  rejected_at: row.rejected_at ?? prior?.rejected_at ?? null,
                }
                if (!prior) api.writes += 1
                rows.set(key, merged)
                return { data: merged, error: null }
              },
            }),
          }),
        }
      }
      return { select: () => ({ eq: () => ({ range: async () => ({ data: [], error: null }) }) }) }
    },
  }
  return api
}

const phoneRow = (e164, over = {}) => ({
  canonical_e164: e164, phone_type: 'W', is_best_phone_for_owner: false, best_phone_score: 50, ...over,
})

const CALL = (supabase, over = {}) => runContactResolutionPhase({
  supabaseClient: supabase,
  property_id: PROPERTY,
  master_owner_id: OWNER,
  inbound_from: A,
  relationship: { relationship_outcome: 'property_specific_non_owner' },
  source_message_id: 'msg-1',
  source_thread_key: 'thread-1',
  ...over,
})

// ── Journey A — wrong owner → next phone ───────────────────────────────────

test('Journey A: "No, I don\'t own it" rejects A durably and selects B', async () => {
  const supabase = makeSupabase({ phones: [phoneRow(B, { best_phone_score: 70 }), phoneRow(C)] })
  const r = await CALL(supabase)

  assert.equal(r.ran, true)
  assert.equal(r.persisted, true)
  assert.equal(r.contact_property_role, CONTACT_PROPERTY_ROLE.NOT_OWNER)
  assert.equal(r.action, RESOLUTION_ACTION.START_NEXT_PHONE)
  assert.equal(r.next_contact.phone_e164, B)
  assert.equal(r.property_opportunity_terminated, false)
  assert.equal(r.sends, 0)

  // durable: A is recorded rejected
  const stored = supabase._rows.get(`${PROPERTY}|${A}`)
  assert.ok(stored.rejected_at, 'A must be durably rejected')
  assert.equal(stored.suppression_scope, 'contact_property_pair')
})

test('Journey A: the planned next contact is HELD, not sendable', async () => {
  const supabase = makeSupabase({ phones: [phoneRow(B)] })
  const r = await CALL(supabase)
  assert.equal(r.next_contact.send_message, false)
  assert.equal(r.next_contact.automation_authority, 'review_hold')
  assert.equal(r.requires_review, true)
})

test('Journey A: the property stays active, never marked not_interested', async () => {
  const supabase = makeSupabase({ phones: [phoneRow(B)] })
  const r = await CALL(supabase)
  assert.equal(r.property_contact_state, 'contact_resolution_pending')
  assert.equal(r.property_opportunity_terminated, false)
  assert.equal(r.seller_interest_implied, undefined)
})

// ── Journey B — referral ───────────────────────────────────────────────────

test('Journey B: a referral creates a distinct held contact at S1', async () => {
  const supabase = makeSupabase({ phones: [phoneRow(B)] })
  const r = await CALL(supabase, {
    relationship: { relationship_outcome: 'property_specific_non_owner_with_referral' },
    referral: { referral_detected: true, referred_phone_e164: '+13055551234', referred_name: 'John' },
  })

  assert.equal(r.action, RESOLUTION_ACTION.START_REFERRED_CONTACT)
  assert.equal(r.next_contact.phone_e164, '+13055551234')
  assert.notEqual(r.next_contact.phone_e164, B, 'referral must outrank the enrichment pool')
  assert.equal(r.next_contact.merge_with_parent_timeline, false)
  assert.equal(r.next_contact.start_stage, 'ownership_confirmation')
  assert.equal(r.referral_execution.status, 'executed')
  assert.equal(r.referral_execution.persisted, true)
  assert.equal(r.referral_execution.sends, 0)
  assert.equal(r.sends, 0)
})

test('Journey B: the source contact is recorded as referral_source, not owner', async () => {
  const supabase = makeSupabase({ phones: [] })
  await CALL(supabase, {
    relationship: { relationship_outcome: 'property_specific_non_owner_with_referral' },
    referral: { referral_detected: true, referred_phone_e164: '+13055551234' },
  })
  const stored = supabase._rows.get(`${PROPERTY}|${A}`)
  assert.equal(stored.contact_property_role, CONTACT_PROPERTY_ROLE.REFERRAL_SOURCE)
  assert.ok(stored.rejected_at, 'the source is disqualified for this property')
})

// ── Journey C — self-referral ──────────────────────────────────────────────

test('Journey C: a self-referral is refused with no loop and no duplicate', async () => {
  const supabase = makeSupabase({ phones: [] })
  const r = await CALL(supabase, {
    relationship: { relationship_outcome: 'property_specific_non_owner_with_referral' },
    referral: { referral_detected: true, referred_phone_e164: A },
  })

  assert.equal(r.referral_execution.status, 'invalid')
  assert.equal(r.referral_execution.reason, 'referral_points_at_source_contact')
  assert.equal(r.referral_execution.persisted, false)
  assert.equal(r.sends, 0)
  // Only the source row exists; no second identity was minted.
  assert.equal(supabase.writes, 1)
})

// ── Journey D — phones exhausted → email ───────────────────────────────────

test('Journey D: no eligible phones → exhausted, held, zero sends', async () => {
  const supabase = makeSupabase({ phones: [] })
  const r = await CALL(supabase)
  assert.equal(r.action, RESOLUTION_ACTION.EXHAUSTED)
  assert.equal(r.property_opportunity_terminated, false)
  assert.equal(r.requires_review, true)
  assert.equal(r.sends, 0)
})

test('Journey D: a landline-only pool is not treated as contactable', async () => {
  const supabase = makeSupabase({ phones: [phoneRow(B, { phone_type: 'L' })] })
  const r = await CALL(supabase)
  assert.equal(r.action, RESOLUTION_ACTION.EXHAUSTED)
})

// ── Journey E — STOP ───────────────────────────────────────────────────────

test('Journey E: STOP suppresses and never invokes the waterfall', async () => {
  const supabase = makeSupabase({ phones: [phoneRow(B), phoneRow(C)] })
  const r = await CALL(supabase, { canonical_intent: 'opt_out' })

  assert.equal(r.action, RESOLUTION_ACTION.SUPPRESSED)
  assert.equal(r.waterfall_invoked, false)
  assert.equal(r.next_contact, undefined)
  assert.equal(r.suppression_scope, 'channel_compliance')
  assert.equal(r.sends, 0)
})

test('Journey E: STOP wins even when the message also denies ownership', async () => {
  const supabase = makeSupabase({ phones: [phoneRow(B)] })
  const r = await CALL(supabase, {
    canonical_intent: 'opt_out',
    relationship: { relationship_outcome: 'property_specific_non_owner' },
  })
  assert.equal(r.action, RESOLUTION_ACTION.SUPPRESSED)
  assert.equal(r.waterfall_invoked, false)
  const stored = supabase._rows.get(`${PROPERTY}|${A}`)
  assert.equal(stored.suppression_scope, 'channel_compliance')
})

// ── Journey F — webhook replay ─────────────────────────────────────────────

test('Journey F: the same inbound delivered twice yields one durable outcome', async () => {
  const supabase = makeSupabase({ phones: [phoneRow(B)] })
  const first = await CALL(supabase)
  const second = await CALL(supabase)

  assert.equal(first.action, second.action)
  assert.equal(supabase.writes, 1, 'replay must not create a second row')
  assert.equal(supabase._rows.size, 1)
  assert.equal(second.sends, 0)
})

test('Journey F: replaying a referral 10x yields one referred identity', async () => {
  const supabase = makeSupabase({ phones: [] })
  for (let i = 0; i < 10; i += 1) {
    const r = await CALL(supabase, {
      relationship: { relationship_outcome: 'property_specific_non_owner_with_referral' },
      referral: { referral_detected: true, referred_phone_e164: '+13055551234', referred_name: 'John' },
    })
    assert.equal(r.sends, 0)
  }
  // one source row + one referred row
  assert.equal(supabase._rows.size, 2)
  assert.equal(supabase.writes, 2)
})

// ── Owner confirmed ────────────────────────────────────────────────────────

test('Journey: ownership confirmed persists the role and runs no waterfall', async () => {
  const supabase = makeSupabase({ phones: [phoneRow(B)] })
  const r = await CALL(supabase, { relationship: { relationship_outcome: 'ownership_confirmed' } })
  assert.equal(r.action, RESOLUTION_ACTION.CONTINUE_CURRENT)
  assert.equal(r.contact_property_role, CONTACT_PROPERTY_ROLE.CONFIRMED_OWNER)
  const stored = supabase._rows.get(`${PROPERTY}|${A}`)
  assert.equal(stored.rejected_at, null, 'a confirmed owner must not be rejected')
})

// ── Fail-closed ────────────────────────────────────────────────────────────

test('V2-1B: a persist failure yields review and NO next contact', async () => {
  const broken = {
    from: () => ({
      select: () => ({ eq: () => ({ range: async () => ({ data: [], error: null }) }) }),
      upsert: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }) }),
    }),
  }
  const r = await CALL(broken)
  assert.equal(r.reason, 'persist_failed')
  assert.equal(r.requires_review, true)
  assert.equal(r.next_contact, undefined)
  assert.equal(r.sends, 0)
})

test('V2-1B: events emitted are the canonical contact-resolution vocabulary', async () => {
  const supabase = makeSupabase({ phones: [phoneRow(B)] })
  const r = await CALL(supabase)
  const types = r.events.map((e) => e.type)
  assert.ok(types.includes(EV.OWNERSHIP_CONTACT_REJECTED))
  assert.ok(types.includes(EV.NEXT_PHONE_SELECTED))
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  loadPropertyResolutionState,
  recordContactOutcome,
  recordReferralExecution,
  isReferralExecuted,
  OUTCOME_TO_ROLE,
} from '@/lib/domain/seller-flow/contact-resolution-repository.js'
import {
  resolveNextContactAction,
  S1_CONTACT_OUTCOME,
  RESOLUTION_ACTION,
  CONTACT_PROPERTY_ROLE,
} from '@/lib/domain/seller-flow/contact-resolution-waterfall.js'
import { planReferralExecution } from '@/lib/domain/seller-flow/referral-proposal-executor.js'
import { deriveS1Outcome, RELATIONSHIP_TO_S1_OUTCOME } from '@/lib/domain/seller-flow/resolve-contact-outcome-phase.js'

/**
 * V2-1B — cross-process durability.
 *
 * The point is that a rejection survives the death of the runtime. These tests
 * therefore never carry a rejection forward in a JS variable: every "new
 * process" re-reads the store from scratch, exactly as a cold container would.
 *
 * The store is a faithful stand-in for the migrated table: keyed on
 * (property_id, contact_phone_e164) with the same upsert semantics and the
 * same partial-unique behaviour on referral_identity_key. A real-database run
 * is reported separately in the pass notes; this suite has to stay hermetic
 * because the critical suite forbids live network access.
 */

function makeStore() {
  const rows = new Map()          // `${property}|${phone}` -> row
  const referralKeys = new Map()  // identity_key -> row

  const api = {
    inserts: 0,
    from(table) {
      if (table !== 'contact_property_resolution') {
        return { select: () => ({ eq: () => ({ range: async () => ({ data: [], error: null }) }) }) }
      }
      return {
        select: (_cols) => ({
          eq: (col, val) => ({
            range: async () => ({
              data: [...rows.values()].filter((r) => r[col] === val),
              error: null,
            }),
            maybeSingle: async () => ({
              data: [...rows.values()].find((r) => r[col] === val) ?? null,
              error: null,
            }),
          }),
        }),
        upsert: (row, opts = {}) => ({
          select: () => ({
            maybeSingle: async () => {
              const onReferralKey = String(opts.onConflict || '').includes('referral_identity_key')
              if (onReferralKey && row.referral_identity_key) {
                const existing = referralKeys.get(row.referral_identity_key)
                if (existing) return { data: existing, error: null }
              }
              const key = `${row.property_id}|${row.contact_phone_e164}`
              const prior = rows.get(key)
              const merged = {
                id: prior?.id ?? `row-${rows.size + 1}`,
                created_at: prior?.created_at ?? '2026-09-12T00:00:00Z',
                ...prior,
                ...row,
                // rejected_at is sticky: once a pairing is ruled out a later
                // turn must not silently un-reject it.
                rejected_at: row.rejected_at ?? prior?.rejected_at ?? null,
              }
              if (!prior) api.inserts += 1
              rows.set(key, merged)
              if (merged.referral_identity_key) referralKeys.set(merged.referral_identity_key, merged)
              return { data: merged, error: null }
            },
          }),
        }),
      }
    },
    _rows: rows,
  }
  return api
}

const PROPERTY = 'prop-durable-1'
const A = '+13050000001'
const B = '+13050000002'
const C = '+13050000003'
const W = (phone, over = {}) => ({ phone_e164: phone, phone_type: 'W', ...over })
const POOL = () => [
  W(A, { is_best_phone_for_owner: true, best_phone_score: 90 }),
  W(B, { best_phone_score: 70 }),
  W(C, { best_phone_score: 50 }),
]

/** A fresh "process": nothing but the store crosses the boundary. */
async function newProcessResolve(store, { rejectPhone, outcome = S1_CONTACT_OUTCOME.NOT_OWNER, emails = [] }) {
  if (rejectPhone) {
    await recordContactOutcome(store, {
      property_id: PROPERTY, contact_phone_e164: rejectPhone, outcome,
      suppression_scope: 'contact_property_pair',
    })
  }
  const state = await loadPropertyResolutionState(store, PROPERTY)
  assert.equal(state.ok, true)
  return resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.NOT_OWNER,
    property_id: PROPERTY,
    current_phone: rejectPhone,
    phones: POOL().filter((p) => p.phone_e164 !== rejectPhone),
    emails,
    rejected_phones: state.rejected_phones,
    suppressed_phones: state.suppressed_phones,
  })
}

// ── The core durability walk (§6) ──────────────────────────────────────────

test('V2-1B DURABILITY: A rejected in process 1 is still excluded in process 2', async () => {
  const store = makeStore()

  const p1 = await newProcessResolve(store, { rejectPhone: A })
  assert.equal(p1.action, RESOLUTION_ACTION.START_NEXT_PHONE)
  assert.equal(p1.next_contact.phone_e164, B)

  // New process: the ONLY thing carried over is the store.
  const state = await loadPropertyResolutionState(store, PROPERTY)
  assert.ok(state.rejected_phones.includes(A), 'A must be durably rejected')

  const p2 = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.NOT_OWNER,
    property_id: PROPERTY,
    current_phone: null,
    phones: POOL(),
    rejected_phones: state.rejected_phones,
  })
  assert.notEqual(p2.next_contact.phone_e164, A, 'A must never be reselected')
  assert.equal(p2.next_contact.phone_e164, B)
})

test('V2-1B DURABILITY: A→B→C→email→exhausted entirely from stored state', async () => {
  const store = makeStore()

  const afterA = await newProcessResolve(store, { rejectPhone: A })
  assert.equal(afterA.next_contact.phone_e164, B)

  const afterB = await newProcessResolve(store, { rejectPhone: B })
  assert.equal(afterB.next_contact.phone_e164, C, 'A and B both skipped from the store')

  const afterC = await newProcessResolve(store, {
    rejectPhone: C, emails: [{ email: 'owner@example.com' }],
  })
  assert.equal(afterC.action, RESOLUTION_ACTION.EMAIL_FALLBACK)
  assert.equal(afterC.next_contact.email, 'owner@example.com')

  const finalState = await loadPropertyResolutionState(store, PROPERTY)
  assert.deepEqual(finalState.rejected_phones.sort(), [A, B, C].sort())

  const exhausted = resolveNextContactAction({
    outcome: S1_CONTACT_OUTCOME.NOT_OWNER,
    property_id: PROPERTY,
    current_phone: null,
    phones: POOL(),
    emails: [],
    rejected_phones: finalState.rejected_phones,
  })
  assert.equal(exhausted.action, RESOLUTION_ACTION.EXHAUSTED)
  assert.equal(exhausted.property_opportunity_terminated, false)
  assert.equal(exhausted.seller_interest_implied, null)
})

test('V2-1B: the role survives the restart, not just the rejection flag', async () => {
  const store = makeStore()
  await recordContactOutcome(store, {
    property_id: PROPERTY, contact_phone_e164: A, outcome: S1_CONTACT_OUTCOME.FORMER_OWNER,
  })
  const state = await loadPropertyResolutionState(store, PROPERTY)
  assert.equal(state.roles.get(A).role, CONTACT_PROPERTY_ROLE.FORMER_OWNER)
})

test('V2-1B: rejection is sticky — a later turn cannot un-reject a pairing', async () => {
  const store = makeStore()
  await recordContactOutcome(store, { property_id: PROPERTY, contact_phone_e164: A, outcome: S1_CONTACT_OUTCOME.NOT_OWNER })
  // A later, weaker signal for the same pairing.
  await recordContactOutcome(store, { property_id: PROPERTY, contact_phone_e164: A, outcome: 'something_else' })
  const state = await loadPropertyResolutionState(store, PROPERTY)
  assert.ok(state.rejected_phones.includes(A), 'rejection must persist')
})

test('V2-1B: an unknown historical contact stays unknown', async () => {
  const store = makeStore()
  const state = await loadPropertyResolutionState(store, PROPERTY)
  assert.equal(state.ok, true)
  assert.equal(state.row_count, 0)
  assert.equal(state.roles.get(A), undefined, 'absence must not be read as a role')
  assert.equal(state.rejected_phones.length, 0)
})

test('V2-1B: an owner-confirmed pairing is NOT rejected', async () => {
  const store = makeStore()
  await recordContactOutcome(store, { property_id: PROPERTY, contact_phone_e164: A, outcome: S1_CONTACT_OUTCOME.OWNER_CONFIRMED })
  const state = await loadPropertyResolutionState(store, PROPERTY)
  assert.equal(state.roles.get(A).role, CONTACT_PROPERTY_ROLE.CONFIRMED_OWNER)
  assert.equal(state.rejected_phones.includes(A), false)
})

test('V2-1B: rejection is scoped to ONE property, never the owner', async () => {
  // The grain defect this migration exists to avoid: rejecting A for property
  // 1 must leave A eligible for property 2.
  const store = makeStore()
  await recordContactOutcome(store, { property_id: 'prop-1', contact_phone_e164: A, outcome: S1_CONTACT_OUTCOME.NOT_OWNER })
  const other = await loadPropertyResolutionState(store, 'prop-2')
  assert.equal(other.rejected_phones.includes(A), false, 'rejection leaked across properties')
})

// ── Referral durability + idempotency (§5) ─────────────────────────────────

const REFERRAL = {
  id: 'ref-d1',
  property_id: PROPERTY,
  source_contact_phone: A,
  referred_phone_e164: '+13055551234',
  referred_name: 'John Smith',
}

test('V2-1B IDEMPOTENT: the same referral processed 10 times yields one identity', async () => {
  const store = makeStore()
  for (let i = 0; i < 10; i += 1) {
    const plan = planReferralExecution(REFERRAL, {})
    const written = await recordReferralExecution(store, plan, { property_id: PROPERTY })
    assert.equal(written.ok, true)
    assert.equal(written.sends ?? 0, 0)
  }
  const state = await loadPropertyResolutionState(store, PROPERTY)
  const referred = [...state.roles.keys()].filter((k) => k === '+13055551234')
  assert.equal(referred.length, 1, 'exactly one referred contact row')
  assert.equal(store.inserts, 1, 'exactly one insert across 10 executions')
})

test('V2-1B: referral execution survives a restart and reports executed', async () => {
  const store = makeStore()
  const plan = planReferralExecution(REFERRAL, {})
  await recordReferralExecution(store, plan, { property_id: PROPERTY })

  const check = await isReferralExecuted(store, plan.identity_key)
  assert.equal(check.executed, true)
})

test('V2-1B: referral provenance survives the restart', async () => {
  const store = makeStore()
  const plan = planReferralExecution(REFERRAL, {})
  await recordReferralExecution(store, plan, { property_id: PROPERTY })
  const state = await loadPropertyResolutionState(store, PROPERTY)
  const row = state.roles.get('+13055551234')
  assert.equal(row.contact_origin, 'referral')
})

test('V2-1B: the referred contact is a CANDIDATE, not a rejected one', async () => {
  const store = makeStore()
  const plan = planReferralExecution(REFERRAL, {})
  await recordReferralExecution(store, plan, { property_id: PROPERTY })
  const state = await loadPropertyResolutionState(store, PROPERTY)
  assert.equal(state.rejected_phones.includes('+13055551234'), false)
  assert.equal(state.roles.get('+13055551234').role, CONTACT_PROPERTY_ROLE.UNKNOWN)
})

test('V2-1B: an invalid referral is never persisted', async () => {
  const store = makeStore()
  const plan = planReferralExecution({ ...REFERRAL, referred_phone_e164: A }, {}) // self-referral
  const written = await recordReferralExecution(store, plan, { property_id: PROPERTY })
  assert.equal(written.ok, false)
  assert.equal(store.inserts, 0)
})

// ── Fail-closed behaviour ──────────────────────────────────────────────────

test('V2-1B FAIL CLOSED: an unreadable store never yields a selection', async () => {
  const broken = {
    from: () => ({
      select: () => ({ eq: () => ({ range: async () => ({ data: null, error: { message: 'boom' } }) }) }),
    }),
  }
  const state = await loadPropertyResolutionState(broken, PROPERTY)
  assert.equal(state.ok, false)
  assert.equal(state.reason, 'resolution_state_unreadable')
  assert.deepEqual(state.rejected_phones, [], 'must not report an empty exclusion set as authoritative')
})

test('V2-1B: a write without identity is refused', async () => {
  const store = makeStore()
  const r = await recordContactOutcome(store, { property_id: '', contact_phone_e164: A, outcome: 'not_owner' })
  assert.equal(r.ok, false)
  assert.equal(store.inserts, 0)
})

// ── Phase mapping (§4) ─────────────────────────────────────────────────────

test('V2-1B: opt-out outranks the relationship outcome', async () => {
  // Both "not my house" AND "stop". Compliance must win, or the waterfall runs
  // off the back of an opt-out.
  const outcome = deriveS1Outcome({
    canonical_intent: 'opt_out',
    relationship_outcome: 'property_specific_non_owner',
  })
  assert.equal(outcome, S1_CONTACT_OUTCOME.OPT_OUT)
})

test('V2-1B: a non-owner WITH a referral maps to the referral branch', () => {
  assert.equal(
    deriveS1Outcome({ relationship_outcome: 'property_specific_non_owner', referral_detected: true }),
    S1_CONTACT_OUTCOME.REFERRAL
  )
})

test('V2-1B: every canonical relationship outcome maps to a known S1 outcome', () => {
  const valid = new Set(Object.values(S1_CONTACT_OUTCOME))
  for (const [rel, s1] of Object.entries(RELATIONSHIP_TO_S1_OUTCOME)) {
    assert.ok(valid.has(s1), `${rel} maps to unknown outcome ${s1}`)
  }
})

test('V2-1B: an unrecognised relationship outcome yields no action', () => {
  assert.equal(deriveS1Outcome({ relationship_outcome: 'something_new' }), null)
})

test('V2-1B: every outcome maps to a durable role', () => {
  for (const outcome of Object.values(S1_CONTACT_OUTCOME)) {
    assert.ok(OUTCOME_TO_ROLE[outcome], `${outcome} has no durable role`)
  }
})

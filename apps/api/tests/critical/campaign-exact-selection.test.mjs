import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyExactSelection,
  previewExactSelection,
  normalizeSelectionIds,
} from '@/lib/domain/campaigns/campaign-exact-selection.js'

// Fixture rows mirror the production campaign_target_graph state of the three
// South Florida acceptance properties (2026-10-08): verified identity, wireless,
// queue_eligible, first contact, Miami sender market. Phones are fictitious.
const base = {
  identity_alignment: 'verified',
  phone_type: 'W',
  sms_eligible: true,
  queue_eligible: true,
  never_contacted: true,
  timezone: 'America/New_York',
  sender_market: 'Miami, FL',
  blocker_flags: { vendor_dnc: false },
}
const SOUTH_FLORIDA = [
  { ...base, graph_id: 'g1', property_id: '227990249', property_address_full: '520 Nw 17th Ave, Fort Lauderdale, Fl 33311', owner_name: 'Doris L Campbell', seller_person_key: 'pk1', canonical_e164: '+13055550001', acquisition_score: 70 },
  { ...base, graph_id: 'g2', property_id: '232476849', property_address_full: '376 Nw 80th St, Miami, Fl 33150', owner_name: 'Jean E Meme & Hedrithe Lucas', seller_person_key: 'pk2', canonical_e164: '+13055550002', acquisition_score: 65 },
  { ...base, graph_id: 'g3', property_id: '232481638', property_address_full: '3101 Nw 66th St, Miami, Fl 33147', owner_name: 'Miguel Lainez & Mirna Maradiago', seller_person_key: 'pk3', canonical_e164: '+13055550003', acquisition_score: 60 },
]
const UNRELATED = { ...base, graph_id: 'gx', property_id: '999999999', property_address_full: 'Unrelated', seller_person_key: 'pkx', canonical_e164: '+13055550099' }
const REQUESTED = ['227990249', '232476849', '232481638']

function stub(rows, { misbehave = false, error = null } = {}) {
  return {
    from() {
      return {
        select() { return this },
        in(col, ids) {
          if (error) return Promise.resolve({ data: null, error })
          const data = misbehave ? rows : rows.filter((r) => ids.includes(r[col]))
          return Promise.resolve({ data, error: null })
        },
      }
    },
  }
}

test('ACCEPTANCE: the South Florida preview contains exactly the three requested properties', async () => {
  const result = await previewExactSelection({ property_ids: REQUESTED }, { supabase: stub([...SOUTH_FLORIDA, UNRELATED]) })
  assert.equal(result.ok, true)
  assert.equal(result.requested_count, 3)
  assert.equal(result.outcome_count, 3)
  assert.equal(result.outside_selection_count, 0)
  assert.deepEqual(result.results.map((r) => r.property_id), REQUESTED)
  assert.deepEqual(result.counts, { included: 3, excluded: 0, held: 0, duplicate: 0, unresolved: 0 })
  assert.equal(result.no_send_queue_rows_created, true)
  assert.deepEqual(result.target_filter, { field_key: 'properties.property_id', operator: 'in', value: REQUESTED })
})

test('rows outside the selection are an integrity failure, never included', async () => {
  const result = await previewExactSelection({ property_ids: REQUESTED }, { supabase: stub([...SOUTH_FLORIDA, UNRELATED], { misbehave: true }) })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'rows_outside_selection')
  assert.equal(result.results.some((r) => r.property_id === '999999999'), false)
})

test('every requested property gets exactly one outcome with an explicit reason', () => {
  const rows = [
    SOUTH_FLORIDA[0],
    { ...SOUTH_FLORIDA[1], active_queue_item: true },                                     // held
    { ...SOUTH_FLORIDA[2], queue_eligible: false, queue_block_reason: 'suppressed' },       // excluded
    { ...base, property_id: 'dup', seller_person_key: 'pk9', canonical_e164: '3055550001', acquisition_score: 1 }, // duplicate of 227990249
    { ...base, property_id: 'nophone', seller_person_key: 'pk8', canonical_e164: null, queue_block_reason: 'missing_phone' }, // unresolved
  ]
  const r = classifyExactSelection([...REQUESTED, 'dup', 'nophone', 'absent'], rows)
  const by = Object.fromEntries(r.results.map((x) => [x.property_id, x]))
  assert.equal(by['227990249'].status, 'included')
  assert.equal(by['232476849'].status, 'held')
  assert.equal(by['232476849'].reason, 'active_queue_item')
  assert.equal(by['232481638'].status, 'excluded')
  assert.equal(by['232481638'].reason, 'suppressed')
  assert.equal(by.dup.status, 'duplicate')
  assert.equal(by.dup.reason, 'same_recipient_as:227990249')
  assert.equal(by.nophone.status, 'unresolved')
  assert.equal(by.absent.status, 'unresolved')
  assert.equal(by.absent.reason, 'not_in_campaign_graph')
  assert.equal(r.outcome_count, 6)
})

test('selection ids are trimmed and deduplicated, order preserved', () => {
  assert.deepEqual(normalizeSelectionIds([' a ', 'b', 'a', '', null, 'c']), ['a', 'b', 'c'])
})

test('cohort scope confirmation: a changed cohort is refused', async () => {
  const r = await previewExactSelection({ property_ids: REQUESTED, cohort_confirmation: { confirmed_count: 2 } }, { supabase: stub(SOUTH_FLORIDA) })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'cohort_count_changed')
})

test('empty selection and graph errors fail without guessing', async () => {
  assert.equal((await previewExactSelection({ property_ids: [] }, { supabase: stub([]) })).error, 'empty_selection')
  assert.equal((await previewExactSelection({ property_ids: REQUESTED }, { supabase: stub([], { error: { message: 'down' } }) })).error, 'campaign_graph_unavailable')
})

test('vendor DNC is reported as an advisory, with unknown preserved', () => {
  const r = classifyExactSelection(['x'], [{ ...base, property_id: 'x', seller_person_key: 'p', canonical_e164: '+13055550123', blocker_flags: {} }])
  assert.equal(r.results[0].vendor_dnc_advisory, 'unknown')
})

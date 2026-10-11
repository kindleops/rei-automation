import test from 'node:test'
import assert from 'node:assert/strict'
import {
  linkSaleToOwner, classifyOwner, inferSale, emptyMatrix, addToMatrix, validationStats, inferredInvestorLabel, saleBuyerOfRecord,
  TIERS, INVESTOR_TIERS, LINK_RULE,
} from '../../src/lib/domain/market-intelligence/mi-inferred-investor.js'
import { resolveSaleOwnerRow, saleOwnerIds, salePropertyKeys, createSaleOwnerReader } from '../../src/lib/domain/market-intelligence/mi-sale-owner.js'


test('link: only the most recent sale with no later transfer and a post-recording owner snapshot inherits today\'s owner', () => {
  const base = { propertyId: 'p1', soldOn: '2025-06-01', isLatestSale: true, laterTransferOn: null, ownerObservedOn: '2026-08-15' }
  assert.deepEqual(linkSaleToOwner(base), { linked: true, reason: 'linked' })
  assert.equal(linkSaleToOwner({ ...base, propertyId: null }).reason, 'no_property')
  assert.equal(linkSaleToOwner({ ...base, isLatestSale: false }).reason, 'not_latest_sale')
  // a later recording of the SAME transaction (≤ 45 days) does not break the link; a real later transfer does
  assert.equal(linkSaleToOwner({ ...base, laterTransferOn: '2025-07-10' }).reason, 'linked')
  assert.equal(linkSaleToOwner({ ...base, laterTransferOn: '2025-07-20' }).reason, 'later_transfer')
  assert.equal(linkSaleToOwner({ ...base, ownerObservedOn: null }).reason, 'no_owner_record')
  // an owner snapshot taken before the deed could be recorded may still show the SELLER
  assert.equal(linkSaleToOwner({ ...base, soldOn: '2026-08-01' }).reason, 'owner_snapshot_before_sale')
  assert.equal(linkSaleToOwner({ ...base, soldOn: '2026-07-16' }).reason, 'linked') // exactly the lag
  assert.equal(LINK_RULE.recording_lag_days, 30)
})

test('tiers: strong / likely / trust / absentee-only / no signal, each with its evidence', () => {
  const t = (sig) => classifyOwner(sig).tier
  assert.equal(t({ corporate: true, outOfState: true }), 'strong')
  assert.equal(t({ corporate: true, mailStack: 2 }), 'strong')
  assert.equal(t({ mailStack: 3 }), 'likely') // a stack is an individual's ONLY signal → Likely (owner decision)
  assert.equal(t({ mailStack: 12, outOfState: true }), 'strong')
  assert.equal(t({ corporate: true }), 'likely') // an LLC alone is only LIKELY (brief §48)
  assert.equal(t({ outOfState: true, mailStack: 2 }), 'likely')
  assert.equal(t({ trust: true }), 'trust_estate') // trusts are their own class, not investor by default
  assert.equal(t({ trust: true, outOfState: true, mailStack: 2 }), 'trust_estate')
  assert.equal(t({ trust: true, mailStack: 5 }), 'likely') // …unless they stack
  assert.equal(t({ outOfState: true }), 'absentee_only')
  assert.equal(t({ mailStack: 2 }), 'no_signal') // an in-state pair (a household) is not investor evidence
  assert.equal(t({}), 'no_signal')
  assert.equal(t({ mailStack: 4, residentOwner: true }), 'no_signal') // the owner lives there
  assert.equal(t({ corporate: true, residentOwner: true }), 'likely')
  assert.deepEqual(classifyOwner({ corporate: true, outOfState: true, mailStack: 7 }).evidence, ['entity_owner', 'out_of_state_mailing', 'mailing_stack_3_plus'])
  assert.deepEqual(INVESTOR_TIERS, ['strong', 'likely'])
  assert.equal(inferSale({ propertyId: 'p', soldOn: '2025-01-01', isLatestSale: false, corporate: true }).tier, null)
})

test('validation: confusion matrix → precision / recall against recorded investor buyers', () => {
  const m = emptyMatrix()
  for (let i = 0; i < 80; i += 1) addToMatrix(m, 'strong', true)
  for (let i = 0; i < 10; i += 1) addToMatrix(m, 'likely', false)
  for (let i = 0; i < 20; i += 1) addToMatrix(m, 'no_signal', true)
  for (let i = 0; i < 890; i += 1) addToMatrix(m, 'no_signal', false)
  const v = validationStats(m)
  assert.equal(v.tp, 80); assert.equal(v.fp, 10); assert.equal(v.fn, 20); assert.equal(v.tn, 890)
  assert.equal(v.precision, 80 / 90)
  assert.equal(v.recall, 0.8)
  assert.equal(v.tiers.strong.precision, 1)
  assert.equal(validationStats(emptyMatrix()).precision, null)
})

test('label: unmistakable, with base and validation; never a bare share', () => {
  assert.equal(inferredInvestorLabel({ share: 0.41, linked: 210_000, precision: 0.87, validationN: 9000 }),
    'Inferred investor (owner-based) · 41% of 210K linked sales · validated 87% precision vs recorded buyers')
  assert.equal(inferredInvestorLabel({ share: 0.2, linked: 1500, precision: null, validationN: 0 }), 'Inferred investor (owner-based) · 20% of 1.5K linked sales · not validated')
})

test('buyer of record: deed buyer first; else today\'s owner when linked; persons never named; else "Buyer not on record"', () => {
  const name = (x) => (/LLC|INC|HOLDINGS/.test(x) ? x : null)
  assert.equal(saleBuyerOfRecord({ buyer: 'ACME HOLDINGS LLC', buyer_kind: 'company' }, null, name).label, 'ACME HOLDINGS LLC')
  assert.equal(saleBuyerOfRecord({ buyer: null, buyer_kind: 'person' }, null, name).label, 'Individual buyer')
  assert.equal(saleBuyerOfRecord({}, { linked: false, reason: 'not_latest_sale' }, name).label, 'Buyer not on record')
  const linked = { linked: true, reason: 'linked' }
  assert.equal(saleBuyerOfRecord({}, { ...linked, corporate: true }, name).label, 'Company (name not on record) · current owner of record')
  assert.equal(saleBuyerOfRecord({}, { ...linked, corporate: true, ownerName: 'BLUE OAK HOLDINGS LLC' }, name).label, 'BLUE OAK HOLDINGS LLC · current owner of record')
  assert.equal(saleBuyerOfRecord({}, { ...linked, residentOwner: true }, name).label, 'Individual (owner-occupant) · current owner of record')
  assert.equal(saleBuyerOfRecord({}, { ...linked, outOfState: true }, name).label, 'Individual (absentee · out-of-state mailing) · current owner of record')
  const indiv = saleBuyerOfRecord({}, { ...linked, ownerName: 'JOHN SMITH' }, name)
  assert.equal(indiv.label, 'Individual (occupancy not on record) · current owner of record')
  assert.equal(indiv.name, null)
})

test('sale-owner resolver: one row → link, tier and display buyer; ids are validated and capped', async () => {
  const row = { comp_id: 't:1', property_id: 'p1', sold_on: '2025-03-01', buyer: null, buyer_kind: null, is_latest_sale: true, later_transfer_on: null, owner_observed_on: '2026-08-20',
    is_corporate_owner: true, is_trust: false, out_of_state_owner: true, mail_stack: 14, resident_owner: false, owner_name: 'JANE DOE' }
  const r = resolveSaleOwnerRow(row)
  assert.equal(r.owner_link.linked, true)
  assert.equal(r.inferred.tier, 'strong')
  assert.equal(r.buyer_of_record.label, 'Company (name not on record) · current owner of record') // a person-like name is withheld
  const resold = resolveSaleOwnerRow({ ...row, is_latest_sale: false })
  assert.equal(resold.buyer_of_record.label, 'Buyer not on record')
  assert.equal(resold.inferred, null)
  assert.deepEqual(saleOwnerIds('t:1, p:abc ,bad id,t:1'), ['t:1', 'p:abc'])
  assert.equal(saleOwnerIds(Array.from({ length: 300 }, (_, i) => `t:${i}`)).length, 100)
  const calls = []
  const read = createSaleOwnerReader({ query: async (sql, params) => { calls.push(params); return { rows: [row] } } })
  const map = await read('t:1')
  assert.equal(map.get('t:1').inferred.tier, 'strong')
  assert.deepEqual(calls[0], [['t:1']])
  // Comp Intelligence rows: property id + sale date
  assert.deepEqual(salePropertyKeys('P-9@2025-03-01, bad, P-9@2025-03-01'), { keys: ['P-9@2025-03-01'], ids: ['P-9'], dates: ['2025-03-01'] })
  const byProp = await read.byProperty('p1@2025-03-01')
  assert.deepEqual(calls[1], [['p1'], ['2025-03-01']])
  assert.equal(byProp.size, 1)
})


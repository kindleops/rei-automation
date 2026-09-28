/**
 * BUYER MATCH workspace — the rules that decide who is shown as a buyer, in
 * what tier, and why. Pinned to production cases measured 2026-09-28.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyBuyer, contactability, dispositionWindow, displayableCompanyName, evidenceLines, familyFit, identityTier,
  lenderClass, priceFit, rankBuyers, recencyFit, subjectFamily,
} from '../../src/lib/domain/buyer-match/buyer-match-workspace-service.js'
import { latestRunCandidates } from '../../src/lib/domain/buyer-match/buyer-identity-rules.js'

const window = dispositionWindow({ value: 324000 })
const ctx = { family: 'single_family', window, subject: { sqft: 1400 }, radius: 5, months: 36, zip: '85033', countyLabel: 'Maricopa County' }
const zak = {
  buyer_id: 'company:us_az:L10511200', kind: 'company', name: 'ZAK VENTURES L.L.C.', identity_method: 'exact_registry_company_identity', registry: true,
  acquisitions: 16, dispositions: 6, days_since_last: 33, t90: 14, t365: 16, last_acquisition: '2026-06-25',
  dominant_family: 'sfr', families: ['sfr'], price_p25: 225000, price_p50: 245000, price_p75: 1117000, cash_share: 0.625,
  county_purchases: 16, foreclosure_deeds: 0, linked_transactions: 16,
  near: { n: 9, same_family: 9, n_1mi: 1, same_zip: 3, nearest_miles: 0.79, last_date: '2026-05-28', median_price: 250000, cash_share: 1 },
}

test('a repeat local cash buyer with same-type purchases in range is a strong match, explained by counts', () => {
  const c = classifyBuyer(zak, ctx)
  assert.equal(c.tier, 'strong')
  const lines = evidenceLines(zak, c, ctx).map((l) => l.text)
  assert.ok(lines.includes('9 single family purchases within 5 mi'))
  assert.ok(lines.includes('3 purchases in ZIP 85033'))
  assert.ok(lines.includes('Last purchase 33 days ago'))
  assert.ok(lines.includes('100% cash nearby'))
})

test('lenders, servicers, GSEs and agencies are never disposition buyers — with the measured deed share', () => {
  for (const name of ['Secretary Of Veterans Affairs', 'Secretary Of Housing And Urban Development', 'FEDERAL NATIONAL MORTGAGE ASSOCIATION', 'WELLS FARGO BANK, N.A.', 'LAKEVIEW LOAN SERVICING, LLC', 'Wilmington Savings Fund Society, FSB', 'Navy Federal Credit Union', 'State Of Texas', 'VMC REO, LLC', 'DATA MORTGAGE, INC.', 'Freedom Mortgage Corporation']) {
    assert.ok(lenderClass(name), name)
  }
  for (const name of ['ZAK VENTURES L.L.C.', 'Bank Street Holdings LLC', 'Estate Of Smith Investments LLC', 'Opendoor Property Trust I']) {
    assert.equal(lenderClass(name), null, name)
  }
  const c = classifyBuyer({ ...zak, name: 'FEDERAL NATIONAL MORTGAGE ASSOCIATION', foreclosure_deeds: 49, linked_transactions: 52 }, ctx)
  assert.equal(c.tier, 'excluded')
  assert.match(c.exclusions[0].label, /49 of 52 acquisitions were foreclosure deeds/)
})

test('a third-party investor buying at auction is kept and labelled, not excluded', () => {
  const b = { ...zak, name: 'Auction Buyers LLC', foreclosure_deeds: 12, linked_transactions: 16 }
  const c = classifyBuyer(b, ctx)
  assert.notEqual(c.tier, 'excluded')
  assert.ok(evidenceLines(b, c, ctx).some((l) => l.text === 'Buys at foreclosure auction'))
})

test('one-time individual buyers are owner-occupant signals — never listed', () => {
  assert.equal(classifyBuyer({ ...zak, kind: 'person', name: null, acquisitions: 1 }, ctx), null)
  assert.ok(classifyBuyer({ ...zak, kind: 'person', name: null, acquisitions: 3 }, ctx))
})

test('asset type, recency and price produce named why-not reasons', () => {
  const sfrBuyer = { ...zak, near: { n: 0, same_family: 0 } }
  const apt = classifyBuyer(sfrBuyer, { ...ctx, family: 'apartment' })
  assert.equal(apt.tier, 'excluded')
  assert.equal(apt.exclusions[0].code, 'type_mismatch')
  assert.equal(classifyBuyer({ ...zak, days_since_last: 900 }, ctx).exclusions.at(-1).code, 'stale')
  const cheap = classifyBuyer({ ...zak, price_p25: 120000, price_p75: 160000 }, ctx)
  assert.equal(cheap.exclusions.at(-1).code, 'price_outside')
})

test('price fit is overlap of the observed band with the offer→value window', () => {
  assert.deepEqual(dispositionWindow({ value: 300000, offer: 200000 }), { low: 200000, high: 300000, basis: 'offer_to_value' })
  assert.equal(priceFit({ price_p25: 150000, price_p75: 210000 }, { low: 200000, high: 300000 }).verdict, 'inside')
  assert.equal(priceFit({ price_p25: 120000, price_p75: 170000 }, { low: 200000, high: 300000 }).verdict, 'near')
  assert.equal(priceFit({ price_p25: 50000, price_p75: 90000 }, { low: 200000, high: 300000 }).verdict, 'outside')
  assert.equal(priceFit({}, { low: 1, high: 2 }).verdict, 'unknown')
  assert.equal(recencyFit(20), 'active')
  assert.equal(recencyFit(800), 'stale')
})

test('asset families bridge the W8C and transaction vocabularies', () => {
  assert.equal(familyFit({ dominant_family: 'sfr', families: ['sfr'] }, 'single_family'), 'dominant')
  assert.equal(familyFit({ dominant_family: 'sfr', families: ['sfr', 'small_multifamily_2_4'] }, 'multifamily'), 'present')
  assert.equal(familyFit({ dominant_family: 'sfr', families: ['sfr'] }, 'apartment'), 'absent')
  assert.equal(subjectFamily({ asset_family: 'multifamily', units: 24 }), 'apartment')
  assert.equal(subjectFamily({ asset_family: 'multifamily', units: 2 }), 'multifamily')
  assert.equal(subjectFamily({ asset_family: 'residential' }), 'single_family')
})

test('personal names on registry "company" entities are withheld', () => {
  assert.equal(displayableCompanyName('WILLIAMS,MICHAEL'), null)
  assert.equal(displayableCompanyName('Michael Williams'), null)
  assert.equal(displayableCompanyName('Holley Construction, LLC'), 'Holley Construction, LLC')
  assert.equal(displayableCompanyName('ZAK VENTURES L.L.C.'), 'ZAK VENTURES L.L.C.')
})

test('identity evidence keeps its tier; contactability is never inferred from a name', () => {
  assert.equal(identityTier('exact_registry_company_identity').tier, 'registry')
  assert.equal(identityTier('seller_transaction_company_corroboration').tier, 'corroborated')
  assert.equal(identityTier('property_linked_contact_tokenset').tier, 'engine')
  assert.equal(contactability({ kind: 'company', registry: true }).state, 'company_identity_only')
  assert.equal(contactability({ kind: 'person' }).state, 'none')
})

test('ranking: tier first, then same-type nearby purchases, then 12-month activity', () => {
  const r = rankBuyers([
    { id: 'a', tier: 'moderate', nearby: { sameFamily: 9 }, activity: { t365: 1 } },
    { id: 'b', tier: 'strong', nearby: { sameFamily: 2 }, activity: { t365: 3 } },
    { id: 'c', tier: 'strong', nearby: { sameFamily: 2 }, activity: { t365: 9 } },
  ])
  assert.deepEqual(r.map((x) => x.id), ['c', 'b', 'a'])
})

test('property-level buyer counts read the newest match run only, without foreclosure grantees', () => {
  const rows = [
    { buyer_match_run_id: 'old', created_at: '2026-09-01', buyer_display_name: 'A LLC' },
    { buyer_match_run_id: 'old', created_at: '2026-09-01', buyer_display_name: 'B LLC' },
    { buyer_match_run_id: 'new', created_at: '2026-09-18', buyer_display_name: 'A LLC' },
    { buyer_match_run_id: 'new', created_at: '2026-09-18', buyer_display_name: 'Secretary Of Veterans Affairs' },
  ]
  assert.deepEqual(latestRunCandidates(rows).map((r) => r.buyer_display_name), ['A LLC'])
})

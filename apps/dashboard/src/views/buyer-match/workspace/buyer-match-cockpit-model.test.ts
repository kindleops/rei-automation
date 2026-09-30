import { describe, expect, it } from 'vitest'
import type { BuyerMatchWorkspace, MatchedBuyer, WindowTransaction } from '../../../domain/buyer-match/buyer-match-workspace-api'
import type { BuyerProfile } from '../../../domain/entity-graph/entity-graph-intel-api'
import { buildReceipts, fitIndicators, haversineMiles, holdingsOf, modelAsOf, strength, thesis } from './buyer-match-cockpit-model'

/**
 * The cockpit only READS the server's evidence: words are a dictionary over
 * the model's verdicts, the thesis is assembled from flags that passed, and
 * every receipt is a recorded purchase — never a party name.
 */

const SUBJECT = { lat: 29.650232, lng: -95.378956 }

const buyer = (over: Partial<MatchedBuyer> = {}): MatchedBuyer => ({
  id: 'company:us_tx:0803599960',
  kind: 'company',
  name: 'Amplified Properties LLC',
  tier: 'strong',
  exclusions: [],
  evidence: [],
  fit: { type: 'dominant', price: { verdict: 'inside', low: 181212, high: 235244 }, recency: 'active', size: { verdict: 'inside', low: 1278, high: 1671 }, market: 'strong' },
  identity: { tier: 'registry', label: 'Registry resolved', method: 'exact_registry_company_identity', registry: true, jurisdiction: 'us_tx', aliases: 1, confidence: 1 },
  activity: { acquisitions: 15, dispositions: 2, first: '2025-05-23', last: '2026-06-18', daysSince: 40, t90: 13, t180: 14, t365: 14, status: 'active' },
  nearby: { purchases: 5, sameFamily: 5, within1mi: 0, sameZip: 2, nearestMiles: 1.6, last: '2026-06-04', medianPrice: 170107, cashShare: 0 },
  countyPurchases: 15,
  buyBox: { families: ['Single family'], dominant: 'Single family', priceLow: 181212, priceMid: 218386, priceHigh: 235244, sqftLow: 1278, sqftHigh: 1671, beds: 3, units: 1, cashShare: 0, markets: ['TX · Harris'], primaryMarket: 'TX · Harris', topState: 'TX', declared: true },
  behavior: { archetype: 'High-volume buyer', holdFlip: 'Resells (flip-like)', foreclosureDeeds: 0, linkedTransactions: 15 },
  portfolio: { observed: 0, owned: 3, sold: 2, crossover: true },
  recent: [],
  contact: { state: 'company_identity_only', label: 'Registered company — no verified contact' },
  ...over,
})

const row = (over: Partial<WindowTransaction> = {}): WindowTransaction => ({
  txnId: 1496090, buyerId: 'company:us_tx:0803599960', propertyId: '2131284350', lat: 29.663462, lng: -95.357158,
  address: '4637 Brinkley St, Houston, Tx 77051', city: 'Houston', zip: '77051', date: '2026-06-04', price: 161861, nominal: false,
  family: 'Single family', sameFamily: true, beds: 3, baths: 1, sqft: 1318, yearBuilt: 1962, cash: false, docType: 'Deed', miles: 1.6,
  ...over,
})

const workspace = (rows: WindowTransaction[] = [row()]): BuyerMatchWorkspace => ({
  subject: { propertyId: '2130387643', address: '3025 Sunbeam St, Houston, Tx 77051', city: 'Houston', state: 'TX', zip: '77051', county: 'Harris', market: 'Houston, TX', ...SUBJECT, family: 'single_family', familyLabel: 'Single family', propertyType: 'Single Family', units: 1, beds: 4, baths: 2, sqft: 1828, yearBuilt: 1955, value: 219000, valueBasis: 'avm', offer: null, ask: null, stage: null, opportunityId: null, window: { low: 186150, high: 219000, basis: 'value_band' } },
  query: { radiusMiles: 5, months: 36, radiusOptions: [1, 2, 3, 5, 10, 25], monthOptions: [12, 24, 36, 60] },
  transactions: { available: true, reason: null, radiusMiles: 5, months: 36, total: 367, returned: 367, truncated: false, rows },
} as unknown as BuyerMatchWorkspace)

const purchase = (over: Partial<BuyerProfile['purchases'][number]> = {}): BuyerProfile['purchases'][number] => ({
  id: 1496090, date: '2026-06-04', price: 161861, docType: 'Deed', seller: 'SMITH, JANE', cash: false, lender: 'Some Bank NA', propertyId: null, inUniverse: false,
  address: null, lat: null, lng: null, evidence: { basis: 'link', tier: 'resolved' },
  ...over,
} as BuyerProfile['purchases'][number])

const profile = (purchases: BuyerProfile['purchases'], extra: Partial<BuyerProfile> = {}): BuyerProfile => ({ purchases, owned: [], portfolio: [], ...extra } as unknown as BuyerProfile)

describe('strength words are a dictionary over model verdicts — no scores', () => {
  it('maps each verdict to one word and tone', () => {
    expect(strength('price', 'inside')).toEqual({ word: 'Match', tone: 'good' })
    expect(strength('price', 'near')).toEqual({ word: 'Close', tone: 'mid' })
    expect(strength('recency', 'active')).toEqual({ word: 'Current', tone: 'good' })
    expect(strength('market', 'strong')).toEqual({ word: 'Strong evidence', tone: 'good' })
    expect(strength('market', 'county')).toEqual({ word: 'County only', tone: 'mid' })
    expect(strength('size', 'unknown')).toEqual({ word: 'No evidence', tone: 'unk' })
    expect(strength('type', 'something-new')).toEqual({ word: 'No evidence', tone: 'unk' })
  })
  it('row indicators read the five fit verdicts in order', () => {
    const f = fitIndicators(buyer({ fit: { ...buyer().fit, size: { verdict: 'outside' }, market: 'county' } }))
    expect(f.map((x) => `${x.label}:${x.tone}`)).toEqual(['Type:good', 'Price:good', 'Market:mid', 'Recency:good', 'Size:bad'])
  })
})

describe('the thesis is built only from evidence that passed', () => {
  it('reads every passing flag, and no figure beyond the window definitions', () => {
    const t = thesis(buyer(), workspace())
    expect(t).toBe('High-volume buyer — focused on single family in this size range, repeatedly buying within 5 mi, paying inside this deal’s window, and active in the last 90 days.')
    expect(t?.replace(/5 mi|90 days/g, '')).not.toMatch(/\d/)
  })
  it('drops what failed; says nothing when nothing passed', () => {
    const partial = thesis(buyer({ fit: { ...buyer().fit, price: { verdict: 'outside' }, size: { verdict: 'outside' } } }), workspace())
    expect(partial).not.toMatch(/window|size/)
    const none = buyer({ fit: { type: 'unknown', price: { verdict: 'unknown' }, recency: 'stale', size: { verdict: 'unknown' }, market: 'none' } })
    expect(thesis(none, workspace())).toBeNull()
  })
  it('never leads with a contradicting archetype; a ruled-out buyer reads its exclusions', () => {
    expect(thesis(buyer({ behavior: { ...buyer().behavior, archetype: 'Inactive buyer' } }), workspace())).toMatch(/^Buyer — /)
    const out = buyer({ tier: 'excluded', exclusions: [{ code: 'lender_or_agency', label: 'Government agency — 49 of 52 acquisitions were foreclosure deeds' }] })
    expect(thesis(out, workspace())).toBe('Government agency — 49 of 52 acquisitions were foreclosure deeds.')
  })
})

describe('receipts: every mark is a recorded purchase', () => {
  it('before the purchase list arrives, the located window rows stand alone', () => {
    const set = buildReceipts(buyer(), workspace(), null)
    expect(set.complete).toBe(false)
    expect(set.receipts).toHaveLength(1)
    expect(set.receipts[0]).toMatchObject({ inWindow: true, miles: 1.6, sameFamily: true, inUniverse: null })
  })

  it('merges the linked purchases by transaction, locates what the read can, and copies no party', () => {
    const p = profile([
      purchase({ id: 1507077, date: '2026-06-18', price: 176225 }),
      purchase({ id: 1496090 }),
      purchase({ id: 1732373, date: '2026-05-29', price: null, propertyId: '2131185410', inUniverse: true, address: '7974 Sparta St, Houston, Tx 77028', lat: 29.81149, lng: -95.281852, propertyType: 'Single Family' }),
    ])
    const other = row({ txnId: 999, buyerId: 'company:us_tx:SOMEONE_ELSE', date: '2026-06-30' })
    const set = buildReceipts(buyer(), workspace([row(), other]), p)
    expect(set.receipts.map((r) => r.txnId)).toEqual(['1507077', '1496090', '1732373'])
    const [unlocated, windowed, fromRecord] = set.receipts
    expect(unlocated).toMatchObject({ lat: null, miles: null, inWindow: false, price: 176225, sameFamily: null })
    expect(windowed).toMatchObject({ inWindow: true, miles: 1.6, inUniverse: false, docType: 'Deed' })
    expect(fromRecord.inUniverse).toBe(true)
    expect(fromRecord.propertyId).toBe('2131185410')
    expect(fromRecord.miles).toBeGreaterThan(12)
    expect(fromRecord.miles).toBeLessThan(13.5)
    expect([set.mapped, set.unmapped, set.recorded, set.complete]).toEqual([2, 1, 15, true])
    const json = JSON.stringify(set)
    expect(json).not.toMatch(/SMITH|Some Bank|seller|lender/)
  })

  it('a window row the list did not reach is still a receipt', () => {
    const set = buildReceipts(buyer(), workspace([row(), row({ txnId: 42, date: '2026-01-02' })]), profile([purchase({ id: 1496090 })]))
    expect(set.receipts.map((r) => r.txnId)).toEqual(['1496090', '42'])
  })
})

describe('holdings and geometry', () => {
  it('holdings are the model’s owned and observed-portfolio properties, once each, with their basis', () => {
    const h = holdingsOf(profile([], {
      owned: [{ propertyId: 'A', address: '12957 Shannon Hills Dr, Houston, Tx 77099', value: 159000, equityPercent: 24, propertyType: 'Single Family', market: 'Houston, TX', lat: 29.680919, lng: -95.609774, evidence: { basis: 'name', tier: 'observed' } }],
      portfolio: [
        { propertyId: 'A', address: 'dup', value: null, equity: null, propertyType: null, lat: null, lng: null, attribution: null },
        { propertyId: 'B', address: '1 Main St', value: 100000, equity: null, propertyType: null, lat: null, lng: null, attribution: 'high' },
      ],
    } as Partial<BuyerProfile>), SUBJECT)
    expect(h.map((x) => [x.propertyId, x.basis])).toEqual([['A', 'Owns · owner-name match'], ['B', 'Observed portfolio']])
    expect(h[0].miles).toBeGreaterThan(13)
    expect(h[1].miles).toBeNull()
  })
  it('ages are counted to the buyer model’s own date (last purchase + days since), not the wall clock', () => {
    const w = { ...workspace(), buyers: [buyer()], excluded: [] } as unknown as BuyerMatchWorkspace
    expect(new Date(modelAsOf(w) as number).toISOString().slice(0, 10)).toBe('2026-07-28')
    expect(modelAsOf({ ...w, buyers: [buyer({ activity: { ...buyer().activity, last: null } })] } as BuyerMatchWorkspace)).toBeNull()
  })
  it('distances agree with the server’s haversine', () => {
    expect(haversineMiles(SUBJECT.lat, SUBJECT.lng, 29.663462, -95.357158)).toBeCloseTo(1.6, 1)
  })
})

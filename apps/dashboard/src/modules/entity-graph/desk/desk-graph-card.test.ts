import { describe, expect, it } from 'vitest'
import { nodeCardFacts } from './DeskGraphCard'
import type { EntityNetwork } from '../console/entity-network-api'

const network = {
  anchor: { type: 'property', id: 'p1', nodeId: 'property:p1' },
  owner: { id: 'o1', name: 'Ruiz Family Trust', kind: 'trust', kindLabel: 'Trust', linked: true, propertyCount: 2, units: 3, markets: ['Dallas, TX'], language: null, bestChannel: null, maxOwnershipYears: 20, tags: [], portfolio: null },
  mailing: null,
  properties: [{ id: 'p1', ownerId: 'o1', address: '12 Elm St', city: 'Dallas', state: 'TX', zip: '75001', county: 'Dallas', market: 'Dallas, TX', lat: 1, lng: 1, type: 'SFR', units: 1, beds: 3, baths: 2, sqft: 1400, yearBuilt: 1962, lotAcres: null, value: 250000, equityPct: 62, equity: 155000, equityRule: 'loan_and_value', loanBalance: 95000, loanAmount: null, loanPayment: null, ltv: null, freeAndClear: false, activeLien: true, taxAmount: null, taxDelinquent: true, taxDelinquentYear: 2024, lastSale: { date: '2006-06-05', price: 120000, docType: 'Warranty Deed' }, ownershipYears: 20, repairReference: null, streetview: null, tags: ['Vacant Home'], outOfStateOwner: false, corporateOwner: false }],
  propertiesTruncated: 0,
  debt: { properties: 1, totalValue: 250000, totalEquity: 155000, totalLoanBalance: 95000, monthlyPayment: null, withDebt: 1, freeAndClear: 0, activeLiens: 1, taxDelinquent: 1, blendedLtv: null },
  entities: [{ id: 'e1', name: 'Ruiz Holdings LLC', kind: 'llc', kindLabel: 'LLC', mailing: null }],
  people: [], phones: [], emails: [], related: [], history: [],
  outreach: { threads: [{ threadKey: 't1', propertyId: 'p1', personId: null, at: '2026-10-05T12:00:00Z', preview: 'Maybe, what would you offer?', stage: 'S2', hot: false, intent: null, nextAction: null }], lastSend: null },
  graph: { anchorId: 'property:p1', nodes: [], edges: [] },
  records: { mortgages: [], liens: [{ id: 'l1', label: 'Lis pendens', category: null, type: null, title: null, description: null, amountDue: null, party1: null, party2: null, hoaName: null, defaultAmount: null, dateOfDeath: null, taxPeriod: null, county: null, distress: true }], sales: [], foreclosures: [], ownerBuyer: null, parcel: null, totals: { openMortgages: 1, balance: 95000, payment: null, liens: 1, distressLiens: 1, sales: 1 } },
} as unknown as EntityNetwork

describe('graph hover card', () => {
  it('a property card carries value, equity, owners + entity type, units, last sale, debt, liens, outreach and distress', () => {
    const outreach = new Map([['p1', { sms: { eligible: false, reason: 'missing_phone', rows: 1, ready: 0, source: 'g', reviewChecked: true }, lastContact: { at: '2026-10-05T12:00:00Z', direction: 'inbound' as const, channel: 'sms', source: 'inbox' }, stage: { value: 'offer_sent', source: 'pipeline' as const }, status: { value: 'active', source: 'pipeline' as const }, dealId: 'd1', conversation: { threadKey: 't1', at: '2026-10-05T12:00:00Z', direction: 'inbound', preview: 'Maybe, what would you offer?', bucket: null, suppressed: false }, campaigns: { count: 1, latest: { id: 'c1', name: 'Dallas S1', status: 'built', targetStatus: 'ready', blockReason: null } } }]])
    const f = nodeCardFacts({ id: 'property:p1', type: 'property', label: '12 Elm St', meta: {} }, network, outreach)
    expect(f.title).toBe('12 Elm St')
    // the SAME equity text as the grid cell (equity-display.ts): amount + %
    expect(f.figures.map((x) => x.v)).toEqual(['$250K', '$155K · 62%', '1'])
    const rows = Object.fromEntries(f.rows.map((r) => [r.k, r.v]))
    expect(rows.Owner).toContain('Ruiz Family Trust')
    expect(rows.Owner).toContain('Ruiz Holdings LLC')
    expect(rows.Owner).toContain('Trust')
    expect(rows['Last sale']).toContain('$120K')
    expect(rows.Debt).toContain('1 open loan')
    expect(rows.Liens).toContain('Lis pendens')
    expect(rows['SMS eligible']).toBe('No · No phone on file')
    expect(rows.Stage).toContain('Offer Sent')
    expect(rows.Campaign).toContain('Dallas S1')
    expect(f.flags).toEqual(expect.arrayContaining(['Tax delinquent', 'Active lien', 'Lis pendens', 'Vacant']))
    expect(f.signals?.[0].tone).toBe('distress')
    expect(f.message?.text).toContain('what would you offer')
  })
  it('a cluster node says how to expand it', () => {
    expect(nodeCardFacts({ id: 'property:__cluster', type: 'property', label: '+12', meta: { cluster: true } }, network, new Map()).subtitle).toMatch(/expand/)
  })
})

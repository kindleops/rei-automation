/**
 * ENTITY GRAPH 8.5.1 CORRECTNESS (owner, 2026-10-08/09): units, equity, liens,
 * signals, layouts, complete pages, click-through. One test per defect.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { EntitySearchResult } from '../../domain/entity-graph/entity-graph.types'
import { SCOPE_TABLE_COLUMNS, NUMERIC_UNITS, formatUnit, visibleEnrichmentFields, defaultVisibleColumns } from './mobile/entity-graph-table-columns'
import { migrateLayoutColumns, normalizeTableLayout } from './mobile/entity-graph-table-layout'
import { __columnCacheTest, planColumnReads } from './mobile/use-entity-graph-columns'
import { __outreachCacheTest, readOutreach } from './desk/desk-outreach'
import { absorbPageAttachments, completePageParams } from './desk/desk-page'
import { signalLines, signalRowHeight } from './desk/SignalBadges'
import { nodeAnchor } from './desk/desk-model'
import { equityDisplay } from './equity-display'

const prop = (id: string, details: Record<string, unknown> = {}): EntitySearchResult => ({
  entityType: 'property', entityId: id, title: id, badges: [], linkedCounts: {}, details: details as EntitySearchResult['details'], contextIds: { propertyId: id },
})
const col = (key: string) => {
  const c = SCOPE_TABLE_COLUMNS.properties.find((x) => x.key === key)
  if (!c) throw new Error(`no column ${key}`)
  return c
}

describe('units: every column declares one, and formatting follows the unit — never the name', () => {
  it('every catalog column in every scope has an explicit unit', () => {
    for (const [scope, cols] of Object.entries(SCOPE_TABLE_COLUMNS)) {
      for (const c of cols) expect(c.unit, `${scope}.${c.key}`).toBeTruthy()
    }
  })
  it('BUILDING / LOT SQFT render as square feet, not dollars ("square_FEEt" matched /fee/)', () => {
    const row = prop('P1', { row: { building_square_feet: 2184, lot_square_feet: 7405, lot_acreage: 0.17, lot_size_depth_feet: 120, sum_garage_sqft: 400 } })
    expect(col('building_square_feet').render(row)).toBe('2,184 sqft')
    expect(col('lot_square_feet').render(row)).toBe('7,405 sqft')
    expect(col('lot_acreage').render(row)).toBe('0.17 ac')
    expect(col('lot_size_depth_feet').render(row)).toBe('120 ft')
    expect(col('sum_garage_sqft').render(row)).toBe('400 sqft')
  })
  it('only currency columns ever render a "$"', () => {
    for (const c of SCOPE_TABLE_COLUMNS.properties.filter((x) => x.field && NUMERIC_UNITS.has(x.unit))) {
      const out = c.render(prop('P', { equityRule: 'loan_and_value', row: { [c.field!]: 1234 } }))
      if (c.unit === 'currency' || c.unit === 'currency_per_sqft') expect(out, c.key).toMatch(/\$/)
      else expect(out ?? '', c.key).not.toMatch(/\$/)
    }
  })
  it('years are literal, rates of 0 are "not recorded", negatives keep their sign', () => {
    expect(formatUnit('year', 1958)).toBe('1958')
    expect(formatUnit('rate', 0)).toBeNull()
    expect(formatUnit('rate', 6.5)).toBe('6.50%')
    expect(formatUnit('currency', -487061252)).toBe('−$487M')
    expect(formatUnit('date', '2021-03-04')).toBe('Mar 4, 2021')
    expect(formatUnit('sqft', null)).toBeNull()
  })
})

describe('equity: one rendering everywhere', () => {
  it('amount + % for known equity (negative included), class for a vendor flag, Unknown otherwise', () => {
    expect(equityDisplay({ percent: 100, amount: 111363200, rule: 'no_recorded_mortgage' }).text).toBe('$111M · 100%')
    expect(equityDisplay({ percent: -11, amount: -42000, rule: 'loan_and_value' }).text).toBe('−$42K · −11%')
    expect(equityDisplay({ percent: -11, amount: -42000, rule: 'loan_and_value' }).tone).toBe('crit')
    expect(equityDisplay({ percent: null, amount: null, rule: 'vendor_high_equity_flag' }).text).toBe('High (vendor flag)')
    expect(equityDisplay({ percent: 100, amount: null, rule: 'unknown' }).text).toBe('Unknown')
  })
  it('the vendor equity columns never show a fabricated 100% without loan evidence', () => {
    expect(col('equity_percent').render(prop('A', { equityRule: 'unknown', row: { equity_percent: 100 } }))).toBe('Unverified · no loan data')
    expect(col('equity_percent').render(prop('B', { equityRule: 'loan_and_value', row: { equity_percent: 38 } }))).toBe('38%')
  })
})

describe('signals: every signal listed, rows sized to fit', () => {
  it('wraps into lines instead of folding into "+N"', () => {
    const labels = ['Tax delinquent', 'Probate', 'Vacant', 'Lis pendens', 'Absentee owner', 'High equity', 'Tired landlord', 'Out of state owner']
    const lines = signalLines(labels, 390)
    expect(lines).toBeGreaterThan(1)
    expect(signalRowHeight(lines, 30)).toBeGreaterThan(30)
    expect(signalLines([], 390)).toBe(1)
    expect(signalRowHeight(1, 30)).toBe(30)
  })
})

describe('saved layouts: a key never changes meaning under a stale layout', () => {
  it('v1 → v2: conversation stage inserted next to pipeline stage, filings next to liens, coordinates leave the first screen', () => {
    expect(migrateLayoutColumns('properties', ['latitude', 'stage', 'status', 'liens', 'value'], 1)).toEqual(['stage', 'convoStage', 'status', 'liens', 'filings', 'value'])
    const layout = normalizeTableLayout({ columns: { properties: ['estimated_repair_cost', 'longitude', 'liens', 'best_phone', 'value'] } })
    expect(layout.columns.properties).toEqual(['liens', 'filings', 'value'])
    // a v2 layout is left as saved
    expect(normalizeTableLayout({ version: 2, columns: { properties: ['latitude', 'liens'] } }).columns.properties).toEqual(['latitude', 'liens'])
  })
  it('the default first screen has no ids, coordinates or vendor repair figures', () => {
    const def = defaultVisibleColumns('properties')
    for (const k of ['latitude', 'longitude', 'property_id', 'master_owner_id']) expect(def).not.toContain(k)
    expect(def.every((k) => !/repair/.test(k))).toBe(true)
  })
})

describe('one complete page: no lazy fill', () => {
  beforeEach(() => { __columnCacheTest.reset(); __outreachCacheTest.reset() })
  it('a page that arrived with its fields + outreach leaves nothing for the lazy hooks to fetch', () => {
    const fields = visibleEnrichmentFields('properties', ['year_built', 'building_square_feet', 'smsEligible'])
    expect(completePageParams(fields, true)).toEqual({ fields: 'year_built,building_square_feet', outreach: '1' })
    const results = [prop('1', { row: { year_built: 1958 }, outreach: { sms: { eligible: true } } }), prop('2', { row: {}, outreach: null })]
    expect(planColumnReads(results, fields)).toEqual(['1', '2'])
    absorbPageAttachments({ results, attached: { fields, fieldsLoaded: fields, outreach: true, errors: [] } })
    expect(planColumnReads(results, fields)).toEqual([])
    expect(readOutreach('1')).toEqual({ sms: { eligible: true } })
    expect(readOutreach('2')).toBeNull()
  })
  it('a failed attachment is not cached as "known empty" (it stays retryable)', () => {
    const results = [prop('3', { row: {} })]
    absorbPageAttachments({ results, attached: { fields: ['year_built'], outreach: true, errors: [{ source: 'columns', message: 'timeout' }, { source: 'outreach', message: 'x' }] } })
    expect(planColumnReads(results, ['year_built'])).toEqual(['3'])
    expect(readOutreach('3')).toBeUndefined()
  })
})

describe('every linked item opens a network', () => {
  it('phone / email → its person (else the owner), title entity → its owner, the name-on-title node → nothing', () => {
    expect(nodeAnchor({ id: 'phone:ph1', type: 'phone', label: '', meta: { personId: 'pros_1', ownerId: 'mo_1' } })).toEqual({ type: 'person', id: 'pros_1' })
    expect(nodeAnchor({ id: 'email:e1', type: 'email', label: '', meta: { personId: null, ownerId: 'mo_1' } })).toEqual({ type: 'owner', id: 'mo_1' })
    expect(nodeAnchor({ id: 'entity:so_1', type: 'entity', label: '', meta: { ownerId: 'mo_1' } })).toEqual({ type: 'owner', id: 'mo_1' })
    expect(nodeAnchor({ id: 'owner:unlinked', type: 'owner', label: '', meta: {} })).toBeNull()
  })
})

describe('entity contact needing review is a candidate, never "No phone"', () => {
  it('the SMS cell names the candidate (masked) while eligibility stays No', () => {
    const r = prop('E1', { outreach: { sms: { eligible: false, reason: 'entity_contact_requires_review', rows: 1, ready: 0, source: 'g', reviewChecked: true }, entityContact: { entityName: 'Stonebridge Holdings LLC', entityStatus: 'active', person: 'Ana Ruiz', phoneMasked: '•••-4477', phoneCallable: true, hasEmail: false, emailUsable: false, role: 'unknown', roleLabel: 'Unknown · needs review', requiresReview: true, reviewReasons: [] }, lastContact: null, stage: null, status: null, dealId: null, conversation: null, campaigns: null } })
    const v = col('smsEligible').render(r)
    expect(v).toBe('No · entity contact needs review · Ana Ruiz •••-4477')
    expect(v).not.toMatch(/No phone/)
  })
  it('pipeline and conversation stages are separate columns', () => {
    const r = prop('S1', { outreach: { sms: null, lastContact: null, stage: { value: 'offer_sent', source: 'pipeline' }, status: null, pipeline: { stage: 'offer_sent', status: 'active' }, conversationState: { stage: 'price_discovery', status: 'open' }, dealId: 'd', conversation: null, campaigns: null } })
    expect(col('stage').render(r)).toBe('Offer Sent')
    expect(col('convoStage').render(r)).toBe('Price Discovery')
    expect(col('status').render(r)).toBe('Active')
    const convoOnly = prop('S2', { outreach: { sms: null, lastContact: null, stage: { value: 'interested', source: 'conversation' }, status: null, dealId: null, conversation: null, campaigns: null } })
    expect(col('stage').render(convoOnly)).toBeNull()
    expect(col('convoStage').render(convoOnly)).toBe('Interested')
  })
})

describe('values add up: one source per cell, a basis for every number', () => {
  it('last sale never mixes the recorded date with the vendor price, and flags prices that cannot be this parcel', () => {
    const rec = { captured: true, mortgageCount: 0, lienCount: 0, saleCount: 1, signals: [], lastSaleDate: '2020-06-05', lastSaleDocType: 'Warranty Deed' }
    // recorded sale without a price: the vendor price is NOT borrowed
    expect(col('lastSale').render(prop('L1', { value: 600000, records: rec, row: { sale_price: 9800000, sale_date: '2019-01-01' } }))).toBe('Jun 5, 2020 · Warranty Deed · recorded')
    // $9.8M sale on a $600K-valued parcel: said, not silently shown
    expect(col('lastSale').render(prop('L2', { value: 600000, records: { ...rec, lastSalePrice: 9800000 } }))).toBe('Jun 5, 2020 · $9.8M · Warranty Deed · price ≫ value · bulk / multi-parcel? · recorded')
    expect(col('lastSale').render(prop('L3', { value: 600000, records: { ...rec, lastSalePrice: 10 } }))).toContain('nominal price')
    expect(col('lastSale').render(prop('L5', { value: 111363200, records: { ...rec, lastSalePrice: 9800000 } }))).toContain('price ≪ value')
    // no recorded sale: the vendor fields, labelled vendor
    expect(col('lastSale').render(prop('L4', { value: 300000, records: { captured: true, mortgageCount: 0, lienCount: 0, saleCount: 0, signals: [] }, row: { sale_date: '2006-06-05', sale_price: 120000, last_sale_doc_type: 'Grant Deed' } }))).toBe('Jun 5, 2006 · $120K · Grant Deed · vendor')
  })
})

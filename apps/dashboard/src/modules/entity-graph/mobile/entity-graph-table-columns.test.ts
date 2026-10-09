import { beforeEach, describe, expect, it } from 'vitest'
import type { EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'
import {
  SCOPE_TABLE_COLUMNS,
  nextHeaderSort,
  sortLoadedRows,
  visibleEnrichmentFields,
} from './entity-graph-table-columns'
import { normalizeTableLayout } from './entity-graph-table-layout'
import { __columnCacheTest, planColumnReads, storeColumnValues, withColumnValues } from './use-entity-graph-columns'

const prop = (id: string, details: Record<string, unknown> = {}): EntitySearchResult => ({
  entityType: 'property',
  entityId: id,
  title: id,
  badges: [],
  linkedCounts: {},
  details: details as EntitySearchResult['details'],
  contextIds: { propertyId: id },
})
const col = (key: string) => {
  const c = SCOPE_TABLE_COLUMNS.properties.find((x) => x.key === key)
  if (!c) throw new Error(`no column ${key}`)
  return c
}

describe('Entity Graph table columns', () => {
  beforeEach(() => __columnCacheTest.reset())

  it('every picker column the browse row lacks is enrichment-backed (none silently empty)', () => {
    // RC 8.3.1: these rendered from details.row, which browse never returned.
    // sale_date / sale_price are folded into the one Last sale column (field audit 2026-10-08)
    for (const key of ['year_built', 'zoning', 'effective_year_built', 'total_bedrooms', 'total_baths', 'building_square_feet', 'basement', 'air_conditioning', 'rec.first_loan_type', 'person.age']) {
      expect(col(key).field).toBe(key)
    }
    expect(visibleEnrichmentFields('properties', ['value', 'year_built', 'zoning'])).toEqual(['zoning', 'year_built'])
    expect(visibleEnrichmentFields('buyers', ['year_built'])).toEqual([])
  })

  it('index-backed picker fields ask the server for a whole-cohort sort', () => {
    for (const key of ['year_built', 'zoning', 'total_bedrooms']) expect(col(key).sortBy).toBe(key)
    // the vendor repair estimate is not a grid column at all (valuation lanes: MLS ARV lane reference only)
    expect(SCOPE_TABLE_COLUMNS.properties.some((c) => /repair/.test(c.key))).toBe(false)
    expect(col('lastSale').fields).toEqual(['sale_date', 'sale_price'])
    expect(col('units').sortBy).toBe('units_count')
    expect(col('loans').sortBy).toBe('rec_mortgage_count')
    // No index planned: stays a loaded-rows sort.
    expect(col('flood_zone').sortBy).toBeUndefined()
  })

  it('enriched values render; missing values are null ("—"), never 0', () => {
    storeColumnValues(['P1'], ['year_built', 'total_bedrooms'], { P1: { year_built: 1958 } })
    const [row] = withColumnValues([prop('P1')])
    expect(col('year_built').render(row)).toBe('1958')
    expect(col('total_bedrooms').render(row)).toBeNull()
    expect(col('property_id').render(row)).toBe('P1')
  })

  it('plans only ids missing a visible field', () => {
    storeColumnValues(['P1'], ['year_built'], { P1: { year_built: 1958 } })
    const rows = [prop('P1'), prop('P2'), prop('P2')]
    expect(planColumnReads(rows, ['year_built'])).toEqual(['P2'])
    expect(planColumnReads(rows, ['year_built', 'zoning'])).toEqual(['P1', 'P2'])
    expect(planColumnReads(rows, [])).toEqual([])
  })

  it('loan / lien counts are "—" when the record summary was not captured', () => {
    const uncaptured = prop('P1', { records: { captured: false, mortgageCount: 0, lienCount: 0, saleCount: 0, signals: [] } })
    const captured = prop('P2', { records: { captured: true, mortgageCount: 0, lienCount: 2, saleCount: 0, signals: [] } })
    expect(col('loans').render(uncaptured)).toBeNull()
    // an older API counted every recorded document as a lien — say documents, not liens
    expect(col('liens').render(captured)).toBe('2 recorded documents')
    // liens only (lien + judgment classes); a UCC financing statement is a filing, not a lien
    const split = prop('P3', { records: { captured: true, mortgageCount: 0, lienCount: 1, liens: ["Mechanic's lien"], filings: [{ category: 'FINANCING STATEMENT', class: 'ucc', label: 'UCC financing statement' }], lienAmountDue: 12000, saleCount: 0, signals: [] } })
    expect(col('liens').render(split)).toBe("Mechanic's lien · $12K due")
    expect(col('filings').render(split)).toBe('UCC financing statement')
    const uccOnly = prop('P4', { records: { captured: true, mortgageCount: 0, lienCount: 0, liens: [], filings: [{ category: 'FINANCING STATEMENT', class: 'ucc', label: 'UCC financing statement' }], saleCount: 0, signals: [] } })
    expect(col('liens').render(uccOnly)).toBe('None recorded')
    expect(col('loans').render(captured)).toBe('0')
  })

  it('header click cycles asc → desc → none', () => {
    const a = nextHeaderSort(null, 'year_built')
    expect(a).toEqual({ key: 'year_built', dir: 'asc' })
    const b = nextHeaderSort(a, 'year_built')
    expect(b).toEqual({ key: 'year_built', dir: 'desc' })
    expect(nextHeaderSort(b, 'year_built')).toBeNull()
    expect(nextHeaderSort(b, 'zoning')).toEqual({ key: 'zoning', dir: 'asc' })
  })

  it('sorts loaded rows numerically, nulls last both ways, ties keep server order', () => {
    const rows = [
      prop('A', { row: { year_built: 1990 } }),
      prop('B', { row: {} }),
      prop('C', { row: { year_built: 1950 } }),
      prop('D', { row: { year_built: 1990 } }),
    ]
    const ids = (r: EntitySearchResult[]) => r.map((x) => x.entityId)
    expect(ids(sortLoadedRows('properties', rows, col('year_built'), 'asc'))).toEqual(['C', 'A', 'D', 'B'])
    expect(ids(sortLoadedRows('properties', rows, col('year_built'), 'desc'))).toEqual(['A', 'D', 'C', 'B'])
    // Currency renders as "$1.2M" but sorts by the number.
    const valued = [prop('X', { value: 950_000 }), prop('Y', { value: 1_200_000 }), prop('Z', {})]
    expect(ids(sortLoadedRows('properties', valued, col('value'), 'desc'))).toEqual(['Y', 'X', 'Z'])
  })

  it('a stored layout keeps only known columns and valid sorts', () => {
    const layout = normalizeTableLayout({
      columns: { properties: ['year_built', 'gone_column', 7], nope: ['x'] },
      sort: { properties: { key: 'zoning', dir: 'desc' }, buyers: { key: 'zoning', dir: 'sideways' } },
    })
    expect(layout.columns.properties).toEqual(['year_built'])
    expect(layout.sort.properties).toEqual({ key: 'zoning', dir: 'desc' })
    expect(layout.sort.buyers).toBeUndefined()
    expect(normalizeTableLayout('garbage')).toEqual({ columns: {}, sort: {} })
  })
})

describe('field audit (2026-10-08)', () => {
  it('columns with no data source are gone, the sale columns are one, debug ids are grouped', () => {
    const keys = new Set(SCOPE_TABLE_COLUMNS.properties.map((c) => c.key))
    for (const k of ['ppsf', 'cap_rate', 'rent_estimate', 'arv_estimate', 'lastPrice', 'records', 'seller_tags_text', 'sqft_range', 'avg_sqft_per_unit', 'beds_per_unit', 'best_phone', 'contact_status', 'estimated_repair_cost']) expect(keys.has(k)).toBe(false)
    // owner field list 2026-10-09: offered (stories exists but is empty → listed as "no data", not offered)
    for (const k of ['sale_date', 'sale_price', 'property_type', 'patio', 'equity_percent', 'equity_amount']) expect(keys.has(k)).toBe(true)
    expect(col('stories').noData).toBe(true)
    expect(col('property_type').label).toBe('Property use type')
    expect(keys.has('basement')).toBe(true)
    expect(col('master_owner_id').group).toBe('provenance')
    expect(col('source_system').group).toBe('provenance')
    expect(SCOPE_TABLE_COLUMNS.properties.length).toBeGreaterThanOrEqual(200)
  })
  it('owner-as-buyer shows only a repeat or active buyer', () => {
    expect(col('ownerBuyer').render(prop('A', { records: { captured: true, mortgageCount: 0, lienCount: 0, saleCount: 0, signals: [], ownerBuyer: { buyerId: 'b', acquisitions: 1, status: 'inactive' } } }))).toBeNull()
    expect(col('ownerBuyer').render(prop('B', { records: { captured: true, mortgageCount: 0, lienCount: 0, saleCount: 0, signals: [], ownerBuyer: { buyerId: 'b', acquisitions: 4, status: 'active' } } }))).toBe('4 purchases · active')
  })
})

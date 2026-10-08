import { describe, expect, it } from 'vitest'
import { humanBucket, propertySignals, signalFor } from './property-signals'
import type { EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'

const row = (details: Record<string, unknown>) => ({ entityType: 'property', entityId: '1', title: 'x', linkedCounts: {}, contextIds: {}, details }) as unknown as EntitySearchResult

describe('one signal system', () => {
  it('merges vendor flags, seller tags and recorded signals into one deduplicated, toned list, distress first', () => {
    const s = propertySignals(row({
      flags: 'High Equity; Probate; Apartment Building 5+ Units; Corner Lot; Off Market',
      row: { seller_tags_text: 'Probate, Tired Landlord, Commercial' },
      records: { captured: true, mortgageCount: 0, lienCount: 1, saleCount: 0, signals: [{ key: 'probate', label: 'Probate', tone: 'alert' }, { key: 'lis_pendens', label: 'Lis pendens', tone: 'alert' }] },
      taxDelinquent: true,
    }))
    expect(s.map((x) => x.label)).toEqual(['Probate', 'Lis pendens', 'Tax delinquent', 'High equity', 'Tired landlord'])
    expect(s.map((x) => x.tone)).toEqual(['distress', 'distress', 'distress', 'opportunity', 'opportunity'])
  })
  it('property facts are never badges; unknown tokens are humanised, never raw codes', () => {
    for (const fact of ['Apartment Building 5+ Units', 'Commercial', 'Off Market', 'Corner Lot', 'Storage Units', 'Strip Malls']) expect(signalFor(fact)).toBeNull()
    expect(signalFor('SOME_NEW_FLAG')?.label).toBe('Some new flag')
    expect(humanBucket('APARTMENT_BUILDINGS')).toBe('Apartment buildings')
    expect(signalFor('Low Equity')?.tone).toBe('risk')
  })
})

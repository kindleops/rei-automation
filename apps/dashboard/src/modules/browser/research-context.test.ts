import { describe, expect, it } from 'vitest'
import { factsFromSubject } from './research-context'
import { pickItem, propertyLaunchItems } from './launch-plane'

/* The real GET /api/cockpit/properties/:id/subject shape (property 273312064, captured 2026-10-02): evidence objects { value, source, … }. */
const ev = (value: unknown, source: string) => ({ value, source, source_timestamp: null, confidence: null, applicability: 'subject', missing_reason: value == null ? 'empty_or_unknown' : null, present: value != null })
const SUBJECT = {
  property_id: '273312064',
  parcel_apn: ev('04-029-24-43-0175', 'properties.apn_parcel_id'),
  canonical_address: ev('3635 Emerson Ave N, Minneapolis, Mn 55412', 'properties.property_address_full'),
  city: ev('Minneapolis', 'properties.property_address_city'),
  state: ev('MN', 'properties.property_address_state'),
  zip: ev('55412', 'properties.property_address_zip'),
  county: ev('Hennepin', 'properties.property_address_county_name'),
  latitude: ev(45.021381, 'properties.latitude'),
  longitude: ev(-93.294633, 'properties.longitude'),
  market: ev('Minneapolis, MN', 'properties.market'),
}

describe('research facts from the real subject contract', () => {
  it('unwraps evidence objects into the registry property shape, APN included', () => {
    const f = factsFromSubject('273312064', SUBJECT)!
    expect(f.apn).toBe('04-029-24-43-0175')
    expect(f.property).toMatchObject({ apn_parcel_id: '04-029-24-43-0175', property_address: '3635 Emerson Ave N', property_address_city: 'Minneapolis', property_address_state: 'MN', property_address_county_name: 'Hennepin', latitude: 45.021381 })
  })

  it('Hennepin assessor and tax open as parcel deep links (no "Parcel ID required")', () => {
    const items = propertyLaunchItems(factsFromSubject('273312064', SUBJECT)!.property)
    for (const type of ['ASSESSOR', 'TAX'] as const) {
      const { item, reason } = pickItem(items, type)
      expect(reason, type).toBeNull()
      expect(item?.url, type).toMatch(/^https:\/\//)
      expect(item?.url, type).toMatch(/0402924430175|04-029-24-43-0175/)
    }
  })

  it('an empty parcel field is said honestly', () => {
    const f = factsFromSubject('x', { ...SUBJECT, parcel_apn: ev(null, 'properties.apn_parcel_id') })!
    expect(f.apn).toBeNull()
    expect(pickItem(propertyLaunchItems(f.property), 'ASSESSOR').reason).toBe('Parcel ID required')
  })
})

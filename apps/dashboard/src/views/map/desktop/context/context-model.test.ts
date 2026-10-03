import { describe, expect, it } from 'vitest'
import {
  CONTEXT_DEFAULTS, cameraMediaLabel, cameraStatus, camerasRequestFor, contextGroup, crimeRequestFor, crimeStatus, directionLabel, fmtDay,
  presenceFeatures, presenceRequestFor, presenceStatus, type CamerasReply, type CrimeReply, type PresenceReply,
} from './context-model'

const MSP = { west: -93.42, south: 44.9, east: -93.1, north: 45.08 }

describe('context overlay requests mirror the server refusals', () => {
  it('cameras need a state-sized view', () => {
    expect(camerasRequestFor(MSP, 11.25)).toBe('/api/cockpit/map/cameras?bbox=-93.4200,44.9000,-93.1000,45.0800&zoom=11.3')
    expect(camerasRequestFor(MSP, 4)).toBeNull()
  })
  it('crime always asks (the server answers coverage); presence refuses a continent before any call', () => {
    expect(crimeRequestFor(MSP, 9, 30)).toContain('/api/cockpit/map/crime?bbox=')
    expect(crimeRequestFor(MSP, 9, 30)).toContain('&days=30')
    expect(presenceRequestFor(MSP, 12, 24)).toBe('/api/cockpit/map/investor-presence?bbox=-93.4200,44.9000,-93.1000,45.0800&zoom=12.0&months=24')
    expect(presenceRequestFor(MSP, 8, 24)).toBeNull()
    expect(presenceRequestFor({ west: -100, south: 30, east: -90, north: 40 }, 10, 24)).toBeNull()
  })
})

const camReply = (over: Partial<CamerasReply> = {}): CamerasReply => ({ ok: true, mode: 'points', cameras: [], cells: [], attributions: [], coverage: [], ...over })

describe('honest statuses', () => {
  it('cameras: not covered is said, never "0 cameras"', () => {
    const s = cameraStatus(camReply(), 11)
    expect(s.state).toBe('not_covered')
    expect(s.reason).toMatch(/No public camera feed connected here/)
  })
  it('cameras: TxDOT is described as location-only', () => {
    const s = cameraStatus(camReply({
      cameras: [{ id: 'tx_txdot_its:DAL-x', name: 'IH30 @ X', road: 'I-30', direction: 'E', lat: 32.8, lng: -96.8, status: 'LIVE', feed: 'PROVIDER_PAGE_ONLY', media: 'link', freshness: 'unknown', provider: 'TxDOT ITS' }],
      coverage: [{ provider: 'TxDOT ITS', state: 'TX', region: null, coverage_status: 'METADATA_ONLY', image_policy: 'link_only', attribution: 'TxDOT', terms_url: null }],
    }), 11)
    expect(s.state).toBe('on')
    expect(s.count).toBe(1)
    expect(s.coverage).toMatch(/locations · pictures on TxDOT/)
  })
  it('cameras: a provider that failed is unavailable, not empty', () => {
    const s = cameraStatus(camReply({ unavailable: ['MnDOT'], coverage: [{ provider: 'MnDOT', state: 'MN', region: null, coverage_status: 'FULL', image_policy: 'proxy', attribution: 'MnDOT', terms_url: null }] }), 11)
    expect(s.state).toBe('unavailable')
    expect(s.reason).toMatch(/MnDOT not answering/)
  })
  it('crime: not covered, zoom in, capped', () => {
    const base: CrimeReply = { ok: true, mode: 'incidents', covered: true, window_days: 30, incidents: [], categories: [], sources: [] }
    expect(crimeStatus({ ...base, covered: false, mode: 'not_covered' }).state).toBe('not_covered')
    expect(crimeStatus({ ...base, mode: 'zoom_in', min_zoom: 11 }).reason).toMatch(/Zoom in/)
    expect(crimeStatus({ ...base, per_source: [{ source_id: 'x', city: 'Chicago', count: 2000, latest_on: '2026-09-26', truncated: true }] }).reason).toMatch(/Newest 2,000 shown for Chicago/)
    expect(crimeStatus(null).state).toBe('unavailable')
  })
  it('presence: zoomed out waits; data reports the latest sale', () => {
    expect(presenceStatus(null, 8, true).state).toBe('waiting')
    const r: PresenceReply = { ok: true, mode: 'cells', window_months: 24, cells: [{ lat: 1, lng: 1, sales: 3, investor_purchases: 1, entity_owned: 2 }], latest_sale_on: '2026-08-19' }
    const s = presenceStatus(r, 12, false)
    expect(s.state).toBe('on')
    expect(s.reason).toBe('latest recorded sale here Aug 19, 2026')
  })
})

describe('Layers rows', () => {
  it('one context group, three rows, no score anywhere', () => {
    const g = contextGroup({ on: false, state: 'off', count: 0, reason: null, coverage: null, attributions: [] }, { on: false, state: 'off', count: 0, reason: null, coverage: null, attributions: [] }, { on: false, state: 'off', count: 0, reason: null, coverage: null, attributions: [] }, CONTEXT_DEFAULTS)
    expect(g.id).toBe('context')
    expect(g.rows.map((r) => r.id)).toEqual(['ctxCameras', 'ctxCrime', 'ctxPresence'])
    expect(JSON.stringify(g)).not.toMatch(/unsafe|\bsafe\b|safety (score|rating)/i)
  })
})

describe('presence features keep both components separate', () => {
  it('each component scales on its own range', () => {
    const fc = presenceFeatures([{ lat: 1, lng: 2, sales: 10, investor_purchases: 4, entity_owned: 0 }, { lat: 1, lng: 3, sales: 5, investor_purchases: 1, entity_owned: 9 }])
    const [a, b] = fc.features.map((f) => f.properties as Record<string, number>)
    expect(a.pr).toBe(1)
    expect(a.er).toBe(0)
    expect(b.er).toBe(1)
    expect(b.pr).toBeCloseTo(0.5)
  })
})

describe('labels', () => {
  it('directions, days, media', () => {
    expect(directionLabel('E')).toBe('Eastbound')
    expect(directionLabel(null)).toBe('Direction not published')
    expect(fmtDay('2026-10-02')).toBe('Oct 2, 2026')
    expect(cameraMediaLabel({ ok: true, media: { still: { kind: 'proxy', path: '/x', refresh_sec: 60 }, stream: null, provider_page_url: null } }).label).toMatch(/every 60 s/)
    expect(cameraMediaLabel({ ok: true, provider: { id: 'tx', name: 'TxDOT ITS', attribution: '', terms_url: null }, media: { still: null, stream: null, provider_page_url: 'https://its.txdot.gov/x' } }).kind).toBe('link')
  })
})

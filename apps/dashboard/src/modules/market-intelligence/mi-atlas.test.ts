import { describe, expect, it } from 'vitest'
import { ATLAS_METRICS, CONUS, areasCollection, areasRequest, atlasAvailability, atlasFrame, legendRange, pointsCollection } from './ui/atlas-model'
import { headlineNotes, inferredNote } from './ui/headline-model'
import { fmtDateTime } from './mi-format'
import { DEFAULT_STATE, miPath, parseMiLocation } from './mi-route-state'
import type { MiPoint } from './mi-types'

const ATLAS = (id: string) => ATLAS_METRICS.find((m) => m.id === id)!

describe('hero atlas model', () => {
  it('nationwide frames CONUS and draws states; a metro draws ZIP outlines; a ZIP shows its neighbourhood', () => {
    expect(atlasFrame({ level: 'nation', bbox: null })).toEqual(CONUS)
    expect(areasRequest({ level: 'nation', bbox: null }).zoom).toBe(4)
    expect(areasRequest({ level: 'state', bbox: [-106, 25, -93, 36] }).zoom).toBe(4)
    const mpls = areasRequest({ level: 'market', bbox: [-93.75, 44.8, -92.95, 45.24] })
    expect(mpls.zoom).toBe(10)
    const zip = atlasFrame({ level: 'zip', bbox: [-93.318, 44.985, -93.28, 45.013] })
    expect(zip[1][0] - zip[0][0]).toBeGreaterThan(0.038 * 4)
  })
  it('inferred is pending until the summary carries it; MF $/door needs a multifamily-capable asset', () => {
    expect(atlasAvailability(ATLAS('inferred_investor_count'), 'all', { inferred_investor: { available: false, reason: 'not_installed', message: null } }).ok).toBe(false)
    expect(atlasAvailability(ATLAS('inferred_investor_count'), 'all', { inferred_investor: { available: true, reason: null, message: null } }).ok).toBe(true)
    expect(atlasAvailability(ATLAS('median_price_per_unit'), 'sfr', null).ok).toBe(false)
    expect(atlasAvailability(ATLAS('median_price_per_unit'), 'all', null).ok).toBe(true)
  })
  it('a thin / missing value is positioned but never coloured or weighted', () => {
    const rows: MiPoint[] = [
      { id: 'zip:1', label: 'a', c: [-93, 45], v: 100, n: 100, s: 'ok', sales: 100, t: 1 },
      { id: 'zip:2', label: 'b', c: [-93.1, 45], v: 1, n: 1, s: 'ok', sales: 1, t: 0 },
      { id: 'zip:3', label: 'c', c: [-93.2, 45], v: null, n: 4, s: 'insufficient', sales: 4, t: null },
    ]
    const fc = pointsCollection(rows, 'count')
    const p = fc.features.map((f) => f.properties as Record<string, number | null>)
    expect(p[0].w).toBe(1)
    expect(p[1].w).toBeGreaterThan(0)
    expect(p[2].w).toBe(0)
    expect(p[2].ok).toBe(0)
    expect(pointsCollection(rows, 'rate').features.every((f) => (f.properties as { w: number }).w === 0)).toBe(true)
    expect(legendRange(rows)).toEqual({ min: 1, max: 100 })
  })
  it('areas outside the subject are drawn quiet (no colour)', () => {
    const heat = { level: 'zip', rows: [
      { key: '55411', id: 'zip:55411', label: '55411', v: 1, n: 1, t: 0.4, tip: '', outline: { type: 'Polygon', coordinates: [] } as GeoJSON.Geometry },
      { key: '55001', id: 'zip:55001', label: '55001', v: 1, n: 1, t: 0.9, tip: '', outline: { type: 'Polygon', coordinates: [] } as GeoJSON.Geometry },
    ] }
    const fc = areasCollection(heat, { id: 'market:minneapolis-mn', level: 'market' }, new Set(['zip:55411']))
    const props = fc.features.map((f) => f.properties as Record<string, unknown>)
    expect(props[0]).toMatchObject({ member: 1, t: 0.4 })
    expect(props[1]).toMatchObject({ member: 0, t: null })
    const st = areasCollection({ level: 'state', rows: [{ ...heat.rows[0], id: 'state:TX' }, { ...heat.rows[1], id: 'state:MN' }] }, { id: 'state:TX', level: 'state' }, null)
    expect(st.features.map((f) => (f.properties as { member: number }).member)).toEqual([1, 0])
  })
})

describe('one status line instead of a page of "Unavailable"', () => {
  const values = {
    sales_growth: { value: null, n: 0, status: 'unavailable' as const, reason: 'No valid baseline: Prior 1Y would start 2024-08, before sales coverage begins (2025-09)' },
    sms_eligible_count: { value: null, n: 0, status: 'not_loaded' as const, reason: 'Seller universe loaded for 0 of 33 states' },
  }
  const status = { inferred_investor: { available: false, reason: 'not_installed', message: 'x' }, coverage: { coverage_start: '2025-09', complete_through: '2026-07', months: [] } }
  it('collapses inferred / growth / universe into short sentences', () => {
    const notes = headlineNotes({ values, geography: { level: 'nation', state: null } as never }, status)
    expect(notes.map((n) => n.id)).toEqual(['inferred', 'growth', 'universe'])
    expect(notes[1].text).toContain('Sep 2025')
    expect(notes[2].text).toContain('open a state')
  })
  it('names tonight\'s build only when the extension exists but this build predates it', () => {
    expect(inferredNote({ inferred_investor: { available: false, reason: 'not_built', message: null } })).toContain("tonight's build")
    expect(inferredNote({ inferred_investor: { available: false, reason: 'not_installed', message: null } })).not.toContain("tonight's build")
    expect(inferredNote({ inferred_investor: { available: true, reason: null, message: null } })).toBeNull()
  })
})

describe('format + route', () => {
  it('parses Postgres "+00" timestamps instead of printing them raw', () => {
    expect(fmtDateTime('2026-10-06 11:29:00.062555+00')).not.toContain('+00')
  })
  it('the leaderboard order and the heat metric round-trip in the path; defaults stay short', () => {
    expect(DEFAULT_STATE.hm).toBe('sales_count')
    expect(miPath({})).toBe('/market-intelligence')
    expect(parseMiLocation(miPath({ lb: 'company_buyer_count', hm: 'cash_purchase_share' }))).toMatchObject({ lb: 'company_buyer_count', hm: 'cash_purchase_share' })
  })
})

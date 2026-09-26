/**
 * Map lenses, density settings and the relative-time label — focused tests.
 */
import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { formatLensValue, LENS_FAMILIES, lensById, MAP_LENSES, normalize, rampExpression } from './map-lenses'
import { lensGridForZoom } from './useMapLens'
import { LensLegend } from './MapIntelCards'
import { agoLabel } from './MapMobileChrome'
import { iconOverlapZoom, sampleQuotaForZoom, scoreFloorForZoom } from '../map-marker-density'

;(globalThis as any).React = React

describe('lens catalogue', () => {
  it('every lens has a family, a unique id, and a real data source or is the stage view', () => {
    const ids = new Set<string>()
    for (const l of MAP_LENSES) {
      expect(ids.has(l.id)).toBe(false)
      ids.add(l.id)
      expect(LENS_FAMILIES.some((f) => f.key === l.family)).toBe(true)
      if (l.source) expect(l.domain).toBeDefined()
    }
    expect(lensById('radar').source).toBeNull()
    expect(lensById('nope').id).toBe('radar')
  })
  it('no heat lens drives a legacy mode that paints its own heat underneath', () => {
    for (const l of MAP_LENSES) {
      if (l.source) expect(['opportunity_heat', 'buyer_demand', 'census']).not.toContain(l.legacyMode)
    }
  })
  it('normalises into 0..1 with clamping, and inverts where older is hotter', () => {
    const equity = lensById('equity')
    expect(normalize(equity, 50)).toBe(0)
    expect(normalize(equity, 100)).toBe(1)
    expect(normalize(equity, -277)).toBe(0)
    const age = lensById('year_built')
    expect(normalize(age, 1915)).toBe(1)
    expect(normalize(age, 1990)).toBe(0)
  })
  it('formats values in the lens unit', () => {
    expect(formatLensValue(lensById('census_income'), 106533)).toBe('$107K')
    expect(formatLensValue(lensById('hpi'), 0.156)).toBe('16%')
    expect(formatLensValue(lensById('equity'), 81.7)).toBe('82%')
    expect(formatLensValue(lensById('value'), 1_250_000)).toBe('$1.3M')
    expect(formatLensValue(lensById('equity'), null)).toBe('—')
  })
  it('ramp expressions start transparent only for heatmaps', () => {
    const heat = rampExpression('heat', ['heatmap-density'], true)
    expect(heat[4]).toBe('rgba(0,0,0,0)')
    const field = rampExpression('heat', ['get', 't'])
    expect(field[4]).not.toBe('rgba(0,0,0,0)')
  })
  it('grids match the RPC: individual properties from zoom 13', () => {
    expect(lensGridForZoom(14)).toBe(0)
    expect(lensGridForZoom(12)).toBe(0.004)
    expect(lensGridForZoom(10)).toBe(0.015)
    expect(lensGridForZoom(4)).toBe(0.6)
  })
})

describe('map key', () => {
  it('prints the real domain at each end, cold on the left', () => {
    const html = renderToStaticMarkup(<LensLegend lens={lensById('year_built')} state={{ loading: false, error: null, count: 50, inView: [1920, 1970], lensId: 'year_built' }} zoom={14} />)
    expect(html).toContain('1990+')
    expect(html).toContain('≤ 1915')
    expect(html).toContain('50 properties')
    expect(html).toContain('here 1920 – 1970')
  })
  it('never shows the previous lens’s range', () => {
    const html = renderToStaticMarkup(<LensLegend lens={lensById('census_income')} state={{ loading: true, error: null, count: 0, inView: [-277, 100], lensId: 'equity' }} zoom={9} />)
    expect(html).not.toContain('here')
    expect(html).toContain('Reading')
  })
  it('the stage view is a ring key, not a gradient', () => {
    const html = renderToStaticMarkup(<LensLegend lens={lensById('radar')} state={{ loading: false, error: null, count: 0, inView: null }} zoom={11} />)
    expect(html).toContain('Ring = stage')
    expect(html).toContain('Negotiating')
  })
})

describe('Advanced settings change what draws', () => {
  it('Everything admits every property from zoom 11.5; Sparse holds back until street level', () => {
    expect(scoreFloorForZoom(11.5, 'high')).toBe(0)
    expect(sampleQuotaForZoom(11.5, 'high')).toBe(100)
    expect(scoreFloorForZoom(11.5, 'low')).toBeGreaterThan(scoreFloorForZoom(11.5, 'medium'))
    expect(sampleQuotaForZoom(15, 'low')).toBe(100)
    expect(iconOverlapZoom('high')).toBeLessThan(iconOverlapZoom('medium'))
    expect(iconOverlapZoom('medium')).toBeLessThan(iconOverlapZoom('low'))
  })
})

describe('relative time', () => {
  it('reads "now", never "now ago"', () => {
    const t = Date.parse('2026-09-26T12:00:00Z')
    expect(agoLabel(t - 10_000, t)).toBe('now')
    expect(agoLabel(t - 5 * 60_000, t)).toBe('5m ago')
    expect(agoLabel(0, t)).toBe('')
  })
})

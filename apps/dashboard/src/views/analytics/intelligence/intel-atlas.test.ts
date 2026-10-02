import { describe, expect, it } from 'vitest'
import { atlasLevel, dodge, frameBox, heatClass, heatOf, loadCounties, loadStates, matchCounty, normCounty, outlineShape, pointInPath, zipOutlineLayer } from './intel-atlas'
import type { GeoJsonOutline, ZipOutlines } from './intel-atlas'
import { project } from './intel-geo'

describe('intel-atlas — geometry and matching, never a number', () => {
  it('the drill level is the deepest geography step; market is a filter, not a level', () => {
    expect(atlasLevel([])).toBe('nation')
    expect(atlasLevel([{ dim: 'market' }])).toBe('nation')
    expect(atlasLevel([{ dim: 'state' }, { dim: 'county' }])).toBe('county')
    expect(atlasLevel([{ dim: 'state' }, { dim: 'county' }, { dim: 'city' }, { dim: 'zip' }, { dim: 'campaign' }])).toBe('zip')
  })

  it('normalises recorded county names to Census names', () => {
    expect(normCounty('De Kalb')).toBe(normCounty('DeKalb'))
    expect(normCounty('Saint Louis')).toBe(normCounty('St. Louis'))
    expect(normCounty('Hennepin County')).toBe('hennepin')
  })

  it('every county recorded on messaged properties (production, 120 days) finds its Census polygon', async () => {
    const recorded = 'Anoka|MN; Baltimore City|MD; Bastrop|TX; Broward|FL; Canyon|ID; Clark|NV; Clayton|GA; Cook|IL; Cumberland|NC; Cuyahoga|OH; Dakota|MN; Dallas|TX; De Kalb|GA; Durham|NC; Duval|FL; Edgecombe|NC; Fulton|GA; Harris|TX; Hartford|CT; Hennepin|MN; Henry|GA; Hillsborough|FL; Jackson|MO; Los Angeles|CA; Maricopa|AZ; Marion|IN; Mecklenburg|NC; Miami-Dade|FL; Milwaukee|WI; Nash|NC; Orange|CA; Orange|FL; Osage|OK; Palm Beach|FL; Providence|RI; Ramsey|MN; Riverside|CA; Saint Louis|MO; San Bernardino|CA; San Joaquin|CA; Shelby|TN; Spokane|WA; Stanislaus|CA; Tarrant|TX; Travis|TX; Tulsa|OK; Wagoner|OK; Williamson|TX; Wilson|NC; Wyandotte|KS'.split('; ')
    const missing: string[] = []
    for (const key of recorded) {
      const shapes = await loadCounties(key.split('|')[1])
      if (!matchCounty(key, shapes)) missing.push(key)
    }
    expect(missing).toEqual([])
    // "Baltimore City" is the independent city, not Baltimore County
    expect(matchCounty('Baltimore City|MD', await loadCounties('MD'))?.id).toBe('24510')
    // two St. Louis areas: the row's own centroid decides (a point in the county, west of the city)
    const stl = project(-90.45, 38.64)
    expect(matchCounty('Saint Louis|MO', await loadCounties('MO'), stl)?.id).toBe('29189')
  })

  it('point-in-polygon agrees with the projection (Minneapolis is in Hennepin)', async () => {
    const hennepin = (await loadCounties('MN')).find((c) => c.id === '27053')
    const xy = project(-93.27, 44.98)
    expect(hennepin && xy && pointInPath(hennepin.d, xy[0], xy[1])).toBe(true)
    const states = await loadStates()
    expect(states.length).toBe(51)
    expect(states.find((s) => s.abbr === 'MN')?.name).toBe('Minnesota')
  })

  it('heat: no base is no heat; rates linear from zero; counts square-root; quantised into bands', () => {
    expect(heatOf(null, 1, 'rate')).toBeNull()
    expect(heatOf(0.05, 0.1, 'rate')).toBeCloseTo(0.5)
    expect(heatOf(25, 100, 'count')).toBeCloseTo(0.5)
    expect(heatOf(0.2, 0.1, 'rate')).toBe(1)
    expect(heatClass(0.01)).toBeCloseTo(1 / 6)
    expect(heatClass(0)).toBe(0)
  })

  it('the camera keeps the frame aspect and never zooms past a minimum', () => {
    const b = frameBox({ x: 100, y: 100, w: 0, h: 0 }, 0.1, 20)
    expect(b.w).toBeGreaterThanOrEqual(20)
    expect(b.w / b.h).toBeCloseTo(975 / 610)
  })

  it('centre marks never hide each other, and remember their true centre', () => {
    const marks = [{ x: 10, y: 10, r: 1 }, { x: 10.2, y: 10, r: 1 }, { x: 10, y: 10, r: 0.5 }, { x: 40, y: 40, r: 1 }]
    const out = dodge(marks)
    for (let i = 0; i < out.length; i += 1) for (let j = i + 1; j < out.length; j += 1) {
      expect(Math.hypot(out[i].x - out[j].x, out[i].y - out[j].y)).toBeGreaterThanOrEqual(out[i].r + out[j].r - 0.05)
    }
    expect(out[3]).toMatchObject({ x: 40, y: 40, ox: 40, oy: 40 })
    expect(out[0]).toMatchObject({ ox: 10, oy: 10 })
  })

  /* ── ZIP outlines (fixture GeoJSON: real ZCTA 55411 / 55412 as the outline function returns them) ── */
  const Z55411: GeoJsonOutline = { type: 'Polygon', coordinates: [[[-93.32061, 44.98938], [-93.31847, 44.98697], [-93.31847, 44.98405], [-93.29819, 44.98447], [-93.29392, 44.98427], [-93.29365, 44.98304], [-93.29084, 44.98317], [-93.29108, 44.98426], [-93.28533, 44.98422], [-93.28538, 44.98685], [-93.2806, 44.99029], [-93.28093, 44.9909], [-93.2829, 44.99088], [-93.28294, 44.99197], [-93.27637, 44.99202], [-93.27364, 44.99286], [-93.27577, 44.99652], [-93.27442, 45.00441], [-93.27489, 45.01313], [-93.29306, 45.01314], [-93.29547, 45.01391], [-93.2963, 45.01316], [-93.31849, 45.01325], [-93.31846, 44.99891], [-93.31987, 44.99725], [-93.31926, 44.99156], [-93.32061, 44.98938]]] }
  const Z55412: GeoJsonOutline = { type: 'MultiPolygon', coordinates: [[[[-93.32321, 45.04058], [-93.31849, 45.01325], [-93.27489, 45.01313], [-93.28449, 45.04393], [-93.32321, 45.04058]]], [[[-93.31938, 45.04202], [-93.31931, 45.04018], [-93.31807, 45.0402], [-93.31938, 45.04202]]]] }

  it('a ZIP outline lands in the same frame as the Census counties (55411 sits inside Hennepin)', async () => {
    const shape = outlineShape(Z55411, project)
    expect(shape).not.toBeNull()
    expect(shape?.d.startsWith('M')).toBe(true)
    expect(shape?.d.endsWith('Z')).toBe(true)
    // its own anchor is inside it, and inside the county polygon it belongs to
    expect(pointInPath(shape!.d, shape!.at[0], shape!.at[1])).toBe(true)
    const hennepin = (await loadCounties('MN')).find((c) => c.id === '27053')!
    expect(pointInPath(hennepin.d, shape!.at[0], shape!.at[1])).toBe(true)
    // a ZIP is a fraction of a frame unit: the path keeps sub-unit precision
    expect(shape!.box[2] - shape!.box[0]).toBeLessThan(1)
    expect(shape!.box[2] - shape!.box[0]).toBeGreaterThan(0.05)
  })

  it('multipolygons keep every part; rings outside the projection or collapsed are dropped', () => {
    expect(outlineShape(Z55412, project)?.d.match(/M/g)?.length).toBe(2)
    expect(outlineShape({ type: 'Polygon', coordinates: [[[2.35, 48.85], [2.36, 48.85], [2.36, 48.86], [2.35, 48.85]]] }, project)).toBeNull()
    expect(outlineShape({ type: 'Polygon', coordinates: [[[-93.3, 45.0], [-93.29, 45.0]]] }, project)).toBeNull()
    expect(outlineShape(null, project)).toBeNull()
  })

  it('ZIP layer: outlines where the function has them, centre marks for the rest, and the key says which', () => {
    const rows = [{ key: '55411' }, { key: '55412' }, { key: '55405' }]
    // before the function exists (or when it fails): every ZIP is a centre mark, the approximation is stated
    for (const answer of [null, { available: false, reason: 'not_installed' } as ZipOutlines]) {
      const l = zipOutlineLayer(rows, answer, project)
      expect(l.areas).toEqual([])
      expect(l.rest.map((r) => r.key)).toEqual(['55411', '55412', '55405'])
      expect(l.approximated).toBe(true)
      expect(l.note).toBe('ZIPs have no outline available — drawn at the centre of their properties')
    }
    // the function answers, one ZIP has no outline
    const some = zipOutlineLayer(rows, { available: true, source: 'US Census ZCTA', zips: { 55411: Z55411, 55412: Z55412 }, missing: ['55405'] }, project)
    expect(some.areas.map((a) => a.row.key)).toEqual(['55411', '55412'])
    expect(some.rest.map((r) => r.key)).toEqual(['55405'])
    expect(some.note).toBe('ZIP outlines: US Census ZCTA · 1 without outline shown at property centre')
    expect(some.approximated).toBe(true)
    // every ZIP on show has an outline: the approximation caption is gone
    const all = zipOutlineLayer(rows.slice(0, 2), { available: true, source: 'US Census ZCTA', zips: { 55411: Z55411, 55412: Z55412 }, missing: [] }, project)
    expect(all.rest).toEqual([])
    expect(all.approximated).toBe(false)
    expect(all.note).toBe('ZIP outlines: US Census ZCTA')
  })
})

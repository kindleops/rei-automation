import { describe, expect, it } from 'vitest'
import { atlasLevel, dodge, frameBox, heatClass, heatOf, loadCounties, loadStates, matchCounty, normCounty, pointInPath } from './intel-atlas'
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
})

import { describe, expect, it, vi } from 'vitest'

vi.mock('../desktop/workspace/workspace-store', () => ({ announceWorkspace: vi.fn(), getWorkspace: () => ({ layout: {} }), isWorkspaceRunning: () => false, openApp: vi.fn() }))
vi.mock('../desktop/workspace/layout', () => ({ instanceForApp: () => null }))
vi.mock('../../app/router', () => ({ pushRoutePath: vi.fn(), replaceRoutePath: vi.fn(), useRouteLocation: () => '/market-intelligence' }))

import { fmtPct, fmtSample, fmtUsd, fmtValue } from './mi-format'
import { DEFAULT_STATE, miPath, parseMiLocation, childLevelOf } from './mi-route-state'
import { composerPathFor, consumePending, mapAreaFor, openBeside, showGeoOnMap, MAP_AREA_PENDING_KEY, MAP_LENS_PENDING_KEY } from './mi-handoffs'
import { marketIntelDeckCommands, metricOfPhrase, parseComparison } from './deck-commands'
import { intakeFromLocation } from '../../views/campaign-command/composer/composer-intake'
import { MI_MAP_LENSES } from './map/mi-lens-defs'
import { DESK_LENSES, DESK_LENS_FAMILIES, LENS_FAMILIES, MAP_LENSES, lensById, LENS_RAMPS, rampFor } from '../../views/map/mobile/map-lenses'
import type { MiGeoSummary, MiValue } from './mi-types'

const geo = (over: Partial<MiGeoSummary>): MiGeoSummary => ({ id: 'zip:55411', level: 'zip', level_label: 'ZIP', name: '55411', label: '55411 · Minneapolis, MN', state: 'MN', parent_id: null, parents: {}, centroid: null, bbox: null, geometry: 'census_zcta', ...over })

describe('format: a number only for ok values (brief §3, §44)', () => {
  const ok: MiValue = { value: 221000, n: 183, status: 'ok' }
  it('prints money with no false precision', () => {
    expect(fmtUsd(221_400)).toBe('$221K')
    expect(fmtUsd(1_234_567)).toBe('$1.23M')
    expect(fmtPct(0.312)).toBe('31%')
    expect(fmtPct(0.054)).toBe('5.4%')
    expect(fmtPct(-0.12, true)).toBe('−12%')
    expect(fmtPct(0.12, true)).toBe('+12%')
  })
  it('withholds thin, unavailable and not-loaded values', () => {
    expect(fmtValue({ id: 'median_sale_price', unit: 'usd' }, ok)).toBe('$221K')
    expect(fmtValue({ id: 'median_sale_price', unit: 'usd' }, { value: null, n: 4, status: 'insufficient', reason: 'Insufficient sample: 4 of 10 needed' })).toBe('Thin sample')
    expect(fmtValue({ id: 'x', unit: 'count' }, { value: null, n: 0, status: 'unavailable' })).toBe('Unavailable')
    expect(fmtValue({ id: 'x', unit: 'count' }, { value: null, n: 0, status: 'not_loaded' })).toBe('Not loaded')
    expect(fmtSample({ id: 'x', unit: 'usd', aggregation: 'median' }, { value: null, n: 4, status: 'insufficient', reason: 'Insufficient sample: 4 of 10 needed' })).toMatch(/4 of 10/)
    expect(fmtSample({ id: 'investor_purchase_share', unit: 'pct', aggregation: 'ratio' }, { value: 0.35, n: 40, status: 'ok', coverage: 0.1 })).toBe('n 40 · 10% recorded')
  })
})

describe('route state: the pane path restores the screen', () => {
  it('round-trips and omits defaults', () => {
    const s = { ...DEFAULT_STATE, geo: 'market:dallas-tx', tab: 'rankings' as const, rl: 'zip', rm: 'investor_purchase_share', cmp: ['market:dallas-tx', 'market:houston-tx'], sf: [{ metric: 'sales_count', op: 'gte' as const, value: 100 }] }
    const p = miPath(s)
    expect(p.startsWith('/market-intelligence?')).toBe(true)
    expect(p).not.toContain('period=')
    expect(parseMiLocation(p)).toEqual(s)
    expect(miPath({})).toBe('/market-intelligence')
  })
  it('rejects ambiguous string identity and bad filters', () => {
    const s = parseMiLocation('/market-intelligence?geo=Dallas&cmp=zip:75217,Houston&sf=[{"metric":"x","op":"drop","value":1}]')
    expect(s.geo).toBe('nation:US')
    expect(s.cmp).toEqual(['zip:75217'])
    expect(s.sf).toEqual([])
  })
  it('default child levels', () => {
    expect(childLevelOf('nation')).toBe('state')
    expect(childLevelOf('market')).toBe('zip')
    expect(childLevelOf('zip')).toBeNull()
  })
})

describe('handoffs (brief §25–§28)', () => {
  it('Create campaign audience only prefills Composer with the geography', () => {
    expect(composerPathFor(geo({}))).toEqual({ ok: true, path: '/campaign-command?compose=1&geo_level=zip&geo=55411&label=55411+%C2%B7+Minneapolis%2C+MN' })
    const m = composerPathFor(geo({ id: 'market:dallas-tx', level: 'market', name: 'Dallas, TX', label: 'Dallas, TX', state: 'TX' }))
    expect(m.ok && m.path).toContain('market=Dallas%2C+TX')
    const c = composerPathFor(geo({ id: 'county:MN:hennepin', level: 'county', name: 'Hennepin County', label: 'Hennepin County, MN' }))
    expect(c.ok && c.path).toContain('geo_level=county&geo=Hennepin&geo_state=MN')
    expect(composerPathFor(geo({ id: 'nation:US', level: 'nation' })).ok).toBe(false)
    for (const p of ['launch', 'queue', 'send', 'activate']) expect(JSON.stringify(m)).not.toContain(p)
  })
  it('Composer reads the geography intake as canonical location filters', () => {
    expect(intakeFromLocation('/campaign-command?compose=1&geo_level=zip&geo=55411&label=ZIP')).toEqual({ kind: 'geography', level: 'zip', values: ['55411'], state: null, label: 'ZIP' })
    expect(intakeFromLocation('/campaign-command?compose=1&geo_level=city&geo=Minneapolis&geo_state=MN')).toMatchObject({ kind: 'geography', level: 'city', values: ['Minneapolis'], state: 'MN' })
    expect(intakeFromLocation('/campaign-command?compose=1&geo_level=city&geo=Minneapolis')).toEqual({ kind: 'blank' }) // a city needs its state
    expect(intakeFromLocation('/campaign-command?compose=1&geo_level=zip&geo=abc')).toEqual({ kind: 'blank' })
  })
  it('Show on Map: stages the area + lens, opens beside, refuses a pinned Map', () => {
    const store = new Map<string, string>()
    const events: string[] = []
    const deps = { running: () => true, openBeside: vi.fn(() => 'opened' as const), navigate: vi.fn(), announce: vi.fn(), mapPinned: () => null, storage: { setItem: (k: string, v: string) => { store.set(k, v) } }, dispatch: (n: string) => { events.push(n) } }
    expect(showGeoOnMap(geo({}), { lensMetric: 'investor_purchase_count' }, deps)).toBe('beside')
    expect(deps.openBeside).toHaveBeenCalledWith('/map')
    expect(JSON.parse(store.get(MAP_AREA_PENDING_KEY) as string)).toMatchObject({ kind: 'zip', key: '55411' })
    expect(JSON.parse(store.get(MAP_LENS_PENDING_KEY) as string)).toMatchObject({ lens: 'mi_investor_purchase_count' })
    expect(events).toEqual(['nexus:map-set-lens', 'nexus:map-open-area'])
    const pinned = { ...deps, mapPinned: () => ({ label: '123 Main' }), openBeside: vi.fn() }
    expect(showGeoOnMap(geo({}), {}, pinned)).toBe('pinned')
    expect(pinned.openBeside).not.toHaveBeenCalled()
    expect(mapAreaFor(geo({ id: 'market:dallas-tx', level: 'market', name: 'Dallas, TX' }))).toEqual({ kind: 'market', key: 'Dallas, TX', label: '55411 · Minneapolis, MN' })
  })
  it('open beside falls back to a real navigation when no room', () => {
    const nav = vi.fn()
    expect(openBeside('/map', { running: () => true, openBeside: () => 'refused', navigate: nav, announce: vi.fn() })).toBe('navigated')
    expect(nav).toHaveBeenCalledWith('/map')
  })
  it('staged requests expire after 30 s and are read once', () => {
    const mem = new Map<string, string>([['k', JSON.stringify({ lens: 'mi_sales_count', at: 1000 })]])
    const st = { getItem: (k: string) => mem.get(k) ?? null, removeItem: (k: string) => { mem.delete(k) } }
    expect(consumePending('k', st, 20_000)).toMatchObject({ lens: 'mi_sales_count' })
    expect(consumePending('k', st, 20_000)).toBeNull()
    mem.set('k', JSON.stringify({ lens: 'x', at: 0 }))
    expect(consumePending('k', st, 40_000)).toBeNull()
  })
})

describe('Command Deck grammar (brief §35)', () => {
  it('market <place>', () => {
    const r = marketIntelDeckCommands('market 55411')
    expect(r[0].route).toBe('/market-intelligence?geo=zip%3A55411')
    expect(marketIntelDeckCommands('market Dallas')[0].route).toBe('/market-intelligence?q=Dallas')
  })
  it('rank zip by investor purchases', () => {
    expect(parseMiLocation(marketIntelDeckCommands('rank zip by investor purchases')[0].route as string)).toMatchObject({ tab: 'rankings', rl: 'zip', rm: 'investor_purchase_count' })
    expect(parseMiLocation(marketIntelDeckCommands('rank zips by investor share in Texas')[0].route as string)).toMatchObject({ rm: 'investor_purchase_share', q: 'Texas' })
  })
  it('compare Dallas Houston', () => {
    expect(marketIntelDeckCommands('compare Dallas Houston')[0].route).toBe('/market-intelligence?tab=compare&cq=Dallas%7CHouston')
    expect(marketIntelDeckCommands('compare San Antonio, El Paso')[0].route).toContain('cq=San+Antonio%7CEl+Paso')
  })
  it('screen Texas investor share > 15', () => {
    const r = marketIntelDeckCommands('screen Texas investor share > 15')[0]
    const st = parseMiLocation(r.route as string)
    expect(st.tab).toBe('screener')
    expect(st.q).toBe('Texas')
    expect(st.sf).toEqual([{ metric: 'investor_purchase_share', op: 'gt', value: 0.15 }])
    expect(parseMiLocation(marketIntelDeckCommands('screen New York median price under 150k')[0].route as string).sf).toEqual([{ metric: 'median_sale_price', op: 'lt', value: 150000 }])
    expect(parseComparison('>= 20%', 'cash_purchase_share')).toEqual({ op: 'gte', value: 0.2 })
    expect(metricOfPhrase('cap rate')).toBeNull()
    expect(marketIntelDeckCommands('screen Texas cap rate > 8')).toEqual([])
  })
})

describe('Map: MI is a lens family on the existing Map, desktop only (brief §11, §40)', () => {
  it('phone lens lists are unchanged; desktop lists add the intel family', () => {
    expect(MAP_LENSES.some((l) => l.family === 'intel')).toBe(false)
    expect(LENS_FAMILIES.some((f) => f.key === 'intel')).toBe(false)
    expect(DESK_LENS_FAMILIES.at(-1)).toEqual({ key: 'intel', label: 'Market Intelligence' })
    expect(DESK_LENSES.length).toBe(MAP_LENSES.length + MI_MAP_LENSES.length)
    expect(lensById('mi_investor_purchase_count').family).toBe('intel')
  })
  it('every MI lens is an area lens on one single-hue ramp', () => {
    for (const l of MI_MAP_LENSES) { expect(l.ramp).toBe('intel'); expect(l.areal).toBe(true); expect(l.source).toBe(`mi:${l.id.slice(3)}`) }
    expect(LENS_RAMPS.intel).toHaveLength(6)
  })
  it('light theme: the MI ramp runs dark-for-high on the pale basemap; other lenses are untouched', () => {
    const doc = globalThis as unknown as { document?: { documentElement: { getAttribute: (k: string) => string | null } } }
    const had = doc.document
    let theme = 'light'
    doc.document = { documentElement: { getAttribute: (k: string) => (k === 'data-nexus-theme' ? theme : null) } }
    try {
      expect(rampFor({ ramp: 'intel' })).toBe('intel_light')
      expect(rampFor({ ramp: 'money' })).toBe('money')
      theme = 'dark'
      expect(rampFor({ ramp: 'intel' })).toBe('intel')
      const lum = (hex: string) => parseInt(hex.slice(1, 3), 16) * 0.299 + parseInt(hex.slice(3, 5), 16) * 0.587 + parseInt(hex.slice(5, 7), 16) * 0.114
      const light = LENS_RAMPS.intel_light
      expect(lum(light[light.length - 1])).toBeLessThan(lum(light[0])) // high value = darker on Light
      const dark = LENS_RAMPS.intel
      expect(lum(dark[dark.length - 1])).toBeGreaterThan(lum(dark[0])) // high value = brighter on Dark
    } finally { doc.document = had }
  })
})

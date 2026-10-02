import { afterEach, describe, expect, it } from 'vitest'
import { anyOverlap, colsOf } from './home-grid'
import { addInstance, itemsFor, layoutFromPreset, migrateLayout, PRESET_IDS, PRESETS, withGeometry } from './home-layout-model'
import { __widgetRegistryTest, boundsOf, classifySize, getHomeWidget, registerHomeWidget, resolveConfig, sizeModeFor } from './widget-registry'
import { homeDeckCommands, parseHomeCommand, pinFromQuery } from './home-commands'

const Dummy = () => null
const bounds = (type: string) => { const d = getHomeWidget(type); return d ? boundsOf(d) : undefined }

afterEach(() => __widgetRegistryTest.clear())

describe('widget registry', () => {
  it('rejects invalid widget definitions', () => {
    expect(() => registerHomeWidget({ id: 'Bad Id', ownerApp: 'x', name: 'x', icon: 'grid', description: '', domain: 'Command', sizes: ['small'], defaultSize: 'small', component: Dummy, defaultConfig: {}, data: '', openAction: () => null, refresh: { everyMs: 60_000 }, emptyState: '' })).toThrow(/id/)
    expect(() => registerHomeWidget({ id: 'ok.widget', ownerApp: 'x', name: 'x', icon: 'grid', description: '', domain: 'Command', sizes: ['small'], defaultSize: 'large', component: Dummy, defaultConfig: {}, data: '', openAction: () => null, refresh: { everyMs: 60_000 }, emptyState: '' })).toThrow(/defaultSize/)
  })

  it('recomposes by footprint, falling back to the nearest supported size', () => {
    expect(classifySize(3, 2)).toBe('compact')
    expect(classifySize(8, 3)).toBe('wide')
    expect(classifySize(8, 6)).toBe('feature')
    expect(classifySize(4, 7)).toBe('tall')
    expect(sizeModeFor(8, 6, ['small', 'medium', 'large'])).toBe('large')
    expect(sizeModeFor(3, 2, ['medium', 'large'])).toBe('medium')
  })

  it('migrates and validates stored config against the schema', () => {
    registerHomeWidget({
      id: 'test.metric', ownerApp: 'analytics', name: 'T', icon: 'stats', description: '', domain: 'Intelligence', sizes: ['small'], defaultSize: 'small', component: Dummy,
      defaultConfig: { metric: 'replied', period: '7d' }, configVersion: 2,
      migrateConfig: (c, from) => (from < 2 ? { metric: c.kpi === 'replies' ? 'replied' : 'delivered', period: c.period as string } : (c as { metric: string; period: string })),
      configSchema: [{ key: 'metric', kind: 'select', label: 'M', options: [{ value: 'replied', label: 'R' }, { value: 'delivered', label: 'D' }] }, { key: 'period', kind: 'segmented', label: 'P', options: [{ value: '7d', label: '7D' }, { value: '30d', label: '30D' }] }],
      data: '', openAction: () => null, refresh: { everyMs: 60_000 }, emptyState: '',
    })
    const def = getHomeWidget('test.metric')!
    // v1 config lifted by the widget's own migration
    expect(resolveConfig(def, { kpi: 'replies', period: '30d' }, 1)).toEqual({ metric: 'replied', period: '30d' })
    // a value the schema no longer offers falls back to the default; unknown keys are dropped
    expect(resolveConfig(def, { metric: 'gone', period: '30d', stray: 1 }, 2)).toEqual({ metric: 'replied', period: '30d' })
  })
})

describe('layout model', () => {
  it('builds every preset as a valid, overlap-free board at every width', () => {
    for (const p of PRESET_IDS) {
      const l = layoutFromPreset(p)
      expect(l.widgets.length).toBe(PRESETS[p].slots.length)
      for (const fam of ['narrow', 'standard', 'wide', 'ultra', 'wall'] as const) {
        const items = itemsFor(l, fam, bounds)
        expect(items).toHaveLength(l.widgets.length)
        expect(anyOverlap(items)).toBe(false)
        expect(items.every((i) => i.cell.x + i.cell.w <= colsOf(fam))).toBe(true)
      }
    }
  })

  it('keeps an ultrawide arrangement when the laptop arrangement changes', () => {
    let l = layoutFromPreset('command')
    const wall = itemsFor(l, 'wall', bounds)
    l = withGeometry(l, 'wall', wall.map((i, n) => (n === 0 ? { ...i, cell: { ...i.cell, x: 20 } } : i)))
    const laptop = itemsFor(l, 'standard', bounds)
    l = withGeometry(l, 'standard', laptop.map((i, n) => (n === 0 ? { ...i, cell: { ...i.cell, y: 30 } } : i)))
    expect(l.widgets[0].geometry.wall!.x).toBe(20)
    expect(l.widgets[0].geometry.standard!.y).toBe(30)
    expect(l.primaryFamily).toBe('standard')
  })

  it('places a widget added at one width into the other widths too', () => {
    let l = layoutFromPreset('minimal')
    l = withGeometry(l, 'wall', itemsFor(l, 'wall', bounds))
    const res = addInstance(l, { type: 'inbox.replies', ownerApp: 'inbox', size: 'medium' }, 'standard', itemsFor(l, 'standard', bounds))
    const wall = itemsFor(res.layout, 'wall', bounds)
    expect(wall.some((i) => i.id === res.id)).toBe(true)
    expect(anyOverlap(wall)).toBe(false)
  })

  it('keeps an unregistered widget type (rendered as a placeholder) and never crashes on it', () => {
    const l = migrateLayout({ id: 'l_retired', widgets: [{ id: 'w_retired1', type: 'retired.thing', size: 'medium', geometry: { standard: { x: 0, y: 0, w: 4, h: 4 } } }] })!
    expect(l.widgets[0].type).toBe('retired.thing')
    expect(itemsFor(l, 'standard', bounds)).toHaveLength(1)
  })
})

describe('home commands', () => {
  it('parses route commands and deck pins', () => {
    expect(parseHomeCommand('?home=customize')).toEqual({ kind: 'customize' })
    expect(parseHomeCommand('?home=add&widget=inbox.replies')).toEqual({ kind: 'add', type: 'inbox.replies' })
    expect(parseHomeCommand('?home=preset&preset=closings')).toEqual({ kind: 'preset', preset: 'closings' })
    expect(parseHomeCommand('?home=preset&preset=chaos')).toBeNull()
    expect(pinFromQuery('?home=pin&kind=campaign&id=c-1&label=Dallas')).toEqual({ widget: 'campaign.engine', ownerApp: 'campaign-command', subject: { kind: 'campaign', id: 'c-1', label: 'Dallas' } })
  })

  it('offers deterministic deck commands only for what was typed', () => {
    const ctx = { layouts: [{ id: 'l1', name: 'Wall' }], campaign: { id: 'c-1', label: 'Dallas Q4' } }
    expect(homeDeckCommands('customize home', ctx).map((r) => r.route)).toContain('/home?home=customize')
    expect(homeDeckCommands('home layout wa', ctx).map((r) => r.title)).toContain('Switch Home to Wall')
    expect(homeDeckCommands('reset home', ctx)[0].route).toBe('/home?home=reset')
    expect(homeDeckCommands('pin to home', ctx)[0].title).toBe('Pin Dallas Q4 to Home')
    expect(homeDeckCommands('pin to home', { ...ctx, campaign: null })).toHaveLength(0)
    expect(homeDeckCommands('in', ctx)).toHaveLength(0)
  })
})

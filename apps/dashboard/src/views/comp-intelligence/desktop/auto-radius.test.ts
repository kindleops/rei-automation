import { describe, expect, it } from 'vitest'
import type { CompsWorkspace, EvidenceComp } from '../../../domain/comp-intelligence/comps-evidence-api'
import { nextAutoRadius, QUICK_RADII, usableWithin } from './auto-radius'
import { monthChoices, radiusChoices } from './MapStage'
import { buildFilterSections } from './filter-sections'
import { NO_FILTERS } from '../../../domain/comp-intelligence/comps-workstation-model'

const comp = (mi: number, over: Partial<EvidenceComp> = {}) => ({ state: 'candidate', assetMatch: true, salePrice: 200000, distanceMiles: mi, ...over }) as EvidenceComp
const ws = (dists: number[], engineRadius = 4): Pick<CompsWorkspace, 'comps' | 'query' | 'engineRules'> => ({
  comps: dists.map((d) => comp(d)),
  query: { radiusMiles: 1, months: 30, radiusOptions: [], monthOptions: [], engineWindow: { radiusMiles: engineRadius, months: 30, clamped: false } },
  engineRules: null,
})

describe('auto radius — fitted to density, the engine’s depth (8 comps) as the bar', () => {
  it('dense: 8+ usable comps within 0.5 mi narrows to 0.5', () => {
    expect(nextAutoRadius(ws(Array(9).fill(0.3)), 1)).toMatchObject({ next: 0.5 })
    expect(nextAutoRadius(ws(Array(9).fill(0.3)), 0.5).next).toBeNull()
  })
  it('enough within 1 mi stays at 1 mi', () => {
    expect(nextAutoRadius(ws([...Array(4).fill(0.3), ...Array(5).fill(0.8)]), 1).next).toBeNull()
  })
  it('thin: widens 1 → 2 → the engine window, then stops', () => {
    expect(nextAutoRadius(ws([0.3, 0.9]), 1).next).toBe(2)
    expect(nextAutoRadius(ws([0.3, 0.9, 1.8]), 2).next).toBe(4)
    expect(nextAutoRadius(ws([0.3]), 4).next).toBeNull()
    // land / multifamily windows are wider: the ladder climbs to them
    expect(nextAutoRadius(ws([0.3], 10), 4).next).toBe(10)
  })
  it('excluded, other-asset and unpriced sales never count as usable', () => {
    const w = { comps: [comp(0.2, { state: 'excluded' }), comp(0.2, { assetMatch: false }), comp(0.2, { salePrice: null }), comp(0.2)] }
    expect(usableWithin(w, 1)).toBe(1)
  })
})

describe('window options', () => {
  it('quick radius chips are 0.5 · 1 · 2 · 4, plus the engine window and the current radius when different', () => {
    expect([...QUICK_RADII]).toEqual([0.5, 1, 2, 4])
    expect(radiusChoices(1, 4)).toEqual([0.5, 1, 2, 4])
    expect(radiusChoices(10, 7)).toEqual([0.5, 1, 2, 4, 7, 10])
  })
  it('“Sold within” offers 3 months below the served 6', () => {
    expect(monthChoices([6, 12, 18, 24, 36], 30)).toEqual([3, 6, 12, 18, 24, 30, 36])
  })
  it('the universe filters offer ≤ 3 months and 4 mi', () => {
    const sections = buildFilterSections(NO_FILTERS, () => {}, 'sfr')
    expect(sections.map((x) => x.id)).toEqual(['distance', 'time', 'property', 'transaction'])
    type Opt = { value: string; label: string }
    const time = sections[1].render() as unknown as { props: { options: Opt[] } }
    expect(time.props.options.map((o) => o.label)).toEqual(['Search', '30 d', '3 mo', '6 mo', '12 mo', '24 mo'])
    const dist = sections[0].render() as unknown as { props: { children: Array<{ props: { options: Opt[] } }> } }
    expect(dist.props.children[0].props.options.map((o) => o.value)).toEqual(['any', '0.5', '1', '2', '4'])
  })
})

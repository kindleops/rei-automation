/** Non-component UI helpers (kept out of component files for fast refresh). */
import type { LCComboOption, LCMenuEntry } from '../../../shared/lc'
import { fmtCount } from '../mi-format'
import { openComposerFor, showGeoOnMap } from '../mi-handoffs'
import type { MiGeoSummary, MiTrendPoint } from '../mi-types'
import { isWatched, toggleWatch } from '../mi-watchlist'

const COLORS = ['var(--lc-chart-1)', 'var(--lc-chart-2)', 'var(--lc-chart-3)', 'var(--lc-chart-4)', 'var(--lc-chart-5)', 'var(--lc-chart-6)']
/** Series colour in fixed order (dataviz rule: never cycled by rank, never red-for-identity). */
export const seriesColor = (i: number) => COLORS[i % COLORS.length]

export const LEVEL_SUB: Record<string, string> = { zip: 'ZIP', city: 'City', county: 'County', market: 'Market', state: 'State', nation: 'Nationwide' }
export const optionOf = (g: MiGeoSummary): LCComboOption => ({
  value: g.id,
  label: g.label,
  sub: [LEVEL_SUB[g.level], g.coverage?.sales ? `${fmtCount(g.coverage.sales)} sales` : null, g.geometry === 'none' ? null : 'outlined'].filter(Boolean).join(' · '),
  kind: LEVEL_SUB[g.level],
  group: LEVEL_SUB[g.level],
  icon: g.level === 'zip' ? 'hash' : g.level === 'market' ? 'target' : g.level === 'state' || g.level === 'nation' ? 'globe' : 'pin',
})


/** Spark series from the dossier's monthly trend (covered months only; gaps stay gaps). */
export function sparkOf(trends: MiTrendPoint[] | undefined, key: keyof MiTrendPoint): Array<number | null> {
  return (trends ?? []).filter((p) => p.status !== 'pre_coverage').map((p) => (p.status === 'covered' && typeof p[key] === 'number' ? (p[key] as number) : null))
}


export function geoMenu(g: MiGeoSummary, ctx: { openGeo: (id: string) => void; addToCompare: (id: string) => void; setInspect: (id: string | null) => void; setTab: (t: string) => void; heatMetric?: string }): LCMenuEntry[] {
  const watched = isWatched(g.id)
  return [
    { id: 'open', label: 'Open geography', icon: 'arrow-up-right', onSelect: () => ctx.openGeo(g.id) },
    { id: 'inspect', label: 'Inspect', icon: 'eye', onSelect: () => ctx.setInspect(g.id) },
    { id: 'map', label: 'Show on Map', icon: 'map', hint: 'Beside · frames the area', onSelect: () => { showGeoOnMap(g) } },
    { id: 'heat', label: 'Show on Map with heat', icon: 'grid', hint: 'Market Intelligence lens', onSelect: () => { showGeoOnMap(g, { lensMetric: ctx.heatMetric ?? 'investor_purchase_count' }) } },
    { id: 'compare', label: 'Add to compare', icon: 'layout-split', onSelect: () => ctx.addToCompare(g.id) },
    { kind: 'separator', id: 's1' },
    { id: 'sales', label: 'View recent sales', icon: 'list', hint: 'Inspector · market sales, not valuation comps', onSelect: () => ctx.setInspect(g.id) },
    { id: 'buyers', label: 'View buyers', icon: 'users', hint: 'Company buyers observed here', onSelect: () => { ctx.openGeo(g.id); ctx.setTab('investors') } },
    { id: 'props', label: 'View properties on Map', icon: 'pin', onSelect: () => { showGeoOnMap(g) } },
    { id: 'composer', label: 'Create campaign audience', icon: 'send', hint: 'Opens Composer prefilled · never launches', disabled: g.level === 'nation', reason: 'Pick a state or smaller area', onSelect: () => { openComposerFor(g) } },
    { kind: 'separator', id: 's2' },
    { id: 'watch', label: watched ? 'Remove from watchlist' : 'Add to watchlist', icon: 'star', checked: watched, onSelect: () => { toggleWatch({ id: g.id, label: g.label, level: g.level }) } },
  ]
}


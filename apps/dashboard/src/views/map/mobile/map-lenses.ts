/**
 * Map intelligence lenses — what each mode actually draws.
 *
 * Every lens reads get_map_lens_points (Supabase), which returns a real stored
 * value per point: a property field, an ACS / HUD / FHFA / FEMA market cell,
 * a sold comp, or recent outreach. The domain below is fixed per lens (set
 * from the measured 5th–95th percentile, 2026-09-26) so a colour always means
 * the same number, and the legend prints it.
 */

export type LensFamily = 'pipeline' | 'property' | 'market' | 'comps'
export type LensRamp = 'heat' | 'money' | 'water' | 'age' | 'signal' | 'spectrum'

export interface MapLens {
  id: string
  label: string
  /** One line: what the colour means. */
  sub: string
  family: LensFamily
  /** get_map_lens_points p_lens; null = markers only (no heat layer). */
  source: string | null
  /** Legacy Command Map mode that drives marker styling while this lens is on. */
  legacyMode: 'acquisition' | 'buyer_demand' | 'comps' | 'execution' | 'opportunity_heat' | 'territory' | 'census' | 'command'
  domain?: [number, number]
  /** Higher value = colder (e.g. year built: older is hotter). */
  invert?: boolean
  ramp?: LensRamp
  format?: 'pct' | 'pct100' | 'usd' | 'usdk' | 'year' | 'score' | 'share' | 'count'
  attribution?: string
  /** Market lenses: one point per area — larger, softer radius. */
  areal?: boolean
  /** Decorative: a density glow that fades out once properties draw (z9.5). Markers keep full strength. */
  ambient?: boolean
}

export const MAP_LENSES: ReadonlyArray<MapLens> = [
  // ── Pipeline ──────────────────────────────────────────────────────────
  { id: 'radar', label: 'Acquisition Radar', sub: 'Every property, coloured by conversation stage', family: 'pipeline', source: 'properties', ambient: true, legacyMode: 'acquisition', domain: [0, 1], ramp: 'signal' },
  { id: 'command', label: 'Command', sub: 'Your live conversations and hottest leads', family: 'pipeline', source: 'motivation', legacyMode: 'command', domain: [55, 85], ramp: 'signal', format: 'score', attribution: 'Motivation score' },
  { id: 'execution', label: 'Execution Live', sub: 'Outreach in the last 14 days · delivered is brightest', family: 'pipeline', source: 'outreach', legacyMode: 'execution', domain: [0, 1], ramp: 'signal', format: 'share', attribution: 'send_queue' },
  { id: 'territory', label: 'Territory Scan', sub: 'Where your property universe is densest', family: 'pipeline', source: 'properties', legacyMode: 'territory', domain: [0, 1], ramp: 'spectrum', format: 'count', attribution: 'properties' },

  // ── Property intelligence ─────────────────────────────────────────────
  { id: 'opportunity', label: 'Opportunity Heat', sub: 'Seller motivation score, averaged by area', family: 'property', source: 'motivation', legacyMode: 'acquisition', domain: [30, 72], ramp: 'heat', format: 'score', attribution: 'Structured motivation score' },
  { id: 'equity', label: 'Equity', sub: 'Owner equity %, averaged by area', family: 'property', source: 'equity', legacyMode: 'acquisition', domain: [50, 100], ramp: 'money', format: 'pct100', attribution: 'Public record equity' },
  { id: 'free_clear', label: 'Free & Clear', sub: 'Share of properties with no mortgage balance', family: 'property', source: 'free_clear', legacyMode: 'acquisition', domain: [0.3, 1], ramp: 'money', format: 'share', attribution: 'Public record loans' },
  { id: 'value', label: 'Property Value', sub: 'Estimated value, averaged by area', family: 'property', source: 'value', legacyMode: 'acquisition', domain: [100000, 900000], ramp: 'money', format: 'usdk', attribution: 'Estimated value (AVM)' },
  { id: 'year_built', label: 'Housing Age', sub: 'Year built · older stock burns hotter', family: 'property', source: 'year_built', legacyMode: 'acquisition', domain: [1915, 1990], invert: true, ramp: 'age', format: 'year', attribution: 'Assessor year built' },
  { id: 'distress', label: 'Distress', sub: 'Distress tag score, averaged by area', family: 'property', source: 'distress', legacyMode: 'acquisition', domain: [20, 60], ramp: 'heat', format: 'score', attribution: 'Distress tags' },
  { id: 'tax_delinquent', label: 'Tax Delinquent', sub: 'Share of properties behind on taxes', family: 'property', source: 'tax_delinquent', legacyMode: 'acquisition', domain: [0, 0.25], ramp: 'heat', format: 'share', attribution: 'County tax records' },

  // ── Market (Census & public data) ─────────────────────────────────────
  { id: 'census_income', label: 'Household Income', sub: 'Median household income · ACS', family: 'market', source: 'census_income', legacyMode: 'acquisition', domain: [40000, 145000], ramp: 'money', format: 'usdk', attribution: 'US Census ACS 5-yr', areal: true },
  { id: 'census_rent', label: 'Median Rent', sub: 'Median gross rent · ACS', family: 'market', source: 'census_rent', legacyMode: 'acquisition', domain: [950, 2550], ramp: 'money', format: 'usd', attribution: 'US Census ACS 5-yr', areal: true },
  { id: 'hud_rent', label: 'Fair Market Rent', sub: '2-bed Small Area FMR · HUD', family: 'market', source: 'hud_rent', legacyMode: 'acquisition', domain: [1100, 3500], ramp: 'money', format: 'usd', attribution: 'HUD SAFMR', areal: true },
  { id: 'hpi', label: 'Price Growth', sub: '5-year home price appreciation · FHFA', family: 'market', source: 'hpi', legacyMode: 'acquisition', domain: [0.25, 0.73], ramp: 'heat', format: 'pct', attribution: 'FHFA HPI', areal: true },
  { id: 'census_vacancy', label: 'Vacancy', sub: 'Vacant housing share · ACS', family: 'market', source: 'census_vacancy', legacyMode: 'acquisition', domain: [0.02, 0.23], ramp: 'heat', format: 'pct', attribution: 'US Census ACS 5-yr', areal: true },
  { id: 'census_renter', label: 'Renter Share', sub: 'Renter-occupied share · ACS', family: 'market', source: 'census_renter', legacyMode: 'acquisition', domain: [0.13, 0.76], ramp: 'spectrum', format: 'pct', attribution: 'US Census ACS 5-yr', areal: true },
  { id: 'census_rent_burden', label: 'Rent Burden', sub: 'Rent as % of income · ACS', family: 'market', source: 'census_rent_burden', legacyMode: 'acquisition', domain: [25, 43], ramp: 'heat', format: 'pct100', attribution: 'US Census ACS 5-yr', areal: true },
  { id: 'census_year_built', label: 'Housing Stock Age', sub: 'Median year built · ACS', family: 'market', source: 'census_year_built', legacyMode: 'acquisition', domain: [1942, 2005], invert: true, ramp: 'age', format: 'year', attribution: 'US Census ACS 5-yr', areal: true },
  { id: 'market_tax_delinquent', label: 'Market Tax Delinquency', sub: 'Tax-delinquent share of SFR · county records', family: 'market', source: 'market_tax_delinquent', legacyMode: 'acquisition', domain: [0, 0.08], ramp: 'heat', format: 'pct', attribution: 'Ownership cells', areal: true },
  { id: 'market_foreclosure', label: 'Foreclosure Pressure', sub: 'Foreclosure share of SFR · county records', family: 'market', source: 'market_foreclosure', legacyMode: 'acquisition', domain: [0, 0.1], ramp: 'heat', format: 'pct', attribution: 'Ownership cells', areal: true },
  { id: 'flood', label: 'Flood Exposure', sub: 'Share in FEMA special flood hazard area', family: 'market', source: 'flood', legacyMode: 'acquisition', domain: [0, 0.38], ramp: 'water', format: 'pct', attribution: 'FEMA NFHL', areal: true },

  // ── Comps & buyers ────────────────────────────────────────────────────
  { id: 'comps_price', label: 'Sold Comps', sub: 'Recent sale prices, averaged by area', family: 'comps', source: 'comps_price', legacyMode: 'comps', domain: [80000, 900000], ramp: 'money', format: 'usdk', attribution: 'Recent sold comps' },
  { id: 'comps_ppsf', label: 'Price / Sq Ft', sub: 'Sold $ per square foot', family: 'comps', source: 'comps_ppsf', legacyMode: 'comps', domain: [60, 400], ramp: 'heat', format: 'usd', attribution: 'Recent sold comps' },
]

export const LENS_FAMILIES: ReadonlyArray<{ key: LensFamily; label: string }> = [
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'property', label: 'Property intelligence' },
  { key: 'market', label: 'Census & market' },
  { key: 'comps', label: 'Comps & buyers' },
]

export const lensById = (id: string | null | undefined): MapLens =>
  MAP_LENSES.find((l) => l.id === id) ?? MAP_LENSES[0]

/** Colour stops, cold → hot, each ramp starting transparent for heatmaps. */
export const LENS_RAMPS: Record<LensRamp, string[]> = {
  // The cold end stays luminous enough to read on a dark basemap.
  heat: ['#3b2a9a', '#7e22ce', '#db2777', '#f43f5e', '#fb923c', '#fde047'],
  money: ['#1d4ed8', '#0891b2', '#10b981', '#84cc16', '#facc15', '#fff3a3'],
  water: ['#1e3a8a', '#1d4ed8', '#2563eb', '#38bdf8', '#7dd3fc', '#e0f2fe'],
  age: ['#475569', '#64748b', '#b45309', '#ea580c', '#f97316', '#fde68a'],
  signal: ['#1e3a5f', '#0e7490', '#06b6d4', '#22d3ee', '#a5f3fc', '#ffffff'],
  spectrum: ['#312e81', '#4f46e5', '#8b5cf6', '#ec4899', '#f97316', '#fde047'],
}

export function normalize(lens: MapLens, v: number): number {
  const [a, b] = lens.domain ?? [0, 1]
  const t = b === a ? 0 : (v - a) / (b - a)
  const c = Math.max(0, Math.min(1, t))
  return lens.invert ? 1 - c : c
}

export function formatLensValue(lens: MapLens, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  switch (lens.format) {
    case 'pct': return `${Math.round(v * 100)}%`
    case 'pct100': return `${Math.round(v)}%`
    case 'usd': return `$${Math.round(v).toLocaleString()}`
    case 'usdk': return v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : `$${Math.round(v / 1000)}K`
    case 'year': return String(Math.round(v))
    case 'score': return String(Math.round(v))
    case 'share': return `${Math.round(v * 100)}%`
    default: return Math.round(v).toLocaleString()
  }
}

/** MapLibre colour expression over a normalised 0..1 input. */
export function rampExpression(ramp: LensRamp, input: unknown, alphaFirst = false): unknown[] {
  const stops = LENS_RAMPS[ramp]
  const expr: unknown[] = ['interpolate', ['linear'], input]
  stops.forEach((c, i) => {
    const t = i / (stops.length - 1)
    expr.push(t, i === 0 && alphaFirst ? 'rgba(0,0,0,0)' : c)
  })
  return expr
}

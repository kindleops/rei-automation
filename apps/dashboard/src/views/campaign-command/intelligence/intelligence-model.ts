import type { Band, CatalogMetric, MetricCoverage, RankSource, ScreenerExpr, ScreenerLeaf, ScreenerOp, Tier } from './intelligence-types'

/**
 * Pure view-model for the intelligence surfaces. A share is only ever
 * rendered from BOTH numbers (count and denominator) — never a bare % and
 * never a % without its n.
 */

const nf = new Intl.NumberFormat('en-US')
export const fmtN = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? '—' : nf.format(n))

export interface Share { count: number; denominator: number; text: string; pct: string | null; ratio: number | null }

export function share(count: number | null | undefined, denominator: number | null | undefined): Share {
  const c = Number.isFinite(count as number) ? Number(count) : 0
  const d = Number.isFinite(denominator as number) ? Number(denominator) : 0
  if (d <= 0) return { count: c, denominator: 0, text: `${fmtN(c)} / —`, pct: null, ratio: null }
  const ratio = c / d
  const p = ratio * 100
  const pct = p > 0 && p < 0.1 ? '<0.1%' : `${p >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)}%`
  return { count: c, denominator: d, text: `${fmtN(c)} / ${fmtN(d)}`, pct, ratio }
}

export const TIER_ORDER: Tier[] = ['A', 'B', 'C', 'UNKNOWN']
export const TIER_LABEL: Record<Tier, string> = { A: 'A · Acute pressure', B: 'B · Strong stacked', C: 'C · Soft', UNKNOWN: 'Unknown score' }
export const TIER_SHORT: Record<Tier, string> = { A: 'Tier A', B: 'Tier B', C: 'Tier C', UNKNOWN: 'Unknown' }

export const BAND_LABEL: Record<Band, string> = {
  A: 'Band A · acute', B: 'Band B · stacked', C: 'Band C · soft', FALLBACK: 'Legacy fallback (no current evidence)', UNRANKED: 'Unranked',
}
export const RANK_SOURCE_LABEL: Record<RankSource, string> = { v2: 'Ranked by v2', legacy_fallback: 'Legacy fallback', unranked: 'Unranked' }

export const SEGMENT_ORDER = ['acute', 'tax_lien', 'vacancy_repair', 'stacked_landlord', 'other_soft', 'unknown_score'] as const

export function titleCase(code: string | null | undefined): string {
  const s = String(code ?? '').trim()
  if (!s) return '—'
  const words = s.replace(/[_\s]+/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export const situationLabel = (code: string | null | undefined) => (code ? titleCase(code) : 'Not known')

const ANGLE: Record<string, string> = {
  SPEED_CERTAINTY: 'Speed / certainty', AS_IS_NO_REPAIRS: 'As-is, no repairs', TENANT_RELIEF: 'Tenant relief', CONVENIENCE: 'Convenience',
  TAX_FLEXIBILITY: 'Tax flexibility', SELLER_FINANCE: 'Seller finance', LEASE_OPTION: 'Lease option',
}
export const angleLabel = (code: string | null | undefined) => (code ? ANGLE[code] ?? titleCase(code) : 'No angle supported by evidence')

export const COMPONENT_LABEL: Record<string, string> = {
  forced_sale_pressure: 'forced-sale pressure', landlord_fatigue: 'landlord fatigue', equity_unlock: 'equity unlock',
  property_burden: 'property burden', tax_pain: 'tax pain', debt_pressure: 'debt pressure',
}

/** "High forced-sale pressure (72)" · "landlord fatigue not known" — null is unknown, never 0. */
export function componentWords(key: string, value: number | null | undefined): { level: 'high' | 'moderate' | 'low' | 'unknown'; text: string } {
  const label = COMPONENT_LABEL[key] ?? titleCase(key).toLowerCase()
  if (value === null || value === undefined || !Number.isFinite(value)) return { level: 'unknown', text: `${label} not known` }
  const level = value >= 60 ? 'high' : value >= 30 ? 'moderate' : 'low'
  return { level, text: `${level === 'high' ? 'High' : level === 'moderate' ? 'Moderate' : 'Low'} ${label} (${Math.round(value)})` }
}

export function coverageVerdict(cov: Pick<MetricCoverage, 'ratio' | 'threshold' | 'exposed' | 'known' | 'total'> | null | undefined): string {
  if (!cov || !cov.total) return 'Coverage not measured — not offered'
  const s = share(cov.known, cov.total)
  return cov.exposed
    ? `${s.pct} known (${s.text}) · exposed (≥ ${Math.round(cov.threshold * 100)}%)`
    : `${s.pct} known (${s.text}) · below the ${Math.round(cov.threshold * 100)}% exposure threshold`
}

export function catalogReason(m: CatalogMetric): string | null {
  if (m.exposed) return null
  if (m.reason === 'coverage_not_measured' || !m.coverage) return 'Coverage not measured yet — not offered'
  return `Only ${share(m.coverage.known, m.coverage.total).pct} of sellers have a value (needs ${Math.round(m.threshold * 100)}%)`
}

export const SOURCE_LABEL: Record<string, string> = { graph: 'Graph', situation: 'Seller situation', market: 'Market (MI)', derived: 'Derived', rank: 'Rank v2' }

export function opsForType(type: string): Array<{ value: ScreenerOp; label: string }> {
  if (type === 'boolean') return [{ value: 'is_true', label: 'is yes' }, { value: 'is_false', label: 'is no' }]
  if (type === 'number') return [{ value: 'gte', label: '≥' }, { value: 'lte', label: '≤' }, { value: 'gt', label: '>' }, { value: 'lt', label: '<' }]
  return [{ value: 'in', label: 'is any of' }, { value: 'nin', label: 'is none of' }]
}

export const opNeedsValue = (op: ScreenerOp) => !['is_true', 'is_false', 'known', 'unknown'].includes(op)

export interface BuilderRow { id: string; metric: string; op: ScreenerOp; value: string }

/** Builder rows (AND list + one nested ANY group) → the API's DSL. Incomplete rows are dropped. */
export function buildExpression(all: BuilderRow[], any: BuilderRow[], catalog: CatalogMetric[]): ScreenerExpr {
  const byKey = new Map(catalog.map((m) => [m.key, m]))
  const leaf = (r: BuilderRow): ScreenerLeaf | null => {
    const m = byKey.get(r.metric)
    if (!m) return null
    if (!opNeedsValue(r.op)) return { m: r.metric, op: r.op }
    const raw = r.value.trim()
    if (!raw) return null
    if (m.type === 'number') {
      const n = Number(raw)
      return Number.isFinite(n) ? { m: r.metric, op: r.op, v: n } : null
    }
    const values = raw.split(',').map((s) => s.trim()).filter(Boolean)
    return values.length ? { m: r.metric, op: r.op, v: values } : null
  }
  const allLeaves = all.map(leaf).filter((x): x is ScreenerLeaf => x !== null)
  const anyLeaves = any.map(leaf).filter((x): x is ScreenerLeaf => x !== null)
  const parts: ScreenerExpr[] = [...allLeaves]
  if (anyLeaves.length === 1) parts.push(anyLeaves[0])
  else if (anyLeaves.length > 1) parts.push({ any: anyLeaves })
  return { all: parts }
}

export function languageLabel(code: string): string {
  return titleCase(code)
}

/** Histogram bars normalised to the tallest bucket (shape only; counts stay visible). */
export function histogramBars(buckets: Array<{ lo: number; hi: number; n: number }>): Array<{ lo: number; hi: number; n: number; h: number }> {
  const max = Math.max(1, ...buckets.map((b) => b.n))
  return buckets.map((b) => ({ ...b, h: b.n / max }))
}

export const PROVENANCE_LABEL: Record<string, string> = {
  public_record: 'Public record', vendor_record: 'Property record', vendor_flag: 'DealMachine flag', derived_ratio: 'Derived ratio', formula_estimate: 'Formula estimate (low confidence)',
}

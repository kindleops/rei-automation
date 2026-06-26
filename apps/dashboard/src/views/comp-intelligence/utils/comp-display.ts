import type { CanonicalSubjectProperty } from '../../../domain/comp-intelligence/types'
import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'

export const fmtCurrency = (n: number | null | undefined) =>
  n != null && n > 0
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
    : '—'

export const fmtPpsf = (n: number | null | undefined) =>
  n != null && n > 0 ? `$${Math.round(n)}/sf` : '—'

export const fmtNum = (n: number | null | undefined) =>
  n != null ? new Intl.NumberFormat('en-US').format(n) : '—'

export const fmtDate = (value: string | null | undefined) => {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export type CompQuality = 'strong' | 'usable' | 'weak' | 'excluded' | 'preliminary' | 'official'

export function humanizeSourcePath(path: string | null | undefined): string {
  if (!path) return '—'
  if (path === 'DIRECT_RPC' || path === 'direct_rpc') return 'Public records'
  if (path === 'MARKET_FALLBACK') return 'Market fallback'
  if (path === 'API_DISCOVERY') return 'MLS / recorded sales'
  return path.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}

export function humanizeEvidenceRole(role: string | null | undefined): string | null {
  if (!role) return null
  if (role === 'DEGRADED_COMP') return 'Recovered public-record sale'
  if (role === 'EVIDENCE_ONLY') return 'Preliminary comp evidence'
  return role.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}

export function compQuality(row: CompTransactionEvidence): CompQuality {
  if (row.evidence_authority === 'DEGRADED_NON_AUTHORITATIVE') return 'preliminary'
  if (row.qualification_status === 'REJECTED' || row.qualification_status === 'QUARANTINED') return 'excluded'
  if (row.evidence_authority === 'AUTHORITATIVE_V3' && row.pricing_eligibility) return 'official'
  const score = row.similarity ?? row.qualification_score ?? 0
  if (score >= 80) return 'strong'
  if (score >= 65) return 'usable'
  if (score >= 45) return 'weak'
  if (row.pricing_eligibility) return 'usable'
  return 'preliminary'
}

export function compQualityLabel(quality: CompQuality): string {
  switch (quality) {
    case 'strong': return 'Strong comp'
    case 'usable': return 'Usable comp'
    case 'weak': return 'Weak comp'
    case 'excluded': return 'Excluded'
    case 'preliminary': return 'Preliminary evidence'
    case 'official': return 'Official V3 comp'
    default: return 'Comp'
  }
}

export function compMatchLabel(row: CompTransactionEvidence): string {
  const score = row.similarity ?? row.qualification_score
  if (row.comp_match_label && !/recovered|evidence/i.test(row.comp_match_label)) return row.comp_match_label
  if (score == null) return 'Match pending'
  if (score >= 90) return 'Elite match'
  if (score >= 80) return 'Strong match'
  if (score >= 70) return 'Usable match'
  if (score >= 55) return 'Weak match'
  return 'Low similarity'
}

export function pricePerSqft(row: CompTransactionEvidence): number | null {
  if (row.sale_price && row.square_feet && row.square_feet > 0) {
    return Math.round(row.sale_price / row.square_feet)
  }
  return null
}

export interface SubjectFacts {
  address: string
  city: string | null
  state: string | null
  zip: string | null
  propertyType: string | null
  beds: number | null
  baths: number | null
  sqft: number | null
  lotSqft: number | null
  yearBuilt: number | null
  units: number | null
  estimatedValue: number | null
  lat: number | null
  lng: number | null
  coordinateSource: string | null
  coordinateResolved: boolean
  freshness: string | null
}

export function subjectFactsFromPayload(
  subject: CanonicalSubjectProperty | null,
  fallbackAddress: string,
): SubjectFacts {
  return {
    address: subject?.canonical_address?.value || subject?.normalized_address?.value || fallbackAddress,
    city: subject?.city?.value ?? null,
    state: subject?.state?.value ?? null,
    zip: subject?.zip?.value ?? null,
    propertyType: subject?.property_type?.value ?? subject?.asset_type?.value ?? null,
    beds: subject?.bedrooms?.value ?? null,
    baths: subject?.bathrooms?.value ?? null,
    sqft: subject?.square_feet?.value ?? null,
    lotSqft: subject?.lot_square_feet?.value ?? null,
    yearBuilt: subject?.year_built?.value ?? null,
    units: subject?.units?.value ?? null,
    estimatedValue: subject?.estimated_value?.value ?? subject?.estimated_arv?.value ?? null,
    lat: subject?.latitude?.value ?? null,
    lng: subject?.longitude?.value ?? null,
    coordinateSource: subject?.coordinate_source ?? null,
    coordinateResolved: subject?.is_subject_resolved ?? false,
    freshness: subject?.latitude?.source ?? null,
  }
}

export interface CompMarketSummaryStats {
  count: number
  closestSale: CompTransactionEvidence | null
  newestSale: CompTransactionEvidence | null
  lowSale: number | null
  medianSale: number | null
  highSale: number | null
  medianPpsf: number | null
  radiusMiles: number
  monthsBack: number
  isPreliminary: boolean
}

export function computeMarketSummary(
  rows: CompTransactionEvidence[],
  radiusMiles: number,
  monthsBack: number,
  isPreliminary: boolean,
): CompMarketSummaryStats {
  const priced = rows.filter((r) => r.sale_price != null && r.sale_price > 0)
  const prices = priced.map((r) => r.sale_price!).sort((a, b) => a - b)
  const ppsfValues = priced
    .map(pricePerSqft)
    .filter((v): v is number => v != null && v > 0)
    .sort((a, b) => a - b)

  const median = (values: number[]) => {
    if (!values.length) return null
    const mid = Math.floor(values.length / 2)
    return values.length % 2 === 0
      ? Math.round((values[mid - 1] + values[mid]) / 2)
      : values[mid]
  }

  const byDistance = [...priced].sort((a, b) =>
    (a.geography.distance_miles ?? 99) - (b.geography.distance_miles ?? 99),
  )
  const byDate = [...priced].sort((a, b) => {
    const da = a.sale_date ? new Date(a.sale_date).getTime() : 0
    const db = b.sale_date ? new Date(b.sale_date).getTime() : 0
    return db - da
  })

  return {
    count: rows.length,
    closestSale: byDistance[0] ?? null,
    newestSale: byDate[0] ?? null,
    lowSale: prices[0] ?? null,
    medianSale: median(prices),
    highSale: prices[prices.length - 1] ?? null,
    medianPpsf: median(ppsfValues),
    radiusMiles,
    monthsBack,
    isPreliminary,
  }
}

export type ComparisonTone = 'exact' | 'small' | 'material' | 'missing'

export interface ComparisonRow {
  label: string
  subject: string
  comp: string
  diff: string
  tone: ComparisonTone
}

function pctDiff(subject: number, comp: number): string {
  const pct = ((comp - subject) / subject) * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}%`
}

export function buildComparisonRows(
  subject: SubjectFacts,
  comp: CompTransactionEvidence,
): ComparisonRow[] {
  const rows: ComparisonRow[] = []

  const addNumeric = (
    label: string,
    subj: number | null,
    compVal: number | null,
    formatter: (n: number) => string = fmtNum,
  ) => {
    if (subj == null && compVal == null) {
      rows.push({ label, subject: '—', comp: '—', diff: '—', tone: 'missing' })
      return
    }
    const s = subj != null ? formatter(subj) : '—'
    const c = compVal != null ? formatter(compVal) : '—'
    let diff = '—'
    let tone: ComparisonTone = 'missing'
    if (subj != null && compVal != null && subj > 0) {
      const delta = Math.abs(compVal - subj) / subj
      if (delta < 0.001) { diff = 'Exact'; tone = 'exact' }
      else if (delta <= 0.1) { diff = pctDiff(subj, compVal); tone = 'small' }
      else { diff = pctDiff(subj, compVal); tone = 'material' }
    }
    rows.push({ label, subject: s, comp: c, diff, tone })
  }

  addNumeric('Square feet', subject.sqft, comp.square_feet ?? null)
  rows.push({
    label: 'Beds',
    subject: subject.beds != null ? String(subject.beds) : '—',
    comp: comp.bedrooms != null ? String(comp.bedrooms) : '—',
    diff: subject.beds != null && comp.bedrooms != null
      ? (subject.beds === comp.bedrooms ? 'Exact' : `${comp.bedrooms - subject.beds > 0 ? '+' : ''}${comp.bedrooms - subject.beds}`)
      : '—',
    tone: subject.beds != null && comp.bedrooms != null
      ? (subject.beds === comp.bedrooms ? 'exact' : 'small')
      : 'missing',
  })
  rows.push({
    label: 'Baths',
    subject: subject.baths != null ? String(subject.baths) : '—',
    comp: comp.bathrooms != null ? String(comp.bathrooms) : '—',
    diff: subject.baths != null && comp.bathrooms != null
      ? (subject.baths === comp.bathrooms ? 'Exact' : `${(comp.bathrooms - subject.baths).toFixed(1)}`)
      : '—',
    tone: subject.baths != null && comp.bathrooms != null
      ? (subject.baths === comp.bathrooms ? 'exact' : 'small')
      : 'missing',
  })
  addNumeric('Year built', subject.yearBuilt, comp.year_built ?? null, (n) => String(n))
  addNumeric('Lot size', subject.lotSqft, comp.lot_square_feet ?? null)

  rows.push({
    label: 'Distance',
    subject: '—',
    comp: '—',
    diff: comp.geography.distance_miles != null ? `${comp.geography.distance_miles.toFixed(2)} mi` : '—',
    tone: 'small',
  })
  rows.push({
    label: 'Sold price',
    subject: '—',
    comp: '—',
    diff: fmtCurrency(comp.sale_price),
    tone: 'material',
  })
  rows.push({
    label: 'Price / sqft',
    subject: '—',
    comp: '—',
    diff: fmtPpsf(pricePerSqft(comp)),
    tone: 'small',
  })

  return rows
}
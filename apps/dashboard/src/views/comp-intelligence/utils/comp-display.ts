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

export type EvidenceAuthority =
  | 'OFFICIAL_V3'
  | 'PRELIMINARY_RECOVERED'
  | 'REVIEW_REQUIRED'
  | 'REJECTED'

export type MatchQuality = 'STRONG' | 'USABLE' | 'WEAK' | 'UNRATED'

export interface CompClassification {
  authority: EvidenceAuthority
  quality: MatchQuality
  score: number | null
  isExcluded: boolean
}

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

/** One canonical adapter for authority vs match quality separation. */
export function classifyComp(row: CompTransactionEvidence): CompClassification {
  const score = row.similarity ?? row.qualification_score ?? null
  const qualStatus = (row.qualification_status || '').toUpperCase()
  const isExplicitReject = qualStatus === 'REJECTED' || qualStatus === 'QUARANTINED'

  let authority: EvidenceAuthority
  if (isExplicitReject) {
    authority = 'REJECTED'
  } else if (row.evidence_authority === 'AUTHORITATIVE_V3') {
    authority = 'OFFICIAL_V3'
  } else if (row.evidence_authority === 'DEGRADED_NON_AUTHORITATIVE' || /recovered|degraded|prelim|evidence/i.test(row.evidence_role || '')) {
    authority = 'PRELIMINARY_RECOVERED'
  } else if (qualStatus === 'REVIEW' || qualStatus === 'REVIEW_REQUIRED') {
    authority = 'REVIEW_REQUIRED'
  } else {
    authority = 'PRELIMINARY_RECOVERED'
  }

  let quality: MatchQuality
  const label = (row.comp_match_label || '').toLowerCase()
  if (isExplicitReject) {
    quality = 'UNRATED'
  } else if (label.includes('elite') || label.includes('strong')) {
    quality = 'STRONG'
  } else if (label.includes('usable')) {
    quality = 'USABLE'
  } else if (label.includes('weak') || label.includes('review')) {
    quality = 'WEAK'
  } else if (score != null) {
    if (score >= 80) quality = 'STRONG'
    else if (score >= 65) quality = 'USABLE'
    else if (score >= 45) quality = 'WEAK'
    else quality = 'UNRATED'
  } else if (row.pricing_eligibility) {
    quality = 'USABLE'
  } else {
    quality = 'UNRATED'
  }

  return {
    authority,
    quality,
    score,
    isExcluded: authority === 'REJECTED',
  }
}

export function compQuality(row: CompTransactionEvidence): CompQuality {
  const c = classifyComp(row)
  if (c.isExcluded) return 'excluded'
  if (c.authority === 'OFFICIAL_V3') return 'official'
  if (c.authority === 'PRELIMINARY_RECOVERED' && c.quality !== 'STRONG' && c.quality !== 'USABLE') return 'preliminary'
  if (c.quality === 'STRONG') return 'strong'
  if (c.quality === 'USABLE') return 'usable'
  if (c.quality === 'WEAK') return 'weak'
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

export type CompFilterKey = 'all' | 'strong' | 'usable' | 'review' | 'excluded'

export function getMatchTierForFilter(c: CompClassification): CompFilterKey {
  if (c.isExcluded) return 'excluded'
  if (c.quality === 'STRONG') return 'strong'
  if (c.quality === 'USABLE') return 'usable'
  // WEAK and REVIEW_REQUIRED map to Review filter bucket
  return 'review'
}

export function getFilterLabel(key: CompFilterKey): string {
  switch (key) {
    case 'all': return 'All'
    case 'strong': return 'Strong'
    case 'usable': return 'Usable'
    case 'review': return 'Review'
    case 'excluded': return 'Excluded'
    default: return key
  }
}

export function getAuthorityBadge(authority: EvidenceAuthority): string {
  switch (authority) {
    case 'OFFICIAL_V3': return 'V3 Official'
    case 'PRELIMINARY_RECOVERED': return 'Recovered'
    case 'REVIEW_REQUIRED': return 'Review'
    case 'REJECTED': return 'Excluded'
    default: return 'Evidence'
  }
}

export function getQualityLabel(quality: MatchQuality): string {
  switch (quality) {
    case 'STRONG': return 'Strong Match'
    case 'USABLE': return 'Usable Match'
    case 'WEAK': return 'Review'
    case 'UNRATED': return 'Unrated'
    default: return 'Match'
  }
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
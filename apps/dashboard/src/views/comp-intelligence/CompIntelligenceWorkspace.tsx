import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { buildZillowUrl, buildGoogleMapsUrl, loadSubjectComps, loadMarketComps } from '../../lib/data/commandMapData'
import { buildStreetViewUrl } from '../../domain/inbox/inbox-normalization'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { DealContext } from '../../lib/data/dealContext'
import type { ViewWidthPercent, ViewLayoutMode } from '../../domain/inbox/view-layout'
import { calculateWholesaleDeal } from '../../lib/underwriting/calculator'
import './comp-intelligence.css'

// ─────────────────────────────────────────────────────────────────────────────
// Comp Intelligence Workspace
// Purpose: valuation + comp evidence + deterministic offer inputs.
// Buyer demand belongs in Buyer Match. This view only shows market evidence
// when it supports valuation confidence, not buyer-dispo matching.
// ─────────────────────────────────────────────────────────────────────────────

function dispatchSound(name: string, detail?: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent(`vcc:sound:${name}`, { detail }))
}

type AssetClass = 'single_family' | 'multifamily' | 'land' | 'commercial' | 'unknown'
type ValuationMode = 'residential_arv' | 'multifamily_comp' | 'land' | 'commercial'
type MapMode = 'value' | 'market' | 'model'
type RadiusMiles = 0.25 | 0.5 | 1 | 1.5 | 3 | 5
type SortMode = 'match' | 'dist' | 'date' | 'price' | 'ppsf'

interface CompCandidate {
  id: string
  propertyId: string
  address: string
  city?: string
  state?: string
  zip?: string

  soldPrice: number | null
  soldDate: string | null
  soldSource: 'MLS SOLD' | 'PUBLIC RECORD SOLD' | 'RECORDED SALE' | 'UNKNOWN'

  estimatedValue: number | null
  priceOffValue: number | null
  percentOff: number | null

  beds: number | null
  baths: number | null
  sqft: number | null
  units: number | null

  propertyType: string | null
  assetClass: AssetClass
  yearBuilt: number | null
  condition: string | null
  constructionType: string | null
  lotSizeAcres: number | null

  ppsf: number | null
  ppu: number | null
  ppbd: number | null
  sqftPerUnit: number | null
  bedsPerUnit: number | null

  distanceMiles: number | null
  confidenceScore: number | null
  dealGrade: string | null
  compScore: number
  compMatchLabel: string

  buyerName?: string | null
  buyerType?: string | null
  isCorporateBuyer?: boolean
  isInstitutionalBuyer?: boolean | null
  institutionalMatchName?: string | null

  imageUrl?: string | null
  zillowUrl: string

  selected: boolean
  excluded: boolean
  excludeReason: string | null
  arvWeight: number
  lat: number
  lng: number

  reasoning: {
    distanceScore: number
    assetTypeScore: number
    propertyTypeScore: number
    sqftUnitsScore: number
    bedsBathsScore: number
    yearBuiltScore: number
    saleRecencyScore: number
    conditionScore: number
    isOutlier: boolean
    outlierReason: string | null
  }
}

interface ArvStats {
  arv: number
  low: number
  high: number
  avgPpsf: number
  arvPpsf: number
  avgPpu: number
  arvPpu: number
  confidence: number
  count: number
  conservativeOffer: number
  targetOffer: number
  maxAllowableOffer: number
  repairEstimate: number
  expectedAssignmentLow: number
  expectedAssignmentHigh: number
  buyerExitPrice: number
  buyerDemandScore: number
}

interface EvidenceSummary {
  includedCount: number
  excludedCount: number
  totalCount: number
  eliteCount: number
  strongCount: number
  weakCount: number
  mlsCount: number
  publicRecordCount: number
  institutionalCount: number
  avgScore: number
  medianPrice: number
  medianPpsf: number
  confidenceLabel: string
  confidenceTone: 'locked' | 'weak' | 'building' | 'strong' | 'elite'
}

const MAPS_API_KEY = (import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_MAPS_API_KEY
  || 'AIzaSyAhOk7KZkduU4qywmrlq5ZqSOtgktHYiFk'

const DARK_MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

const fmt = (n: number | null | undefined) =>
  n ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n) : 'Price Unknown'
const fmtNum = (n: number | null | undefined) => n ? new Intl.NumberFormat('en-US').format(n) : '—'
const fmtK = (n: number | null | undefined) => n ? `$${Math.round(n / 1000)}k` : '—'
const fmtPpsf = (n: number | null | undefined) => n ? `$${Math.round(n)}/sf` : '—'
const pct = (n: number | null | undefined) => typeof n === 'number' ? `${Math.round(n)}%` : '—'

function asNumber(value: unknown, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function computeMedian(values: number[]): number {
  const valid = values.filter(v => Number.isFinite(v) && v > 0)
  if (!valid.length) return 0
  const s = [...valid].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? Math.round((s[m - 1] + s[m]) / 2) : s[m]
}

function formatRelativeMin(date: Date): string {
  const diff = Math.round((Date.now() - date.getTime()) / 60000)
  if (diff < 1) return 'just now'
  if (diff < 60) return `${diff}m ago`
  return `${Math.round(diff / 60)}h ago`
}

function makeStreetviewUrl(lat: number, lng: number, size: string): string {
  return `https://maps.googleapis.com/maps/api/streetview?size=${size}&location=${lat},${lng}&pitch=5&fov=90&key=${MAPS_API_KEY}`
}

function calculateCompMatchScore(
  comp: Partial<CompCandidate>,
  subject: Partial<CompCandidate>
): { score: number; label: string; reasoning: CompCandidate['reasoning'] } {
  let score = 0

  let distanceScore = 0
  const dist = comp.distanceMiles ?? 99
  if (dist <= 0.25) distanceScore = 20
  else if (dist <= 0.5) distanceScore = 18
  else if (dist <= 1.0) distanceScore = 15
  else if (dist <= 1.5) distanceScore = 12
  else if (dist <= 3.0) distanceScore = 8
  else distanceScore = 4
  score += distanceScore

  let assetTypeScore = 0
  if (comp.assetClass === subject.assetClass) assetTypeScore = 20
  else if (
    ['single_family', 'multifamily'].includes(comp.assetClass || '') &&
    ['single_family', 'multifamily'].includes(subject.assetClass || '')
  ) assetTypeScore = 12
  score += assetTypeScore

  let propertyTypeScore = 0
  if (comp.propertyType && subject.propertyType && comp.propertyType === subject.propertyType) propertyTypeScore = 10
  else if (comp.propertyType && subject.propertyType && comp.propertyType.includes(subject.propertyType)) propertyTypeScore = 6
  else if (!comp.propertyType || !subject.propertyType) propertyTypeScore = 3
  score += propertyTypeScore

  let sqftUnitsScore = 0
  if (subject.assetClass === 'multifamily') {
    const sUnits = subject.units ?? 1
    const cUnits = comp.units ?? 1
    const diff = Math.abs(sUnits - cUnits)
    if (diff === 0) sqftUnitsScore = 15
    else if (diff <= 1) sqftUnitsScore = 12
    else if (diff <= 4) sqftUnitsScore = 8
    else sqftUnitsScore = 3
  } else {
    const sSqft = subject.sqft ?? 0
    const cSqft = comp.sqft ?? 0
    if (sSqft > 0 && cSqft > 0) {
      const diffPct = Math.abs(sSqft - cSqft) / sSqft
      if (diffPct <= 0.1) sqftUnitsScore = 15
      else if (diffPct <= 0.2) sqftUnitsScore = 12
      else if (diffPct <= 0.3) sqftUnitsScore = 8
      else sqftUnitsScore = 3
    } else sqftUnitsScore = 3
  }
  score += sqftUnitsScore

  let bedsBathsScore = 0
  const sBeds = subject.beds ?? 0
  const cBeds = comp.beds ?? 0
  const sBaths = subject.baths ?? 0
  const cBaths = comp.baths ?? 0
  if (sBeds > 0 && cBeds > 0) {
    if (sBeds === cBeds && sBaths === cBaths) bedsBathsScore = 10
    else if (Math.abs(sBeds - cBeds) <= 1 && Math.abs(sBaths - cBaths) <= 0.5) bedsBathsScore = 6
    else bedsBathsScore = 0
  } else bedsBathsScore = 3
  score += bedsBathsScore

  let yearBuiltScore = 0
  const sYear = subject.yearBuilt ?? 0
  const cYear = comp.yearBuilt ?? 0
  if (sYear > 0 && cYear > 0) {
    const diff = Math.abs(sYear - cYear)
    if (diff <= 5) yearBuiltScore = 10
    else if (diff <= 10) yearBuiltScore = 8
    else if (diff <= 20) yearBuiltScore = 5
    else yearBuiltScore = 2
  } else yearBuiltScore = 3
  score += yearBuiltScore

  let saleRecencyScore = 0
  const soldDate = comp.soldDate ? new Date(comp.soldDate) : null
  if (soldDate && !Number.isNaN(soldDate.getTime())) {
    const daysAgo = (Date.now() - soldDate.getTime()) / 86400000
    if (daysAgo <= 30) saleRecencyScore = 10
    else if (daysAgo <= 90) saleRecencyScore = 8
    else if (daysAgo <= 180) saleRecencyScore = 6
    else if (daysAgo <= 365) saleRecencyScore = 4
    else saleRecencyScore = 1
  } else saleRecencyScore = 1
  score += saleRecencyScore

  let conditionScore = 0
  if (comp.condition === subject.condition && comp.condition !== 'Unknown') conditionScore = 5
  else if (comp.condition === 'Unknown' || subject.condition === 'Unknown') conditionScore = 2
  else conditionScore = 1
  score += conditionScore

  let isOutlier = false
  let outlierReason: string | null = null
  if (comp.soldPrice && subject.estimatedValue) {
    const diff = Math.abs(comp.soldPrice - subject.estimatedValue) / subject.estimatedValue
    if (diff > 0.5) {
      isOutlier = true
      outlierReason = 'Price varies >50% from subject estimate'
    }
  }

  let label = 'Exclude / Review'
  if (score >= 90) label = 'Elite Match'
  else if (score >= 80) label = 'Strong Match'
  else if (score >= 70) label = 'Usable Match'
  else if (score >= 55) label = 'Weak Match'

  return {
    score,
    label,
    reasoning: {
      distanceScore,
      assetTypeScore,
      propertyTypeScore,
      sqftUnitsScore,
      bedsBathsScore,
      yearBuiltScore,
      saleRecencyScore,
      conditionScore,
      isOutlier,
      outlierReason
    }
  }
}

function computeArvStats(comps: CompCandidate[], subject: Partial<CompCandidate>): ArvStats | null {
  const active = comps.filter(c => c.selected && !c.excluded && c.soldPrice)
  if (!active.length) return null

  const totalScore = active.reduce((sum, c) => sum + c.compScore, 0)
  if (totalScore === 0) return null

  let weightedPpsf = 0
  let weightedPpu = 0
  active.forEach(c => {
    const weight = c.compScore / totalScore
    weightedPpsf += (c.ppsf ?? 0) * weight
    weightedPpu += (c.ppu ?? 0) * weight
  })

  const prices = active.map(c => c.soldPrice ?? 0).filter(p => p > 0).sort((a, b) => a - b)
  const avgPpsf = Math.round(active.reduce((s, c) => s + (c.ppsf ?? 0), 0) / active.length)
  const avgPpu = Math.round(active.reduce((s, c) => s + (c.ppu ?? 0), 0) / active.length)

  let arv = 0
  if (subject.assetClass === 'multifamily' && subject.units && weightedPpu > 0) {
    arv = Math.round((weightedPpu * subject.units) / 1000) * 1000
  } else if (subject.sqft && weightedPpsf > 0) {
    arv = Math.round((weightedPpsf * subject.sqft) / 1000) * 1000
  } else {
    arv = Math.round(active.reduce((s, c) => s + (c.soldPrice ?? 0), 0) / active.length / 1000) * 1000
  }

  const confidenceBase = (totalScore / (active.length * 100)) * 100
  const countBoost = Math.min(10, active.length * 1.5)
  const dataPenalty = (!subject.sqft && subject.assetClass !== 'multifamily') || (subject.assetClass === 'multifamily' && !subject.units) ? 15 : 0
  const confidence = Math.round(Math.max(0, Math.min(98, confidenceBase + countBoost - dataPenalty)))

  const repairEstimate = Number((subject as any).estimated_repair_cost) ||
    (subject.sqft ? subject.sqft * (subject.condition === 'Poor' ? 45 : subject.condition === 'Fair' ? 25 : 15) : 0)

  const uwResult = calculateWholesaleDeal({
    propertyType: subject.assetClass === 'multifamily'
      ? (subject.units && subject.units >= 5 ? 'multifamily_large' : 'multifamily_small')
      : 'sfh',
    arv,
    repairs: repairEstimate
  })

  return {
    arv,
    low: prices[0] || 0,
    high: prices[prices.length - 1] || 0,
    avgPpsf,
    arvPpsf: Math.round(weightedPpsf),
    avgPpu,
    arvPpu: Math.round(weightedPpu),
    confidence,
    count: active.length,
    conservativeOffer: Math.round(arv * 0.65) - repairEstimate - uwResult.assignmentFee,
    targetOffer: uwResult.mao,
    maxAllowableOffer: uwResult.maoCeiling,
    repairEstimate,
    expectedAssignmentLow: uwResult.assignmentFee,
    expectedAssignmentHigh: uwResult.assignmentFee * 1.5,
    buyerExitPrice: Math.round(arv * 0.85),
    buyerDemandScore: Math.round(confidence * 0.9)
  }
}

function getCompRole(comp: CompCandidate, arvStats: ArvStats | null): { label: string; cls: string } {
  if (comp.excluded) return { label: 'Excluded', cls: 'is-outlier' }
  if (comp.reasoning.isOutlier) return { label: 'Review Needed', cls: 'is-review' }
  if (comp.isInstitutionalBuyer) return { label: 'Institutional', cls: 'is-institutional' }
  if (!comp.soldPrice || !arvStats?.arv) return comp.compScore >= 85
    ? { label: 'Core ARV Comp', cls: 'is-core' }
    : { label: 'Moderate Match', cls: 'is-core' }

  const ratio = comp.soldPrice / arvStats.arv
  if (ratio > 1.08) return { label: 'Retail Ceiling', cls: 'is-retail' }
  if (ratio < 0.76) return { label: 'Investor Reality', cls: 'is-investor' }
  if (comp.compScore >= 85) return { label: 'Core ARV Comp', cls: 'is-core' }
  return { label: 'Comp Evidence', cls: 'is-core' }
}

function getAiReason(comp: CompCandidate): string {
  if (comp.excluded) return 'Manually excluded from valuation'
  if (comp.reasoning.isOutlier) return comp.reasoning.outlierReason || 'Outlier — review before including'
  if (comp.isInstitutionalBuyer) return `Institutional sale signal: ${comp.institutionalMatchName || comp.buyerType || 'known buyer'}`
  if (comp.compScore >= 88) return 'Elite comp — strongest subject resemblance in this radius'
  if (comp.compScore >= 80) return 'Strong comp — supports the weighted ARV model'
  if (comp.compScore >= 70) return 'Usable comp — helpful for range validation'
  if (comp.reasoning.distanceScore >= 18) return 'Close proximity, but weak similarity profile'
  return 'Weak evidence — keep out unless market is thin'
}

function getMatchLabelClass(label: string): string {
  if (label.includes('Elite')) return 'is-elite'
  if (label.includes('Strong')) return 'is-strong'
  if (label.includes('Usable')) return 'is-usable'
  if (label.includes('Weak')) return 'is-weak'
  return 'is-review'
}

function getScoreClass(score: number): string {
  if (score >= 80) return 'is-hi'
  if (score >= 65) return 'is-mid'
  if (score >= 50) return 'is-ok'
  return 'is-lo'
}

function getSourceBadgeClass(source: string): string {
  if (source === 'MLS SOLD') return 'is-mls'
  if (source === 'PUBLIC RECORD SOLD') return 'is-public'
  if (source === 'RECORDED SALE') return 'is-recorded'
  return 'is-unknown'
}

function getScoreBarFillClass(val: number, max: number): string {
  const ratio = max > 0 ? val / max : 0
  if (ratio >= 0.75) return 'is-hi'
  if (ratio >= 0.5) return 'is-mid'
  return 'is-lo'
}

function getConfidenceTone(confidence: number): EvidenceSummary['confidenceTone'] {
  if (confidence >= 85) return 'elite'
  if (confidence >= 72) return 'strong'
  if (confidence >= 55) return 'building'
  if (confidence > 0) return 'weak'
  return 'locked'
}

function getConfidenceLabel(confidence: number) {
  if (confidence >= 85) return 'Elite Evidence'
  if (confidence >= 72) return 'Strong Evidence'
  if (confidence >= 55) return 'Building Evidence'
  if (confidence > 0) return 'Thin Evidence'
  return 'Locked'
}

function summarizeEvidence(comps: CompCandidate[], arvStats: ArvStats | null): EvidenceSummary {
  const included = comps.filter(c => c.selected && !c.excluded)
  const total = comps.length
  const avgScore = total ? Math.round(comps.reduce((s, c) => s + c.compScore, 0) / total) : 0
  const confidence = arvStats?.confidence ?? 0
  return {
    includedCount: included.length,
    excludedCount: comps.filter(c => c.excluded).length,
    totalCount: total,
    eliteCount: comps.filter(c => c.compScore >= 90).length,
    strongCount: comps.filter(c => c.compScore >= 80).length,
    weakCount: comps.filter(c => c.compScore < 55).length,
    mlsCount: comps.filter(c => c.soldSource === 'MLS SOLD').length,
    publicRecordCount: comps.filter(c => c.soldSource === 'PUBLIC RECORD SOLD').length,
    institutionalCount: comps.filter(c => c.isInstitutionalBuyer).length,
    avgScore,
    medianPrice: computeMedian(included.map(c => c.soldPrice || 0)),
    medianPpsf: computeMedian(included.map(c => c.ppsf || 0)),
    confidenceLabel: getConfidenceLabel(confidence),
    confidenceTone: getConfidenceTone(confidence)
  }
}

function inferValuationMode(assetClass?: AssetClass): ValuationMode {
  if (assetClass === 'multifamily') return 'multifamily_comp'
  if (assetClass === 'land') return 'land'
  if (assetClass === 'commercial') return 'commercial'
  return 'residential_arv'
}

function normalizeAssetClass(value: unknown): AssetClass {
  const raw = String(value || '').toLowerCase()
  if (raw.includes('multi') || raw.includes('apartment') || raw.includes('unit')) return 'multifamily'
  if (raw.includes('land') || raw.includes('vacant')) return 'land'
  if (raw.includes('commercial') || raw.includes('retail') || raw.includes('industrial') || raw.includes('storage')) return 'commercial'
  if (raw.includes('single') || raw.includes('sfr') || raw.includes('sfh')) return 'single_family'
  return 'unknown'
}

export function CompIntelligenceWorkspace({
  thread,
  dealContext = null,
  paused = false,
  paneWidth = '100',
  layoutMode = 'full',
}: {
  thread: InboxWorkflowThread | null
  dealContext?: DealContext | null
  paused?: boolean
  paneWidth?: ViewWidthPercent
  layoutMode?: ViewLayoutMode
}) {
  const t = thread as unknown as Record<string, unknown>
  const dp = dealContext?.property as Record<string, unknown> | undefined

  const subject: Partial<CompCandidate> = useMemo(() => {
    const rawAsset = dp?.normalized_asset_class || t?.normalized_asset_class || dealContext?.property_type || t?.property_type
    const normalized = normalizeAssetClass(rawAsset)
    return {
      propertyId: String(dealContext?.propertyId || t?.propertyId || t?.property_id || ''),
      address: String(dealContext?.propertyAddress || t?.propertyAddress || t?.property_address || t?.subject || 'Subject Property'),
      city: String(dp?.property_address_city || t?.property_city || t?.city || ''),
      state: String(dp?.property_address_state || t?.property_state || t?.state || ''),
      zip: String(dp?.property_address_zip || t?.property_zip || t?.zip || ''),
      lat: asNumber(dealContext?.latitude || dealContext?.lat || t?.latitude || t?.lat),
      lng: asNumber(dealContext?.longitude || dealContext?.lng || t?.longitude || t?.lng),
      assetClass: normalized === 'unknown'
        ? ((dealContext?.property_type || t?.property_type) === 'Multi-Family' ? 'multifamily' : 'single_family')
        : normalized,
      propertyType: String(dealContext?.property_type || t?.property_type || ''),
      beds: asNumber(dp?.total_bedrooms || t?.total_bedrooms || t?.beds),
      baths: asNumber(dp?.total_baths || t?.total_baths || t?.baths),
      sqft: asNumber(dp?.building_square_feet || t?.building_square_feet || t?.sqft),
      units: asNumber(dp?.units_count || t?.units_count),
      yearBuilt: asNumber(dp?.year_built || t?.year_built),
      condition: String(dp?.building_condition || t?.building_condition || 'Unknown'),
      estimatedValue: asNumber(dp?.estimated_value || t?.estimated_value || t?.est_value)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, dp, dealContext?.propertyId, dealContext?.propertyAddress, dealContext?.latitude, dealContext?.longitude, dealContext?.property_type])

  const hasCoords = Math.abs(subject.lat || 0) > 0.001 && Math.abs(subject.lng || 0) > 0.001

  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map())
  const subjectMarkerRef = useRef<maplibregl.Marker | null>(null)
  const [mapReady, setMapReady] = useState(false)

  const [mapMode, setMapMode] = useState<MapMode>('value')
  const [radius, setRadius] = useState<RadiusMiles>(1)
  const [monthsBack, setMonthsBack] = useState<number>(6)
  const [assetClass, setAssetClass] = useState<string | undefined>(subject.assetClass)
  const [sortBy, setSortBy] = useState<SortMode>('match')
  const [comps, setComps] = useState<CompCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [openCompId, setOpenCompId] = useState<string | null>(null)
  const [expandedCompId, setExpandedCompId] = useState<string | null>(null)
  const [lastCalcTime, setLastCalcTime] = useState<Date | null>(null)
  const [activeSourceFilters, setActiveSourceFilters] = useState<string[]>([])
  const [valuationMode, setValuationMode] = useState<ValuationMode>(inferValuationMode(subject.assetClass as AssetClass))

  useEffect(() => {
    setValuationMode(inferValuationMode(subject.assetClass as AssetClass))
    setAssetClass(subject.assetClass)
  }, [subject.propertyId, subject.assetClass])

  useEffect(() => {
    let cancelled = false
    const propertyId = subject.propertyId
    const market = String(t?.market || subject.city || '')
    const zip = String(t?.zip || t?.property_zip || subject.zip || '')

    if (paused) return
    if (!propertyId) {
      setComps([])
      return
    }

    setLoading(true)
    dispatchSound('valuation_scan_started')

    const fetchPromise = hasCoords
      ? loadSubjectComps(propertyId, radius, monthsBack, 100, { assetClass })
      : loadMarketComps(market, zip, 100, { assetClass, monthsBack })

    fetchPromise.then((data) => {
      if (cancelled) return
      setLoading(false)
      dispatchSound('valuation_scan_completed', { count: data.length })

      const mappedComps: CompCandidate[] = data.map((d, i) => {
        const soldPrice = d.mls_sold_price || d.sale_price || 0
        const soldDate = d.mls_sold_date || d.sale_date || null
        let soldSource: CompCandidate['soldSource'] = 'UNKNOWN'
        if (d.mls_sold_price || d.mls_sold_date) soldSource = 'MLS SOLD'
        else if (d.sale_price || d.sale_date) soldSource = 'PUBLIC RECORD SOLD'

        const c: Partial<CompCandidate> = {
          id: d.property_id || `comp-${i}`,
          propertyId: d.property_id,
          address: d.property_address_full,
          city: d.property_address_city,
          state: d.property_address_state,
          zip: d.property_address_zip,
          soldPrice: soldPrice > 0 ? soldPrice : null,
          soldDate,
          soldSource,
          sqft: d.building_square_feet || null,
          beds: d.total_bedrooms || null,
          baths: d.total_baths || null,
          units: d.units_count || null,
          yearBuilt: d.year_built || null,
          condition: d.building_condition || d.renovation_level_classification || 'Unknown',
          assetClass: normalizeAssetClass(d.normalized_asset_class || d.property_type),
          propertyType: d.property_type,
          constructionType: d.construction_type || null,
          lotSizeAcres: d.lot_size_acres || null,
          lat: d.latitude,
          lng: d.longitude,
          distanceMiles: d.distance_miles,
          estimatedValue: d.estimated_value || null,
          priceOffValue: d.price_off_value || null,
          percentOff: d.percent_off || null,
          ppsf: d.computed_ppsf || (soldPrice > 0 && d.building_square_feet ? Math.round(soldPrice / d.building_square_feet) : null),
          ppu: d.ppu || (soldPrice > 0 && d.units_count && d.units_count > 1 ? Math.round(soldPrice / d.units_count) : null),
          ppbd: d.ppbd || (soldPrice > 0 && d.total_bedrooms ? Math.round(soldPrice / d.total_bedrooms) : null),
          sqftPerUnit: (d as any).sqft_per_unit || (d.building_square_feet && d.units_count ? Math.round(d.building_square_feet / d.units_count) : null),
          bedsPerUnit: (d as any).beds_per_unit || (d.total_bedrooms && d.units_count ? Math.round((d.total_bedrooms / d.units_count) * 10) / 10 : null),
          imageUrl: d.streetview_image || d.satellite_image || buildStreetViewUrl(d.property_address_full) || null,
          zillowUrl: buildZillowUrl(d.property_address_full),
          buyerType: d.buyer_type_label || null,
          isCorporateBuyer: d.is_corporate_buyer || false,
          isInstitutionalBuyer: d.is_institutional_buyer || false,
          institutionalMatchName: d.institutional_match_name || null,
          confidenceScore: d.confidence_score || null,
          dealGrade: d.deal_grade || null,
          excluded: false,
          excludeReason: null,
          arvWeight: 0,
        }

        const scoring = calculateCompMatchScore(c, subject)
        return {
          ...c,
          compScore: scoring.score,
          compMatchLabel: scoring.label,
          reasoning: scoring.reasoning,
          selected: scoring.score >= 70 && !!c.soldPrice && !scoring.reasoning.isOutlier
        } as CompCandidate
      })

      setComps(mappedComps)
    }).catch(err => {
      console.error(err)
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject.propertyId, subject.lat, subject.lng, radius, monthsBack, assetClass, hasCoords, paused])

  const arvStats = useMemo(() => computeArvStats(comps, subject), [comps, subject])

  const finalComps = useMemo(() => {
    const active = comps.filter(c => c.selected && !c.excluded)
    const totalScore = active.reduce((sum, c) => sum + c.compScore, 0)
    return comps.map(c => ({
      ...c,
      arvWeight: (c.selected && !c.excluded && totalScore > 0) ? Math.round((c.compScore / totalScore) * 100) : 0
    }))
  }, [comps])

  const filteredComps = useMemo(() => {
    if (!activeSourceFilters.length) return finalComps
    return finalComps.filter(comp => {
      if (activeSourceFilters.includes('MLS') && comp.soldSource === 'MLS SOLD') return true
      if (activeSourceFilters.includes('PR') && comp.soldSource === 'PUBLIC RECORD SOLD') return true
      if (activeSourceFilters.includes('Buyer') && (comp.isCorporateBuyer || comp.buyerType)) return true
      if (activeSourceFilters.includes('Inst.') && comp.isInstitutionalBuyer) return true
      return false
    })
  }, [finalComps, activeSourceFilters])

  const sortedComps = useMemo(() => {
    return [...filteredComps].sort((a, b) => {
      if (sortBy === 'match') return b.compScore - a.compScore
      if (sortBy === 'dist') return (a.distanceMiles ?? 99) - (b.distanceMiles ?? 99)
      if (sortBy === 'date') return new Date(b.soldDate || 0).getTime() - new Date(a.soldDate || 0).getTime()
      if (sortBy === 'price') return (b.soldPrice || 0) - (a.soldPrice || 0)
      if (sortBy === 'ppsf') return (b.ppsf || 0) - (a.ppsf || 0)
      return 0
    })
  }, [filteredComps, sortBy])

  const evidenceSummary = useMemo(() => summarizeEvidence(finalComps, arvStats), [finalComps, arvStats])

  const [displayArv, setDisplayArv] = useState(0)
  const arvAnimRef = useRef<number | null>(null)

  useEffect(() => {
    const target = arvStats?.arv ?? 0
    const start = displayArv
    if (target === start) return

    const startTime = Date.now()
    const duration = 700
    const tick = () => {
      const elapsed = Date.now() - startTime
      const progress = Math.min(elapsed / duration, 1)
      const ease = 1 - Math.pow(1 - progress, 3)
      setDisplayArv(Math.round(start + (target - start) * ease))
      if (progress < 1) arvAnimRef.current = requestAnimationFrame(tick)
    }

    if (arvAnimRef.current) cancelAnimationFrame(arvAnimRef.current)
    arvAnimRef.current = requestAnimationFrame(tick)
    return () => { if (arvAnimRef.current) cancelAnimationFrame(arvAnimRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arvStats?.arv])

  useEffect(() => {
    if (!arvStats) return
    setLastCalcTime(new Date())
    if (arvStats.confidence >= 78) dispatchSound('high_confidence_valuation', { confidence: arvStats.confidence })
    else if (arvStats.confidence < 50) dispatchSound('low_confidence_warning', { confidence: arvStats.confidence })
  }, [arvStats?.arv, arvStats?.confidence])

  const hoveredComp = useMemo(() => finalComps.find(c => c.id === hoveredId) ?? null, [finalComps, hoveredId])
  const openComp = useMemo(() => finalComps.find(c => c.id === openCompId) ?? null, [finalComps, openCompId])

  const toggleSelected = useCallback((id: string, wasSelected?: boolean) => {
    setComps(prev => prev.map(c => c.id === id ? { ...c, selected: !c.selected, excluded: false } : c))
    dispatchSound(wasSelected ? 'comp_excluded' : 'comp_included')
  }, [])

  const toggleExcluded = useCallback((id: string) => {
    setComps(prev => prev.map(c => c.id === id ? { ...c, excluded: !c.excluded, selected: c.excluded ? true : false } : c))
    dispatchSound('comp_excluded')
  }, [])

  const handleAction = async (action: string) => {
    if (!subject.propertyId) return

    try {
      if (action === 'save_snapshot') {
        if (!arvStats) return
        const active = finalComps.filter(c => c.selected && !c.excluded)
        const response = await fetch(`/api/cockpit/properties/${subject.propertyId}/valuation-snapshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            master_owner_id: String(t?.master_owner_id || ''),
            valuation_type: valuationMode,
            estimated_arv: arvStats.arv,
            estimated_value: arvStats.arv,
            arv_confidence_score: arvStats.confidence,
            comp_confidence_score: arvStats.confidence,
            median_sale_price: computeMedian(active.map(c => c.soldPrice || 0)),
            median_ppsf: computeMedian(active.map(c => c.ppsf || 0)),
            median_ppu: computeMedian(active.map(c => c.ppu || 0)),
            low_value: arvStats.low,
            high_value: arvStats.high,
            repair_estimate: arvStats.repairEstimate,
            conservative_offer: arvStats.conservativeOffer,
            target_offer: arvStats.targetOffer,
            max_allowable_offer: arvStats.maxAllowableOffer,
            expected_assignment_low: arvStats.expectedAssignmentLow,
            expected_assignment_high: arvStats.expectedAssignmentHigh,
            buyer_exit_price: arvStats.buyerExitPrice,
            buyer_demand_score: arvStats.buyerDemandScore,
            included_comp_count: active.length,
            excluded_comp_count: finalComps.filter(c => c.excluded).length,
            radius_miles: radius,
            lookback_months: monthsBack,
            asset_class: assetClass,
            included_comps: active.map(c => ({ id: c.id, score: c.compScore, weight: c.arvWeight })),
            excluded_comps: finalComps.filter(c => c.excluded).map(c => ({ id: c.id, reason: c.excludeReason }))
          })
        })
        const result = await response.json()
        if (result.ok) dispatchSound('valuation_snapshot_saved')
      }

      if (action === 'push_underwriting') {
        const response = await fetch(`/api/cockpit/properties/${subject.propertyId}/push-to-underwriting`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread_key: String(t?.thread_key || '') })
        })
        const result = await response.json()
        if (result.ok) dispatchSound('underwriting_pushed')
      }

      if (action === 'buyer_match') {
        const response = await fetch(`/api/cockpit/properties/${subject.propertyId}/run-buyer-match`, { method: 'POST' })
        const result = await response.json()
        if (result.ok) dispatchSound('buyer_match_started')
      }
    } catch (err) {
      console.error('Action failed:', err)
      dispatchSound('action_failed', { action })
    }
  }

  useEffect(() => {
    if (!mapRef.current || !hasCoords) return

    const map = new maplibregl.Map({
      container: mapRef.current,
      style: DARK_MAP_STYLE,
      center: [subject.lng!, subject.lat!],
      zoom: 14,
      attributionControl: false,
      pitchWithRotate: false,
    })

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')
    map.on('load', () => {
      const subEl = document.createElement('div')
      subEl.className = 'ci-subject-pin'
      subEl.setAttribute('aria-label', `Subject: ${subject.address}`)
      subEl.innerHTML = '★'
      subjectMarkerRef.current = new maplibregl.Marker({ element: subEl }).setLngLat([subject.lng!, subject.lat!]).addTo(map)

      map.addSource('ci-radius', { type: 'geojson', data: makeRadiusGeoJson([subject.lng!, subject.lat!], radius) })
      map.addLayer({ id: 'ci-radius-fill', type: 'fill', source: 'ci-radius', paint: { 'fill-color': 'rgba(59,130,246,0.04)' } })
      map.addLayer({ id: 'ci-radius-line', type: 'line', source: 'ci-radius', paint: { 'line-color': 'rgba(59,130,246,0.4)', 'line-width': 1.5, 'line-dasharray': [4, 3] } })
      setMapReady(true)
    })

    mapInstanceRef.current = map
    return () => {
      markersRef.current.forEach(m => m.remove())
      markersRef.current.clear()
      subjectMarkerRef.current?.remove()
      subjectMarkerRef.current = null
      setMapReady(false)
      map.remove()
      mapInstanceRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject.lat, subject.lng, hasCoords])

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapReady || !hasCoords) return
    const source = map.getSource('ci-radius') as maplibregl.GeoJSONSource | undefined
    source?.setData(makeRadiusGeoJson([subject.lng!, subject.lat!], radius))
  }, [radius, mapReady, hasCoords, subject.lng, subject.lat])

  useEffect(() => {
    const el = subjectMarkerRef.current?.getElement()
    if (el) el.classList.toggle('is-scanning', loading)
  }, [loading])

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapReady) return

    markersRef.current.forEach(m => m.remove())
    markersRef.current.clear()

    sortedComps.forEach(comp => {
      if (!comp.lat || !comp.lng) return
      const el = document.createElement('button')
      el.type = 'button'
      const matchQualityClass = comp.compScore < 55 ? 'is-weak' : ''
      el.className = [
        'ci-comp-pin',
        comp.selected && !comp.excluded ? 'is-selected' : '',
        comp.excluded ? 'is-excluded' : '',
        comp.isInstitutionalBuyer ? 'is-institutional' : '',
        matchQualityClass
      ].filter(Boolean).join(' ')
      el.setAttribute('aria-label', `${comp.address}: ${fmt(comp.soldPrice)}`)
      el.innerHTML = `<span>${comp.soldPrice ? fmtK(comp.soldPrice) : 'SOLD'}</span>`
      el.addEventListener('mouseenter', () => setHoveredId(comp.id))
      el.addEventListener('mouseleave', () => setHoveredId(null))
      el.addEventListener('click', e => {
        e.stopPropagation()
        setOpenCompId(p => p === comp.id ? null : comp.id)
      })
      markersRef.current.set(comp.id, new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([comp.lng, comp.lat]).addTo(map))
    })
  }, [sortedComps, mapReady])

  if (!thread) {
    return (
      <div className={`ci-workspace ci-workspace--empty is-pane-${paneWidth} is-layout-${layoutMode}`} data-comp-intelligence="true">
        <div className="ci-empty-state">
          <div className="ci-empty-state__icon">⌖</div>
          <strong>No Subject Selected</strong>
          <p>Select a seller or property to launch the valuation cockpit.</p>
        </div>
      </div>
    )
  }

  const includedCount = finalComps.filter(c => c.selected && !c.excluded).length
  const isMF = subject.assetClass === 'multifamily'
  const hasSubjectDataGap = (!subject.sqft && !isMF) || (isMF && !subject.units)

  return (
    <div className={`ci-workspace is-pane-${paneWidth} is-layout-${layoutMode} is-mode-${mapMode}`} data-comp-intelligence="true">
      <div className="ci-workspace__map-col">
        {hasCoords
          ? <div ref={mapRef} className="ci-map-canvas" />
          : <div className="ci-map-canvas ci-map-no-coords-wrap"><span>No coordinates on file</span><p>Using market fallback for comp lookup.</p></div>
        }

        <MapCommandCenter
          mapMode={mapMode}
          setMapMode={setMapMode}
          radius={radius}
          setRadius={setRadius}
          activeSourceFilters={activeSourceFilters}
          setActiveSourceFilters={setActiveSourceFilters}
          loading={loading}
          totalCount={finalComps.length}
          includedCount={includedCount}
          confidence={arvStats?.confidence ?? 0}
        />

        <AnimatePresence>
          {hoveredComp && !openCompId && (
            <CompHoverTooltip comp={hoveredComp} arvStats={arvStats} />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {openComp && (
            <CompDetailPopover
              comp={openComp}
              onClose={() => setOpenCompId(null)}
              onToggleSelected={() => toggleSelected(openComp.id, openComp.selected)}
            />
          )}
        </AnimatePresence>
      </div>

      <motion.div
        className="ci-panel"
        initial={{ opacity: 0, x: 16 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
      >
        <DossierHeader
          subject={subject}
          radius={radius}
          monthsBack={monthsBack}
          evidenceSummary={evidenceSummary}
          arvStats={arvStats}
        />

        <ValuationCommandBar
          valuationMode={valuationMode}
          setValuationMode={setValuationMode}
          sortBy={sortBy}
          setSortBy={setSortBy}
          monthsBack={monthsBack}
          setMonthsBack={setMonthsBack}
          assetClass={assetClass}
          setAssetClass={setAssetClass}
          loading={loading}
        />

        {mapMode === 'market' ? (
          <MarketEvidencePanel evidenceSummary={evidenceSummary} arvStats={arvStats} />
        ) : mapMode === 'model' ? (
          <ValuationModelPanel
            subject={subject}
            comps={finalComps}
            arvStats={arvStats}
            hasSubjectDataGap={hasSubjectDataGap}
          />
        ) : (
          <>
            <ValuationHeroCard
              arvStats={arvStats}
              displayArv={displayArv}
              comps={finalComps}
              subject={subject}
              lastCalcTime={lastCalcTime}
              isMF={isMF}
              evidenceSummary={evidenceSummary}
            />

            <EvidenceQualityStrip summary={evidenceSummary} arvStats={arvStats} />

            <ValuationAgentRail
              comps={finalComps}
              arvStats={arvStats}
              loading={loading}
              subject={subject}
            />

            {arvStats && <OfferWaterfallMini arvStats={arvStats} />}

            {hasSubjectDataGap && (
              <SubjectDataGapAlert
                message={isMF
                  ? 'Subject unit count missing. Multifamily valuation confidence is reduced.'
                  : 'Subject sqft missing. Residential ARV confidence is reduced.'
                }
              />
            )}

            <StickyValuationActions
              arvStats={arvStats}
              onAction={handleAction}
              canPush={!!arvStats && !hasSubjectDataGap}
            />

            {sortedComps.length > 0 && (
              <CompNavigatorStrip
                comps={sortedComps}
                activeId={hoveredId}
                onSelect={id => {
                  setHoveredId(id)
                  document.getElementById(`comp-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
                }}
              />
            )}

            <div className="ci-list-section">
              <div className="ci-list-head">
                <span>Comp Evidence</span>
                {loading ? <span>Scanning...</span> : <span>{sortedComps.length} shown · {includedCount} in ARV</span>}
              </div>
              <div>
                {sortedComps.length === 0 && !loading && (
                  <div className="ci-list-status is-empty">
                    <strong>No comps found</strong>
                    <p>Adjust radius, source filters, asset class, or lookback.</p>
                  </div>
                )}
                {sortedComps.map(comp => (
                  <CompEvidenceCard
                    key={comp.id}
                    comp={comp}
                    arvStats={arvStats}
                    isHovered={hoveredId === comp.id}
                    isExpanded={expandedCompId === comp.id}
                    onEnter={() => setHoveredId(comp.id)}
                    onLeave={() => setHoveredId(null)}
                    onClick={() => setExpandedCompId(p => p === comp.id ? null : comp.id)}
                    onToggleSelected={() => toggleSelected(comp.id, comp.selected)}
                    onToggleExcluded={() => toggleExcluded(comp.id)}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </motion.div>
    </div>
  )
}

function MapCommandCenter({
  mapMode,
  setMapMode,
  radius,
  setRadius,
  activeSourceFilters,
  setActiveSourceFilters,
  loading,
  totalCount,
  includedCount,
  confidence
}: {
  mapMode: MapMode
  setMapMode: (mode: MapMode) => void
  radius: RadiusMiles
  setRadius: (radius: RadiusMiles) => void
  activeSourceFilters: string[]
  setActiveSourceFilters: React.Dispatch<React.SetStateAction<string[]>>
  loading: boolean
  totalCount: number
  includedCount: number
  confidence: number
}) {
  return (
    <div className="ci-map-controls ci-map-controls--elite">
      <div className="ci-map-control-topline">
        <span className="ci-map-kicker">Comp Intelligence</span>
        <span className={`ci-map-health is-${getConfidenceTone(confidence)}`}>{confidence || 0}%</span>
      </div>

      <div className="ci-map-control-group" role="group" aria-label="Map mode">
        {([
          ['value', 'Value'],
          ['market', 'Market'],
          ['model', 'Model'],
        ] as [MapMode, string][]).map(([mode, label]) => (
          <button key={mode} type="button" className={`ci-map-ctrl-btn${mapMode === mode ? ' is-active' : ''}`} onClick={() => setMapMode(mode)}>
            {label}
          </button>
        ))}
      </div>

      <div className="ci-map-control-group ci-map-control-group--radius" role="group" aria-label="Radius">
        {([0.25, 0.5, 1, 1.5, 3, 5] as RadiusMiles[]).map(r => (
          <button key={r} type="button" className={`ci-map-ctrl-btn${radius === r ? ' is-active' : ''}`} onClick={() => setRadius(r)}>
            {r}mi
          </button>
        ))}
      </div>

      <div className="ci-source-chips">
        {[['MLS', 'is-mls'], ['PR', 'is-pr'], ['Buyer', 'is-buyer'], ['Inst.', 'is-inst']].map(([label, cls]) => (
          <button
            key={label}
            type="button"
            className={`ci-source-chip ${cls} ${activeSourceFilters.includes(label) ? 'is-active' : ''}`}
            onClick={() => setActiveSourceFilters(prev => prev.includes(label) ? prev.filter(f => f !== label) : [...prev, label])}
          >
            {label}
          </button>
        ))}
      </div>

      <button type="button" className={`ci-run-btn ${loading ? 'is-scanning' : ''}`}>
        <span className="ci-run-btn__dot" />
        {loading ? 'Scanning Evidence...' : `${includedCount}/${totalCount} Included`}
      </button>
    </div>
  )
}

function DossierHeader({ subject, radius, monthsBack, evidenceSummary, arvStats }: {
  subject: Partial<CompCandidate>
  radius: number
  monthsBack: number
  evidenceSummary: EvidenceSummary
  arvStats: ArvStats | null
}) {
  const hasIncompleteData = !subject.sqft && subject.assetClass !== 'multifamily'
  const hasNoUnits = subject.assetClass === 'multifamily' && !subject.units
  const cityStateParts = [subject.city, subject.state, subject.zip].filter(Boolean)

  return (
    <div className="ci-subject-header ci-subject-header--command">
      <div className="ci-subject-header__top">
        <div className="ci-subject-header__img">
          <StreetviewThumb lat={subject.lat || 0} lng={subject.lng || 0} size="subject" />
        </div>
        <div className="ci-subject-header__info">
          <div className="ci-subject-header__eyebrow">Valuation Dossier</div>
          <span className="ci-subject-header__addr">{subject.address}</span>
          {cityStateParts.length > 0 && <span className="ci-subject-header__citystate">{cityStateParts.join(', ')}</span>}
          <div className="ci-subject-header__specs">
            {subject.propertyType && <span>{subject.propertyType}</span>}
            {subject.sqft && subject.sqft > 0 ? <span>{subject.sqft.toLocaleString()} sf</span> : <span className="is-warn-text">Sqft unknown</span>}
            {subject.beds && subject.beds > 0 && <span>{subject.beds}bd / {subject.baths || 0}ba</span>}
            {subject.yearBuilt && subject.yearBuilt > 0 && <span>Built {subject.yearBuilt}</span>}
            {subject.units && subject.units > 1 && <span>{subject.units} units</span>}
          </div>
        </div>
        <div className={`ci-dossier-grade is-${evidenceSummary.confidenceTone}`}>
          <strong>{arvStats ? arvStats.confidence : 0}</strong>
          <span>{evidenceSummary.confidenceLabel}</span>
        </div>
      </div>

      <div className="ci-subject-header__chips">
        <span className="ci-status-chip is-info">{radius}mi radius</span>
        <span className="ci-status-chip is-info">{monthsBack}mo lookback</span>
        <span className="ci-status-chip is-info">{evidenceSummary.totalCount} comps</span>
        <span className="ci-status-chip is-info">{evidenceSummary.includedCount} included</span>
        {(hasIncompleteData || hasNoUnits) && <span className="ci-status-chip is-warn">Incomplete Data</span>}
        {!subject.sqft && !hasNoUnits && <span className="ci-status-chip is-warn">Sqft Missing</span>}
        {hasNoUnits && <span className="ci-status-chip is-warn">Units Missing</span>}
      </div>
    </div>
  )
}

function ValuationCommandBar({
  valuationMode,
  setValuationMode,
  sortBy,
  setSortBy,
  monthsBack,
  setMonthsBack,
  assetClass,
  setAssetClass,
  loading
}: {
  valuationMode: ValuationMode
  setValuationMode: (mode: ValuationMode) => void
  sortBy: SortMode
  setSortBy: (mode: SortMode) => void
  monthsBack: number
  setMonthsBack: (value: number) => void
  assetClass?: string
  setAssetClass: (value: string | undefined) => void
  loading: boolean
}) {
  return (
    <div className="ci-command-bar">
      <div className="ci-command-bar__left">
        <span className="ci-command-label">Model Inputs</span>
        {loading && <span className="ci-command-loading">Scanning</span>}
      </div>

      <div className="ci-command-inputs">
        <label className="ci-select-shell">
          <span>Mode</span>
          <select value={valuationMode} onChange={e => setValuationMode(e.target.value as ValuationMode)}>
            <option value="residential_arv">Residential ARV</option>
            <option value="multifamily_comp">Multifamily Comp</option>
            <option value="land">Land Model</option>
            <option value="commercial">Commercial Model</option>
          </select>
        </label>
        <label className="ci-select-shell">
          <span>Sort</span>
          <select value={sortBy} onChange={e => setSortBy(e.target.value as SortMode)}>
            <option value="match">Best Match</option>
            <option value="dist">Closest</option>
            <option value="date">Newest Sale</option>
            <option value="price">Highest Price</option>
            <option value="ppsf">PPSF</option>
          </select>
        </label>
        <label className="ci-select-shell">
          <span>Lookback</span>
          <select value={monthsBack} onChange={e => setMonthsBack(Number(e.target.value))}>
            <option value={3}>3 Months</option>
            <option value={6}>6 Months</option>
            <option value={12}>12 Months</option>
            <option value={24}>24 Months</option>
          </select>
        </label>
        <label className="ci-select-shell">
          <span>Asset</span>
          <select value={assetClass || ''} onChange={e => setAssetClass(e.target.value || undefined)}>
            <option value="">All Types</option>
            <option value="single_family">Single Family</option>
            <option value="multifamily">Multifamily</option>
            <option value="land">Land</option>
            <option value="commercial">Commercial</option>
          </select>
        </label>
      </div>
    </div>
  )
}

function ValuationHeroCard({ arvStats, displayArv, comps, subject, lastCalcTime, isMF, evidenceSummary }: {
  arvStats: ArvStats | null
  displayArv: number
  comps: CompCandidate[]
  subject: Partial<CompCandidate>
  lastCalcTime: Date | null
  isMF: boolean
  evidenceSummary: EvidenceSummary
}) {
  const active = comps.filter(c => c.selected && !c.excluded)
  const total = comps.length
  const hasPending = !subject.sqft && !isMF

  return (
    <div className={`ci-valuation-hero ci-valuation-hero--elite is-${evidenceSummary.confidenceTone}`}>
      <div className="ci-valuation-hero__top">
        <div className="ci-valuation-hero__left">
          <div className="ci-eyebrow">Estimated ARV</div>
          {arvStats ? (
            <>
              <div className="ci-arv-value">
                {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(displayArv)}
              </div>
              <div className="ci-arv-range">Evidence range {fmtK(arvStats.low)} – {fmtK(arvStats.high)}</div>
              <div className="ci-arv-basis">
                {active.length} comps · {isMF ? `${fmtK(arvStats.arvPpu)}/unit` : `${fmtPpsf(arvStats.arvPpsf)}`} · median {fmtK(evidenceSummary.medianPrice)}
              </div>
              {lastCalcTime && <div className="ci-arv-last-calc">Recalculated {formatRelativeMin(lastCalcTime)}</div>}
            </>
          ) : (
            <>
              <div className="ci-arv-value is-pending">Pending</div>
              <span className="ci-arv-status-label">
                {hasPending ? 'Needs subject sqft · ' : ''}
                {active.length === 0 ? '0 included comps' : 'Computing...'}
              </span>
            </>
          )}
        </div>
        <CompConfidenceBadge confidence={arvStats?.confidence ?? 0} />
      </div>

      <div className="ci-valuation-hero__metrics">
        <HeroMetric label="Included" value={String(active.length)} tone={active.length > 0 ? 'green' : undefined} />
        <HeroMetric label="Available" value={String(total)} />
        <HeroMetric label="Retail Ceiling" value={arvStats ? fmtK(arvStats.high) : '—'} tone="blue" />
        <HeroMetric label="Investor Reality" value={arvStats ? fmtK(arvStats.buyerExitPrice) : '—'} tone="amber" />
      </div>
    </div>
  )
}

function HeroMetric({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'blue' | 'amber' }) {
  return (
    <div className="ci-hero-metric">
      <span className="ci-hero-metric__label">{label}</span>
      <strong className={`ci-hero-metric__value${tone ? ` is-${tone}` : ''}`}>{value}</strong>
    </div>
  )
}

function EvidenceQualityStrip({ summary, arvStats }: { summary: EvidenceSummary; arvStats: ArvStats | null }) {
  return (
    <div className="ci-evidence-strip">
      <EvidencePill label="MLS" value={summary.mlsCount} />
      <EvidencePill label="Public" value={summary.publicRecordCount} />
      <EvidencePill label="Elite" value={summary.eliteCount} />
      <EvidencePill label="Strong" value={summary.strongCount} />
      <EvidencePill label="Weak" value={summary.weakCount} danger={summary.weakCount > summary.strongCount} />
      <EvidencePill label="Median PPSF" value={summary.medianPpsf ? fmtPpsf(summary.medianPpsf) : '—'} />
      <EvidencePill label="MAO" value={arvStats ? fmtK(arvStats.maxAllowableOffer) : '—'} />
    </div>
  )
}

function EvidencePill({ label, value, danger }: { label: string; value: string | number; danger?: boolean }) {
  return (
    <div className={`ci-evidence-pill${danger ? ' is-danger' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function ValuationAgentRail({ comps, arvStats, loading, subject }: {
  comps: CompCandidate[]
  arvStats: ArvStats | null
  loading: boolean
  subject: Partial<CompCandidate>
}) {
  const outlierCount = comps.filter(c => c.reasoning.isOutlier).length
  const includedCount = comps.filter(c => c.selected && !c.excluded).length
  const isMF = subject.assetClass === 'multifamily'

  const agents = [
    {
      name: 'Subject Agent',
      status: loading ? 'running' : (!subject.sqft && !isMF) || (!subject.units && isMF) ? 'warning' : 'complete',
      output: !subject.sqft && !isMF ? 'Sqft missing; confidence reduced' : subject.sqft ? `${subject.assetClass?.replace('_', ' ')} · ${subject.sqft.toLocaleString()} sf` : 'Analyzing subject data...',
      outputCls: (!subject.sqft && !isMF) ? 'is-warn' : 'is-ok',
      score: null as number | null
    },
    {
      name: 'Comp Agent',
      status: loading ? 'running' : comps.length > 0 ? 'complete' : 'idle',
      output: loading ? 'Scanning market evidence...' : `${comps.length} comps scanned`,
      outputCls: loading ? '' : comps.length > 0 ? 'is-ok' : '',
      score: comps.length > 0 ? comps.length : null
    },
    {
      name: 'Outlier Agent',
      status: loading ? 'running' : outlierCount > 0 ? 'warning' : comps.length > 0 ? 'complete' : 'idle',
      output: loading ? 'Detecting volatility...' : outlierCount > 0 ? `${outlierCount} weak/outlier matches flagged` : comps.length > 0 ? 'No major outliers detected' : 'Waiting for comps',
      outputCls: outlierCount > 0 ? 'is-warn' : '',
      score: null
    },
    {
      name: 'ARV Agent',
      status: loading ? 'running' : arvStats ? 'complete' : includedCount === 0 ? 'warning' : 'idle',
      output: arvStats ? `ARV: ${fmtK(arvStats.arv)} · ${arvStats.confidence}% confidence` : includedCount === 0 ? 'Waiting for included comps' : 'Computing...',
      outputCls: arvStats ? 'is-ok' : includedCount === 0 ? 'is-warn' : '',
      score: arvStats ? arvStats.confidence : null
    },
    {
      name: 'Value Stack Agent',
      status: arvStats ? 'complete' : 'idle',
      output: arvStats ? `Retail ${fmtK(arvStats.arv)} · Investor ${fmtK(arvStats.buyerExitPrice)}` : 'Waiting for valuation stack',
      outputCls: arvStats ? 'is-info' : '',
      score: null
    },
    {
      name: 'Offer Input Agent',
      status: arvStats ? 'complete' : 'idle',
      output: arvStats ? `Target ${fmtK(arvStats.targetOffer)} · ceiling ${fmtK(arvStats.maxAllowableOffer)}` : 'Locked until ARV exists',
      outputCls: arvStats ? 'is-info' : '',
      score: null
    }
  ]

  return (
    <div className="ci-agent-rail">
      <div className="ci-agent-rail__head">
        <span className="ci-agent-rail__title">Valuation Stack</span>
      </div>
      {agents.map(agent => (
        <div key={agent.name} className="ci-agent-item">
          <div className={`ci-agent-dot is-${agent.status}`} />
          <div className="ci-agent-info">
            <span className="ci-agent-name">{agent.name}</span>
            <span className={`ci-agent-output ${agent.outputCls}`}>{agent.output}</span>
          </div>
          {agent.score !== null && <span className="ci-agent-score">{agent.score}</span>}
        </div>
      ))}
    </div>
  )
}

function OfferWaterfallMini({ arvStats }: { arvStats: ArvStats }) {
  const liquidityAdj = Math.round(arvStats.arv * -0.03)
  const riskAdj = Math.round(arvStats.arv * -0.02)

  const rows = [
    { label: 'Retail ARV', value: arvStats.arv, cls: '' },
    { label: 'Investor Exit', value: arvStats.buyerExitPrice, cls: '' },
    { label: 'Repair Adjustment', value: -arvStats.repairEstimate, cls: 'is-negative' },
    { label: 'Liquidity Adjustment', value: liquidityAdj, cls: 'is-negative' },
    { label: 'Risk Adjustment', value: riskAdj, cls: 'is-negative' },
    { label: 'Target Spread', value: arvStats.expectedAssignmentLow, cls: 'is-highlight' },
    { label: 'Suggested Offer Input', value: arvStats.targetOffer, cls: 'is-total' },
  ]

  return (
    <div className="ci-waterfall">
      <div className="ci-waterfall__head">
        <span>Offer Input Waterfall</span>
        <small>Final strategy lives in Offer Engine</small>
      </div>
      {rows.map(row => (
        <div key={row.label} className={`ci-waterfall-row ${row.cls}`}>
          <span className="ci-waterfall-label">
            {row.cls !== 'is-total' && <span className="ci-waterfall-connector" />}
            {row.label}
          </span>
          <span className="ci-waterfall-value">
            {row.value >= 0
              ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(row.value)
              : `-$${Math.round(Math.abs(row.value) / 1000)}k`
            }
          </span>
        </div>
      ))}
    </div>
  )
}

function SubjectDataGapAlert({ message }: { message: string }) {
  return (
    <div className="ci-data-gap">
      <div className="ci-data-gap__head">
        <span className="ci-data-gap__icon">⚠</span>
        <span className="ci-data-gap__title">Subject Data Gap</span>
      </div>
      <p className="ci-data-gap__message">{message}</p>
      <div className="ci-data-gap__actions">
        <button type="button" className="ci-data-gap__btn">Use county record</button>
        <button type="button" className="ci-data-gap__btn">Estimate from comps</button>
        <button type="button" className="ci-data-gap__btn">Manual entry</button>
      </div>
    </div>
  )
}

function StickyValuationActions({ arvStats, onAction, canPush }: {
  arvStats: ArvStats | null
  onAction: (action: string) => void
  canPush: boolean
}) {
  return (
    <div className="ci-deal-actions ci-deal-actions--sticky">
      <button
        type="button"
        className="ci-deal-btn is-primary"
        disabled={!arvStats}
        onClick={() => onAction('save_snapshot')}
      >
        Save Valuation Snapshot
      </button>
      <div className="ci-deal-btn-grid">
        <button type="button" className="ci-deal-btn" disabled={!canPush} onClick={() => onAction('push_underwriting')}>Push to Underwriting</button>
        <button type="button" className="ci-deal-btn" onClick={() => onAction('buyer_match')}>Run Buyer Match</button>
        <button type="button" className="ci-deal-btn" onClick={() => onAction('seller_reply')}>Gen Seller Reply</button>
        <button type="button" className="ci-deal-btn" onClick={() => onAction('mark_hot')}>Mark Hot Deal</button>
      </div>
    </div>
  )
}

function CompNavigatorStrip({ comps, activeId, onSelect }: {
  comps: CompCandidate[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div className="ci-nav-strip">
      {comps.slice(0, 28).map(comp => {
        const isIncluded = comp.selected && !comp.excluded
        const isExcluded = comp.excluded
        const isWeak = comp.compScore < 55
        let cls = ''
        if (activeId === comp.id) cls = 'is-active'
        else if (isExcluded) cls = 'is-excluded'
        else if (isIncluded) cls = 'is-included'
        else if (isWeak) cls = 'is-weak'

        return (
          <button key={comp.id} type="button" className={`ci-nav-pill ${cls}`} onClick={() => onSelect(comp.id)}>
            <span>{comp.soldPrice ? fmtK(comp.soldPrice) : 'SOLD'}</span>
            <span style={{ opacity: 0.55 }}>{comp.compScore}</span>
          </button>
        )
      })}
    </div>
  )
}

function CompEvidenceCard({ comp, arvStats, isHovered, isExpanded, onEnter, onLeave, onClick, onToggleSelected, onToggleExcluded }: {
  comp: CompCandidate
  arvStats: ArvStats | null
  isHovered: boolean
  isExpanded: boolean
  onEnter: () => void
  onLeave: () => void
  onClick: () => void
  onToggleSelected: () => void
  onToggleExcluded: () => void
}) {
  const isActive = comp.selected && !comp.excluded
  const isMF = comp.assetClass === 'multifamily'
  const role = getCompRole(comp, arvStats)
  const aiReason = getAiReason(comp)
  const scoreCls = getScoreClass(comp.compScore)
  const matchLabelCls = getMatchLabelClass(comp.compMatchLabel)
  const sourceCls = getSourceBadgeClass(comp.soldSource)

  let cardCls = 'ci-evidence-card'
  if (isActive) cardCls += ' is-included'
  else if (comp.excluded) cardCls += ' is-excluded'
  else if (comp.compScore < 55) cardCls += ' is-weak'
  if (isHovered) cardCls += ' is-hover'
  if (isExpanded) cardCls += ' is-open'

  const scoreItems = [
    { label: 'Dist', val: comp.reasoning.distanceScore, max: 20 },
    { label: 'Asset', val: comp.reasoning.assetTypeScore, max: 20 },
    { label: 'Size', val: comp.reasoning.sqftUnitsScore, max: 15 },
    { label: 'Beds', val: comp.reasoning.bedsBathsScore, max: 10 },
    { label: 'Built', val: comp.reasoning.yearBuiltScore, max: 10 },
    { label: 'Date', val: comp.reasoning.saleRecencyScore, max: 10 },
    { label: 'Cond', val: comp.reasoning.conditionScore, max: 5 },
    { label: 'Type', val: comp.reasoning.propertyTypeScore, max: 10 },
  ]

  return (
    <motion.div
      id={`comp-${comp.id}`}
      className={cardCls}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      <div className="ci-ev-header">
        <span className={`ci-ev-source-badge ${sourceCls}`}>{comp.soldSource}</span>
        <span className="ci-ev-date">{comp.soldDate ? new Date(comp.soldDate).toLocaleDateString() : 'Date Unknown'}</span>
        <span className="ci-ev-distance">{comp.distanceMiles?.toFixed(2) ?? '—'} mi</span>
        <div className="ci-ev-match-score">
          <span className={`ci-ev-score-num ${scoreCls}`}>{comp.compScore}</span>
          <span className={`ci-ev-match-label ${matchLabelCls}`}>{comp.compMatchLabel.split(' ')[0]}</span>
        </div>
      </div>

      <div className="ci-ev-main">
        <div className="ci-ev-thumb">
          <StreetviewThumb lat={comp.lat || 0} lng={comp.lng || 0} size="row" />
          {isActive && <div className="ci-ev-thumb-badge is-in">✓ IN ARV</div>}
          {comp.excluded && <div className="ci-ev-thumb-badge is-out">EXCL</div>}
        </div>
        <div className="ci-ev-content">
          <div className="ci-ev-price">{fmt(comp.soldPrice)}</div>
          <div className="ci-ev-addr">{comp.address}</div>
          <div className="ci-ev-role-badges">
            <span className={`ci-role-badge ${role.cls}`}>{role.label}</span>
            {comp.arvWeight > 0 && <span className="ci-role-badge is-core">{comp.arvWeight}% ARV Wt.</span>}
            {comp.isInstitutionalBuyer && <span className="ci-role-badge is-institutional">Institutional Signal</span>}
          </div>
        </div>
      </div>

      <div className="ci-ev-metrics">
        {isMF ? (
          <>
            <Metric label="Units" value={comp.units || '—'} />
            <Metric label="PPU" value={fmtK(comp.ppu)} />
            <Metric label="PPSF" value={fmtPpsf(comp.ppsf)} />
            <Metric label="Avg SF" value={comp.sqftPerUnit || '—'} />
          </>
        ) : (
          <>
            <Metric label="Bd/Ba" value={`${comp.beds || '—'}/${comp.baths || '—'}`} />
            <Metric label="Sqft" value={comp.sqft?.toLocaleString() || '—'} />
            <Metric label="PPSF" value={fmtPpsf(comp.ppsf)} />
            <Metric label="Built" value={comp.yearBuilt || '—'} />
            <Metric label="Cond." value={comp.condition || '—'} />
          </>
        )}
      </div>

      <div className="ci-ev-score-strip">
        {scoreItems.map(item => (
          <div key={item.label} className="ci-ev-score-item">
            <span className="ci-ev-score-item__label">{item.label}</span>
            <div className="ci-ev-score-bar">
              <div
                className={`ci-ev-score-bar__fill ${getScoreBarFillClass(item.val, item.max)}`}
                style={{ width: `${Math.round((item.val / item.max) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="ci-ev-ai-row">
        <span className="ci-ev-why">{aiReason}</span>
        <div className="ci-ev-arv-impact">
          {comp.arvWeight > 0 && <span className="ci-ev-arv-chip">{comp.arvWeight}% weight</span>}
        </div>
      </div>

      <div className="ci-ev-actions" onClick={e => e.stopPropagation()}>
        <motion.button type="button" className={`ci-ev-action-btn is-include${isActive ? ' is-active' : ''}`} onClick={onToggleSelected} whileTap={{ scale: 0.95 }}>
          {isActive ? '✓ In ARV' : 'Include'}
        </motion.button>
        <motion.button type="button" className={`ci-ev-action-btn is-exclude${comp.excluded ? ' is-active' : ''}`} onClick={onToggleExcluded} whileTap={{ scale: 0.95 }}>
          {comp.excluded ? 'Unexclude' : 'Exclude'}
        </motion.button>
        <a href={comp.zillowUrl} target="_blank" rel="noopener noreferrer" className="ci-ev-action-btn is-external">Zillow ↗</a>
        <a href={buildGoogleMapsUrl(comp.address, comp.lat || undefined, comp.lng || undefined)} target="_blank" rel="noopener noreferrer" className="ci-ev-action-btn is-external">Maps ↗</a>
      </div>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            className="ci-ev-expanded"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="ci-ev-expanded__heading">Full Scoring Breakdown</div>
            <div className="ci-ev-scoring-full">
              {scoreItems.map(item => (
                <div key={item.label} className="ci-ev-score-detail">
                  <span className="ci-ev-score-detail__name">{item.label}</span>
                  <span className="ci-ev-score-detail__val">{item.val}/{item.max}</span>
                </div>
              ))}
            </div>
            {comp.reasoning.isOutlier && <div className="ci-ev-outlier">⚠ Outlier: {comp.reasoning.outlierReason}</div>}
            <div className="ci-ev-expanded__heading">Model Notes</div>
            <p className="ci-ev-ai-explain">{aiReason} — ARV contribution: {comp.arvWeight > 0 ? `${comp.arvWeight}% weight applied` : 'not contributing.'}</p>
            {comp.percentOff !== null && (
              <p className="ci-ev-ai-explain" style={{ marginTop: 4 }}>Discount vs estimate: {Math.round((comp.percentOff || 0) * 100)}%.</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="ci-ev-metric"><strong>{value}</strong><span>{label}</span></div>
}

function MarketEvidencePanel({ evidenceSummary, arvStats }: { evidenceSummary: EvidenceSummary; arvStats: ArvStats | null }) {
  const evidenceMetrics = [
    { label: 'MLS Evidence', value: evidenceSummary.mlsCount },
    { label: 'Public Record Evidence', value: evidenceSummary.publicRecordCount },
    { label: 'Institutional Signals', value: evidenceSummary.institutionalCount },
    { label: 'Included Comp Count', value: evidenceSummary.includedCount },
    { label: 'Retail Ceiling', value: arvStats ? fmtK(arvStats.high) : 'Pending' },
    { label: 'Investor Reality', value: arvStats ? fmtK(arvStats.buyerExitPrice) : 'Pending' },
    { label: 'Median PPSF', value: evidenceSummary.medianPpsf ? fmtPpsf(evidenceSummary.medianPpsf) : 'Pending' },
    { label: 'Market Confidence', value: arvStats ? pct(arvStats.confidence) : 'Pending' },
  ]

  return (
    <div className="ci-demand-panel ci-demand-panel--market">
      <div className="ci-demand-panel__head">Market Evidence Intelligence</div>
      <div className="ci-demand-grid">
        {evidenceMetrics.map(m => (
          <div key={m.label} className="ci-demand-metric">
            <div className="ci-demand-metric__label">{m.label}</div>
            <div className={`ci-demand-metric__value${m.value === 'Pending' ? ' is-pending' : ''}`}>{m.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ValuationModelPanel({ subject, comps, arvStats, hasSubjectDataGap }: {
  subject: Partial<CompCandidate>
  comps: CompCandidate[]
  arvStats: ArvStats | null
  hasSubjectDataGap: boolean
}) {
  const included = comps.filter(c => c.selected && !c.excluded)
  const avgScore = included.length ? Math.round(included.reduce((s, c) => s + c.compScore, 0) / included.length) : 0

  return (
    <div className="ci-model-panel">
      <div className="ci-model-panel__hero">
        <span className="ci-eyebrow">Deterministic Valuation Model</span>
        <strong>{arvStats ? fmt(arvStats.arv) : 'Locked'}</strong>
        <p>
          Comp Intelligence calculates value from weighted evidence. Buyer Match calculates liquidity and exit demand.
          Offer Engine should consume both.
        </p>
      </div>

      <div className="ci-model-grid">
        <ModelRow label="Subject asset" value={String(subject.assetClass || 'unknown')} />
        <ModelRow label="Subject basis" value={subject.assetClass === 'multifamily' ? `${subject.units || 0} units` : `${fmtNum(subject.sqft)} sqft`} />
        <ModelRow label="Included comps" value={included.length} />
        <ModelRow label="Average comp score" value={avgScore} />
        <ModelRow label="Weighted PPSF" value={arvStats ? fmtPpsf(arvStats.arvPpsf) : '—'} />
        <ModelRow label="Weighted PPU" value={arvStats ? fmtK(arvStats.arvPpu) : '—'} />
        <ModelRow label="Repair estimate" value={arvStats ? fmt(arvStats.repairEstimate) : '—'} />
        <ModelRow label="Data gap" value={hasSubjectDataGap ? 'Yes' : 'No'} />
      </div>
    </div>
  )
}

function ModelRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="ci-model-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function CompHoverTooltip({ comp, arvStats }: { comp: CompCandidate; arvStats: ArvStats | null }) {
  return (
    <motion.div
      key="tooltip"
      className="ci-tooltip"
      initial={{ opacity: 0, y: 6, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.97 }}
      transition={{ duration: 0.15 }}
    >
      <div className="ci-tooltip__source-line">
        <span className="ci-tooltip__source">{comp.soldSource}</span>
        <span className="ci-tooltip__date">{comp.soldDate ? new Date(comp.soldDate).toLocaleDateString() : 'Date Unknown'}</span>
      </div>
      <strong className="ci-tooltip__addr">{comp.address}</strong>
      <div className="ci-tooltip__grid">
        <span>Sold Price</span><strong>{fmt(comp.soldPrice)}</strong>
        <span>Distance</span><strong>{comp.distanceMiles?.toFixed(2) ?? '—'} mi</strong>
        <span>PPSF</span><strong>{fmtPpsf(comp.ppsf)}</strong>
        <span>Sqft</span><strong>{comp.sqft?.toLocaleString() ?? '—'} sf</strong>
        <span>Match</span><strong className={getScoreClass(comp.compScore)}>{comp.compScore}/100</strong>
        {arvStats && comp.arvWeight > 0 && <><span>ARV Wt.</span><strong>{comp.arvWeight}%</strong></>}
      </div>
    </motion.div>
  )
}

function CompDetailPopover({ comp, onClose, onToggleSelected }: {
  comp: CompCandidate
  onClose: () => void
  onToggleSelected: () => void
}) {
  const details: [string, string][] = [
    ['Sold Price', fmt(comp.soldPrice)],
    ['Sold Date', comp.soldDate ? new Date(comp.soldDate).toLocaleDateString() : 'Unknown'],
    ['Source', comp.soldSource],
    ['PPSF', fmtPpsf(comp.ppsf)],
    ['Sqft', comp.sqft?.toLocaleString() ?? 'Unknown'],
    ['Beds / Baths', `${comp.beds ?? '—'} bd / ${comp.baths ?? '—'} ba`],
    ['Year Built', String(comp.yearBuilt ?? 'Unknown')],
    ['Condition', comp.condition ?? 'Unknown'],
    ['Distance', `${comp.distanceMiles?.toFixed(2) ?? '—'} mi`],
    ['Match Score', `${comp.compScore}/100`],
    ['ARV Weight', `${comp.arvWeight}%`],
  ]
  if (comp.assetClass === 'multifamily') {
    details.push(['Units', String(comp.units ?? '—')], ['PPU', fmtK(comp.ppu)])
  }

  return (
    <motion.div
      className="ci-detail-popover"
      initial={{ opacity: 0, scale: 0.96, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.18 }}
    >
      <div className="ci-detail-popover__img">
        <StreetviewThumb lat={comp.lat || 0} lng={comp.lng || 0} size="popover" />
      </div>
      <div className="ci-detail-popover__head">
        <div>
          <strong>{comp.address}</strong>
          <span>{fmt(comp.soldPrice)} · {comp.soldDate ? new Date(comp.soldDate).getFullYear() : ''}</span>
        </div>
        <button type="button" className="ci-popover__close" onClick={onClose}>✕</button>
      </div>
      <div className="ci-detail-popover__body">
        {details.map(([label, value]) => (
          <div key={label} className="ci-detail-popover__row">
            <span>{label}</span><strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="ci-detail-popover__actions">
        <a href={comp.zillowUrl} target="_blank" rel="noopener noreferrer" className="ci-pop-action">Zillow ↗</a>
        <button type="button" className={`ci-pop-action ${comp.selected ? 'is-on' : ''}`} onClick={() => { onToggleSelected(); onClose() }}>
          {comp.selected ? '✓ Included' : 'Include'}
        </button>
      </div>
    </motion.div>
  )
}

function CompConfidenceBadge({ confidence }: { confidence: number }) {
  const color = confidence >= 78 ? '#34d399' : confidence >= 58 ? '#fbbf24' : confidence > 0 ? '#f87171' : 'rgba(100,116,139,0.3)'
  const circ = 138.23
  return (
    <div className="ci-conf-badge">
      <svg viewBox="0 0 56 56" aria-label={`Confidence ${confidence}`}>
        <circle cx="28" cy="28" r="22" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5" />
        <circle
          cx="28"
          cy="28"
          r="22"
          fill="none"
          stroke={color}
          strokeWidth="5"
          strokeDasharray={`${(confidence / 100) * circ} ${circ}`}
          strokeLinecap="round"
          transform="rotate(-90 28 28)"
          style={{ transition: 'stroke-dasharray 0.6s ease, stroke 0.4s' }}
        />
      </svg>
      <div className="ci-conf-badge__inner">
        <strong>{confidence}</strong>
        <span>/ 100</span>
        <small>CONF</small>
      </div>
    </div>
  )
}

function StreetviewThumb({ lat, lng, size }: { lat: number; lng: number; size: 'row' | 'popover' | 'subject' }) {
  const [err, setErr] = useState(false)
  const dims = size === 'row' ? '120x80' : size === 'popover' ? '320x180' : '200x130'
  const url = makeStreetviewUrl(lat, lng, dims)

  if (err || !lat || !lng) {
    return <div className={`ci-sv-placeholder ci-sv-placeholder--${size}`} aria-hidden><span>☐</span></div>
  }

  return <img src={url} alt="" className={`ci-sv-img ci-sv-img--${size}`} loading="lazy" onError={() => setErr(true)} />
}

function makeRadiusGeoJson(center: [number, number], radiusMiles: number) {
  const coords: [number, number][] = []
  for (let i = 0; i < 64; i++) {
    const angle = (i / 64) * 2 * Math.PI
    coords.push([
      center[0] + (radiusMiles / (69 * Math.cos((center[1] * Math.PI) / 180))) * Math.sin(angle),
      center[1] + (radiusMiles / 69) * Math.cos(angle),
    ])
  }
  coords.push(coords[0])
  return { type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: [coords] }, properties: {} }
}

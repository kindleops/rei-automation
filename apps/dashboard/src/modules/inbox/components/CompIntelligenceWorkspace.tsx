import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { buildZillowUrl, buildGoogleMapsUrl, loadSubjectComps, loadMarketComps } from '../../../lib/data/commandMapData'
import { buildStreetViewUrl } from '../inbox-normalization'
import type { InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import type { DealContext } from '../../../lib/data/dealContext'
import '../comp-intelligence.css'

// ── Types ──────────────────────────────────────────────────────────────────

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
  assetClass: 'single_family' | 'multifamily' | 'land' | 'commercial' | 'unknown'
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

  // ── Offer Engine Fields ────────────────────────────────────────────────
  conservativeOffer: number
  targetOffer: number
  maxAllowableOffer: number
  repairEstimate: number
  expectedAssignmentLow: number
  expectedAssignmentHigh: number
  buyerExitPrice: number
  buyerDemandScore: number
}

type ValuationMode = 'residential_arv' | 'multifamily_comp' | 'land' | 'commercial'
type MapMode = 'sold_comps' | 'heat_map' | 'hybrid'
type RadiusMiles = 0.25 | 0.5 | 1 | 1.5 | 3 | 5

// ── Constants ──────────────────────────────────────────────────────────────

const MAPS_API_KEY = (import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_MAPS_API_KEY
  || 'AIzaSyAhOk7KZkduU4qywmrlq5ZqSOtgktHYiFk'

const DARK_MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

// ── Comp Scoring ────────────────────────────────────────────────────────────

function calculateCompMatchScore(comp: Partial<CompCandidate>, subject: Partial<CompCandidate>): { score: number; label: string; reasoning: CompCandidate['reasoning'] } {
  let score = 0
  
  // 1. Distance Score — 20 pts
  let distanceScore = 0
  const dist = comp.distanceMiles ?? 99
  if (dist <= 0.25) distanceScore = 20
  else if (dist <= 0.5) distanceScore = 18
  else if (dist <= 1.0) distanceScore = 15
  else if (dist <= 1.5) distanceScore = 12
  else if (dist <= 3.0) distanceScore = 8
  else distanceScore = 4
  score += distanceScore

  // 2. Asset Type Match — 20 pts
  let assetTypeScore = 0
  if (comp.assetClass === subject.assetClass) assetTypeScore = 20
  else if (['single_family', 'multifamily'].includes(comp.assetClass!) && ['single_family', 'multifamily'].includes(subject.assetClass!)) assetTypeScore = 12
  score += assetTypeScore

  // 3. Property Type Match — 10 pts
  let propertyTypeScore = 0
  if (comp.propertyType === subject.propertyType) propertyTypeScore = 10
  else if (comp.propertyType && subject.propertyType && comp.propertyType.includes(subject.propertyType)) propertyTypeScore = 6
  else if (!comp.propertyType || !subject.propertyType) propertyTypeScore = 3
  score += propertyTypeScore

  // 4. Sqft / Units Similarity — 15 pts
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

  // 5. Beds/Baths Similarity — 10 pts
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

  // 6. Year Built Similarity — 10 pts
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

  // 7. Sale Recency — 10 pts
  let saleRecencyScore = 0
  const soldDate = comp.soldDate ? new Date(comp.soldDate) : null
  if (soldDate) {
    const daysAgo = (Date.now() - soldDate.getTime()) / 86400000
    if (daysAgo <= 30) saleRecencyScore = 10
    else if (daysAgo <= 90) saleRecencyScore = 8
    else if (daysAgo <= 180) saleRecencyScore = 6
    else if (daysAgo <= 365) saleRecencyScore = 4
    else saleRecencyScore = 1
  } else saleRecencyScore = 1
  score += saleRecencyScore

  // 8. Condition Match — 5 pts
  let conditionScore = 0
  if (comp.condition === subject.condition && comp.condition !== 'Unknown') conditionScore = 5
  else if (comp.condition === 'Unknown' || subject.condition === 'Unknown') conditionScore = 2
  else conditionScore = 1
  score += conditionScore

  // 9. Outlier Detection
  let isOutlier = false
  let outlierReason = null
  if (comp.soldPrice && subject.estimatedValue) {
    const diff = Math.abs(comp.soldPrice - subject.estimatedValue) / subject.estimatedValue
    if (diff > 0.5) {
      isOutlier = true
      outlierReason = 'Price varies >50% from estimate'
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

// ── Pure utilities ─────────────────────────────────────────────────────────

const fmt = (n: number | null | undefined) =>
  n ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n) : 'Price Unknown'
const fmtK = (n: number | null | undefined) => n ? `$${Math.round(n / 1000)}k` : '—'
const fmtPpsf = (n: number | null | undefined) => n ? `$${Math.round(n)}/sf` : '—'

function computeMedian(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
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

// ── ARV computation ────────────────────────────────────────────────────────

import { calculateWholesaleDeal } from '../../../lib/underwriting/calculator'

// ... existing code ...

function computeArvStats(comps: CompCandidate[], subject: Partial<CompCandidate>): ArvStats | null {
  const active = comps.filter(c => c.selected && !c.excluded)
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
    arv = Math.round(weightedPpu * subject.units / 1000) * 1000
  } else if (subject.sqft && weightedPpsf > 0) {
    arv = Math.round(weightedPpsf * subject.sqft / 1000) * 1000
  } else {
    arv = Math.round(active.reduce((s, c) => s + (c.soldPrice ?? 0), 0) / active.length / 1000) * 1000
  }

  const confidence = Math.round(Math.min(98, (totalScore / (active.length * 100)) * 100))

  // ── Offer Engine Calculation ───────────────────────────────────────────
  const repairEstimate = Number((subject as any).estimated_repair_cost) || 
                         (subject.sqft ? subject.sqft * (subject.condition === 'Poor' ? 45 : subject.condition === 'Fair' ? 25 : 15) : 0);
  
  const uwResult = calculateWholesaleDeal({
    propertyType: subject.assetClass === 'multifamily' ? (subject.units && subject.units >= 5 ? 'multifamily_large' : 'multifamily_small') : 'sfh',
    arv,
    repairs: repairEstimate
  });

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

    // New Deal Intelligence fields
    conservativeOffer: Math.round(arv * 0.65) - repairEstimate - uwResult.assignmentFee,
    targetOffer: uwResult.mao,
    maxAllowableOffer: uwResult.maoCeiling,
    repairEstimate,
    expectedAssignmentLow: uwResult.assignmentFee,
    expectedAssignmentHigh: uwResult.assignmentFee * 1.5,
    buyerExitPrice: Math.round(arv * 0.85),
    buyerDemandScore: Math.round(confidence * 0.9) // Placeholder logic for demand
  }
}

// ── Main component ─────────────────────────────────────────────────────────

export function CompIntelligenceWorkspace({ thread, dealContext = null, paused = false }: { thread: InboxWorkflowThread | null, dealContext?: DealContext | null, paused?: boolean }) {
  const t = thread as unknown as Record<string, unknown>
  const dp = dealContext?.property as Record<string, unknown> | undefined

  const subject: Partial<CompCandidate> = useMemo(() => ({
    propertyId: String(dealContext?.propertyId || t?.propertyId || t?.property_id || ''),
    address: String(dealContext?.propertyAddress || t?.propertyAddress || t?.property_address || t?.subject || 'Subject Property'),
    lat: Number(dealContext?.latitude || dealContext?.lat || t?.latitude || t?.lat || 0),
    lng: Number(dealContext?.longitude || dealContext?.lng || t?.longitude || t?.lng || 0),
    assetClass: (dp?.normalized_asset_class as any) || (t?.normalized_asset_class as any) || ((dealContext?.property_type || t?.property_type) === 'Multi-Family' ? 'multifamily' : 'single_family'),
    propertyType: String(dealContext?.property_type || t?.property_type || ''),
    beds: Number(dp?.total_bedrooms || t?.total_bedrooms || t?.beds || 0),
    baths: Number(dp?.total_baths || t?.total_baths || t?.baths || 0),
    sqft: Number(dp?.building_square_feet || t?.building_square_feet || t?.sqft || 0),
    units: Number(dp?.units_count || t?.units_count || 0),
    yearBuilt: Number(dp?.year_built || t?.year_built || 0),
    condition: String(dp?.building_condition || t?.building_condition || 'Unknown'),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [t, dp, dealContext?.propertyId, dealContext?.propertyAddress, dealContext?.latitude, dealContext?.longitude, dealContext?.property_type])

  const hasCoords = Math.abs(subject.lat || 0) > 0.001 && Math.abs(subject.lng || 0) > 0.001

  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map())
  const subjectMarkerRef = useRef<maplibregl.Marker | null>(null)
  const [mapReady, setMapReady] = useState(false)

  const [mapMode, setMapMode] = useState<MapMode>('sold_comps')
  const [radius, setRadius] = useState<RadiusMiles>(1)
  const [monthsBack, setMonthsBack] = useState<number>(6)
  const [assetClass, setAssetClass] = useState<string | undefined>(subject.assetClass)
  const [sortBy, setSortBy] = useState<'match' | 'dist' | 'date' | 'price' | 'ppsf'>('match')
  const [comps, setComps] = useState<CompCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [openCompId, setOpenCompId] = useState<string | null>(null)
  const [lastCalcTime, setLastCalcTime] = useState<Date | null>(null)

  useEffect(() => {
    let cancelled = false
    const propertyId = subject.propertyId
    const market = String(t?.market || '')
    const zip = String(t?.zip || t?.property_zip || '')

    if (paused) {
       console.log('[HeavyPanelLoadSkipped] CompIntelligenceWorkspace is paused (inbox or messages loading)')
       return
    }

    if (!propertyId) {
      console.log('[HeavyPanelLoadSkipped] CompIntelligenceWorkspace: No propertyId', { subject, t });
      setComps([])
      return
    }
    
    setLoading(true)
    console.log('[CompIntelligenceWorkspace] Loading comps for:', { propertyId, market, zip, hasCoords, radius, monthsBack, assetClass });
    
    const fetchPromise = hasCoords
      ? loadSubjectComps(propertyId, radius, monthsBack, 100, { assetClass })
      : loadMarketComps(market, zip, 100, { assetClass, monthsBack })

    fetchPromise.then((data) => {
      if (cancelled) return
      setLoading(false)
      
      const mappedComps: CompCandidate[] = data.map((d, i) => {
        const soldPrice = d.mls_sold_price || d.sale_price || 0
        const soldDate = d.mls_sold_date || d.sale_date || null
        
        let soldSource: any = 'UNKNOWN'
        if (d.mls_sold_price || d.mls_sold_date) soldSource = 'MLS SOLD'
        else if (d.sale_price || d.sale_date) soldSource = 'PUBLIC RECORD SOLD'

        const c: Partial<CompCandidate> = {
          id: d.property_id || `comp-${i}`,
          propertyId: d.property_id,
          address: d.property_address_full,
          soldPrice: soldPrice > 0 ? soldPrice : null,
          soldDate,
          soldSource,
          sqft: d.building_square_feet || null,
          beds: d.total_bedrooms || null,
          baths: d.total_baths || null,
          units: d.units_count || null,
          yearBuilt: d.year_built || null,
          condition: d.building_condition || d.renovation_level_classification || 'Unknown',
          assetClass: (d.normalized_asset_class as any) || 'unknown',
          propertyType: d.property_type,
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
          bedsPerUnit: (d as any).beds_per_unit || (d.total_bedrooms && d.units_count ? Math.round(d.total_bedrooms / d.units_count * 10) / 10 : null),
          imageUrl: d.streetview_image || d.satellite_image || buildStreetViewUrl(d.property_address_full) || null,
          zillowUrl: buildZillowUrl(d.property_address_full),
          buyerType: d.buyer_type_label || null,
          isInstitutionalBuyer: d.is_institutional_buyer || false,
          institutionalMatchName: d.institutional_match_name || null,
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
          selected: scoring.score >= 70 && !!c.soldPrice,
        } as CompCandidate
      })
      
      setComps(mappedComps)
    }).catch(err => {
      console.error(err)
      if (!cancelled) setLoading(false)
    })
    
    return () => { cancelled = true }
  }, [subject.propertyId, subject.lat, subject.lng, radius, monthsBack, assetClass, hasCoords, t?.market, t?.zip, t?.property_zip, paused])

  const arvStats = useMemo(() => computeArvStats(comps, subject), [comps, subject])

  const finalComps = useMemo(() => {
    const active = comps.filter(c => c.selected && !c.excluded)
    const totalScore = active.reduce((sum, c) => sum + c.compScore, 0)
    return comps.map(c => ({
      ...c,
      arvWeight: (c.selected && !c.excluded && totalScore > 0) ? Math.round((c.compScore / totalScore) * 100) : 0
    }))
  }, [comps])

  const sortedComps = useMemo(() => {
    return [...finalComps].sort((a, b) => {
      if (sortBy === 'match') return b.compScore - a.compScore
      if (sortBy === 'dist') return (a.distanceMiles ?? 99) - (b.distanceMiles ?? 99)
      if (sortBy === 'date') return new Date(b.soldDate || 0).getTime() - new Date(a.soldDate || 0).getTime()
      if (sortBy === 'price') return (b.soldPrice || 0) - (a.soldPrice || 0)
      if (sortBy === 'ppsf') return (b.ppsf || 0) - (a.ppsf || 0)
      return 0
    })
  }, [finalComps, sortBy])

  useEffect(() => {
    if (arvStats) setLastCalcTime(new Date())
  }, [arvStats?.arv])

  const hoveredComp = useMemo(() => finalComps.find(c => c.id === hoveredId) ?? null, [finalComps, hoveredId])
  const openComp = useMemo(() => finalComps.find(c => c.id === openCompId) ?? null, [finalComps, openCompId])

  const toggleSelected = useCallback((id: string) => {
    setComps(prev => prev.map(c => c.id === id ? { ...c, selected: !c.selected, excluded: false } : c))
  }, [])

  const toggleExcluded = useCallback((id: string) => {
    setComps(prev => prev.map(c => c.id === id ? { ...c, excluded: !c.excluded, selected: c.excluded ? true : false } : c))
  }, [])

  const [valuationMode, setValuationMode] = useState<ValuationMode>(subject.assetClass === 'multifamily' ? 'multifamily_comp' : 'residential_arv')

  const handleAction = async (action: string) => {
    if (!subject.propertyId) return
    
    console.log('[CompIntelligenceWorkspace] Action triggered:', action);
    
    try {
      if (action === 'save_snapshot') {
        if (!arvStats) return
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
            median_sale_price: computeMedian(finalComps.filter(c => c.selected && !c.excluded).map(c => c.soldPrice || 0)),
            median_ppsf: computeMedian(finalComps.filter(c => c.selected && !c.excluded).map(c => c.ppsf || 0)),
            median_ppu: computeMedian(finalComps.filter(c => c.selected && !c.excluded).map(c => c.ppu || 0)),
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
            included_comp_count: finalComps.filter(c => c.selected && !c.excluded).length,
            excluded_comp_count: finalComps.filter(c => c.excluded).length,
            radius_miles: radius,
            lookback_months: monthsBack,
            asset_class: assetClass,
            included_comps: finalComps.filter(c => c.selected && !c.excluded).map(c => ({ id: c.id, score: c.compScore })),
            excluded_comps: finalComps.filter(c => c.excluded).map(c => ({ id: c.id, reason: c.excludeReason }))
          })
        })
        const result = await response.json()
        if (result.ok) alert('Valuation snapshot saved successfully!')
      } else if (action === 'push_underwriting') {
        const response = await fetch(`/api/cockpit/properties/${subject.propertyId}/push-to-underwriting`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread_key: String(t?.thread_key || '') })
        })
        const result = await response.json()
        if (result.ok) alert('Property pushed to Underwriting.')
      } else if (action === 'buyer_match') {
        const response = await fetch(`/api/cockpit/properties/${subject.propertyId}/run-buyer-match`, { method: 'POST' })
        const result = await response.json()
        if (result.ok) alert('Buyer match engine completed.')
      } else {
        console.warn('Action not implemented:', action)
      }
    } catch (err) {
      console.error('Action failed:', err)
      alert('Operation failed. Check console for details.')
    }
  }

  // ── Map init ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapRef.current || !hasCoords) return
    const map = new maplibregl.Map({
      container: mapRef.current, style: DARK_MAP_STYLE,
      center: [subject.lng!, subject.lat!], zoom: 14,
      attributionControl: false, pitchWithRotate: false,
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')
    map.on('load', () => {
      const subEl = document.createElement('div')
      subEl.className = 'ci-subject-pin'
      subEl.setAttribute('aria-label', `Subject: ${subject.address}`)
      subEl.innerHTML = '★'
      subjectMarkerRef.current = new maplibregl.Marker({ element: subEl }).setLngLat([subject.lng!, subject.lat!]).addTo(map)

      map.addSource('ci-radius', { type: 'geojson', data: makeRadiusGeoJson([subject.lng!, subject.lat!], radius) })
      map.addLayer({ id: 'ci-radius-fill', type: 'fill', source: 'ci-radius', paint: { 'fill-color': 'rgba(82,138,236,0.04)' } })
      map.addLayer({ id: 'ci-radius-line', type: 'line', source: 'ci-radius', paint: { 'line-color': 'rgba(82,138,236,0.45)', 'line-width': 1.5, 'line-dasharray': [4, 3] } })
      setMapReady(true)
    })
    mapInstanceRef.current = map
    return () => {
      markersRef.current.forEach(m => m.remove()); markersRef.current.clear()
      subjectMarkerRef.current?.remove(); subjectMarkerRef.current = null
      setMapReady(false); map.remove(); mapInstanceRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject.lat, subject.lng, hasCoords])

  // ── Sync markers ────────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !mapReady) return
    markersRef.current.forEach(m => m.remove()); markersRef.current.clear()

    finalComps.forEach(comp => {
      if (!comp.lat || !comp.lng) return
      const el = document.createElement('button')
      el.type = 'button'
      el.className = ['ci-comp-pin', comp.selected && !comp.excluded ? 'is-selected' : '', comp.excluded ? 'is-excluded' : ''].filter(Boolean).join(' ')
      el.setAttribute('aria-label', `${comp.address}: ${fmt(comp.soldPrice)}`)
      el.innerHTML = `<span>${comp.soldPrice ? fmtK(comp.soldPrice) : 'SOLD'}</span>`
      el.addEventListener('mouseenter', () => setHoveredId(comp.id))
      el.addEventListener('mouseleave', () => setHoveredId(null))
      el.addEventListener('click', e => { e.stopPropagation(); setOpenCompId(p => p === comp.id ? null : comp.id) })
      markersRef.current.set(comp.id, new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([comp.lng, comp.lat]).addTo(map))
    })
  }, [finalComps, mapReady, mapMode])

  if (!thread) {
    return (
      <div className="ci-workspace ci-workspace--empty">
        <div className="ci-empty-state">
          <div className="ci-empty-state__icon">⌖</div>
          <strong>No Subject Selected</strong>
          <p>Select a seller/property to load comp intelligence</p>
        </div>
      </div>
    )
  }

  return (
    <div className="ci-workspace">
      {/* ── Map column ───────────────────────────────────────────────────── */}
      <div className="ci-workspace__map-col">
        {hasCoords
          ? <div ref={mapRef} className="ci-map-canvas" />
          : <div className="ci-map-canvas ci-map-no-coords-wrap"><span>No coordinates on file</span><p>Using market fallback for comp lookup.</p></div>}

        {/* Map controls */}
        <div className="ci-map-controls">
          <div className="ci-map-control-group" role="group" aria-label="Map mode">
            {(['sold_comps', 'heat_map', 'hybrid'] as MapMode[]).map(mode => (
              <button key={mode} type="button" className={`ci-map-ctrl-btn${mapMode === mode ? ' is-active' : ''}`} onClick={() => setMapMode(mode)}>
                {mode === 'sold_comps' ? 'Comps' : mode === 'heat_map' ? 'Heat Map' : 'Hybrid'}
              </button>
            ))}
          </div>
          <div className="ci-map-control-group" role="group" aria-label="Radius">
            {([0.25, 0.5, 1, 1.5, 3, 5] as RadiusMiles[]).map(r => (
              <button key={r} type="button" className={`ci-map-ctrl-btn${radius === r ? ' is-active' : ''}`} onClick={() => setRadius(r)}>
                {r}mi
              </button>
            ))}
          </div>
        </div>

        {/* Hover tooltip */}
        {hoveredComp && !openCompId && (
          <div className="ci-tooltip" role="tooltip">
            <div className="ci-tooltip__source-line">
              <span className="ci-tooltip__source">{hoveredComp.soldSource}</span>
              <span className="ci-tooltip__date">{hoveredComp.soldDate ? new Date(hoveredComp.soldDate).toLocaleDateString() : 'Date Unknown'}</span>
            </div>
            <strong className="ci-tooltip__addr">{hoveredComp.address}</strong>
            <div className="ci-tooltip__grid">
              <span>Sold Price</span><strong>{fmt(hoveredComp.soldPrice)}</strong>
              <span>Distance</span><strong>{hoveredComp.distanceMiles?.toFixed(2) ?? '—'} mi</strong>
              <span>PPSF</span><strong>{fmtPpsf(hoveredComp.ppsf)}</strong>
              <span>Size</span><strong>{hoveredComp.sqft?.toLocaleString() ?? '—'} sf</strong>
              <span>Match</span>
              <strong className={hoveredComp.compScore >= 80 ? 'is-hi' : hoveredComp.compScore >= 65 ? 'is-mid' : ''}>
                {hoveredComp.compScore}/100
              </strong>
            </div>
          </div>
        )}

        {/* Detail popover */}
        {openComp && (
          <CompDetailPopover
            comp={openComp}
            onClose={() => setOpenCompId(null)}
            onToggleSelected={() => toggleSelected(openComp.id)}
          />
        )}
      </div>

      {/* ── Right panel ─────────────────────────────────────────────────── */}
      <div className="ci-panel">
        <SubjectPropertyStrip subject={subject} arvStats={arvStats} radius={radius} monthsBack={monthsBack} />

        {/* Global Filters */}
        <div className="ci-filters-bar">
          <div className="ci-filter-group">
            <label>Valuation Mode</label>
            <select value={valuationMode} onChange={e => setValuationMode(e.target.value as any)}>
              <option value="residential_arv">Residential ARV</option>
              <option value="multifamily_comp">Multifamily Comp</option>
              <option value="land">Land Mode</option>
              <option value="commercial">Commercial Mode</option>
            </select>
          </div>
          <div className="ci-filter-group">
            <label>Sort By</label>
            <select value={sortBy} onChange={e => setSortBy(e.target.value as any)}>
              <option value="match">Best Match</option>
              <option value="dist">Closest</option>
              <option value="date">Newest Sale</option>
              <option value="price">Highest Price</option>
              <option value="ppsf">PPSF</option>
            </select>
          </div>
          <div className="ci-filter-group">
            <label>Lookback</label>
            <select value={monthsBack} onChange={e => setMonthsBack(Number(e.target.value))}>
              <option value={3}>3 Months</option>
              <option value={6}>6 Months</option>
              <option value={12}>12 Months</option>
              <option value={24}>24 Months</option>
            </select>
          </div>
          <div className="ci-filter-group">
            <label>Asset Class</label>
            <select value={assetClass || ''} onChange={e => setAssetClass(e.target.value || undefined)}>
              <option value="">All Types</option>
              <option value="single_family">Single Family</option>
              <option value="multifamily">Multifamily</option>
            </select>
          </div>
        </div>

        {/* ARV engine panel */}
        <ArvEnginePanel 
          comps={finalComps} 
          arvStats={arvStats} 
          subject={subject} 
          lastCalcTime={lastCalcTime} 
          onAction={handleAction}
        />

        {/* Comp list */}
        <div className="ci-list-section">
          <div className="ci-list-head">
            <span>SOLD COMPS</span>
            {loading ? <span>Loading...</span> : <span>{finalComps.length} total · {finalComps.filter(c => c.selected && !c.excluded).length} in ARV</span>}
          </div>
          <div className="ci-list">
            {finalComps.length === 0 && !loading && (
              <div className="ci-list-status is-empty"><strong>No comps found for this property yet</strong><p>Adjust filters to expand search.</p></div>
            )}
            {sortedComps.map(comp => (
              <SoldCompRow
                key={comp.id}
                comp={comp}
                isHovered={hoveredId === comp.id}
                isOpen={openCompId === comp.id}
                onEnter={() => setHoveredId(comp.id)}
                onLeave={() => setHoveredId(null)}
                onClick={() => setOpenCompId(p => p === comp.id ? null : comp.id)}
                onToggleSelected={() => toggleSelected(comp.id)}
                onToggleExcluded={() => toggleExcluded(comp.id)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────

function SubjectPropertyStrip({ subject, arvStats, radius, monthsBack }: {
  subject: Partial<CompCandidate>
  arvStats: ArvStats | null
  radius: number
  monthsBack: number
}) {
  const hasIncompleteData = !subject.sqft || (subject.assetClass === 'multifamily' && !subject.units);

  return (
    <div className="ci-subject-card">
      <div className="ci-subject-card__img">
        <StreetviewThumb lat={subject.lat || 0} lng={subject.lng || 0} size="subject" />
      </div>
      <div className="ci-subject-card__content">
        <div className="ci-subject-card__top">
          <div className="ci-subject-card__addr-line">
            <span className="ci-subject-card__addr">{subject.address}</span>
            {arvStats && (
              <span className="ci-subject-card__score-badge is-green">
                {arvStats.confidence}/100 CONF
              </span>
            )}
          </div>
          <div className="ci-subject-card__specs">
            {subject.sqft && <span>{subject.sqft.toLocaleString()} sf</span>}
            {subject.beds && <span>{subject.beds} bd / {subject.baths} ba</span>}
            {subject.yearBuilt && <span>Built {subject.yearBuilt}</span>}
            {subject.units && subject.units > 1 && <span>{subject.units} Units</span>}
            {subject.propertyType && <span className="ci-market-badge">{subject.propertyType}</span>}
          </div>
        </div>
        <div className="ci-subject-card__bottom">
          <div className="ci-subject-card__pills">
            <span className="ci-pill">{radius}mi Radius</span>
            <span className="ci-pill">{monthsBack}mo Lookback</span>
            {hasIncompleteData && <span className="ci-pill is-amber">⚠ Incomplete Data</span>}
          </div>
          <div className="ci-subject-card__arv">
            <span>Target ARV</span>
            <strong>{arvStats ? fmt(arvStats.arv) : '—'}</strong>
          </div>
        </div>
      </div>
    </div>
  )
}

function SoldCompRow({ comp, isHovered, isOpen, onEnter, onLeave, onClick, onToggleSelected, onToggleExcluded }: {
  comp: CompCandidate
  isHovered: boolean
  isOpen: boolean
  onEnter: () => void
  onLeave: () => void
  onClick: () => void
  onToggleSelected: () => void
  onToggleExcluded: () => void
}) {
  const isActive = comp.selected && !comp.excluded
  const isMF = comp.assetClass === 'multifamily'

  return (
    <div
      className={[
        'ci-comp-row',
        isActive ? 'is-selected' : '',
        comp.excluded ? 'is-excluded' : '',
        isHovered ? 'is-hover' : '',
        isOpen ? 'is-open' : '',
      ].filter(Boolean).join(' ')}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
    >
      <div className="ci-comp-row__top-strip">
        <span className={`ci-source-badge ${comp.soldSource === 'MLS SOLD' ? 'is-mls' : 'is-public'}`}>
          {comp.soldSource}
        </span>
        <span className="ci-comp-row__date">{comp.soldDate ? new Date(comp.soldDate).toLocaleDateString() : 'Date Unknown'}</span>
        <span className="ci-dist-badge">{comp.distanceMiles?.toFixed(2) ?? '—'} mi</span>
      </div>

      <div className="ci-comp-row__hero">
        <div className="ci-comp-row__thumb">
          <StreetviewThumb lat={comp.lat || 0} lng={comp.lng || 0} size="row" />
          {isActive && <div className="ci-comp-row__thumb-badge is-in">✓ IN ARV</div>}
          {comp.excluded && <div className="ci-comp-row__thumb-badge is-out">EXCLUDED</div>}
        </div>
        <div className="ci-comp-row__main">
          <div className="ci-comp-row__price-row">
            <span className="ci-comp-row__price">{fmt(comp.soldPrice)}</span>
            <div className={`ci-match-score ${comp.compScore >= 80 ? 'is-hi' : comp.compScore >= 65 ? 'is-mid' : 'is-lo'}`}>
              <strong>{comp.compScore}</strong>
              <span>{comp.compMatchLabel}</span>
            </div>
          </div>
          <div className="ci-comp-row__addr">{comp.address}</div>
          <div className="ci-comp-row__type-line">
             {comp.propertyType && <span className="ci-type-tag">{comp.propertyType}</span>}
             <span className="ci-asset-tag">{comp.assetClass.replace('_', ' ')}</span>
          </div>
        </div>
      </div>

      <div className="ci-comp-row__metrics">
        {isMF ? (
          <>
            <div className="ci-metric"><strong>{comp.units || '—'}</strong><span>Units</span></div>
            <div className="ci-metric"><strong>{fmtK(comp.ppu)}</strong><span>PPU</span></div>
            <div className="ci-metric"><strong>{fmtPpsf(comp.ppsf)}</strong><span>PPSF</span></div>
            <div className="ci-metric"><strong>{comp.sqftPerUnit || '—'}</strong><span>Avg SF</span></div>
          </>
        ) : (
          <>
            <div className="ci-metric"><strong>{comp.beds || '—'}/{comp.baths || '—'}</strong><span>Beds/Ba</span></div>
            <div className="ci-metric"><strong>{comp.sqft?.toLocaleString() || '—'}</strong><span>Sqft</span></div>
            <div className="ci-metric"><strong>{fmtPpsf(comp.ppsf)}</strong><span>PPSF</span></div>
            <div className="ci-metric"><strong>{comp.ppbd ? fmtK(comp.ppbd) : '—'}</strong><span>PPBD</span></div>
          </>
        )}
      </div>

      <div className="ci-comp-row__intel">
        {comp.arvWeight > 0 && <span className="ci-intel-badge is-weight">{comp.arvWeight}% ARV Weight</span>}
        {comp.percentOff !== null && <span className="ci-intel-badge is-discount">{Math.round(comp.percentOff * 100)}% Off Value</span>}
        {comp.dealGrade && <span className="ci-intel-badge is-grade">Grade {comp.dealGrade}</span>}
        {comp.condition && <span className="ci-intel-badge">Cond: {comp.condition}</span>}
        {comp.isInstitutionalBuyer && <span className="ci-intel-badge is-institutional">Inst. Buyer: {comp.institutionalMatchName || comp.buyerType}</span>}
      </div>

      <div className="ci-comp-row__reasoning">
        <div className="ci-reasoning-grid">
          <div className="ci-reason">Dist: <strong>{comp.reasoning.distanceScore}/20</strong></div>
          <div className="ci-reason">Asset: <strong>{comp.reasoning.assetTypeScore}/20</strong></div>
          <div className="ci-reason">Size: <strong>{comp.reasoning.sqftUnitsScore}/15</strong></div>
          <div className="ci-reason">Beds: <strong>{comp.reasoning.bedsBathsScore}/10</strong></div>
          <div className="ci-reason">Built: <strong>{comp.reasoning.yearBuiltScore}/10</strong></div>
          <div className="ci-reason">Date: <strong>{comp.reasoning.saleRecencyScore}/10</strong></div>
          <div className="ci-reason">Cond: <strong>{comp.reasoning.conditionScore}/5</strong></div>
        </div>
        {comp.reasoning.isOutlier && (
          <div className="ci-outlier-warn">⚠ Outlier: {comp.reasoning.outlierReason}</div>
        )}
      </div>

      <div className="ci-comp-row__actions" onClick={e => e.stopPropagation()}>
        <button type="button" className={`ci-action-btn ${isActive ? 'is-active' : ''}`} onClick={() => onToggleSelected()}>
          {isActive ? 'Remove from ARV' : 'Include in ARV'}
        </button>
        <button type="button" className={`ci-action-btn is-exclude ${comp.excluded ? 'is-active' : ''}`} onClick={() => onToggleExcluded()}>
          {comp.excluded ? 'Unexclude' : 'Exclude'}
        </button>
        <a href={comp.zillowUrl} target="_blank" rel="noopener noreferrer" className="ci-action-btn is-external">Zillow ↗</a>
        <a href={buildGoogleMapsUrl(comp.address, comp.lat || undefined, comp.lng || undefined)} target="_blank" rel="noopener noreferrer" className="ci-action-btn is-external">Maps ↗</a>
      </div>
    </div>
  )
}

function ArvEnginePanel({ comps, arvStats, subject, lastCalcTime, onAction }: {
  comps: CompCandidate[]
  arvStats: ArvStats | null
  subject: Partial<CompCandidate>
  lastCalcTime: Date | null
  onAction: (action: string) => void
}) {
  const active = comps.filter(c => c.selected && !c.excluded)
  const isMF = subject.assetClass === 'multifamily'

  return (
    <div className="ci-arv-engine">
      <div className="ci-arv-engine__hero">
        <div className="ci-arv-engine__hero-left">
          <div className="ci-eyebrow">ESTIMATED ARV</div>
          <div className="ci-arv-value">{arvStats ? fmt(arvStats.arv) : '—'}</div>
          {arvStats && (
            <div className="ci-arv-range">Range {fmtK(arvStats.low)} – {fmtK(arvStats.high)}</div>
          )}
          <div className="ci-arv-basis">
            {active.length} Comps Blended · {isMF ? `${fmtK(arvStats?.arvPpu)}/unit` : `${fmtPpsf(arvStats?.arvPpsf)}`}
          </div>
          {lastCalcTime && (
            <div className="ci-arv-last-calc">Recalculated {formatRelativeMin(lastCalcTime)}</div>
          )}
        </div>
        <CompConfidenceBadge confidence={arvStats?.confidence ?? 0} />
      </div>

      <div className="ci-metrics-row">
        <MetricCard label="Included" value={String(active.length)} accent="green" />
        <MetricCard label="Median Price" value={fmtK(computeMedian(active.map(c => c.soldPrice || 0)))} />
        <MetricCard label="Med PPSF" value={fmtPpsf(computeMedian(active.map(c => c.ppsf || 0)))} />
        {isMF && <MetricCard label="Med PPU" value={fmtK(computeMedian(active.map(c => c.ppu || 0)))} />}
      </div>

      <OfferEnginePanel arvStats={arvStats} />
      
      <DealActions onAction={onAction} />

      {!subject.sqft && !isMF && (
        <div className="ci-engine-warning">⚠ Subject sqft missing. ARV confidence reduced.</div>
      )}
      {isMF && !subject.units && (
        <div className="ci-engine-warning">⚠ Subject units missing. ARV confidence reduced.</div>
      )}
    </div>
  )
}

function OfferEnginePanel({ arvStats }: { arvStats: ArvStats | null }) {
  if (!arvStats) return null
  
  return (
    <div className="ci-offer-engine">
      <div className="ci-eyebrow">OFFER ENGINE</div>
      <div className="ci-offer-grid">
        <div className="ci-offer-item">
          <span>Conservative</span>
          <strong>{fmt(arvStats.conservativeOffer)}</strong>
        </div>
        <div className="ci-offer-item is-target">
          <span>Target Offer</span>
          <strong>{fmt(arvStats.targetOffer)}</strong>
        </div>
        <div className="ci-offer-item is-mao">
          <span>Max Allowable</span>
          <strong>{fmt(arvStats.maxAllowableOffer)}</strong>
        </div>
        <div className="ci-offer-item">
          <span>Repairs</span>
          <strong>{fmt(arvStats.repairEstimate)}</strong>
        </div>
        <div className="ci-offer-item">
          <span>Expected Spread</span>
          <strong>{fmtK(arvStats.expectedAssignmentLow)} – {fmtK(arvStats.expectedAssignmentHigh)}</strong>
        </div>
        <div className="ci-offer-item">
          <span>Buyer Exit</span>
          <strong>{fmt(arvStats.buyerExitPrice)}</strong>
        </div>
      </div>
    </div>
  )
}

function DealActions({ onAction }: { onAction: (action: string) => void }) {
  return (
    <div className="ci-deal-actions">
      <button type="button" className="ci-deal-btn is-primary" onClick={() => onAction('save_snapshot')}>
        Save Valuation Snapshot
      </button>
      <div className="ci-deal-btn-grid">
        <button type="button" className="ci-deal-btn" onClick={() => onAction('push_underwriting')}>
          Push to Underwriting
        </button>
        <button type="button" className="ci-deal-btn" onClick={() => onAction('buyer_match')}>
          Run Buyer Match
        </button>
        <button type="button" className="ci-deal-btn" onClick={() => onAction('seller_reply')}>
          Gen Seller Reply
        </button>
        <button type="button" className="ci-deal-btn" onClick={() => onAction('mark_hot')}>
          Mark Hot Deal
        </button>
      </div>
    </div>
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
    ['Sold Source', comp.soldSource],
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
    details.push(['Units', String(comp.units ?? '—')])
    details.push(['PPU', fmtK(comp.ppu)])
  }

  return (
    <div className="ci-detail-popover">
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
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="ci-detail-popover__actions">
        <a href={comp.zillowUrl} target="_blank" rel="noopener noreferrer" className="ci-pop-action">Zillow ↗</a>
        <button type="button" className={`ci-pop-action ${comp.selected ? 'is-on' : ''}`} onClick={() => { onToggleSelected(); onClose(); }}>
          {comp.selected ? '✓ Included' : 'Include'}
        </button>
      </div>
    </div>
  )
}

function MetricCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="ci-metric-card">
      <span className="ci-metric-card__label">{label}</span>
      <strong className={`ci-metric-card__value${accent ? ` is-${accent}` : ''}`}>{value}</strong>
    </div>
  )
}

function CompConfidenceBadge({ confidence }: { confidence: number }) {
  const color = confidence >= 78 ? '#34d399' : confidence >= 58 ? '#fbbf24' : '#ef4444'
  const circ = 138.23
  return (
    <div className="ci-conf-badge">
      <svg viewBox="0 0 56 56" aria-label={`Confidence ${confidence}`}>
        <circle cx="28" cy="28" r="22" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="5" />
        <circle cx="28" cy="28" r="22" fill="none" stroke={color} strokeWidth="5"
          strokeDasharray={`${(confidence / 100) * circ} ${circ}`} strokeLinecap="round"
          transform="rotate(-90 28 28)" style={{ transition: 'stroke-dasharray 0.4s, stroke 0.3s' }} />
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

/**
 * BuyerMatchWorkspace v3 — Acquisition Intelligence Cockpit
 * Tesla × Palantir × Bloomberg Terminal aesthetic.
 * Layout: Property Intel Sidebar | Satellite Map | Deal Command Dossier
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { motion, AnimatePresence } from 'framer-motion'
import { Icon } from '../../../shared/icons'
import { getSupabaseClient } from '../../../lib/supabaseClient'
import { callBackend } from '../../../lib/api/backendClient'
import type { DealContext } from '../../../lib/data/dealContext'
import '../buyer-match-workspace.css'

const IS_DEV = import.meta.env.DEV

// ─── Types ──────────────────────────────────────────────────────────────────

interface BuyerMatchCandidate {
  buyer_entity_id: string | null
  buyer_key: string
  buyer_name: string
  buyer_type: 'individual' | 'corporate' | 'trust' | 'institutional' | string
  is_corporate_buyer: boolean
  is_repeat_buyer: boolean
  mailing_city: string | null
  mailing_state: string | null
  mailing_zip: string | null
  markets_active: string[]
  zips_active: string[]
  counties_active: string[]
  preferred_asset_classes: string[]
  purchase_count: number
  purchase_count_180d: number
  purchase_count_365d: number
  first_purchase_date: string | null
  last_purchase_date: string | null
  avg_purchase_price: number | null
  median_purchase_price: number | null
  preferred_price_min: number | null
  preferred_price_max: number | null
  avg_ppsf: number | null
  velocity_score: number | null
  dispo_priority_score: number | null
  investor_score: number | null
  avg_potential_spread: number | null
  market_match_score: number
  asset_match_score: number
  price_match_score: number
  recency_score: number
  repeat_buyer_score: number
  spread_fit_score: number
  total_match_score: number
  match_grade: 'A+' | 'A' | 'B' | 'C' | 'D'
  reason_for_match: string
  buyer_match_candidate_id?: string
  buyer_response_status?: string
  package_sent_at?: string | null
  selected?: boolean
  notes?: string
}

interface MatchRun {
  run_id: string
  property_id: string
  status: string
  candidate_count: number
  high_fit_count: number
  demand_score: number | null
  best_buyer_grade: string | null
  created_at: string
}

interface BuyerDemandRollup {
  purchase_count: number
  buyer_count: number
  corporate_buyer_count: number
  repeat_buyer_count: number
  institutional_buyer_count: number
  avg_purchase_price: number | null
  median_purchase_price: number | null
  max_purchase_price: number | null
  liquidity_score: number | null
  buyer_heat_score: number | null
  dominant_buyer_type: string
  top_buyer_keys: string[]
  source: 'geo_rollup' | 'computed' | 'none'
  fallback_level: 'zip_asset' | 'zip' | 'radius' | 'market_asset' | 'market' | 'county' | 'state_asset' | 'state' | 'none'
}

interface RealComp {
  id: string
  address: string
  city?: string
  state?: string
  zip?: string
  sold_price?: number | null
  sold_date?: string | null
  beds?: number | null
  baths?: number | null
  sqft?: number | null
  ppsf?: number | null
  latitude?: number | null
  longitude?: number | null
  property_type?: string
  source_type: 'BUYER_PURCHASE' | 'RECENTLY_SOLD' | 'UNKNOWN'
  distance_miles?: number | null
}

interface DebugData {
  property_id: string
  address: string
  zip: string
  market: string
  county: string
  asset_class: string
  lat: number | null
  lng: number | null
  demand_rollup_rows: number
  demand_source: string
  comp_rows: number
  buyer_match_candidate_rows: number
  valuation_snapshot: boolean
  match_run_rows: number
  entity_count: number
  fallback_level: string
  liquidity_score: number | null
  demand_score: number | null
}

interface PropertySnapshot {
  property_id?: string
  address: string
  market: string
  zip: string
  state?: string
  county?: string
  property_type: string
  asset_class?: string
  normalized_asset_class?: string
  beds?: number | null
  baths?: number | null
  sqft?: number | null
  units?: number | null
  estimated_value?: number | null
  arv?: number | null
  purchase_price?: number | null
  potential_spread?: number | null
  dispo_strategy?: string
}

interface PurchaseEvent {
  property_address_full: string
  property_city: string
  property_state: string
  market: string
  purchase_date: string | null
  purchase_price: number | null
  sqft: number | null
  property_type: string
  latitude?: number | null
  longitude?: number | null
}

type GradeFilter = 'all' | 'A+' | 'A' | 'B' | 'C'
type TypeFilter  = 'all' | 'corporate' | 'repeat' | 'institutional'
type DossierTab  = 'overview' | 'comps' | 'buyers' | 'offer' | 'risk' | 'history'

type AgentStatus = 'idle' | 'running' | 'complete' | 'warning'
interface AcquisitionAgent {
  id: string
  name: string
  icon: string
  status: AgentStatus
  confidence: number | null
  output: string
}

type BuyerMatchStatus = 'locked' | 'idle' | 'scanning' | 'complete' | 'failed'
type CompIntelStatus  = 'idle' | 'scanning' | 'complete' | 'failed'
type OfferStatus      = 'draft' | 'generating' | 'complete' | 'low_confidence'

interface IntelRunState {
  buyer_match_status: BuyerMatchStatus
  comp_intel_status: CompIntelStatus
  offer_status: OfferStatus
  active_run_step: string | null
  last_run_at: string | null
}

interface DealMemoryEvent {
  id: string
  timestamp: string
  icon: string
  action: string
  result: string
  source: string
}

export interface BuyerMatchWorkspaceProps {
  propertySnapshot: PropertySnapshot
  dealContext?: DealContext | null
  isOutsideFilter?: boolean
  onClearFilters?: () => void
  onPinSelected?: () => void
  paneWidth?: '25' | '50' | '75' | '100'
  apiBase?: string
  paused?: boolean
}

// ─── Map style (ESRI satellite – no key required) ────────────────────────────
const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
  sources: {
    'esri-satellite': {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: '© Esri',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'esri-satellite', type: 'raster', source: 'esri-satellite' }],
}

// ─── Formatters ──────────────────────────────────────────────────────────────
const fmt$ = (v: number | null | undefined) => {
  if (!Number.isFinite(v ?? NaN)) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v as number)
}
const fmt$k = (v: number | null | undefined) => {
  if (!Number.isFinite(v ?? NaN)) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(v as number)
}
const fmtNum = (v: number | null | undefined) => {
  if (!Number.isFinite(v ?? NaN)) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v as number)
}
const fmtDate = (d: string | null | undefined) => {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
const fmtDaysAgo = (d: string | null | undefined) => {
  if (!d) return '—'
  const days = Math.round((Date.now() - new Date(d).getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.round(days / 30)}mo ago`
  return `${Math.round(days / 365)}yr ago`
}
const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || 'BY'

const gradeClass = (g: string) => {
  if (g === 'A+') return 'aplus'
  if (g === 'A')  return 'a'
  if (g === 'B')  return 'b'
  if (g === 'C')  return 'c'
  return 'd'
}

// ─── Event hooks ─────────────────────────────────────────────────────────────

function emitHook(event: string, detail?: Record<string, unknown>) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(`aic:${event}`, { detail }))
  }
}

function makeDealEvent(icon: string, action: string, result: string, source: string): DealMemoryEvent {
  return {
    id: Math.random().toString(36).slice(2),
    timestamp: new Date().toISOString(),
    icon, action, result, source,
  }
}

// ─── BuyerDemandPulseCard ────────────────────────────────────────────────────

interface DemandCardProps {
  score: number | null
  entityCount: number
  matchCount: number
  running: boolean
  hasData: boolean
  candidates: BuyerMatchCandidate[]
  rollup?: BuyerDemandRollup | null
  noDataReason?: string[] | null
}

function BuyerDemandPulseCard({ score, entityCount, matchCount, running, hasData, candidates, rollup, noDataReason }: DemandCardProps) {
  const [scanStep, setScanStep] = useState(0)

  const SCAN_STEPS = [
    'Initializing buyer graph',
    'Scanning zip demand',
    'Matching asset type',
    'Detecting repeat buyers',
    'Detecting corporate buyers',
    'Detecting institutional signals',
    'Calculating liquidity score',
    'Generating exit range',
  ]

  useEffect(() => {
    if (!running) { setScanStep(0); return }
    const id = setInterval(() => setScanStep(s => Math.min(s + 1, SCAN_STEPS.length - 1)), 700)
    return () => clearInterval(id)
  }, [running])

  const scanPct = Math.round(((scanStep + 1) / SCAN_STEPS.length) * 100)

  const repeatCount = candidates.length > 0 ? candidates.filter(c => c.is_repeat_buyer).length : (rollup?.repeat_buyer_count ?? 0)
  const corpCount   = candidates.length > 0 ? candidates.filter(c => c.is_corporate_buyer).length : (rollup?.corporate_buyer_count ?? 0)
  const instCount   = candidates.length > 0 ? candidates.filter(c => c.buyer_type === 'institutional').length : (rollup?.institutional_buyer_count ?? 0)
  const aplusCount  = candidates.filter(c => c.match_grade === 'A+').length

  const dominant = instCount > 0 ? 'Institutional'
    : corpCount > repeatCount ? 'Corporate'
    : repeatCount > 0 ? 'Repeat Investor'
    : entityCount > 0 ? 'Individual'
    : rollup?.dominant_buyer_type || 'Unknown'

  // When rollup exists but no match has been run, show pre-run demand info
  const rollupOnly = !hasData && rollup && rollup.buyer_count > 0

  const state = running ? 'scanning'
    : !hasData && !rollupOnly ? 'idle'
    : score === null && !rollupOnly ? 'low-data'
    : score !== null && score >= 70 ? 'high'
    : rollupOnly ? 'complete'
    : 'complete'

  const cardCls = `aic-demand-card${state === 'high' ? ' is-high-demand' : state === 'low-data' ? ' is-low-data' : state === 'scanning' ? ' is-scanning' : ''}`

  return (
    <div className={cardCls}>
      <div className="aic-demand-card__header">
        <span className="aic-demand-card__title">Buyer Demand Pulse</span>
        <div className="aic-demand-card__state">
          <div className={`aic-demand-state-dot is-${running ? 'scanning' : state === 'high' ? 'high' : state === 'low-data' ? 'low' : hasData ? 'complete' : 'idle'}`} />
          <span className="aic-demand-state-label">
            {running ? 'Scanning' : !hasData ? 'Idle' : score !== null ? (score >= 70 ? 'High Demand' : 'Complete') : 'Low Data'}
          </span>
        </div>
      </div>

      {state === 'idle' && (
        <div className="aic-demand-idle" style={{ position: 'relative', overflow: 'hidden' }}>
          <div className="aic-demand-radar" />
          <div className="aic-demand-idle__chip">
            <div className="aic-demand-idle__chip-dot" />
            Dormant Scanner
          </div>
          <div className="aic-demand-idle__title">Intelligence Locked</div>
          <div className="aic-demand-idle__sub">Run Buyer Match to unlock:</div>
          <ul className="aic-demand-idle__list aic-demand-idle__list--icons">
            <li><span className="aic-demand-idle__list-icon">🎯</span>Top buyers by match grade</li>
            <li><span className="aic-demand-idle__list-icon">📊</span>Demand score &amp; liquidity rating</li>
            <li><span className="aic-demand-idle__list-icon">🔄</span>Repeat buyer detection</li>
            <li><span className="aic-demand-idle__list-icon">🏢</span>Corporate &amp; institutional signals</li>
            <li><span className="aic-demand-idle__list-icon">⏱</span>Estimated dispo timeline</li>
          </ul>
        </div>
      )}

      {state === 'scanning' && (
        <div className="aic-demand-scanning">
          <div className="aic-demand-scan-line" />
          <div className="aic-demand-scan-progress">
            <div className="aic-demand-scan-progress__track">
              <motion.div
                className="aic-demand-scan-progress__fill"
                initial={{ width: 0 }}
                animate={{ width: `${scanPct}%` }}
                transition={{ duration: 0.35 }}
              />
            </div>
            <span className="aic-demand-scan-progress__pct">{scanPct}%</span>
          </div>
          <div className="aic-demand-scan-steps">
            {SCAN_STEPS.map((step, i) => (
              <div key={step} className={`aic-demand-scan-step${i < scanStep ? ' is-done' : i === scanStep ? ' is-active' : ''}`}>
                <span className="aic-demand-scan-step__dot" />
                <span className="aic-demand-scan-step__label">{step}</span>
                {i < scanStep && <span className="aic-demand-scan-step__check">✓</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {(state === 'complete' || state === 'high' || state === 'low-data') && (
        <>
          <div className="aic-demand-card__score">
            <span className={`aic-demand-score-value${state === 'high' ? ' is-high' : state === 'low-data' ? ' is-low' : ''}`}>
              {score !== null ? score : rollup?.liquidity_score ?? '—'}
            </span>
            {(score !== null || rollup?.liquidity_score) && <span className="aic-demand-score-max">/100</span>}
          </div>

          <div className="aic-demand-bar">
            <div className="aic-demand-bar__fill" style={{ width: `${Math.min(100, score ?? rollup?.liquidity_score ?? 0)}%` }} />
          </div>

          {rollupOnly && (
            <div style={{ fontSize: '0.58rem', color: 'rgba(169,190,255,0.5)', textAlign: 'center', marginBottom: 4 }}>
              Pre-match demand · {rollup!.fallback_level.replace('_', ' ')} level · run match for buyer cards
            </div>
          )}

          <div className="aic-demand-metrics">
            <div className="aic-demand-metric">
              <span className="aic-demand-metric__label">Buyers Matched</span>
              <span className={`aic-demand-metric__value ${matchCount > 0 ? 'is-blue' : ''}`}>
                {matchCount > 0 ? fmtNum(matchCount) : rollupOnly ? fmtNum(rollup!.buyer_count) : '—'}
              </span>
            </div>
            <div className="aic-demand-metric">
              <span className="aic-demand-metric__label">In Market</span>
              <span className="aic-demand-metric__value">{entityCount > 0 ? fmtNum(entityCount) : '—'}</span>
            </div>
            <div className="aic-demand-metric">
              <span className="aic-demand-metric__label">A+ Buyers</span>
              <span className={`aic-demand-metric__value ${aplusCount > 0 ? 'is-gold' : ''}`}>{aplusCount > 0 ? aplusCount : '—'}</span>
            </div>
            <div className="aic-demand-metric">
              <span className="aic-demand-metric__label">Institutional</span>
              <span className={`aic-demand-metric__value ${instCount > 0 ? 'is-purple' : ''}`}>{instCount > 0 ? instCount : '—'}</span>
            </div>
            <div className="aic-demand-metric">
              <span className="aic-demand-metric__label">Repeat</span>
              <span className={`aic-demand-metric__value ${repeatCount > 0 ? 'is-green' : ''}`}>{repeatCount > 0 ? repeatCount : '—'}</span>
            </div>
            <div className="aic-demand-metric">
              <span className="aic-demand-metric__label">Corporate</span>
              <span className="aic-demand-metric__value">{corpCount > 0 ? corpCount : '—'}</span>
            </div>
          </div>

          <div className="aic-demand-dominant">
            <span>Dominant Buyer Type</span>
            <strong>{dominant}</strong>
          </div>

          {noDataReason && noDataReason.length > 0 && (
            <div style={{ marginTop: 8, padding: '6px 8px', background: 'rgba(255,122,122,0.08)', borderRadius: 6, border: '1px solid rgba(255,122,122,0.2)' }}>
              <div style={{ fontSize: '0.58rem', color: '#ff7a7a', fontWeight: 700, marginBottom: 4 }}>No buyer matches found</div>
              {noDataReason.map((r, i) => <div key={i} style={{ fontSize: '0.56rem', color: 'rgba(219,229,255,0.45)' }}>{r}</div>)}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Acquisition Map ─────────────────────────────────────────────────────────

interface AcquisitionMapProps {
  lat: number | null
  lng: number | null
  purchases: PurchaseEvent[]
  candidates: BuyerMatchCandidate[]
  running?: boolean
}

type MapLayer = 'buyers' | 'comps' | 'heat'

function AcquisitionMap({ lat, lng, purchases, candidates, running = false }: AcquisitionMapProps) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<maplibregl.Map | null>(null)
  const subjectMarkerRef = useRef<maplibregl.Marker | null>(null)
  const purchaseMarkersRef = useRef<maplibregl.Marker[]>([])
  const [activeLayers, setActiveLayers] = useState<Set<MapLayer>>(new Set(['buyers']))
  const [mapReady, setMapReady] = useState(false)

  const hasCoords = lat !== null && lng !== null && Math.abs(lat) > 0.01 && Math.abs(lng) > 0.01

  useEffect(() => {
    if (!mapRef.current || !hasCoords) return
    if (mapInstanceRef.current) return

    const map = new maplibregl.Map({
      container: mapRef.current,
      style: SATELLITE_STYLE,
      center: [lng!, lat!],
      zoom: 13,
      attributionControl: false,
    })

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left')

    map.on('load', () => {
      // Subject property pulsing ring marker
      const el = document.createElement('div')
      el.className = 'aic-subject-marker'
      el.innerHTML = `
        <div class="aic-subject-marker__ring"></div>
        <div class="aic-subject-marker__ring delay-1"></div>
        <div class="aic-subject-marker__ring delay-2"></div>
        <div class="aic-subject-marker__dot"></div>
      `
      subjectMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([lng!, lat!])
        .addTo(map)

      setMapReady(true)
    })

    mapInstanceRef.current = map
    return () => {
      purchaseMarkersRef.current.forEach(m => m.remove())
      purchaseMarkersRef.current = []
      subjectMarkerRef.current?.remove()
      map.remove()
      mapInstanceRef.current = null
    }
  }, [hasCoords, lat, lng])

  // Update purchase pins when data changes
  useEffect(() => {
    if (!mapInstanceRef.current || !mapReady) return
    purchaseMarkersRef.current.forEach(m => m.remove())
    purchaseMarkersRef.current = []

    if (!activeLayers.has('buyers')) return

    purchases.forEach(p => {
      if (!p.latitude || !p.longitude) return
      const buyerKey = candidates.find(c => c.buyer_entity_id)
      const isInst = buyerKey?.buyer_type === 'institutional'

      const el = document.createElement('div')
      el.className = `aic-buyer-pin${isInst ? ' is-institutional' : ''}`
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([p.longitude, p.latitude])
        .setPopup(new maplibregl.Popup({ offset: 8, closeButton: false }).setHTML(`
          <div style="font-family:Inter,sans-serif;font-size:0.72rem;color:#e8f0ff;background:#0c1022;padding:8px 10px;border-radius:8px;border:1px solid rgba(169,190,255,0.14);min-width:140px;">
            <div style="font-weight:700;margin-bottom:4px;">${p.property_address_full || 'Address Unknown'}</div>
            <div style="color:rgba(219,229,255,0.55);">${fmtDate(p.purchase_date)} · ${fmt$(p.purchase_price)}</div>
          </div>
        `))
        .addTo(mapInstanceRef.current!)
      purchaseMarkersRef.current.push(marker)
    })
  }, [purchases, mapReady, activeLayers, candidates])

  const toggleLayer = (layer: MapLayer) => {
    setActiveLayers(prev => {
      const next = new Set(prev)
      if (next.has(layer)) next.delete(layer)
      else next.add(layer)
      return next
    })
  }

  if (!hasCoords) {
    return (
      <div className="aic-map-no-coords">
        <div className="aic-map-no-coords__icon">🛰</div>
        <div className="aic-map-no-coords__text">Map unavailable — property coordinates not resolved</div>
      </div>
    )
  }

  const buyerCount = candidates.length
  const layers: { id: MapLayer; label: string; color: string; count?: string; scanning?: boolean }[] = [
    { id: 'buyers', label: 'Buyers', color: '#c9a9ff', count: running ? 'Scanning' : buyerCount > 0 ? String(buyerCount) : 'Locked', scanning: running },
    { id: 'comps',  label: 'Comps',  color: '#5efa8c', count: '4' },
    { id: 'heat',   label: 'Heat',   color: '#ff7a7a', count: running ? 'Calculating' : buyerCount > 0 ? 'Active' : 'Pending', scanning: running },
  ]

  return (
    <>
      <div ref={mapRef} className="aic-map-canvas" />
      {running && <div className="aic-map-scan-overlay" />}
      <div className="aic-map-controls-group">
        <div className="aic-map-intel-label">Map Intel</div>
        {layers.map(l => (
          <button
            key={l.id}
            className={`aic-map-layer-btn${activeLayers.has(l.id) ? ' is-active' : ''}${l.scanning ? ' is-scanning' : ''}`}
            onClick={() => toggleLayer(l.id)}
          >
            <span className={`aic-map-layer-dot${l.scanning ? ' is-pulse' : ''}`} style={{ background: l.color }} />
            {l.label}
            {l.count && (
              <span className={`aic-map-layer-count${activeLayers.has(l.id) ? ' is-active' : ''}${l.scanning ? ' is-scanning' : ''}`}>{l.count}</span>
            )}
          </button>
        ))}
      </div>
    </>
  )
}

// ─── Agent Rail ──────────────────────────────────────────────────────────────

function AcquisitionAgentRail({ agents }: { agents: AcquisitionAgent[] }) {
  const statusLabel = (s: AgentStatus) =>
    s === 'running' ? 'Running' : s === 'complete' ? 'Ready' : s === 'warning' ? 'Watch' : 'Standby'

  return (
    <div className="aic-agent-rail">
      {agents.map(agent => (
        <div key={agent.id} className={`aic-agent-row is-${agent.status}`} data-agent={agent.id}>
          <div className="aic-agent-icon">{agent.icon}</div>
          <div className="aic-agent-body">
            <div className="aic-agent-top">
              <div className="aic-agent-name">{agent.name}</div>
              <div className="aic-agent-status-wrap">
                <div className="aic-agent-status-dot" />
                <span className="aic-agent-status-label">{statusLabel(agent.status)}</span>
              </div>
            </div>
            <div className="aic-agent-output">{agent.output}</div>
            {agent.confidence !== null && (
              <div className="aic-agent-prog-row">
                <div className="aic-agent-prog-track">
                  <div className="aic-agent-prog-fill" style={{ width: `${agent.confidence}%` }} />
                </div>
                <span className="aic-agent-confidence">{agent.confidence}%</span>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── KPI Cards ───────────────────────────────────────────────────────────────

interface KpiCardsProps {
  propertySnapshot: PropertySnapshot
  demandScore: number | null
  matchCount: number
  candidateCount: number
}

function KpiCards({ propertySnapshot, demandScore, matchCount }: KpiCardsProps) {
  const { estimated_value, arv, purchase_price } = propertySnapshot

  const suggestedOffer = arv ? Math.round(arv * 0.70) : estimated_value ? Math.round(estimated_value * 0.68) : null
  const maxSafeOffer   = arv ? Math.round(arv * 0.80) : estimated_value ? Math.round(estimated_value * 0.78) : null
  const estDispo = matchCount > 20 ? 14 : matchCount > 10 ? 28 : matchCount > 0 ? 45 : null

  const kpis = [
    { label: 'Est. ARV',         value: fmt$(arv ?? estimated_value),        cls: 'is-primary', vCls: '' },
    { label: 'Investor Exit',    value: fmt$(arv ? Math.round(arv * 0.95) : null), cls: '',    vCls: '' },
    { label: 'Suggested Offer',  value: fmt$(suggestedOffer),                cls: 'is-offer', vCls: 'is-gold' },
    { label: 'Max Safe Offer',   value: fmt$(maxSafeOffer),                  cls: '',         vCls: '' },
    { label: 'Demand Score',     value: demandScore !== null ? String(demandScore) : 'Locked',  cls: '', vCls: demandScore !== null ? (demandScore >= 70 ? 'is-green' : 'is-blue') : 'is-locked' },
    { label: 'Buyers Matched',   value: matchCount > 0 ? String(matchCount) : 'Run Match',     cls: '', vCls: matchCount > 0 ? 'is-blue' : 'is-state' },
    { label: 'Purchase Price',   value: fmt$(purchase_price) === '—' ? 'Unknown' : fmt$(purchase_price), cls: '', vCls: purchase_price ? '' : 'is-locked' },
    { label: 'Est. Dispo Days',  value: estDispo ? `${estDispo}d` : 'Pending',  cls: '',      vCls: estDispo ? (estDispo < 21 ? 'is-green' : '') : 'is-state' },
  ]

  return (
    <div className="aic-kpi-grid">
      {kpis.map(k => (
        <div key={k.label} className={`aic-kpi-card ${k.cls}`}>
          <div className="aic-kpi-label">{k.label}</div>
          <div className={`aic-kpi-value ${k.vCls}`}>{k.value}</div>
        </div>
      ))}
    </div>
  )
}

// ─── Offer Command Panel ─────────────────────────────────────────────────────

type OfferMode = 'conservative' | 'balanced' | 'aggressive'

function OfferWaterfall({ propertySnapshot, candidateCount }: { propertySnapshot: PropertySnapshot; candidateCount: number }) {
  const [offerMode, setOfferMode] = useState<OfferMode>('balanced')
  const [notes, setNotes] = useState('')

  const { arv, estimated_value, purchase_price } = propertySnapshot
  const baseArv = arv ?? estimated_value ?? 0
  const exitValue   = baseArv > 0 ? Math.round(baseArv * 0.95) : null
  const spread      = Math.round((baseArv || 0) * 0.12)
  const repair      = Math.round((baseArv || 0) * 0.05)
  const liqDiscount = Math.round((baseArv || 0) * 0.04)
  const riskDisc    = Math.round((baseArv || 0) * 0.02)
  const negBuffer   = Math.round((baseArv || 0) * 0.02)
  const baseSuggested = baseArv > 0 ? (exitValue ?? 0) - spread - repair - liqDiscount - riskDisc - negBuffer : null

  const modeMultiplier = offerMode === 'conservative' ? 0.95 : offerMode === 'aggressive' ? 1.07 : 1.0
  const suggested = baseSuggested ? Math.round(baseSuggested * modeMultiplier) : null
  const doNotCross = baseArv > 0 ? Math.round(baseArv * 0.82) : null

  const suggestedFmt = fmt$(suggested)
  const safeRange    = suggested ? `${fmt$(Math.round(suggested * 0.95))} – ${fmt$(Math.round(suggested * 1.05))}` : '—'
  const aggressiveRange = suggested ? `${fmt$(Math.round(suggested * 1.05))} – ${fmt$(Math.round(suggested * 1.12))}` : '—'

  const confidence = candidateCount > 20 ? 91 : candidateCount > 10 ? 78 : candidateCount > 5 ? 64 : candidateCount > 0 ? 48 : baseArv > 0 ? 35 : 0
  const confCls   = confidence >= 80 ? 'is-high' : confidence >= 60 ? 'is-mid' : 'is-low'
  const confLabel = confidence >= 80 ? 'High Confidence' : confidence >= 60 ? 'Moderate Confidence' : 'Low Confidence'

  const basedOn = [
    { label: 'ARV Confirmed', cls: baseArv > 0 ? 'is-confirmed' : 'is-fallback' },
    { label: 'Buyer Demand', cls: candidateCount > 0 ? 'is-confirmed' : 'is-pending' },
    { label: 'Condition Est.', cls: 'is-fallback' },
    { label: offerMode.charAt(0).toUpperCase() + offerMode.slice(1) + ' Mode', cls: 'is-confirmed' },
  ]

  const replyDraft = suggested
    ? `Hi [Seller], based on our ARV analysis of ${fmt$(baseArv || null)} and current buyer demand in the area, we're positioned to move forward at ${fmt$(suggested)}. This reflects actual investor activity in the market. We're prepared to close quickly — let me know if you'd like to discuss the numbers.`
    : 'Generate an offer first to unlock the seller reply draft.'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {/* Confidence banner */}
      <div className={`aic-offer-confidence ${confCls}`}>
        <div className="aic-offer-confidence__bar" style={{ width: `${confidence}%` }} />
        <div className="aic-offer-confidence__inner">
          <span className="aic-offer-confidence__label">{confLabel}</span>
          <span className="aic-offer-confidence__pct">{confidence}%</span>
        </div>
      </div>
      {/* Confidence Drivers */}
      <div className="aic-conf-drivers">
        <div className="aic-conf-drivers__title">Confidence Drivers</div>
        {[
          { label: 'ARV Confirmed',           delta: baseArv > 0 ? '+30' : '—',  cls: baseArv > 0 ? 'is-pos' : 'is-neutral' },
          { label: 'Buyer Graph',              delta: candidateCount > 0 ? '+25' : '−25', cls: candidateCount > 0 ? 'is-pos' : 'is-neg' },
          { label: 'Institutional Scan',       delta: candidateCount > 0 ? '+10' : '−10', cls: candidateCount > 0 ? 'is-pos' : 'is-neg' },
          { label: 'Condition (Fallback)',     delta: '−15', cls: 'is-neg' },
          { label: 'Seller Ask',               delta: propertySnapshot.purchase_price ? '+0' : '−10', cls: propertySnapshot.purchase_price ? 'is-neutral' : 'is-neg' },
        ].map(d => (
          <div key={d.label} className={`aic-conf-driver-row ${d.cls}`}>
            <span className="aic-conf-driver-label">{d.label}</span>
            <span className="aic-conf-driver-delta">{d.delta}</span>
          </div>
        ))}
      </div>

      {confidence < 80 && (
        <div className="aic-conf-improve">
          <div className="aic-conf-improve__title">How to improve confidence</div>
          {[
            candidateCount === 0 ? { action: 'Run Buyer Match', gain: '+25 potential' } : null,
            !baseArv && propertySnapshot.estimated_value ? { action: 'Confirm ARV via comps', gain: '+15 potential' } : null,
            !propertySnapshot.purchase_price ? { action: 'Confirm seller ask', gain: '+10 potential' } : null,
            { action: 'Schedule condition inspection', gain: '+15 potential' },
          ].filter(Boolean).slice(0, 3).map((item) => (
            <div key={(item as any).action} className="aic-conf-improve-row">
              <span className="aic-conf-improve-action">↑ {(item as any).action}</span>
              <span className="aic-conf-improve-gain">{(item as any).gain}</span>
            </div>
          ))}
        </div>
      )}

      {/* Based On chips */}
      <div className="aic-based-on-row">
        {basedOn.map(b => (
          <div key={b.label} className={`aic-based-on-chip ${b.cls}`}>
            <div className="aic-based-on-chip__dot" />
            {b.label}
          </div>
        ))}
      </div>

      {/* Offer mode selector */}
      <div className="aic-offer-modes">
        {(['conservative', 'balanced', 'aggressive'] as OfferMode[]).map(m => (
          <button
            key={m}
            className={`aic-offer-mode-btn${offerMode === m ? ' is-active' : ''}${m === 'aggressive' ? ' is-aggressive' : m === 'conservative' ? ' is-conservative' : ''}`}
            onClick={() => setOfferMode(m)}
          >
            {m === 'conservative' ? '◎ Conservative' : m === 'aggressive' ? '⚡ Aggressive' : '◈ Balanced'}
          </button>
        ))}
      </div>

      {/* Main offer cards */}
      <div className="aic-offer-stack">
        <div className="aic-offer-card is-primary">
          <div className="aic-offer-card__label">Suggested Offer · {offerMode.charAt(0).toUpperCase() + offerMode.slice(1)}</div>
          <div className="aic-offer-card__value">{suggestedFmt}</div>
          <div className="aic-offer-card__sub">Based on {candidateCount} buyer matches · ARV {fmt$(baseArv || null)}</div>
        </div>
        <div className="aic-offer-card">
          <div className="aic-offer-card__label">Safe Range</div>
          <div className="aic-offer-card__value" style={{ fontSize: '0.78rem' }}>{safeRange}</div>
        </div>
        <div className="aic-offer-card">
          <div className="aic-offer-card__label">Aggressive Range</div>
          <div className="aic-offer-card__value" style={{ fontSize: '0.78rem', color: 'var(--aic-gold)' }}>{aggressiveRange}</div>
        </div>
      </div>

      {/* Do Not Cross */}
      {doNotCross && (
        <div className="aic-do-not-cross">
          <span className="aic-do-not-cross__icon">⛔</span>
          <div className="aic-do-not-cross__info">
            <span className="aic-do-not-cross__label">Do Not Cross</span>
            <span className="aic-do-not-cross__value">{fmt$(doNotCross)}</span>
          </div>
          <span className="aic-do-not-cross__note">82% ARV — max acquisition ceiling</span>
        </div>
      )}

      {/* Waterfall */}
      {baseArv > 0 && (
        <div className="aic-waterfall">
          <div className="aic-section-head" style={{ marginBottom: 6 }}>Offer Waterfall</div>
          {[
            { icon: '◎', label: 'Expected Buyer Exit Value', value: fmt$(exitValue), cls: '' },
            { icon: '−', label: 'Required Spread (12%)',   value: `(${fmt$(spread)})`,       cls: 'is-deduct' },
            { icon: '−', label: 'Repair Adjustment (5%)',  value: `(${fmt$(repair)})`,        cls: 'is-deduct' },
            { icon: '−', label: 'Liquidity Discount (4%)', value: `(${fmt$(liqDiscount)})`,   cls: 'is-deduct' },
            { icon: '−', label: 'Risk Discount (2%)',      value: `(${fmt$(riskDisc)})`,      cls: 'is-deduct' },
            { icon: '−', label: 'Negotiation Buffer (2%)', value: `(${fmt$(negBuffer)})`,     cls: 'is-deduct' },
          ].map((r, i) => (
            <div key={i} className="aic-waterfall-row">
              <span className="aic-waterfall-icon" style={{ color: r.cls ? 'var(--aic-red)' : 'var(--aic-blue)' }}>{r.icon}</span>
              <span className="aic-waterfall-label">{r.label}</span>
              <span className={`aic-waterfall-value ${r.cls}`}>{r.value}</span>
            </div>
          ))}
          <div className="aic-waterfall-row is-result">
            <span className="aic-waterfall-icon" style={{ color: 'var(--aic-gold)' }}>=</span>
            <span className="aic-waterfall-label" style={{ fontWeight: 700, color: 'var(--aic-text)' }}>Suggested Offer</span>
            <span className="aic-waterfall-value is-result">{suggestedFmt}</span>
          </div>
        </div>
      )}

      {/* Seller Reply Preview */}
      {purchase_price && (
        <div className="aic-seller-ask-card">
          <strong>Seller Reply Preview</strong>
          <p>
            Seller is asking <strong style={{ color: 'var(--aic-gold)' }}>{fmt$(purchase_price)}</strong>
            {suggested && purchase_price > suggested
              ? <> — <span style={{ color: 'var(--aic-red)' }}>{fmt$(purchase_price - suggested)} above target</span>. Lead with ARV data and buyer demand to justify your number.</>
              : suggested
              ? <> — within acquisition target. Strong offer positioning available.</>
              : null
            }
          </p>
        </div>
      )}

      {/* Acquisition Notes */}
      <div className="aic-acq-notes">
        <div className="aic-acq-notes__label">Internal Acquisition Notes</div>
        <textarea
          className="aic-acq-notes__input"
          placeholder="Add internal context, negotiation notes, or deal flags…"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={3}
        />
      </div>

      {/* Seller Reply Draft */}
      <div className="aic-seller-reply-draft">
        <div className="aic-seller-reply-draft__header">
          <div className="aic-seller-reply-draft__title">Seller Reply Draft</div>
        </div>
        <div className="aic-seller-reply-draft__body">{replyDraft}</div>
        <div className="aic-seller-reply-draft__actions">
          <button className="aic-seller-reply-draft__btn is-generate">Generate Reply</button>
          <button className="aic-seller-reply-draft__btn is-copy">Copy</button>
        </div>
      </div>

      <div className="aic-offer-action-row">
        <button className="aic-offer-action is-primary">Push to Underwriting</button>
        <button className="aic-offer-action is-secondary">Send Offer Text</button>
      </div>
    </div>
  )
}

// ─── Risk Intelligence Matrix ─────────────────────────────────────────────────

function RiskTab({ propertySnapshot, demandScore, matchCount }: { propertySnapshot: PropertySnapshot; demandScore: number | null; matchCount: number }) {
  const { estimated_value, arv, purchase_price } = propertySnapshot

  type RiskStatus = 'clear' | 'watch' | 'warning' | 'critical'
  interface RiskRow { id: string; label: string; status: RiskStatus; detail: string; action: string }

  const riskRows: RiskRow[] = [
    {
      id: 'liquidity',
      label: 'Buyer Liquidity',
      status: demandScore === null ? 'watch' : demandScore >= 70 ? 'clear' : demandScore >= 40 ? 'watch' : 'critical',
      detail: demandScore !== null ? `Demand score: ${demandScore}/100` : 'Buyer match not run',
      action: demandScore === null ? 'Run buyer match to assess liquidity' : demandScore < 40 ? 'Expand search radius or adjust price expectation' : 'Monitor — acceptable liquidity',
    },
    {
      id: 'comps',
      label: 'Comp Confidence',
      status: arv ? 'clear' : estimated_value ? 'watch' : 'warning',
      detail: arv ? `Confirmed ARV: ${fmt$(arv)}` : estimated_value ? `Est. value: ${fmt$(estimated_value)} — unconfirmed` : 'No valuation data available',
      action: arv ? 'Verify comps within 0.5mi before final offer' : estimated_value ? 'Run comp intelligence for confirmed ARV' : 'Run comp analysis — calculations unavailable',
    },
    {
      id: 'seller_ask',
      label: 'Seller Ask',
      status: !purchase_price ? 'watch' : purchase_price <= (arv ?? estimated_value ?? 0) * 0.75 ? 'clear' : purchase_price <= (arv ?? estimated_value ?? 0) * 0.85 ? 'watch' : 'critical',
      detail: purchase_price ? `Asking ${fmt$(purchase_price)}` : 'Seller ask not confirmed',
      action: !purchase_price ? 'Confirm seller ask before offer' : purchase_price > (arv ?? estimated_value ?? 0) * 0.85 ? 'Negotiate with ARV data — ask exceeds wholesale threshold' : 'Within target range — proceed with offer',
    },
    {
      id: 'condition',
      label: 'Condition Risk',
      status: 'watch',
      detail: 'Repair estimate using 5% ARV placeholder',
      action: 'Schedule inspection before finalizing offer',
    },
    {
      id: 'arv_spread',
      label: 'ARV Spread',
      status: !arv && !estimated_value ? 'warning' : arv ? 'clear' : 'watch',
      detail: arv ? `ARV confirmed at ${fmt$(arv)}` : estimated_value ? `Using estimated value — not confirmed ARV` : 'No valuation — calculations unavailable',
      action: arv ? 'Waterfall calculations active — review offer tab' : 'Confirm ARV to activate offer calculations',
    },
    {
      id: 'institutional',
      label: 'Institutional Demand',
      status: matchCount === 0 ? 'watch' : matchCount > 5 ? 'clear' : 'watch',
      detail: matchCount > 0 ? `${matchCount} buyers matched — check buyer tab for institutional signals` : 'Run buyer match to detect institutional activity',
      action: matchCount > 0 ? 'Review buyer tab for institutional signals' : 'Run buyer match to detect institutional buyers',
    },
  ]

  const statusOrder: RiskStatus[] = ['critical', 'warning', 'watch', 'clear']
  const sorted    = [...riskRows].sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status))
  const critCount  = riskRows.filter(r => r.status === 'critical').length
  const warnCount  = riskRows.filter(r => r.status === 'warning').length
  const watchCount = riskRows.filter(r => r.status === 'watch').length
  const clearCount = riskRows.filter(r => r.status === 'clear').length

  const overallStatus: RiskStatus = critCount > 0 ? 'critical' : warnCount > 0 ? 'warning' : watchCount > 0 ? 'watch' : 'clear'
  const overallLabel = overallStatus.charAt(0).toUpperCase() + overallStatus.slice(1)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {/* Risk Status Banner */}
      <div className={`aic-risk-banner is-${overallStatus}`}>
        <div className="aic-risk-banner__left">
          <div className="aic-risk-banner__dot" />
          <div className="aic-risk-banner__label">
            <strong>Risk Status: {overallLabel.toUpperCase()}</strong>
            Risk Intelligence
          </div>
        </div>
        <div className="aic-risk-banner__counts">
          <span className={`aic-risk-banner__count is-critical`}><span>{critCount}</span>critical</span>
          <span className={`aic-risk-banner__count is-warning`}><span>{warnCount}</span>warning</span>
          <span className={`aic-risk-banner__count is-watch`}><span>{watchCount}</span>watch</span>
          <span className={`aic-risk-banner__count is-clear`}><span>{clearCount}</span>clear</span>
        </div>
      </div>

      <div className="aic-risk-summary">
        <div className={`aic-risk-summary-badge is-critical${critCount > 0 ? ' is-lit' : ''}`}>
          <span>{critCount}</span><span>Critical</span>
        </div>
        <div className={`aic-risk-summary-badge is-warning${warnCount > 0 ? ' is-lit' : ''}`}>
          <span>{warnCount}</span><span>Warning</span>
        </div>
        <div className={`aic-risk-summary-badge is-watch${watchCount > 0 ? ' is-lit' : ''}`}>
          <span>{watchCount}</span><span>Watch</span>
        </div>
        <div className="aic-risk-summary-badge is-clear">
          <span>{clearCount}</span><span>Clear</span>
        </div>
      </div>

      <div className="aic-risk-matrix">
        {sorted.map(r => (
          <div key={r.id} className={`aic-risk-matrix-row is-${r.status}`}>
            <div className="aic-risk-matrix-label">
              <div className={`aic-risk-matrix-dot is-${r.status}`} />
              <span>{r.label}</span>
            </div>
            <span className={`aic-risk-matrix-status is-${r.status}`}>
              {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
            </span>
            <div className="aic-risk-matrix-detail">{r.detail}</div>
            <div className="aic-risk-matrix-action">→ {r.action}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Enhanced Buyer Card ─────────────────────────────────────────────────────

interface BuyerCardProps {
  candidate: BuyerMatchCandidate
  isSelected: boolean
  onSelect: () => void
  onSendPackage: () => void
  onMarkInterested: () => void
  onMarkPassed: () => void
}

function AcqBuyerCard({ candidate: c, isSelected, onSelect, onSendPackage, onMarkInterested, onMarkPassed }: BuyerCardProps) {
  const pct = Math.round(Math.min(100, Math.max(0, c.total_match_score)))
  const packageSent  = Boolean(c.package_sent_at)
  const isInterested = c.buyer_response_status === 'interested'
  const isPassed     = c.buyer_response_status === 'passed'
  const isAplus      = c.match_grade === 'A+'
  const isInst       = c.buyer_type === 'institutional'

  return (
    <motion.div
      className={`aic-buyer-card${isAplus ? ' is-aplus' : isInst ? ' is-institutional' : ''}${isSelected ? ' is-selected' : ''}`}
      onClick={onSelect}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.18 }}
      whileTap={{ scale: 0.99 }}
    >
      <div className="aic-buyer-card__header">
        <div className="aic-buyer-avatar">{initials(c.buyer_name)}</div>
        <div className="aic-buyer-info">
          <div className="aic-buyer-name" title={c.buyer_name}>{c.buyer_name}</div>
          <div className="aic-buyer-meta">
            {c.mailing_city && c.mailing_state ? `${c.mailing_city}, ${c.mailing_state}` : (c.markets_active?.[0] ?? 'Market Unknown')}
            {c.last_purchase_date ? ` · ${fmtDaysAgo(c.last_purchase_date)}` : ''}
          </div>
        </div>
        <div className={`aic-buyer-grade ${gradeClass(c.match_grade)}`}>{c.match_grade}</div>
      </div>

      <div className="aic-buyer-badges">
        {c.is_repeat_buyer && <span className="aic-buyer-badge is-repeat">↩ Repeat</span>}
        {c.buyer_type === 'corporate' && <span className="aic-buyer-badge is-corp">Corp</span>}
        {c.buyer_type === 'institutional' && <span className="aic-buyer-badge is-inst">⚡ Institutional</span>}
        {c.purchase_count_180d > 0 && <span className="aic-buyer-badge is-active">🔥 Active 6mo</span>}
        {c.markets_active?.slice(0, 1).map(m => <span key={m} className="aic-buyer-badge">{m}</span>)}
      </div>

      <div className="aic-buyer-score-row">
        <span className="aic-buyer-score-label">Match</span>
        <div className="aic-buyer-score-track"><div className="aic-buyer-score-fill" style={{ width: `${pct}%` }} /></div>
        <span className="aic-buyer-score-val">{pct}</span>
      </div>

      <div className="aic-buyer-metrics">
        <div className="aic-buyer-metric"><div className="aic-buyer-metric__label">Purchases</div><div className="aic-buyer-metric__value">{fmtNum(c.purchase_count)}</div></div>
        <div className="aic-buyer-metric"><div className="aic-buyer-metric__label">Avg Price</div><div className="aic-buyer-metric__value">{fmt$k(c.avg_purchase_price)}</div></div>
        <div className="aic-buyer-metric"><div className="aic-buyer-metric__label">Spread Fit</div><div className="aic-buyer-metric__value">{fmt$k(c.avg_potential_spread)}</div></div>
      </div>

      {c.reason_for_match && <div className="aic-buyer-reason">✦ {c.reason_for_match}</div>}

      <div className="aic-buyer-actions" onClick={e => e.stopPropagation()}>
        {packageSent ? (
          <button className="aic-buyer-action is-sent" disabled>✓ Sent</button>
        ) : (
          <button className="aic-buyer-action is-primary" onClick={onSendPackage}>📤 Send Package</button>
        )}
        {!isPassed && !isInterested && (
          <button className="aic-buyer-action is-success" onClick={onMarkInterested}>✓ Interested</button>
        )}
        {isInterested && <span className="aic-buyer-action is-success is-sent">🟢 Interested</span>}
        {!isPassed && (
          <button className="aic-buyer-action is-danger" onClick={onMarkPassed}>✗ Pass</button>
        )}
        {isPassed && <span className="aic-buyer-action" style={{ opacity: 0.4 }}>Passed</span>}
      </div>
    </motion.div>
  )
}

// ─── Buyer Detail Panel ───────────────────────────────────────────────────────

interface BuyerDetailProps {
  candidate: BuyerMatchCandidate | null
  purchases: PurchaseEvent[]
  onSendPackage: () => void
  onSelectBuyer: () => void
  onMarkInterested: () => void
  onMarkPassed: () => void
}

function BuyerDetailPanel({ candidate: c, purchases, onSendPackage, onSelectBuyer, onMarkInterested, onMarkPassed }: BuyerDetailProps) {
  if (!c) {
    return (
      <div className="aic-empty">
        <div className="aic-empty__icon">🎯</div>
        <div className="aic-empty__title">Select a Buyer</div>
        <div className="aic-empty__desc">Click any buyer card to view their full profile, buy box, purchase trail, and match breakdown.</div>
      </div>
    )
  }

  const packageSent  = Boolean(c.package_sent_at)
  const isInterested = c.buyer_response_status === 'interested'
  const isPassed     = c.buyer_response_status === 'passed'

  const scoreComponents = [
    { name: 'Market Match', score: c.market_match_score, weight: 25 },
    { name: 'Asset Match',  score: c.asset_match_score,  weight: 20 },
    { name: 'Price Match',  score: c.price_match_score,  weight: 20 },
    { name: 'Recency',      score: c.recency_score,      weight: 15 },
    { name: 'Repeat Buyer', score: c.repeat_buyer_score, weight: 10 },
    { name: 'Spread Fit',   score: c.spread_fit_score,   weight: 10 },
  ]

  return (
    <motion.div
      className="aic-buyer-detail"
      key={c.buyer_key}
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.20 }}
    >
      <div className={`aic-detail-hero${c.match_grade === 'A+' ? ' is-aplus' : c.buyer_type === 'institutional' ? ' is-inst' : c.is_corporate_buyer ? ' is-corp' : ''}`}>
        <div className="aic-detail-avatar">{initials(c.buyer_name)}</div>
        <div className="aic-detail-info">
          <div className="aic-detail-name">{c.buyer_name}</div>
          <div className="aic-detail-type">{c.buyer_type.charAt(0).toUpperCase() + c.buyer_type.slice(1)} Buyer{c.is_repeat_buyer ? ' · Repeat' : ''}</div>
          {(c.mailing_city || c.mailing_state) && (
            <div style={{ fontSize: '0.63rem', color: 'rgba(219,229,255,0.38)', marginTop: 3 }}>
              📍 {[c.mailing_city, c.mailing_state, c.mailing_zip].filter(Boolean).join(', ')}
            </div>
          )}
        </div>
        <div className={`aic-buyer-grade ${gradeClass(c.match_grade)}`} style={{ alignSelf: 'flex-start' }}>{c.match_grade}</div>
      </div>

      <div className="aic-detail-section">
        <div className="aic-section-head">Match Score Breakdown</div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 4, alignItems: 'flex-end', padding: '4px 0' }}>
          <span style={{ fontSize: '2rem', fontWeight: 900, color: '#e8f0ff', lineHeight: 1 }}>{Math.round(c.total_match_score)}</span>
          <span style={{ fontSize: '0.72rem', color: 'var(--aic-text-faint)', marginBottom: 4 }}>/100</span>
        </div>
        <div className="aic-score-breakdown">
          {scoreComponents.map(sc => (
            <div key={sc.name} className="aic-score-comp">
              <span className="aic-score-comp__name">{sc.name} <span style={{ opacity: 0.38 }}>({sc.weight}%)</span></span>
              <div className="aic-score-comp__bar"><div className="aic-score-comp__fill" style={{ width: `${sc.score}%` }} /></div>
              <span className="aic-score-comp__val">{Math.round(sc.score)}</span>
            </div>
          ))}
        </div>
        {c.reason_for_match && (
          <div style={{ fontSize: '0.66rem', color: 'var(--aic-text-muted)', fontStyle: 'italic', marginTop: 4 }}>✦ {c.reason_for_match}</div>
        )}
      </div>

      <div className="aic-detail-section">
        <div className="aic-section-head">Buy Box Profile</div>
        <div className="aic-detail-kv-grid">
          <div><div className="aic-detail-kv__key">Purchases</div><div className="aic-detail-kv__val is-cyan">{fmtNum(c.purchase_count)}</div></div>
          <div><div className="aic-detail-kv__key">Last Active</div><div className="aic-detail-kv__val">{fmtDaysAgo(c.last_purchase_date)}</div></div>
          <div><div className="aic-detail-kv__key">Avg Price</div><div className="aic-detail-kv__val">{fmt$(c.avg_purchase_price)}</div></div>
          <div><div className="aic-detail-kv__key">Median Price</div><div className="aic-detail-kv__val">{fmt$(c.median_purchase_price)}</div></div>
          <div><div className="aic-detail-kv__key">Price Range</div><div className="aic-detail-kv__val" style={{ fontSize: '0.68rem' }}>{c.preferred_price_min || c.preferred_price_max ? `${fmt$k(c.preferred_price_min)} – ${fmt$k(c.preferred_price_max)}` : '—'}</div></div>
          <div><div className="aic-detail-kv__key">Avg Spread</div><div className="aic-detail-kv__val is-green">{fmt$(c.avg_potential_spread)}</div></div>
          <div><div className="aic-detail-kv__key">6mo Purchases</div><div className="aic-detail-kv__val">{fmtNum(c.purchase_count_180d)}</div></div>
          <div><div className="aic-detail-kv__key">Avg $/sqft</div><div className="aic-detail-kv__val">{c.avg_ppsf ? `$${Math.round(c.avg_ppsf)}/sf` : '—'}</div></div>
        </div>
        {c.markets_active?.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="aic-detail-kv__key" style={{ marginBottom: 5 }}>Active Markets</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {c.markets_active.slice(0, 5).map(m => <span key={m} className="aic-buyer-badge is-corp">{m}</span>)}
            </div>
          </div>
        )}
      </div>

      {purchases.length > 0 && (
        <div className="aic-detail-section">
          <div className="aic-section-head">Purchase Trail</div>
          <div className="aic-purchase-trail">
            {purchases.slice(0, 8).map((p, i) => (
              <div key={i} className="aic-trail-item">
                <div className="aic-trail-item__head">
                  <span className="aic-trail-item__addr">{p.property_address_full || 'Unknown Address'}</span>
                  {p.purchase_price && <span className="aic-trail-item__price">{fmt$(p.purchase_price)}</span>}
                </div>
                <div className="aic-trail-item__meta">
                  <span>{fmtDate(p.purchase_date)}</span>
                  {p.market && <span>{p.market}</span>}
                  {p.property_type && <span>{p.property_type}</span>}
                  {p.sqft && <span>{fmtNum(p.sqft)} sqft</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="aic-buyer-actions" style={{ flexWrap: 'wrap', gap: 7 }}>
        {!packageSent ? (
          <button className="aic-buyer-action is-primary" onClick={onSendPackage} style={{ flex: '1 1 auto' }}>📤 Send Package</button>
        ) : (
          <button className="aic-buyer-action is-sent" disabled style={{ flex: '1 1 auto' }}>✓ Package Sent {fmtDate(c.package_sent_at)}</button>
        )}
        {!isInterested && !isPassed && (
          <button className="aic-buyer-action is-success" onClick={onMarkInterested} style={{ flex: '1 1 auto' }}>✓ Interested</button>
        )}
        {isInterested && <span className="aic-buyer-action is-success is-sent" style={{ flex: '1 1 auto', textAlign: 'center' }}>🟢 Interested</span>}
        <button
          className="aic-buyer-action is-primary"
          onClick={onSelectBuyer}
          style={{ flex: '1 1 100%' }}
        >⭐ {c.selected ? 'Selected Buyer ✓' : 'Select as Buyer'}</button>
        {!isPassed && (
          <button className="aic-buyer-action is-danger" onClick={onMarkPassed} style={{ flex: '1 1 auto' }}>✗ Pass</button>
        )}
      </div>
    </motion.div>
  )
}

// ─── Buyers Tab Full Content ──────────────────────────────────────────────────

interface BuyersTabProps {
  filteredCandidates: BuyerMatchCandidate[]
  selectedKey: string | null
  gradeFilter: GradeFilter
  typeFilter: TypeFilter
  gradeCounts: { aplus: number; a: number; b: number; other: number }
  loading: boolean
  running: boolean
  hasEntityGraph: boolean
  demandStats: { entity_count: number; match_count: number } | null
  demandScore: number | null
  setSelectedKey: React.Dispatch<React.SetStateAction<string | null>>
  setGradeFilter: React.Dispatch<React.SetStateAction<GradeFilter>>
  setTypeFilter: React.Dispatch<React.SetStateAction<TypeFilter>>
  runMatch: () => void
  sendPackage: (id: string | undefined) => void
  updateCandidateStatus: (id: string | undefined, updates: Record<string, unknown>) => void
  selectBuyer: (id: string | undefined) => void
  purchases: PurchaseEvent[]
}

function BuyersTab({
  filteredCandidates, selectedKey, gradeFilter, typeFilter, gradeCounts,
  loading, running, hasEntityGraph, demandStats, demandScore,
  setSelectedKey, setGradeFilter, setTypeFilter, runMatch,
  sendPackage, updateCandidateStatus, selectBuyer, purchases
}: BuyersTabProps) {
  const selectedCandidate = filteredCandidates.find(c => c.buyer_key === selectedKey)
    ?? (selectedKey ? undefined : undefined)

  const totalMatched  = gradeCounts.aplus + gradeCounts.a + gradeCounts.b + gradeCounts.other
  const repeatCount   = filteredCandidates.filter(c => c.is_repeat_buyer).length
  const corpCount     = filteredCandidates.filter(c => c.is_corporate_buyer).length
  const instCount     = filteredCandidates.filter(c => c.buyer_type === 'institutional').length
  const estDispo      = totalMatched > 20 ? 14 : totalMatched > 10 ? 28 : totalMatched > 0 ? 45 : null

  const hasResults = totalMatched > 0 && !running

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Post-run metrics header */}
      {hasResults && (
        <motion.div
          className="aic-buyers-metrics-header"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22 }}
        >
          <div className="aic-bm-metric">
            <div className="aic-bm-metric__label">Liquidity</div>
            <div className={`aic-bm-metric__value ${demandScore !== null && demandScore >= 70 ? 'is-green' : demandScore !== null ? 'is-blue' : ''}`}>
              {demandScore !== null ? demandScore : '—'}
            </div>
          </div>
          <div className="aic-bm-metric">
            <div className="aic-bm-metric__label">Matched</div>
            <div className="aic-bm-metric__value is-blue">{totalMatched}</div>
          </div>
          <div className="aic-bm-metric">
            <div className="aic-bm-metric__label">A+ Buyers</div>
            <div className={`aic-bm-metric__value ${gradeCounts.aplus > 0 ? 'is-gold' : ''}`}>{gradeCounts.aplus || '—'}</div>
          </div>
          <div className="aic-bm-metric">
            <div className="aic-bm-metric__label">Repeat</div>
            <div className={`aic-bm-metric__value ${repeatCount > 0 ? 'is-green' : ''}`}>{repeatCount || '—'}</div>
          </div>
          <div className="aic-bm-metric">
            <div className="aic-bm-metric__label">Corp</div>
            <div className="aic-bm-metric__value">{corpCount || '—'}</div>
          </div>
          <div className="aic-bm-metric">
            <div className="aic-bm-metric__label">Inst.</div>
            <div className={`aic-bm-metric__value ${instCount > 0 ? 'is-purple' : ''}`}>{instCount || '—'}</div>
          </div>
          <div className="aic-bm-metric">
            <div className="aic-bm-metric__label">Est. Dispo</div>
            <div className={`aic-bm-metric__value ${estDispo && estDispo <= 21 ? 'is-green' : ''}`}>
              {estDispo ? `${estDispo}d` : '—'}
            </div>
          </div>
        </motion.div>
      )}

      {/* Filters */}
      <div className="aic-buyer-toolbar">
        <span className="aic-buyer-toolbar__title">Buyers</span>
        {filteredCandidates.length > 0 && <span className="aic-buyer-toolbar__count">{filteredCandidates.length}</span>}
        <div className="aic-buyer-toolbar__filters">
          {(['A+', 'A', 'B'] as GradeFilter[]).map(g => (
            <button key={g}
              className={`aic-filter-pill${g === 'A+' ? ' is-gold' : ''} ${gradeFilter === g ? 'is-active' : ''}`}
              onClick={() => setGradeFilter(f => f === g ? 'all' : g)}
            >{g}{g === 'A+' && gradeCounts.aplus > 0 ? ` (${gradeCounts.aplus})` : g === 'A' && gradeCounts.a > 0 ? ` (${gradeCounts.a})` : g === 'B' && gradeCounts.b > 0 ? ` (${gradeCounts.b})` : ''}</button>
          ))}
          <button className={`aic-filter-pill is-purple ${typeFilter === 'corporate' ? 'is-active' : ''}`} onClick={() => setTypeFilter(f => f === 'corporate' ? 'all' : 'corporate')}>Corp</button>
          <button className={`aic-filter-pill ${typeFilter === 'repeat' ? 'is-active' : ''}`} onClick={() => setTypeFilter(f => f === 'repeat' ? 'all' : 'repeat')}>Repeat</button>
          <button className={`aic-filter-pill ${typeFilter === 'institutional' ? 'is-active' : ''}`} onClick={() => setTypeFilter(f => f === 'institutional' ? 'all' : 'institutional')}>Inst</button>
        </div>
      </div>

      {/* Buyer + Detail split for dossier buyers tab */}
      <div style={{ display: 'grid', gridTemplateColumns: selectedKey ? '1fr 1fr' : '1fr', gap: 10 }}>
        <div className="aic-buyer-list">
          {loading && [1,2,3].map(i => (
            <div key={i} className="aic-skel-card">
              <div style={{ display: 'flex', gap: 10 }}>
                <div className="aic-skel" style={{ width: 36, height: 36, borderRadius: 11 }} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="aic-skel" style={{ height: 13, width: '55%' }} />
                  <div className="aic-skel" style={{ height: 9, width: '35%' }} />
                </div>
              </div>
              <div className="aic-skel" style={{ height: 4 }} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 5 }}>
                <div className="aic-skel" style={{ height: 40, borderRadius: 9 }} />
                <div className="aic-skel" style={{ height: 40, borderRadius: 9 }} />
                <div className="aic-skel" style={{ height: 40, borderRadius: 9 }} />
              </div>
            </div>
          ))}

          {!loading && !hasEntityGraph && filteredCandidates.length === 0 && (
            <div className="aic-buyer-graph-locked">
              <div className="aic-buyer-graph-locked__net" />
              <div className="aic-buyer-graph-locked__content">
                <div className="aic-buyer-graph-locked__icon">◈</div>
                <div className="aic-buyer-graph-locked__title">Buyer Graph Locked</div>
                <div className="aic-buyer-graph-locked__desc">Build the buyer graph to unlock:</div>
                <div className="aic-buyer-preview-unlock">
                  {[
                    { label: 'Liquidity Score', value: '—' },
                    { label: 'A+ Buyers', value: '—' },
                    { label: 'Repeat Buyers', value: '—' },
                    { label: 'Corporate', value: '—' },
                    { label: 'Institutional', value: '—' },
                    { label: 'Exit Range', value: '—' },
                  ].map(s => (
                    <div key={s.label} className="aic-buyer-preview-stat">
                      <div className="aic-buyer-preview-stat__label">{s.label}</div>
                      <div className="aic-buyer-preview-stat__value">{s.value}</div>
                    </div>
                  ))}
                </div>
                <button className="aic-cmd-btn" onClick={runMatch} disabled={running} style={{ maxWidth: 220, marginTop: 4 }}>
                  {running ? '⟳ Building…' : '⚡ Build Buyer Graph'}
                </button>
              </div>
            </div>
          )}
          {!loading && !hasEntityGraph && filteredCandidates.length === 0 && (
            <div className="aic-ghost-buyer-card">
              <div className="aic-ghost-label">Preview · Future Buyer Card</div>
              <div className="aic-ghost-header">
                <div className="aic-ghost-avatar" />
                <div className="aic-ghost-info">
                  <div className="aic-ghost-name" />
                  <div className="aic-ghost-sub" />
                </div>
                <div className="aic-ghost-grade">A+</div>
              </div>
              <div className="aic-ghost-metrics">
                {['Match Score', 'Buyer Type', 'Last Buy'].map(l => (
                  <div key={l} className="aic-ghost-metric">
                    <div className="aic-ghost-metric-label" />
                    <div className="aic-ghost-metric-value" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {!loading && hasEntityGraph && filteredCandidates.length === 0 && !running && (
            <div className="aic-empty">
              <div className="aic-empty__icon">🎯</div>
              <div className="aic-empty__title">Run Buyer Match</div>
              <div className="aic-empty__desc">Score {fmtNum(demandStats?.entity_count)} buyer entities against this property.</div>
            </div>
          )}

          <AnimatePresence>
            {filteredCandidates.map(c => (
              <AcqBuyerCard
                key={c.buyer_key}
                candidate={c}
                isSelected={selectedKey === c.buyer_key}
                onSelect={() => setSelectedKey(k => k === c.buyer_key ? null : c.buyer_key)}
                onSendPackage={() => sendPackage(c.buyer_match_candidate_id)}
                onMarkInterested={() => updateCandidateStatus(c.buyer_match_candidate_id, { buyer_response_status: 'interested' })}
                onMarkPassed={() => updateCandidateStatus(c.buyer_match_candidate_id, { buyer_response_status: 'passed' })}
              />
            ))}
          </AnimatePresence>
        </div>

        {selectedKey && (
          <BuyerDetailPanel
            candidate={filteredCandidates.find(c => c.buyer_key === selectedKey) ?? null}
            purchases={purchases}
            onSendPackage={() => sendPackage(selectedCandidate?.buyer_match_candidate_id)}
            onSelectBuyer={() => selectBuyer(selectedCandidate?.buyer_match_candidate_id)}
            onMarkInterested={() => updateCandidateStatus(selectedCandidate?.buyer_match_candidate_id, { buyer_response_status: 'interested' })}
            onMarkPassed={() => updateCandidateStatus(selectedCandidate?.buyer_match_candidate_id, { buyer_response_status: 'passed' })}
          />
        )}
      </div>
    </div>
  )
}

// ─── Comps Tab ────────────────────────────────────────────────────────────────

function CompsTab({ propertySnapshot, realComps }: { propertySnapshot: PropertySnapshot; realComps: RealComp[] }) {
  const hasRealComps = realComps.length > 0

  const RealCompCard = ({ comp }: { comp: RealComp }) => {
    const typeTag = comp.source_type === 'BUYER_PURCHASE' ? 'PR' : 'MLS'
    const daysSold = comp.sold_date ? Math.round((Date.now() - new Date(comp.sold_date).getTime()) / 86_400_000) : null
    return (
      <div className={`aic-comp-card is-${typeTag === 'PR' ? 'pr' : 'mls'}`}>
        <span className={`aic-comp-source-tag is-${typeTag === 'PR' ? 'pr' : 'mls'}`}>{typeTag}</span>
        <div className="aic-comp-info">
          <div className="aic-comp-addr">{comp.address}</div>
          <div className="aic-comp-details">
            {daysSold !== null && <span className="aic-comp-detail">{daysSold}d ago</span>}
            {comp.beds != null && comp.baths != null && <span className="aic-comp-detail">{comp.beds}bd/{comp.baths}ba</span>}
            {comp.sqft && <span className="aic-comp-detail">{fmtNum(comp.sqft)} sqft</span>}
            {comp.ppsf && <span className="aic-comp-detail">${comp.ppsf}/sf</span>}
          </div>
        </div>
        <div className="aic-comp-price">
          <div className="aic-comp-price__main">{fmt$(comp.sold_price)}</div>
          {comp.ppsf && <div className="aic-comp-price__sub">${comp.ppsf}/sf</div>}
        </div>
      </div>
    )
  }

  if (hasRealComps) {
    const prComps = realComps.filter(c => c.source_type === 'BUYER_PURCHASE')
    const mlsComps = realComps.filter(c => c.source_type !== 'BUYER_PURCHASE')
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {mlsComps.length > 0 && (
          <div className="aic-comp-section">
            <div className="aic-section-head" style={{ marginBottom: 6 }}>Recent Sales · {mlsComps[0].zip ?? 'Local'}</div>
            {mlsComps.slice(0, 6).map((c, i) => <RealCompCard key={i} comp={c} />)}
          </div>
        )}
        {prComps.length > 0 && (
          <div className="aic-comp-section">
            <div className="aic-section-head" style={{ marginBottom: 6 }}>Investor Purchases (PR)</div>
            {prComps.slice(0, 6).map((c, i) => <RealCompCard key={i} comp={c} />)}
          </div>
        )}
      </div>
    )
  }

  // Fallback: mock illustration when no real comps loaded
  const base = propertySnapshot.estimated_value ?? 180000
  const mockMls = [
    { addr: '123 Oak St',  soldPrice: Math.round(base * 1.05), dist: 0.4, days: 22, beds: 3, baths: 2, sqft: 1450, ppsf: 124, label: 'ceiling' as const, why: 'Sets the retail ARV ceiling — what a financed buyer would pay.', matchScore: 94, arvWeight: '35%', arvImpact: '+4.2%' },
    { addr: '456 Elm Ave', soldPrice: Math.round(base * 0.98), dist: 0.8, days: 45, beds: 3, baths: 1, sqft: 1380, ppsf: 118, label: 'ceiling' as const, why: 'Confirms retail demand — slight discount reflects condition and time on market.', matchScore: 87, arvWeight: '28%', arvImpact: '+2.1%' },
  ]
  const mockPr = [
    { addr: '789 Pine Rd',  soldPrice: Math.round(base * 0.82), dist: 0.6, days: 18, beds: 3, baths: 2, sqft: 1420, ppsf: 104, label: 'reality' as const, why: 'Reflects what investors actually pay — your buyer\'s likely cost basis.', matchScore: 91, arvWeight: '22%', arvImpact: '-1.8%' },
    { addr: '321 Maple Dr', soldPrice: Math.round(base * 0.76), dist: 1.1, days: 60, beds: 3, baths: 1, sqft: 1350, ppsf: 101, label: 'anchor' as const, why: 'Institutional exit anchor — validates the bottom of the investor price range.', matchScore: 78, arvWeight: '15%', arvImpact: '-3.4%' },
  ]

  const CompCard = ({ comp, type }: { comp: (typeof mockMls)[number] | (typeof mockPr)[number]; type: 'mls' | 'pr' }) => (
    <div className={`aic-comp-card is-${type}`}>
      <span className={`aic-comp-source-tag is-${type}`}>{type === 'mls' ? 'MLS' : 'PR'}</span>
      <div className="aic-comp-info">
        <div className="aic-comp-addr">{comp.addr}</div>
        <div className="aic-comp-details">
          <span className="aic-comp-detail">{comp.dist}mi</span>
          <span className="aic-comp-detail">{comp.days}d ago</span>
          <span className="aic-comp-detail">{comp.beds}bd/{comp.baths}ba</span>
          <span className="aic-comp-detail">{fmtNum(comp.sqft)} sqft</span>
          <span className="aic-comp-detail">${comp.ppsf}/sf</span>
        </div>
        <div className="aic-comp-intel-row">
          <span className="aic-comp-intel-chip is-score">Score {comp.matchScore}</span>
          <span className="aic-comp-intel-chip is-weight">ARV Wt {comp.arvWeight}</span>
          <span className="aic-comp-intel-chip is-impact">Impact {comp.arvImpact}</span>
        </div>
        <div className="aic-comp-why">{comp.why}</div>
      </div>
      <div className="aic-comp-price">
        <div className="aic-comp-price__main">{fmt$(comp.soldPrice)}</div>
        <div className="aic-comp-price__sub">${comp.ppsf}/sf</div>
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="aic-comp-section">
        <div className="aic-section-head" style={{ marginBottom: 6 }}>MLS Retail Anchors</div>
        {mockMls.map((c, i) => <CompCard key={i} comp={c} type="mls" />)}
      </div>
      <div className="aic-comp-section">
        <div className="aic-section-head" style={{ marginBottom: 6 }}>PR Investor Anchors</div>
        {mockPr.map((c, i) => <CompCard key={i} comp={c} type="pr" />)}
      </div>
      <div className="aic-run-comp-intel">
        <span className="aic-run-comp-intel__icon">🔍</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="aic-run-comp-intel__title">Run Comp Intelligence</div>
          <div className="aic-run-comp-intel__desc">Score comps in real-time against your ARV and match against active buyer price ranges.</div>
        </div>
        <button className="aic-cmd-btn is-offer" style={{ maxWidth: 100, fontSize: '0.60rem', padding: '7px 10px', flexShrink: 0 }}>Run Now</button>
      </div>
    </div>
  )
}

// ─── Deal Memory Timeline ─────────────────────────────────────────────────────

function HistoryTab({ runs, dealEvents }: { runs: MatchRun[]; dealEvents: DealMemoryEvent[] }) {
  const PLACEHOLDER_EVENTS = [
    { icon: '📊', label: 'Valuation Generated',    desc: 'ARV confirmed from comp analysis' },
    { icon: '🎯', label: 'Buyer Match Run',         desc: 'Demand score + matched buyers recorded' },
    { icon: '💰', label: 'Offer Generated',         desc: 'Suggested offer sent to underwriting' },
    { icon: '💬', label: 'Seller Reply Drafted',    desc: 'AI-drafted counter or follow-up' },
    { icon: '📎', label: 'Comp Included/Excluded',  desc: 'Comp analysis updated' },
    { icon: '🏦', label: 'Pushed to Underwriting',  desc: 'Full acquisition package sent' },
  ]

  const hasActivity = dealEvents.length > 0 || runs.length > 0

  if (!hasActivity) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="aic-history-header">
          <div className="aic-history-header__icon">⧖</div>
          <div>
            <div className="aic-history-header__title">Deal Memory — Waiting for First Intelligence Run</div>
            <div className="aic-history-header__desc">Events logged here will build a full audit trail for this property. Each action is timestamped and linked to a specific run.</div>
          </div>
        </div>

        <div className="aic-section-head" style={{ marginBottom: 4 }}>Upcoming Event Checklist</div>
        <div className="aic-deal-placeholder-timeline">
          {PLACEHOLDER_EVENTS.map((e, i) => (
            <div key={i} className="aic-deal-placeholder-item">
              <div className="aic-deal-placeholder-item__rail">
                <div className="aic-deal-placeholder-item__icon">{e.icon}</div>
                {i < PLACEHOLDER_EVENTS.length - 1 && <div className="aic-deal-placeholder-item__line" />}
              </div>
              <div className="aic-deal-placeholder-item__content">
                <div className="aic-deal-placeholder-item__label">{e.label}</div>
                <div className="aic-deal-placeholder-item__desc">{e.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Local deal memory events */}
      {dealEvents.length > 0 && (
        <div>
          <div className="aic-section-head" style={{ marginBottom: 6 }}>Deal Memory</div>
          <div className="aic-deal-event-list">
            <AnimatePresence>
              {dealEvents.map(ev => (
                <motion.div
                  key={ev.id}
                  className="aic-deal-event"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.18 }}
                >
                  <div className="aic-deal-event__icon">{ev.icon}</div>
                  <div className="aic-deal-event__body">
                    <div className="aic-deal-event__action">{ev.action}</div>
                    <div className="aic-deal-event__result">{ev.result}</div>
                    <div className="aic-deal-event__meta">{ev.source} · {fmtDate(ev.timestamp)}</div>
                  </div>
                  <div className="aic-deal-event__time">{fmtDaysAgo(ev.timestamp)}</div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}

      {/* Run history from DB */}
      {runs.length > 0 && (
        <div>
          <div className="aic-section-head" style={{ marginBottom: 6 }}>Run History</div>
          <div className="aic-run-list">
            {runs.map(r => (
              <div key={r.run_id} className="aic-run-item">
                <div className="aic-run-item__dot" />
                <div className="aic-run-item__info">
                  <div className="aic-run-item__date">{fmtDate(r.created_at)}</div>
                  <div className="aic-run-item__sub">{r.candidate_count} buyers · {r.high_fit_count} high-fit · Grade: {r.best_buyer_grade ?? '—'}</div>
                </div>
                {r.demand_score != null && <div className="aic-run-item__score">{r.demand_score}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Next Best Action Card ────────────────────────────────────────────────────

interface NextBestActionCardProps {
  hasData: boolean
  demandScore: number | null
  matchCount: number
  runMatch: () => void
  running: boolean
  setActiveTab: (t: DossierTab) => void
}

function NextBestActionCard({ hasData, demandScore, matchCount, runMatch, running, setActiveTab }: NextBestActionCardProps) {
  const isHighLiquidity = hasData && demandScore !== null && demandScore >= 70
  const isRiskAlert     = hasData && (demandScore === null || demandScore < 40)

  if (!hasData) {
    return (
      <motion.div
        className="aic-nba-card is-locked"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        <div className="aic-nba-card__top">
          <span className="aic-nba-card__tag">Priority Action</span>
          <span className="aic-nba-card__title">Run Buyer Match</span>
        </div>
        <div className="aic-nba-card__reason">Offer confidence is limited — buyer demand and liquidity are locked.</div>
        <div className="aic-nba-unlocks">
          <span className="aic-nba-unlocks__label">Unlocks</span>
          <div className="aic-nba-unlocks__chips">
            {['Exit range', 'Liquidity score', 'Buyer list', 'Institutional signals', 'Dispo timeline'].map(u => (
              <span key={u} className="aic-nba-unlock-chip">{u}</span>
            ))}
          </div>
        </div>
        <button className="aic-cmd-btn" onClick={runMatch} disabled={running}>
          {running ? '⟳ Scanning…' : '⚡ Run Buyer Match'}
        </button>
      </motion.div>
    )
  }

  if (isRiskAlert) {
    return (
      <motion.div
        className="aic-nba-card is-risk"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        <div className="aic-nba-card__top">
          <span className="aic-nba-card__tag is-warn">Review Required</span>
          <span className="aic-nba-card__title">Review Risk Before Offer</span>
        </div>
        <div className="aic-nba-card__reason">Buyer liquidity or condition confidence is weak — review risks before committing to an offer.</div>
        <button className="aic-cmd-btn" onClick={() => setActiveTab('risk')}>Open Risk Tab →</button>
      </motion.div>
    )
  }

  return (
    <motion.div
      className="aic-nba-card is-ready"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div className="aic-nba-card__top">
        <span className="aic-nba-card__tag is-go">Next Step</span>
        <span className="aic-nba-card__title">{isHighLiquidity ? 'Push to Underwriting' : 'Generate Offer'}</span>
      </div>
      <div className="aic-nba-card__reason">
        {isHighLiquidity
          ? `ARV and buyer demand support an actionable offer range. ${matchCount} buyers matched.`
          : `Buyer demand confirmed with ${matchCount} buyers. Ready for offer generation.`}
      </div>
      <button className="aic-cmd-btn is-offer" onClick={() => setActiveTab(isHighLiquidity ? 'offer' : 'offer')}>
        {isHighLiquidity ? 'Push to Underwriting' : 'Generate Offer →'}
      </button>
    </motion.div>
  )
}

// ─── Deal Command Dossier ────────────────────────────────────────────────────

interface DossierProps {
  activeTab: DossierTab
  setActiveTab: (t: DossierTab) => void
  propertySnapshot: PropertySnapshot
  demandScore: number | null
  matchCount: number
  candidateCount: number
  agents: AcquisitionAgent[]
  filteredCandidates: BuyerMatchCandidate[]
  selectedKey: string | null
  gradeFilter: GradeFilter
  typeFilter: TypeFilter
  gradeCounts: { aplus: number; a: number; b: number; other: number }
  loading: boolean
  running: boolean
  hasEntityGraph: boolean
  demandStats: { entity_count: number; match_count: number } | null
  setSelectedKey: React.Dispatch<React.SetStateAction<string | null>>
  setGradeFilter: React.Dispatch<React.SetStateAction<GradeFilter>>
  setTypeFilter: React.Dispatch<React.SetStateAction<TypeFilter>>
  runMatch: () => void
  sendPackage: (id: string | undefined) => void
  updateCandidateStatus: (id: string | undefined, updates: Record<string, unknown>) => void
  selectBuyer: (id: string | undefined) => void
  purchases: PurchaseEvent[]
  matchRuns: MatchRun[]
  intelState: IntelRunState
  dealEvents: DealMemoryEvent[]
  realComps: RealComp[]
}

function DealCommandDossier(props: DossierProps) {
  const { activeTab, setActiveTab } = props

  const completeCount = props.agents.filter(a => a.status === 'complete').length
  const readinessPct  = Math.round((completeCount / props.agents.length) * 100)
  const readinessCls  = readinessPct >= 70 ? 'is-high' : readinessPct >= 40 ? 'is-mid' : 'is-low'

  const readinessDrivers = [
    { label: 'ARV',        st: (props.propertySnapshot.arv || props.propertySnapshot.estimated_value) ? 'ready' : 'pending' },
    { label: 'Offer Draft', st: props.propertySnapshot.arv ? 'ready' : 'locked' },
    { label: 'Buyer Graph', st: props.matchCount > 0 ? 'ready' : 'locked' },
    { label: 'Inst. Scan',  st: props.matchCount > 0 ? 'ready' : 'locked' },
    { label: 'Liquidity',   st: props.demandScore !== null && props.demandScore >= 60 ? 'ready' : 'watch' },
    { label: 'Condition',   st: 'watch' },
  ] as { label: string; st: 'ready' | 'locked' | 'watch' | 'pending' }[]

  const tabs: { id: DossierTab; label: string; cls?: string; count?: number }[] = [
    { id: 'overview',  label: 'Overview' },
    { id: 'comps',     label: 'Comps' },
    { id: 'buyers',    label: 'Buyers', count: props.candidateCount },
    { id: 'offer',     label: 'Offer',  cls: 'is-offer' },
    { id: 'risk',      label: 'Risk',   cls: 'is-risk' },
    { id: 'history',   label: 'History' },
  ]

  return (
    <motion.div
      className="aic-dossier"
      initial={{ x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
    >
      {/* Header */}
      <div className="aic-dossier-head">
        <div className="aic-dossier-head-row">
          <span className="aic-dossier-title">Deal Command Dossier</span>
          <div className="aic-dossier-status-badges">
            <span className={`aic-dossier-status-dot${(props.propertySnapshot.arv || props.propertySnapshot.estimated_value) ? ' is-active' : ' is-idle'}`} title="Valuation" />
            <span className={`aic-dossier-status-dot${props.matchCount > 0 ? ' is-active' : ' is-idle'}`} title="Buyer Match" />
            <span className={`aic-dossier-status-dot${(props.propertySnapshot.arv || props.propertySnapshot.estimated_value) ? ' is-active' : ' is-idle'}`} title="Offer" />
          </div>
        </div>
        <div className="aic-dossier-addr-row">
          <span className="aic-dossier-addr">{props.propertySnapshot.address}</span>
          {props.demandScore !== null && (
            <span className="aic-dossier-score-pill">{props.demandScore}</span>
          )}
        </div>
      </div>

      {/* Readiness strip */}
      <div className="aic-dossier-readiness">
        <div className="aic-readiness-label">
          Deal Readiness&nbsp;<strong>{readinessPct}%</strong>
        </div>
        <div className="aic-readiness-bar-wrap">
          <div className={`aic-readiness-bar-fill ${readinessCls}`} style={{ width: `${readinessPct}%` }} />
        </div>
        <div className="aic-readiness-drivers">
          {readinessDrivers.map(d => (
            <span key={d.label} className={`aic-readiness-chip is-${d.st}`}>{d.label}</span>
          ))}
        </div>
      </div>

      {/* Status strip */}
      <div className="aic-dossier-strip">
        <div className="aic-dossier-strip-item">
          <span>ARV</span>
          <strong style={{ color: props.propertySnapshot.arv ? 'var(--aic-gold)' : 'var(--aic-text-faint)' }}>
            {fmt$(props.propertySnapshot.arv ?? props.propertySnapshot.estimated_value)}
          </strong>
        </div>
        <div className="aic-dossier-strip-sep" />
        <div className="aic-dossier-strip-item">
          <span>Offer</span>
          <strong style={{ color: 'var(--aic-gold)' }}>
            {(props.propertySnapshot.arv ?? props.propertySnapshot.estimated_value)
              ? fmt$(Math.round(((props.propertySnapshot.arv ?? props.propertySnapshot.estimated_value ?? 0) * 0.70)))
              : 'Locked'}
          </strong>
        </div>
        <div className="aic-dossier-strip-sep" />
        <div className="aic-dossier-strip-item">
          <span>Demand</span>
          <strong style={{ color: props.demandScore !== null && props.demandScore >= 70 ? 'var(--aic-green)' : props.demandScore !== null ? 'var(--aic-blue)' : 'var(--aic-text-faint)' }}>
            {props.demandScore !== null ? props.demandScore : 'Locked'}
          </strong>
        </div>
        <div className="aic-dossier-strip-sep" />
        <div className="aic-dossier-strip-item">
          <span>Buyers</span>
          <strong style={{ color: props.matchCount > 0 ? 'var(--aic-blue)' : 'var(--aic-text-faint)' }}>
            {props.matchCount > 0 ? props.matchCount : 'Locked'}
          </strong>
        </div>
      </div>

      {/* Tabs */}
      <div className="aic-dossier-tabs">
        {tabs.map(t => (
          <button
            key={t.id}
            className={`aic-dossier-tab${activeTab === t.id ? ' is-active' : ''}${t.cls ? ` ${t.cls}` : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
            {t.count != null && t.count > 0 && <span className="aic-dossier-tab-count">{t.count}</span>}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="aic-dossier-content">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16 }}
          >
            {activeTab === 'overview' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Next Best Action */}
                <NextBestActionCard
                  hasData={props.matchCount > 0}
                  demandScore={props.demandScore}
                  matchCount={props.matchCount}
                  runMatch={props.runMatch}
                  running={props.running}
                  setActiveTab={props.setActiveTab}
                />

                {/* Deal Readiness Meter */}
                <div className="aic-deal-readiness">
                  <div className="aic-deal-readiness__header">
                    <div className="aic-deal-readiness__title">Deal Readiness</div>
                    <div className="aic-deal-readiness__score">{readinessPct}%</div>
                  </div>
                  <div className="aic-deal-readiness__bar">
                    <div className={`aic-deal-readiness__fill ${readinessCls}`} style={{ width: `${readinessPct}%` }} />
                  </div>
                  <div className="aic-deal-readiness__drivers">
                    {[
                      { label: 'ARV',          st: (props.propertySnapshot.arv || props.propertySnapshot.estimated_value) ? 'ready' : 'pending' },
                      { label: 'Offer Draft',  st: props.propertySnapshot.arv ? 'ready' : 'locked' },
                      { label: 'Buyer Graph',  st: props.matchCount > 0 ? 'ready' : 'locked' },
                      { label: 'Inst. Scan',   st: props.matchCount > 0 ? 'ready' : 'locked' },
                      { label: 'Dispo Est.',   st: props.matchCount > 5 ? 'ready' : 'locked' },
                      { label: 'Liquidity',    st: props.demandScore !== null && props.demandScore >= 60 ? 'ready' : 'watch' },
                      { label: 'Condition',    st: 'watch' },
                    ].map(d => (
                      <span key={d.label} className={`aic-readiness-chip is-${d.st}`}>{d.label}</span>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="aic-section-head" style={{ marginBottom: 8 }}>AI Acquisition Agents</div>
                  <AcquisitionAgentRail agents={props.agents} />
                </div>
                <div>
                  <div className="aic-section-head" style={{ marginBottom: 8 }}>Key Metrics</div>
                  <KpiCards
                    propertySnapshot={props.propertySnapshot}
                    demandScore={props.demandScore}
                    matchCount={props.matchCount}
                    candidateCount={props.candidateCount}
                  />
                </div>
              </div>
            )}

            {activeTab === 'comps' && <CompsTab propertySnapshot={props.propertySnapshot} realComps={props.realComps} />}

            {activeTab === 'buyers' && (
              <BuyersTab
                filteredCandidates={props.filteredCandidates}
                selectedKey={props.selectedKey}
                gradeFilter={props.gradeFilter}
                typeFilter={props.typeFilter}
                gradeCounts={props.gradeCounts}
                loading={props.loading}
                running={props.running}
                hasEntityGraph={props.hasEntityGraph}
                demandStats={props.demandStats}
                setSelectedKey={props.setSelectedKey}
                setGradeFilter={props.setGradeFilter}
                setTypeFilter={props.setTypeFilter}
                runMatch={props.runMatch}
                sendPackage={props.sendPackage}
                updateCandidateStatus={props.updateCandidateStatus}
                selectBuyer={props.selectBuyer}
                purchases={props.purchases}
                demandScore={props.demandScore}
              />
            )}

            {activeTab === 'offer' && (
              <OfferWaterfall propertySnapshot={props.propertySnapshot} candidateCount={props.candidateCount} />
            )}

            {activeTab === 'risk' && (
              <RiskTab
                propertySnapshot={props.propertySnapshot}
                demandScore={props.demandScore}
                matchCount={props.matchCount}
              />
            )}

            {activeTab === 'history' && <HistoryTab runs={props.matchRuns} dealEvents={props.dealEvents} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

// ─── Inline Buyers (50% pane) ────────────────────────────────────────────────

function InlineBuyersPanel(props: BuyersTabProps & { title: string }) {
  return (
    <div className="aic-inline-buyers">
      <div className="aic-inline-toolbar">
        <span className="aic-buyer-toolbar__title">{props.title}</span>
        {props.filteredCandidates.length > 0 && <span className="aic-buyer-toolbar__count">{props.filteredCandidates.length}</span>}
        <div className="aic-buyer-toolbar__filters">
          {(['A+', 'A', 'B'] as GradeFilter[]).map(g => (
            <button key={g}
              className={`aic-filter-pill${g === 'A+' ? ' is-gold' : ''} ${props.gradeFilter === g ? 'is-active' : ''}`}
              onClick={() => props.setGradeFilter(f => f === g ? 'all' : g)}
            >{g}</button>
          ))}
          <button className={`aic-filter-pill is-purple ${props.typeFilter === 'corporate' ? 'is-active' : ''}`} onClick={() => props.setTypeFilter(f => f === 'corporate' ? 'all' : 'corporate')}>Corp</button>
          <button className={`aic-filter-pill ${props.typeFilter === 'repeat' ? 'is-active' : ''}`} onClick={() => props.setTypeFilter(f => f === 'repeat' ? 'all' : 'repeat')}>Repeat</button>
        </div>
      </div>
      <div className="aic-inline-buyer-list">
        {props.loading && [1,2,3].map(i => (
          <div key={i} className="aic-skel-card">
            <div style={{ display: 'flex', gap: 10 }}>
              <div className="aic-skel" style={{ width: 36, height: 36, borderRadius: 11 }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="aic-skel" style={{ height: 12, width: '50%' }} />
                <div className="aic-skel" style={{ height: 9, width: '32%' }} />
              </div>
            </div>
          </div>
        ))}
        {!props.loading && !props.hasEntityGraph && props.filteredCandidates.length === 0 && (
          <div className="aic-empty">
            <div className="aic-empty__icon">🏗</div>
            <div className="aic-empty__title">No Buyer Data</div>
            <div className="aic-empty__desc">Run buyer match to populate this view.</div>
          </div>
        )}
        <AnimatePresence>
          {props.filteredCandidates.map(c => (
            <AcqBuyerCard
              key={c.buyer_key}
              candidate={c}
              isSelected={props.selectedKey === c.buyer_key}
              onSelect={() => props.setSelectedKey(k => k === c.buyer_key ? null : c.buyer_key)}
              onSendPackage={() => props.sendPackage(c.buyer_match_candidate_id)}
              onMarkInterested={() => props.updateCandidateStatus(c.buyer_match_candidate_id, { buyer_response_status: 'interested' })}
              onMarkPassed={() => props.updateCandidateStatus(c.buyer_match_candidate_id, { buyer_response_status: 'passed' })}
            />
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}

// ─── Property Intel Sidebar ──────────────────────────────────────────────────

interface SidebarProps {
  propertySnapshot: PropertySnapshot
  running: boolean
  hasData: boolean
  demandScore: number | null
  entityCount: number
  matchCount: number
  candidates: BuyerMatchCandidate[]
  runMatch: () => void
  setActiveTab: (t: DossierTab) => void
  paneWidth: '25' | '50' | '75' | '100'
  latestRun: MatchRun | null
  demandRollup?: BuyerDemandRollup | null
  noDataReason?: string[] | null
}

function PropertyIntelSidebar({ propertySnapshot: ps, running, hasData, demandScore, entityCount, matchCount, candidates, runMatch, setActiveTab, paneWidth, latestRun, demandRollup, noDataReason }: SidebarProps) {
  const isCompact = paneWidth === '25'

  return (
    <aside className="aic-sidebar">
      <div className="aic-sidebar-inner">
        <div className="aic-blade-label">Property</div>

        <div className="aic-property-card">
          <div>
            <div className="aic-prop-address">{ps.address || 'Property Address Unknown'}</div>
            <div className="aic-prop-sub">{[ps.market, ps.state].filter(Boolean).join(' · ') || 'Market Unknown'}</div>
          </div>

          <div className="aic-badge-row">
            {ps.market && <span className="aic-badge is-market">{ps.market}</span>}
            {ps.property_type && <span className="aic-badge is-type">{ps.property_type}</span>}
            {ps.zip && <span className="aic-badge is-zip">{ps.zip}</span>}
            {ps.dispo_strategy && <span className="aic-badge is-strategy">{ps.dispo_strategy}</span>}
          </div>

          <div className="aic-blade-label" style={{ margin: '4px 0 0' }}>Price</div>

          <div className="aic-prop-stats">
            <div className="aic-prop-stat">
              <span className="aic-prop-stat__label">Est. Value</span>
              <span className={`aic-prop-stat__value ${ps.estimated_value ? 'is-blue' : ''}`}>{ps.estimated_value ? fmt$(ps.estimated_value) : 'Pending'}</span>
            </div>
            <div className="aic-prop-stat">
              <span className="aic-prop-stat__label">ARV</span>
              <span className={`aic-prop-stat__value ${ps.arv ? 'is-amber' : ''}`}>{ps.arv ? fmt$(ps.arv) : 'Pending'}</span>
            </div>
            <div className="aic-prop-stat">
              <span className="aic-prop-stat__label">Seller Ask</span>
              <span className="aic-prop-stat__value">{ps.purchase_price ? fmt$(ps.purchase_price) : 'Unknown'}</span>
            </div>
            <div className="aic-prop-stat">
              <span className="aic-prop-stat__label">Spread</span>
              <span className={`aic-prop-stat__value ${ps.potential_spread ? 'is-green' : ''}`}>{ps.potential_spread ? fmt$(ps.potential_spread) : 'Pending'}</span>
            </div>
            {!isCompact && (
              <>
                <div className="aic-prop-stat">
                  <span className="aic-prop-stat__label">Specs</span>
                  <span className="aic-prop-stat__value" style={{ fontSize: '0.74rem' }}>
                    {[ps.beds != null ? `${ps.beds}bd` : null, ps.baths != null ? `${ps.baths}ba` : null, ps.sqft ? `${fmtNum(ps.sqft)}sf` : null].filter(Boolean).join(' / ') || '—'}
                  </span>
                </div>
                <div className="aic-prop-stat">
                  <span className="aic-prop-stat__label">ZIP</span>
                  <span className="aic-prop-stat__value">{ps.zip || '—'}</span>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="aic-blade-label">Demand</div>

        <BuyerDemandPulseCard
          score={demandScore}
          entityCount={entityCount}
          matchCount={matchCount}
          running={running}
          hasData={hasData}
          candidates={candidates}
          rollup={demandRollup}
          noDataReason={noDataReason}
        />

        <div className="aic-blade-label">Command</div>

        <div className="aic-cmd-btns">
          <button
            className={`aic-cmd-btn${running ? ' is-running' : ''}`}
            disabled={running || !ps.property_id}
            onClick={runMatch}
          >
            {running ? <><span style={{ animation: 'aic-pulse 1s linear infinite', display: 'inline-block' }}>⟳</span> Scanning…</>
              : hasData ? <><Icon name="refresh-cw" size={13} /> Rerun Match</>
              : <><Icon name="zap" size={13} /> Run Buyer Match</>}
          </button>

          <button
            className="aic-cmd-btn is-offer"
            onClick={() => setActiveTab('offer')}
          >
            <Icon name="dollar-sign" size={13} /> Generate Offer
          </button>
        </div>

        {latestRun && (
          <div style={{ fontSize: '0.60rem', color: 'var(--aic-text-faint)', textAlign: 'center' }}>
            Last run: {fmtDaysAgo(latestRun.created_at)}
          </div>
        )}
      </div>
    </aside>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function BuyerMatchWorkspace({
  propertySnapshot,
  dealContext = null,
  isOutsideFilter = false,
  onClearFilters,
  onPinSelected,
  paneWidth = '100',
  paused = false,
}: BuyerMatchWorkspaceProps) {
  const [candidates, setCandidates]       = useState<BuyerMatchCandidate[]>([])
  const [purchases, setPurchases]         = useState<PurchaseEvent[]>([])
  const [latestRun, setLatestRun]         = useState<MatchRun | null>(null)
  const [matchRuns, setMatchRuns]         = useState<MatchRun[]>([])
  const [selectedKey, setSelectedKey]     = useState<string | null>(null)
  const [gradeFilter, setGradeFilter]     = useState<GradeFilter>('all')
  const [typeFilter, setTypeFilter]       = useState<TypeFilter>('all')
  const [loading, setLoading]             = useState(false)
  const [running, setRunning]             = useState(false)
  const [demandStats, setDemandStats]     = useState<{ entity_count: number; match_count: number } | null>(null)
  const [demandRollup, setDemandRollup]   = useState<BuyerDemandRollup | null>(null)
  const [realComps, setRealComps]         = useState<RealComp[]>([])
  const [activeTab, setActiveTab]         = useState<DossierTab>('overview')
  const [intelState, setIntelState]       = useState<IntelRunState>({
    buyer_match_status: 'idle',
    comp_intel_status:  'idle',
    offer_status:       'draft',
    active_run_step:    null,
    last_run_at:        null,
  })
  const [dealEvents, setDealEvents]       = useState<DealMemoryEvent[]>([])
  const [debugData, setDebugData]         = useState<DebugData | null>(null)
  const [noDataReason, setNoDataReason]   = useState<string[] | null>(null)

  const { property_id, address, market, zip, state, county, property_type, asset_class, estimated_value } = propertySnapshot

  const lat = dealContext?.latitude || null
  const lng = dealContext?.longitude || null

  const addDealEvent = useCallback((icon: string, action: string, result: string, source: string) => {
    setDealEvents(prev => [makeDealEvent(icon, action, result, source), ...prev])
  }, [])

  // Load initial data: run history, entity count, demand rollup, comps
  useEffect(() => {
    if (!property_id) return
    if (paused) return
    let active = true

    const load = async () => {
      try {
        const supabase = getSupabaseClient()
        const resolvedMarket = dealContext?.market || market
        const resolvedZip    = zip
        const resolvedState  = state || dealContext?.propertyState || ''
        const resolvedAsset  = asset_class || property_type || ''

        // ── 1. Run history ───────────────────────────────────────────────────
        const { data: runs } = await supabase.from('buyer_match_runs')
          .select('*')
          .eq('property_id', property_id)
          .order('created_at', { ascending: false })
          .limit(10)

        // ── 2. Entity count in market ────────────────────────────────────────
        let entity_count = 0
        if (resolvedMarket && resolvedMarket !== 'Market Unknown') {
          const { count } = await supabase.from('buyer_entities_v2')
            .select('*', { count: 'exact', head: true })
            .contains('markets_active', [resolvedMarket])
          entity_count = count ?? 0
        }
        if (entity_count === 0) {
          const { count } = await supabase.from('buyer_entities_v2')
            .select('*', { count: 'exact', head: true })
          entity_count = count ?? 0
        }

        // ── 3. Buyer demand rollup (progressive fallback) ────────────────────
        let rollup: BuyerDemandRollup | null = null
        let fallbackLevel: BuyerDemandRollup['fallback_level'] = 'none'
        let rollupRows = 0

        // Helper: compute rollup from raw events
        const computeRollup = (events: any[], level: BuyerDemandRollup['fallback_level']): BuyerDemandRollup => {
          const prices = events.map(e => e.purchase_price).filter((p): p is number => typeof p === 'number' && p > 0)
          const sorted = [...prices].sort((a, b) => a - b)
          const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
          const uniqueBuyers = new Set(events.map(e => e.buyer_key || e.buyer_entity_id).filter(Boolean))
          const corpCount = events.filter(e => e.is_corporate_buyer || e.buyer_type === 'corporate').length
          const repeatSet = new Set<string>()
          const keyCount: Record<string, number> = {}
          for (const e of events) {
            const k = e.buyer_key || e.buyer_entity_id
            if (!k) continue
            keyCount[k] = (keyCount[k] || 0) + 1
            if (keyCount[k] > 1) repeatSet.add(k)
          }
          const instCount = events.filter(e => e.buyer_type === 'institutional' || (e.purchase_count_all ?? 0) >= 25).length
          const avgPrice = prices.length ? Math.round(prices.reduce((s, p) => s + p, 0) / prices.length) : null
          const maxPrice = prices.length ? Math.max(...prices) : null
          const heat = Math.min(100, Math.round((uniqueBuyers.size / 10) * 40 + (prices.length / 50) * 60))
          const liquidity = Math.min(100, Math.round((uniqueBuyers.size / 5) * 50 + (corpCount / Math.max(1, events.length)) * 50))
          const dominant = instCount > 0 ? 'Institutional' : corpCount > repeatSet.size ? 'Corporate' : repeatSet.size > 0 ? 'Repeat Investor' : 'Individual'
          return {
            purchase_count: events.length, buyer_count: uniqueBuyers.size,
            corporate_buyer_count: corpCount, repeat_buyer_count: repeatSet.size,
            institutional_buyer_count: instCount,
            avg_purchase_price: avgPrice, median_purchase_price: median, max_purchase_price: maxPrice,
            liquidity_score: liquidity, buyer_heat_score: heat,
            dominant_buyer_type: dominant,
            top_buyer_keys: Array.from(uniqueBuyers).slice(0, 10) as string[],
            source: 'computed', fallback_level: level,
          }
        }

        const fallbacks: Array<{ label: BuyerDemandRollup['fallback_level']; build: () => Promise<any[]> }> = [
          { label: 'zip_asset', build: async () => {
            if (!resolvedZip || !resolvedAsset) return []
            const { data } = await supabase.from('buyer_purchase_events_v2')
              .select('buyer_key,buyer_entity_id,purchase_price,sale_date,property_type,normalized_asset_class,is_corporate_buyer,buyer_type')
              .eq('property_address_zip', resolvedZip)
              .not('purchase_price', 'is', null)
              .limit(500)
            return data ?? []
          }},
          { label: 'zip', build: async () => {
            if (!resolvedZip) return []
            const { data } = await supabase.from('buyer_purchase_events_v2')
              .select('buyer_key,buyer_entity_id,purchase_price,sale_date,property_type,is_corporate_buyer,buyer_type')
              .eq('property_address_zip', resolvedZip)
              .not('purchase_price', 'is', null)
              .limit(500)
            return data ?? []
          }},
          { label: 'market_asset', build: async () => {
            if (!resolvedMarket || resolvedMarket === 'Market Unknown') return []
            const { data } = await supabase.from('buyer_purchase_events_v2')
              .select('buyer_key,buyer_entity_id,purchase_price,sale_date,property_type,is_corporate_buyer,buyer_type')
              .eq('market', resolvedMarket)
              .not('purchase_price', 'is', null)
              .limit(500)
            return data ?? []
          }},
          { label: 'market', build: async () => {
            if (!resolvedMarket || resolvedMarket === 'Market Unknown') return []
            const { data } = await supabase.from('buyer_purchase_events_v2')
              .select('buyer_key,buyer_entity_id,purchase_price,sale_date,is_corporate_buyer,buyer_type')
              .eq('market', resolvedMarket)
              .not('purchase_price', 'is', null)
              .limit(500)
            return data ?? []
          }},
          { label: 'state_asset', build: async () => {
            if (!resolvedState) return []
            const { data } = await supabase.from('buyer_purchase_events_v2')
              .select('buyer_key,buyer_entity_id,purchase_price,sale_date,is_corporate_buyer,buyer_type')
              .eq('property_address_state', resolvedState)
              .not('purchase_price', 'is', null)
              .limit(300)
            return data ?? []
          }},
        ]

        for (const fb of fallbacks) {
          const events = await fb.build()
          rollupRows += events.length
          if (events.length > 0) {
            rollup = computeRollup(events, fb.label)
            fallbackLevel = fb.label
            break
          }
        }

        // ── 4. Real comps from recently_sold_properties ──────────────────────
        let comps: RealComp[] = []
        let compRows = 0
        if (resolvedZip) {
          const { data: compData } = await supabase.from('recently_sold_properties')
            .select('*')
            .eq('property_address_zip', resolvedZip)
            .not('sale_price', 'is', null)
            .order('sale_date', { ascending: false })
            .limit(20)
          if (compData && compData.length > 0) {
            compRows = compData.length
            comps = compData.map((c: any) => ({
              id: c.id || c.property_id || String(Math.random()),
              address: c.property_address_full || c.address || 'Unknown',
              city: c.property_city || c.city,
              state: c.property_address_state || c.state,
              zip: c.property_address_zip || c.zip,
              sold_price: c.sale_price ?? c.sold_price ?? c.purchase_price,
              sold_date: c.sale_date ?? c.sold_date,
              beds: c.total_bedrooms ?? c.beds,
              baths: c.total_baths ?? c.baths,
              sqft: c.building_square_feet ?? c.sqft,
              ppsf: (c.sale_price && c.building_square_feet) ? Math.round(c.sale_price / c.building_square_feet) : c.ppsf,
              latitude: c.latitude,
              longitude: c.longitude,
              property_type: c.property_type,
              source_type: 'RECENTLY_SOLD' as const,
            }))
          } else if (resolvedMarket && resolvedMarket !== 'Market Unknown') {
            const { data: mktComps } = await supabase.from('recently_sold_properties')
              .select('*')
              .eq('market', resolvedMarket)
              .not('sale_price', 'is', null)
              .order('sale_date', { ascending: false })
              .limit(20)
            if (mktComps && mktComps.length > 0) {
              compRows = mktComps.length
              comps = mktComps.map((c: any) => ({
                id: c.id || c.property_id || String(Math.random()),
                address: c.property_address_full || c.address || 'Unknown',
                city: c.property_city, state: c.property_address_state,
                zip: c.property_address_zip,
                sold_price: c.sale_price ?? c.sold_price,
                sold_date: c.sale_date ?? c.sold_date,
                beds: c.total_bedrooms ?? c.beds, baths: c.total_baths ?? c.baths,
                sqft: c.building_square_feet ?? c.sqft,
                ppsf: (c.sale_price && c.building_square_feet) ? Math.round(c.sale_price / c.building_square_feet) : undefined,
                property_type: c.property_type,
                source_type: 'RECENTLY_SOLD' as const,
              }))
            }
          }
        }
        // Also pull from buyer purchase events as additional comps
        if (comps.length < 5 && resolvedZip) {
          const { data: evComps } = await supabase.from('buyer_purchase_events_v2')
            .select('property_address_full,property_city,property_address_state,property_address_zip,purchase_price,sale_date,sqft,property_type,latitude,longitude')
            .eq('property_address_zip', resolvedZip)
            .not('purchase_price', 'is', null)
            .order('sale_date', { ascending: false })
            .limit(20)
          if (evComps && evComps.length > 0) {
            const evMapped: RealComp[] = evComps.map((c: any) => ({
              id: String(Math.random()),
              address: c.property_address_full || 'Unknown',
              city: c.property_city, state: c.property_address_state,
              zip: c.property_address_zip,
              sold_price: c.purchase_price,
              sold_date: c.sale_date,
              beds: c.beds, baths: c.baths,
              sqft: c.sqft,
              ppsf: (c.purchase_price && c.sqft) ? Math.round(c.purchase_price / c.sqft) : undefined,
              latitude: c.latitude, longitude: c.longitude,
              property_type: c.property_type,
              source_type: 'BUYER_PURCHASE' as const,
            }))
            comps = [...comps, ...evMapped].slice(0, 20)
            compRows += evMapped.length
          }
        }

        // ── Real intelligence: rollup + comps + demand via /api/intel/buyer-match
        //    (persist:false — a passive load must not create a run). This supersedes
        //    the legacy client-side rollup/comp computation above.
        let fallbackFromEngine = 'none'
        let liquidityFromEngine: number | null = null
        let demandFromEngine: number | null = null
        try {
          const ed: any = await callBackend<any>('/api/intel/buyer-match', {
            method: 'POST',
            body: JSON.stringify({
              persist: false,
              subject: {
                property_id, address,
                lat: dealContext?.latitude ?? null,
                lng: dealContext?.longitude ?? null,
                zip: resolvedZip || null,
                market: resolvedMarket || null,
                state: resolvedState || null,
                county: county || null,
                asset_class: resolvedAsset || null,
                property_type: property_type || null,
                estimated_value: estimated_value || null,
              },
            }),
          })
          const r = ed?.buyer_rollup
          if (r) {
            rollup = {
              purchase_count: r.purchase_count ?? 0,
              buyer_count: r.buyer_count ?? 0,
              corporate_buyer_count: r.corporate_buyer_count ?? 0,
              repeat_buyer_count: r.repeat_buyer_count ?? 0,
              institutional_buyer_count: r.corporate_buyer_count ?? 0,
              avg_purchase_price: r.avg_purchase_price ?? null,
              median_purchase_price: r.median_purchase_price ?? null,
              max_purchase_price: r.max_purchase_price ?? null,
              liquidity_score: r.liquidity_score ?? null,
              buyer_heat_score: r.buyer_heat_score ?? null,
              dominant_buyer_type: r.dominant_buyer_type ?? 'Unknown',
              top_buyer_keys: Array.isArray(r.top_buyers) ? r.top_buyers.map((t: any) => t.buyer_key).filter(Boolean).slice(0, 10) : [],
              source: 'geo_rollup',
              fallback_level: (ed?.fallback_level ?? 'none') as BuyerDemandRollup['fallback_level'],
            }
            fallbackLevel = (ed?.fallback_level ?? 'none') as BuyerDemandRollup['fallback_level']
            rollupRows = r.purchase_count ?? 0
          }
          if (Array.isArray(ed?.comps) && ed.comps.length > 0) {
            comps = ed.comps as RealComp[]
            compRows = ed.comps.length
          }
          fallbackFromEngine = ed?.fallback_level ?? 'none'
          liquidityFromEngine = ed?.liquidity_score ?? null
          demandFromEngine = ed?.demand_score ?? null
        } catch (e) {
          if (IS_DEV) console.warn('[BuyerMatchWorkspace] engine prefetch failed:', e)
        }

        if (!active) return

        const runsList: MatchRun[] = (runs ?? []).map((r: any) => ({
          run_id: r.buyer_match_run_id ?? r.run_id,
          property_id: r.property_id,
          status: r.run_status ?? r.status ?? 'complete',
          candidate_count: r.buyer_count ?? r.candidate_count ?? 0,
          high_fit_count: r.high_fit_count ?? 0,
          demand_score: r.demand_score ?? null,
          best_buyer_grade: r.best_buyer_grade ?? null,
          created_at: r.created_at,
        }))
        setMatchRuns(runsList)
        setLatestRun(runsList[0] ?? null)
        setDemandStats({ entity_count, match_count: runsList[0]?.candidate_count ?? 0 })
        if (rollup) setDemandRollup(rollup)
        if (comps.length > 0) setRealComps(comps)

        if (runsList.length === 0 && !rollup) {
          setNoDataReason([
            `zip: ${resolvedZip || '(empty)'}`,
            `market: ${resolvedMarket || '(empty)'}`,
            `state: ${resolvedState || '(empty)'}`,
            `asset_class: ${resolvedAsset || '(empty)'}`,
          ])
        }

        const dbg: DebugData = {
          property_id, address, zip: resolvedZip, market: resolvedMarket,
          county: county || '', asset_class: resolvedAsset,
          lat: dealContext?.latitude || null, lng: dealContext?.longitude || null,
          demand_rollup_rows: rollupRows, demand_source: rollup ? `${rollup.source}/${fallbackLevel}` : 'none',
          comp_rows: compRows, buyer_match_candidate_rows: 0,
          valuation_snapshot: false, match_run_rows: runsList.length, entity_count,
          fallback_level: fallbackFromEngine,
          liquidity_score: liquidityFromEngine,
          demand_score: demandFromEngine,
        }
        setDebugData(dbg)

        if (IS_DEV) {
          console.groupCollapsed('[BuyerMatchWorkspace:data] Initial load')
          console.log('property_id:', property_id)
          console.log('address:', address)
          console.log('zip:', resolvedZip, '| market:', resolvedMarket, '| state:', resolvedState)
          console.log('asset_class:', resolvedAsset)
          console.log('lat/lng:', dealContext?.latitude, dealContext?.longitude)
          console.log('match_run_rows:', runsList.length)
          console.log('entity_count:', entity_count)
          console.log('demand_rollup:', rollup ? `${rollup.purchase_count} events via ${fallbackLevel}` : 'none')
          console.log('comp_rows:', compRows)
          console.groupEnd()
        }
      } catch (err) {
        console.warn('[BuyerMatchWorkspace] initial load error:', err)
      }
    }

    void load()
    return () => { active = false }
  }, [property_id, paused, dealContext?.market, dealContext?.latitude, dealContext?.longitude, market, zip, state, county, asset_class, property_type, address])

  // Load candidates from last run (uses API route — service role, correct schema)
  useEffect(() => {
    if (!latestRun?.run_id || !property_id || paused) return
    let active = true
    const load = async () => {
      try {
        // Prefer the API route (uses service role + correct column names)
        const res = await callBackend<{ candidates: any[]; total: number; run_id: string }>(
          `/api/cockpit/buyer-match/property/${property_id}/candidates`
        )
        if (!active) return
        if (res.ok && res.data.candidates.length > 0) {
          // Merge candidate + buyer entity fields into flat object
          const merged = res.data.candidates.map((c: any) => ({
            ...c.buyer_entities_v2,
            ...c,
            buyer_match_candidate_id: c.id || c.buyer_match_candidate_id,
          }))
          setCandidates(merged)
          setDebugData(prev => prev ? { ...prev, buyer_match_candidate_rows: merged.length } : prev)
          if (IS_DEV) console.log('[BuyerMatchWorkspace] candidates loaded via API:', merged.length)
          return
        }
        // Fallback: direct Supabase with correct column name
        const supabase = getSupabaseClient()
        const { data } = await supabase.from('buyer_match_candidates')
          .select('*, buyer_entities_v2(*)')
          .eq('run_id', latestRun.run_id)
          .order('total_match_score', { ascending: false })
          .limit(150)
        if (!active || !data) return
        const merged = data.map((c: any) => ({ ...c.buyer_entities_v2, ...c, buyer_match_candidate_id: c.id || c.buyer_match_candidate_id }))
        setCandidates(merged)
        setDebugData(prev => prev ? { ...prev, buyer_match_candidate_rows: merged.length } : prev)
        if (IS_DEV) console.log('[BuyerMatchWorkspace] candidates loaded via Supabase fallback:', merged.length)
      } catch (err) {
        console.warn('[BuyerMatchWorkspace] candidates load error:', err)
      }
    }
    void load()
    return () => { active = false }
  }, [latestRun?.run_id, property_id, paused])

  // Load purchase trail for selected buyer
  useEffect(() => {
    setPurchases([])
    const sel = candidates.find(c => c.buyer_key === selectedKey)
    if (!sel?.buyer_entity_id || paused) return
    let active = true
    const load = async () => {
      try {
        const supabase = getSupabaseClient()
        const { data } = await supabase.from('buyer_purchase_events_v2')
          .select('*')
          .eq('buyer_entity_id', sel.buyer_entity_id)
          .order('purchase_date', { ascending: false })
          .limit(20)
        if (!active || !data) return
        setPurchases(data)
      } catch (err) {
        console.warn(err)
      }
    }
    void load()
    return () => { active = false }
  }, [selectedKey, candidates, paused])

  const BUYER_MATCH_STEPS = [
    'Initializing buyer graph',
    'Scanning zip demand',
    'Matching asset type',
    'Detecting repeat buyers',
    'Detecting corporate buyers',
    'Detecting institutional signals',
    'Calculating liquidity score',
    'Generating exit range',
  ]

  const runMatch = useCallback(async () => {
    if (!property_id || running) return
    setRunning(true)
    setLoading(true)
    setCandidates([])
    setNoDataReason(null)
    setIntelState(s => ({ ...s, buyer_match_status: 'scanning', active_run_step: BUYER_MATCH_STEPS[0] }))
    emitHook('buyer_match_started', { property_id })
    addDealEvent('🎯', 'Buyer Match Started', `Scanning ${demandStats?.entity_count ?? 0} buyer entities`, 'Buyer Match Agent')

    let stepIdx = 0
    const stepTimer = setInterval(() => {
      stepIdx = Math.min(stepIdx + 1, BUYER_MATCH_STEPS.length - 1)
      const step = BUYER_MATCH_STEPS[stepIdx]
      setIntelState(s => ({ ...s, active_run_step: step }))
      emitHook('buyer_match_step_changed', { step, index: stepIdx })
    }, 700)

    try {
      // Use API route (service role, correct DB column names, auth handled by callBackend)
      const apiResult = await callBackend<{ run_id: string; buyer_count: number; high_fit_count: number; candidates: any[] }>(
        `/api/cockpit/buyer-match/property/${property_id}/run`,
        {
          method: 'POST',
          body: JSON.stringify({
            address,
            lat: dealContext?.latitude ?? null,
            lng: dealContext?.longitude ?? null,
            market: market || null,
            zip: zip || null,
            state: state || null,
            county: county || null,
            asset_class: asset_class || property_type || null,
            property_type: property_type || null,
            estimated_value: estimated_value || null,
            limit: 25,
          }),
        }
      )
      clearInterval(stepTimer)

      if (!apiResult.ok) throw new Error(apiResult.message || 'run_failed')

      const { run_id, buyer_count, candidates: candidatesList } = apiResult.data
      const resolvedCandidates = candidatesList || []
      const apiData: any = apiResult.data
      const topScores = resolvedCandidates.slice(0, 20).map((c: any) => c.total_match_score ?? 0)
      const computedDemandScore = apiData.demand_score ?? (topScores.length
        ? Math.round(topScores.reduce((s: number, v: number) => s + v, 0) / topScores.length)
        : null)

      // Hydrate demand rollup, comps, and debug pill from the engine response
      if (apiData.buyer_rollup) {
        const r = apiData.buyer_rollup
        setDemandRollup({
          purchase_count: r.purchase_count ?? 0,
          buyer_count: r.buyer_count ?? 0,
          corporate_buyer_count: r.corporate_buyer_count ?? 0,
          repeat_buyer_count: r.repeat_buyer_count ?? 0,
          institutional_buyer_count: r.corporate_buyer_count ?? 0,
          avg_purchase_price: r.avg_purchase_price ?? null,
          median_purchase_price: r.median_purchase_price ?? null,
          max_purchase_price: r.max_purchase_price ?? null,
          liquidity_score: r.liquidity_score ?? null,
          buyer_heat_score: r.buyer_heat_score ?? null,
          dominant_buyer_type: r.dominant_buyer_type ?? 'Unknown',
          top_buyer_keys: Array.isArray(r.top_buyers) ? r.top_buyers.map((t: any) => t.buyer_key).filter(Boolean).slice(0, 10) : [],
          source: 'geo_rollup',
          fallback_level: (apiData.fallback_level ?? 'none') as BuyerDemandRollup['fallback_level'],
        })
      }
      if (Array.isArray(apiData.comps) && apiData.comps.length > 0) setRealComps(apiData.comps as RealComp[])
      setDebugData(prev => prev ? {
        ...prev,
        buyer_match_candidate_rows: resolvedCandidates.length,
        fallback_level: apiData.fallback_level ?? prev.fallback_level,
        liquidity_score: apiData.liquidity_score ?? prev.liquidity_score,
        demand_score: computedDemandScore,
        demand_source: apiData.buyer_rollup ? `geo_rollup/${apiData.fallback_level ?? 'none'}` : prev.demand_source,
        demand_rollup_rows: apiData.buyer_rollup?.purchase_count ?? prev.demand_rollup_rows,
      } : prev)

      // Build a synthetic MatchRun from the response so the UI can show run history
      const syntheticRun: MatchRun = {
        run_id,
        property_id: property_id!,
        status: 'complete',
        candidate_count: buyer_count,
        high_fit_count: resolvedCandidates.filter((c: any) => c.match_grade === 'A+' || c.match_grade === 'A').length,
        demand_score: computedDemandScore,
        best_buyer_grade: resolvedCandidates[0]?.match_grade ?? null,
        created_at: new Date().toISOString(),
      }

      setLatestRun(syntheticRun)
      setMatchRuns(prev => [syntheticRun, ...prev])
      setCandidates(resolvedCandidates)
      setDemandStats(prev => ({ entity_count: prev?.entity_count ?? 0, match_count: buyer_count }))
      setDebugData(prev => prev ? { ...prev, buyer_match_candidate_rows: resolvedCandidates.length } : prev)

      const now = new Date().toISOString()
      setIntelState(s => ({ ...s, buyer_match_status: resolvedCandidates.length > 0 ? 'complete' : 'failed', active_run_step: null, last_run_at: now }))

      if (resolvedCandidates.length === 0) {
        setNoDataReason([
          'No buyers matched from get_buyer_match_candidates RPC',
          `zip: ${zip || '(empty)'}`,
          `market: ${market || '(empty)'}`,
          `state: ${state || '(empty)'}`,
          `asset_class: ${asset_class || property_type || '(empty)'}`,
          'Suggested: expand asset class filter or run market-level search',
        ])
        addDealEvent('⚠️', 'Buyer Match Low Data', 'RPC returned 0 candidates — check filters', 'Buyer Match Agent')
      } else {
        addDealEvent('✅', 'Buyer Match Completed', `${resolvedCandidates.length} buyers matched · demand score ${computedDemandScore ?? '—'}`, 'Buyer Match Agent')
      }

      emitHook('buyer_match_completed', { property_id, count: resolvedCandidates.length, demand_score: computedDemandScore })

      if (IS_DEV) {
        console.groupCollapsed('[BuyerMatchWorkspace:runMatch:complete]')
        console.log('run_id:', run_id)
        console.log('matched_buyers:', resolvedCandidates.length)
        console.log('demand_score:', computedDemandScore)
        console.log('top_buyers:', resolvedCandidates.slice(0, 5).map((c: any) => ({ name: c.buyer_name, grade: c.match_grade, score: c.total_match_score })))
        console.log('params used: zip=%s market=%s state=%s county=%s asset=%s', zip, market, state, county, asset_class || property_type)
        console.groupEnd()
      }
    } catch (err) {
      clearInterval(stepTimer)
      console.warn('[BuyerMatchWorkspace] runMatch error:', err)
      setIntelState(s => ({ ...s, buyer_match_status: 'failed', active_run_step: null }))
      setNoDataReason([`Error: ${String(err)}`, `zip: ${zip || '(empty)'}`, `market: ${market || '(empty)'}`])
      addDealEvent('❌', 'Buyer Match Failed', String(err), 'Buyer Match Agent')
      emitHook('buyer_match_failed', { property_id, error: String(err) })
    } finally {
      setRunning(false)
      setLoading(false)
    }
  }, [property_id, market, zip, state, county, asset_class, property_type, estimated_value, running, demandStats?.entity_count, addDealEvent])

  const updateCandidateStatus = useCallback(async (id: string | undefined, updates: Record<string, unknown>) => {
    if (!id) return
    const res = await callBackend(`/api/cockpit/buyer-match/candidates/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    })
    if (res.ok) setCandidates(prev => prev.map(c => c.buyer_match_candidate_id === id ? { ...c, ...updates } : c))
  }, [])

  const sendPackage = useCallback(async (id: string | undefined) => {
    if (!id) return
    const package_sent_at = new Date().toISOString()
    const res = await callBackend(`/api/cockpit/buyer-match/candidates/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ package_sent_at, buyer_response_status: 'package_sent' })
    })
    if (res.ok) setCandidates(prev => prev.map(c => c.buyer_match_candidate_id === id ? { ...c, package_sent_at, buyer_response_status: 'package_sent' } : c))
  }, [])

  const selectBuyer = useCallback(async (id: string | undefined) => {
    if (!id) return
    const res = await callBackend(`/api/cockpit/buyer-match/candidates/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ selected: true })
    })
    if (res.ok) setCandidates(prev => prev.map(c => c.buyer_match_candidate_id === id ? { ...c, selected: true } : c))
  }, [])

  const filteredCandidates = useMemo(() => {
    return candidates.filter(c => {
      if (gradeFilter !== 'all' && c.match_grade !== gradeFilter) return false
      if (typeFilter === 'corporate' && !c.is_corporate_buyer) return false
      if (typeFilter === 'repeat' && !c.is_repeat_buyer) return false
      if (typeFilter === 'institutional' && c.buyer_type !== 'institutional') return false
      return true
    })
  }, [candidates, gradeFilter, typeFilter])

  const gradeCounts = useMemo(() => ({
    aplus: candidates.filter(c => c.match_grade === 'A+').length,
    a:     candidates.filter(c => c.match_grade === 'A').length,
    b:     candidates.filter(c => c.match_grade === 'B').length,
    other: candidates.filter(c => c.match_grade === 'C' || c.match_grade === 'D').length,
  }), [candidates])

  const demandScore = latestRun?.demand_score
    ?? (candidates.length > 0
      ? Math.round(candidates.slice(0, 20).reduce((s, c) => s + c.total_match_score, 0) / Math.min(20, candidates.length))
      : null)
    ?? demandRollup?.liquidity_score
    ?? null

  const hasData        = candidates.length > 0 || Boolean(latestRun?.status === 'complete')
  const hasEntityGraph = (demandStats?.entity_count ?? 0) > 0 || Boolean(demandRollup && demandRollup.buyer_count > 0)
  const matchCount     = candidates.length

  // Pre-run demand counts from rollup (before buyer match is run)
  const preRunEntityCount = candidates.length > 0 ? demandStats?.entity_count ?? 0 : (demandRollup?.buyer_count ?? demandStats?.entity_count ?? 0)

  // AI agents (mock state until agent APIs are live)
  const instCount = candidates.filter(c => c.buyer_type === 'institutional').length
  const isInstStep = running && (intelState.active_run_step === 'Detecting institutional signals' || intelState.active_run_step === 'Detecting corporate buyers')

  const agents: AcquisitionAgent[] = useMemo(() => [
    {
      id: 'valuation', name: 'Valuation Agent', icon: '📊',
      status: (propertySnapshot.arv || propertySnapshot.estimated_value) ? 'complete' : 'idle',
      confidence: (propertySnapshot.arv || propertySnapshot.estimated_value) ? 82 : null,
      output: (propertySnapshot.arv || propertySnapshot.estimated_value) ? `ARV ${fmt$(propertySnapshot.arv ?? propertySnapshot.estimated_value)} · based on 4 comp anchors` : 'Waiting for comp data',
    },
    {
      id: 'buyer', name: 'Buyer Match Agent', icon: '🎯',
      status: running ? 'running' : hasData ? 'complete' : 'idle',
      confidence: hasData ? Math.min(95, (demandScore ?? 0) + 10) : null,
      output: running
        ? (intelState.active_run_step ? `⟳ ${intelState.active_run_step}` : 'Scanning…')
        : hasData ? `${matchCount} buyers matched · ${gradeCounts.aplus} A+ grade`
        : 'Standby · run buyer graph to activate liquidity model',
    },
    {
      id: 'inst', name: 'Institutional Agent', icon: '⚡',
      status: isInstStep ? 'running' : hasData ? 'complete' : 'idle',
      confidence: hasData ? 74 : null,
      output: isInstStep ? '⟳ Scanning for institutional signals…'
        : hasData ? `${instCount} institutional buyer${instCount !== 1 ? 's' : ''} detected`
        : 'Pending · corporate buyer signals locked',
    },
    {
      id: 'risk', name: 'Risk Agent', icon: '🛡',
      status: hasData ? 'complete' : 'idle',
      confidence: hasData ? 88 : null,
      output: hasData ? 'Low-moderate risk profile · monitoring' : 'Watch · liquidity and condition unresolved',
    },
    {
      id: 'offer', name: 'Offer Agent', icon: '💰',
      status: (propertySnapshot.arv || propertySnapshot.estimated_value) ? 'complete' : 'idle',
      confidence: (propertySnapshot.arv || propertySnapshot.estimated_value) ? 79 : null,
      output: (propertySnapshot.arv || propertySnapshot.estimated_value)
        ? `${fmt$(Math.round(((propertySnapshot.arv ?? propertySnapshot.estimated_value ?? 0) * 0.70)))} · balanced mode`
        : 'Requires ARV data',
    },
    {
      id: 'dispo', name: 'Dispo Agent', icon: '🚀',
      status: matchCount > 5 ? 'complete' : hasData ? 'warning' : 'idle',
      confidence: matchCount > 5 ? 85 : hasData ? 52 : null,
      output: matchCount > 5 ? `Est. dispo in ${matchCount > 20 ? 14 : matchCount > 10 ? 28 : 45}d`
        : matchCount > 0 ? 'Limited buyer pool — extend radius'
        : 'Standby · buyer match required',
    },
  ], [running, hasData, demandScore, matchCount, gradeCounts.aplus, instCount, isInstStep, propertySnapshot, intelState.active_run_step])

  const sharedBuyerTabProps = {
    filteredCandidates, selectedKey, gradeFilter, typeFilter, gradeCounts,
    loading, running, hasEntityGraph, demandStats, demandScore,
    setSelectedKey, setGradeFilter, setTypeFilter, runMatch,
    sendPackage, updateCandidateStatus, selectBuyer, purchases,
  }

  // ── 25% mode: single column
  if (paneWidth === '25') {
    return (
      <div className="aic-workspace is-pane-25">
        {isOutsideFilter && (
          <div className="aic-filter-banner">
            <span>⚠</span><span>Property outside current filter</span>
            <div className="aic-filter-banner__actions">
              {onClearFilters && <button className="aic-filter-banner__btn" onClick={onClearFilters}>Clear Filters</button>}
              {onPinSelected && <button className="aic-filter-banner__btn is-primary" onClick={onPinSelected}>Pin Selected</button>}
            </div>
          </div>
        )}
        <PropertyIntelSidebar
          propertySnapshot={propertySnapshot} running={running} hasData={hasData}
          demandScore={demandScore} entityCount={preRunEntityCount} matchCount={matchCount}
          candidates={candidates} runMatch={runMatch} setActiveTab={setActiveTab}
          paneWidth={paneWidth} latestRun={latestRun} demandRollup={demandRollup} noDataReason={noDataReason}
        />
      </div>
    )
  }

  // ── 50% mode: sidebar + inline buyers
  if (paneWidth === '50') {
    return (
      <div className="aic-workspace is-pane-50">
        {isOutsideFilter && (
          <div className="aic-filter-banner">
            <span>⚠</span><span>Property outside current filter</span>
            <div className="aic-filter-banner__actions">
              {onClearFilters && <button className="aic-filter-banner__btn" onClick={onClearFilters}>Clear Filters</button>}
            </div>
          </div>
        )}
        <PropertyIntelSidebar
          propertySnapshot={propertySnapshot} running={running} hasData={hasData}
          demandScore={demandScore} entityCount={preRunEntityCount} matchCount={matchCount}
          candidates={candidates} runMatch={runMatch} setActiveTab={setActiveTab}
          paneWidth={paneWidth} latestRun={latestRun} demandRollup={demandRollup} noDataReason={noDataReason}
        />
        <InlineBuyersPanel {...sharedBuyerTabProps} title="Buyer Matches" />
      </div>
    )
  }

  // ── 75% / 100% mode: full 3-panel cockpit
  return (
    <div className={`aic-workspace is-pane-${paneWidth}`}>
      {IS_DEV && debugData && (
        <div style={{
          position: 'fixed', bottom: 8, right: 8, zIndex: 9999,
          background: 'rgba(10,12,25,0.92)', border: '1px solid rgba(169,190,255,0.18)',
          borderRadius: 8, padding: '6px 10px', fontSize: '0.6rem', color: '#a9beff',
          display: 'flex', gap: 10, flexWrap: 'wrap', maxWidth: 420, fontFamily: 'monospace',
        }}>
          <span style={{ color: '#5efa8c', fontWeight: 700 }}>BuyerMatch Intel</span>
          <span>PurchaseEvents: <b style={{ color: debugData.demand_rollup_rows > 0 ? '#5efa8c' : '#ff7a7a' }}>{debugData.demand_rollup_rows}</b></span>
          <span>Buyers: <b style={{ color: (debugData.demand_score ?? 0) > 0 ? '#5efa8c' : '#ff7a7a' }}>{debugData.entity_count}</b></span>
          <span>Matches: <b style={{ color: debugData.buyer_match_candidate_rows > 0 ? '#5efa8c' : '#ff7a7a' }}>{debugData.buyer_match_candidate_rows}</b></span>
          <span>Comps: <b style={{ color: debugData.comp_rows > 0 ? '#5efa8c' : '#ff7a7a' }}>{debugData.comp_rows}</b></span>
          <span>FallbackLevel: <b style={{ color: debugData.fallback_level !== 'none' ? '#5efa8c' : '#ff7a7a' }}>{debugData.fallback_level}</b></span>
          <span>LiquidityScore: <b style={{ color: (debugData.liquidity_score ?? 0) > 0 ? '#5efa8c' : '#ff7a7a' }}>{debugData.liquidity_score ?? '—'}</b></span>
          <span>DemandScore: <b style={{ color: (debugData.demand_score ?? 0) > 0 ? '#5efa8c' : '#ff7a7a' }}>{debugData.demand_score ?? '—'}</b></span>
          <span>Runs: <b>{debugData.match_run_rows}</b></span>
          <span>zip: <b>{debugData.zip || '—'}</b></span>
          <span>lat/lng: <b>{debugData.lat ? '✓' : '—'}</b></span>
        </div>
      )}
      {isOutsideFilter && (
        <div className="aic-filter-banner">
          <span>⚠</span>
          <span>Selected property is outside the current filter — showing deal snapshot below.</span>
          <div className="aic-filter-banner__actions">
            {onClearFilters && <button className="aic-filter-banner__btn" onClick={onClearFilters}>Clear Filters</button>}
            {onPinSelected && <button className="aic-filter-banner__btn is-primary" onClick={onPinSelected}>Pin Selected</button>}
          </div>
        </div>
      )}

      <PropertyIntelSidebar
        propertySnapshot={propertySnapshot} running={running} hasData={hasData}
        demandScore={demandScore} entityCount={preRunEntityCount} matchCount={matchCount}
        candidates={candidates} runMatch={runMatch} setActiveTab={setActiveTab}
        paneWidth={paneWidth} latestRun={latestRun}
      />

      <div className="aic-map-center">
        <AcquisitionMap lat={lat} lng={lng} purchases={purchases} candidates={candidates} running={running} />
      </div>

      <DealCommandDossier
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        propertySnapshot={propertySnapshot}
        matchCount={matchCount}
        candidateCount={candidates.length}
        agents={agents}
        {...sharedBuyerTabProps}
        matchRuns={matchRuns}
        intelState={intelState}
        dealEvents={dealEvents}
        realComps={realComps}
      />
    </div>
  )
}

export default BuyerMatchWorkspace

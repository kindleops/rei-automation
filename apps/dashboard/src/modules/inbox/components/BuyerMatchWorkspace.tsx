/**
 * BuyerMatchWorkspace v2 — Dispo War Room
 * Property-first buyer intelligence. Sourced from real sold data.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { getSupabaseClient } from '../../../lib/supabaseClient'
import '../buyer-match-v2.css'

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
  // status fields from buyer_match_candidates if available
  buyer_match_candidate_id?: string
  buyer_response_status?: string
  package_sent_at?: string | null
  selected?: boolean
  notes?: string
}

interface MatchRun {
  buyer_match_run_id: string
  property_id: string
  run_status: string
  buyer_count: number
  high_fit_count: number
  demand_score: number | null
  best_buyer_grade: string | null
  created_at: string
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

type GradeFilter = 'all' | 'A+' | 'A' | 'B' | 'C'
type TypeFilter  = 'all' | 'corporate' | 'repeat' | 'institutional'

export interface BuyerMatchWorkspaceProps {
  propertySnapshot: PropertySnapshot
  isOutsideFilter?: boolean
  onClearFilters?: () => void
  onPinSelected?: () => void
  paneWidth?: '25' | '50' | '75' | '100'
  apiBase?: string
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

const gradeClass = (grade: string) => {
  if (grade === 'A+') return 'grade-aplus'
  if (grade === 'A')  return 'grade-a'
  if (grade === 'B')  return 'grade-b'
  if (grade === 'C')  return 'grade-c'
  return 'grade-d'
}

const cardGradeClass = (grade: string) => {
  if (grade === 'A+') return 'is-grade-aplus'
  if (grade === 'A')  return 'is-grade-a'
  if (grade === 'B')  return 'is-grade-b'
  return ''
}

const heroVariant = (c: BuyerMatchCandidate) => {
  if (c.match_grade === 'A+') return 'is-aplus'
  if (c.buyer_type === 'institutional') return 'is-institutional'
  if (c.is_corporate_buyer) return 'is-corporate'
  return ''
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

function SkeletonCards() {
  return (
    <>
      {[1, 2, 3, 4, 5].map(i => (
        <div key={i} className="bm2-skeleton-card">
          <div style={{ display: 'flex', gap: 12 }}>
            <div className="bm2-skel" style={{ width: 42, height: 42, borderRadius: 13 }} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="bm2-skel" style={{ height: 14, width: '60%' }} />
              <div className="bm2-skel" style={{ height: 10, width: '40%' }} />
            </div>
          </div>
          <div className="bm2-skel" style={{ height: 6 }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 7 }}>
            <div className="bm2-skel" style={{ height: 48, borderRadius: 10 }} />
            <div className="bm2-skel" style={{ height: 48, borderRadius: 10 }} />
            <div className="bm2-skel" style={{ height: 48, borderRadius: 10 }} />
          </div>
        </div>
      ))}
    </>
  )
}

// ─── Buyer Card ───────────────────────────────────────────────────────────────

interface BuyerCardProps {
  candidate: BuyerMatchCandidate
  isSelected: boolean
  onSelect: () => void
  onSendPackage: () => void
  onMarkInterested: () => void
  onMarkPassed: () => void
}

function BuyerCard({ candidate: c, isSelected, onSelect, onSendPackage, onMarkInterested, onMarkPassed }: BuyerCardProps) {
  const pct = Math.round(Math.min(100, Math.max(0, c.total_match_score)))
  const packageSent = Boolean(c.package_sent_at)
  const isInterested = c.buyer_response_status === 'interested'
  const isPassed = c.buyer_response_status === 'passed'

  return (
    <div
      className={`bm2-buyer-card ${isSelected ? 'is-selected' : ''} ${cardGradeClass(c.match_grade)}`}
      onClick={onSelect}
    >
      {/* Header */}
      <div className="bm2-card-header">
        <div className="bm2-card-avatar">{initials(c.buyer_name)}</div>
        <div className="bm2-card-id">
          <div className="bm2-card-name" title={c.buyer_name}>{c.buyer_name}</div>
          <div className="bm2-card-meta">
            {c.mailing_city && c.mailing_state ? `${c.mailing_city}, ${c.mailing_state}` : (c.markets_active?.[0] ?? 'Unknown Market')}
            {c.last_purchase_date ? ` · Last: ${fmtDaysAgo(c.last_purchase_date)}` : ''}
          </div>
        </div>
        <div className={`bm2-card-grade ${gradeClass(c.match_grade)}`}>{c.match_grade}</div>
      </div>

      {/* Badges */}
      <div className="bm2-card-badges">
        {c.is_repeat_buyer && <span className="bm2-card-badge is-repeat">↩ Repeat</span>}
        {c.buyer_type === 'corporate' && <span className="bm2-card-badge is-corp">🏢 Corporate</span>}
        {c.buyer_type === 'institutional' && <span className="bm2-card-badge is-inst">⚡ Institutional</span>}
        {c.purchase_count_180d > 0 && <span className="bm2-card-badge">🔥 Active 6mo</span>}
        {c.markets_active?.slice(0, 1).map(m => (
          <span key={m} className="bm2-card-badge">{m}</span>
        ))}
      </div>

      {/* Score bar */}
      <div className="bm2-score-row">
        <span className="bm2-score-label">Match</span>
        <div className="bm2-score-track">
          <div className="bm2-score-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="bm2-score-val">{pct}</span>
      </div>

      {/* Metrics */}
      <div className="bm2-card-metrics">
        <div className="bm2-card-metric">
          <span className="bm2-card-metric__label">Purchases</span>
          <span className="bm2-card-metric__value">{fmtNum(c.purchase_count)}</span>
        </div>
        <div className="bm2-card-metric">
          <span className="bm2-card-metric__label">Avg Price</span>
          <span className="bm2-card-metric__value">{fmt$k(c.avg_purchase_price)}</span>
        </div>
        <div className="bm2-card-metric">
          <span className="bm2-card-metric__label">Spread Fit</span>
          <span className="bm2-card-metric__value">{fmt$k(c.avg_potential_spread)}</span>
        </div>
      </div>

      {/* Reason */}
      {c.reason_for_match && (
        <div className="bm2-card-reason" title={c.reason_for_match}>
          ✦ {c.reason_for_match}
        </div>
      )}

      {/* Actions */}
      <div className="bm2-card-actions" onClick={e => e.stopPropagation()}>
        {packageSent ? (
          <button className="bm2-card-action is-sent" disabled>✓ Package Sent</button>
        ) : (
          <button className="bm2-card-action is-primary" onClick={onSendPackage}>📤 Send Package</button>
        )}
        {!isPassed && !isInterested && (
          <button className="bm2-card-action is-success" onClick={onMarkInterested}>✓ Interested</button>
        )}
        {isInterested && <span className="bm2-card-action is-sent">🟢 Interested</span>}
        {!isPassed && (
          <button className="bm2-card-action is-danger" onClick={onMarkPassed}>✗ Pass</button>
        )}
        {isPassed && <span className="bm2-card-action" style={{ opacity: 0.5 }}>Passed</span>}
      </div>
    </div>
  )
}

// ─── Detail Panel ─────────────────────────────────────────────────────────────

interface DetailPanelProps {
  candidate: BuyerMatchCandidate | null
  purchases: PurchaseEvent[]
  onSendPackage: () => void
  onSelectBuyer: () => void
  onMarkInterested: () => void
  onMarkPassed: () => void
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
}

function DetailPanel({ candidate: c, purchases, onSendPackage, onSelectBuyer, onMarkInterested, onMarkPassed }: DetailPanelProps) {
  if (!c) {
    return (
      <div className="bm2-detail-empty">
        <div className="bm2-detail-empty__icon">🎯</div>
        <div className="bm2-detail-empty__text">Select a buyer to see full profile, purchase trail, and match explanation.</div>
      </div>
    )
  }

  const scoreComponents = [
    { name: 'Market Match', score: c.market_match_score, weight: 25 },
    { name: 'Asset Match',  score: c.asset_match_score,  weight: 20 },
    { name: 'Price Match',  score: c.price_match_score,  weight: 20 },
    { name: 'Recency',      score: c.recency_score,      weight: 15 },
    { name: 'Repeat Buyer', score: c.repeat_buyer_score, weight: 10 },
    { name: 'Spread Fit',   score: c.spread_fit_score,   weight: 10 },
  ]

  const packageSent = Boolean(c.package_sent_at)
  const isInterested = c.buyer_response_status === 'interested'
  const isPassed = c.buyer_response_status === 'passed'
  const isSelected = c.selected

  return (
    <div className="bm2-detail">
      {/* Hero */}
      <div className={`bm2-detail-hero ${heroVariant(c)}`}>
        <div className="bm2-detail-avatar">{initials(c.buyer_name)}</div>
        <div className="bm2-detail-info">
          <div className="bm2-detail-name">{c.buyer_name}</div>
          <div className="bm2-detail-type">
            {c.buyer_type.charAt(0).toUpperCase() + c.buyer_type.slice(1)} Buyer
            {c.is_repeat_buyer ? ' · Repeat Purchaser' : ''}
          </div>
          {(c.mailing_city || c.mailing_state) && (
            <div style={{ fontSize: '0.68rem', color: 'rgba(219,229,255,0.42)', marginTop: 4 }}>
              📍 {[c.mailing_city, c.mailing_state, c.mailing_zip].filter(Boolean).join(', ')}
            </div>
          )}
        </div>
        <div className={`bm2-detail-grade-badge ${gradeClass(c.match_grade)}`}>{c.match_grade}</div>
      </div>

      {/* Score Breakdown */}
      <div className="bm2-detail-section">
        <div className="bm2-detail-section__head">Match Score Breakdown</div>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: '2rem', fontWeight: 900, color: '#e8f0ff' }}>{Math.round(c.total_match_score)}</span>
          <span style={{ fontSize: '0.80rem', color: 'rgba(219,229,255,0.45)', alignSelf: 'flex-end', marginBottom: 4 }}>/100</span>
        </div>
        <div className="bm2-score-breakdown">
          {scoreComponents.map(sc => (
            <div key={sc.name} className="bm2-score-component">
              <span className="bm2-score-component__name">{sc.name} <span style={{ opacity: 0.45 }}>({sc.weight}%)</span></span>
              <div className="bm2-score-component__bar">
                <div className="bm2-score-component__fill" style={{ width: `${sc.score}%` }} />
              </div>
              <span className="bm2-score-component__val">{Math.round(sc.score)}</span>
            </div>
          ))}
        </div>
        {c.reason_for_match && (
          <div style={{ fontSize: '0.72rem', color: 'rgba(219,229,255,0.50)', fontStyle: 'italic', marginTop: 4 }}>
            ✦ {c.reason_for_match}
          </div>
        )}
      </div>

      {/* Buy Box */}
      <div className="bm2-detail-section">
        <div className="bm2-detail-section__head">Buy Box Profile</div>
        <div className="bm2-detail-kv-grid">
          <div className="bm2-detail-kv">
            <span className="bm2-detail-kv__key">Purchases</span>
            <span className="bm2-detail-kv__val is-cyan">{fmtNum(c.purchase_count)}</span>
          </div>
          <div className="bm2-detail-kv">
            <span className="bm2-detail-kv__key">Last Active</span>
            <span className="bm2-detail-kv__val">{fmtDaysAgo(c.last_purchase_date)}</span>
          </div>
          <div className="bm2-detail-kv">
            <span className="bm2-detail-kv__key">Avg Price</span>
            <span className="bm2-detail-kv__val">{fmt$(c.avg_purchase_price)}</span>
          </div>
          <div className="bm2-detail-kv">
            <span className="bm2-detail-kv__key">Median Price</span>
            <span className="bm2-detail-kv__val">{fmt$(c.median_purchase_price)}</span>
          </div>
          <div className="bm2-detail-kv">
            <span className="bm2-detail-kv__key">Price Range</span>
            <span className="bm2-detail-kv__val" style={{ fontSize: '0.72rem' }}>
              {c.preferred_price_min || c.preferred_price_max
                ? `${fmt$k(c.preferred_price_min)} – ${fmt$k(c.preferred_price_max)}`
                : '—'}
            </span>
          </div>
          <div className="bm2-detail-kv">
            <span className="bm2-detail-kv__key">Avg Spread</span>
            <span className="bm2-detail-kv__val is-green">{fmt$(c.avg_potential_spread)}</span>
          </div>
          <div className="bm2-detail-kv">
            <span className="bm2-detail-kv__key">6mo Purchases</span>
            <span className="bm2-detail-kv__val">{fmtNum(c.purchase_count_180d)}</span>
          </div>
          <div className="bm2-detail-kv">
            <span className="bm2-detail-kv__key">Avg $/sqft</span>
            <span className="bm2-detail-kv__val">{c.avg_ppsf ? `$${Math.round(c.avg_ppsf)}/sf` : '—'}</span>
          </div>
        </div>
        {c.markets_active?.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <div className="bm2-detail-kv__key" style={{ marginBottom: 5 }}>Active Markets</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {c.markets_active.slice(0, 6).map(m => (
                <span key={m} className="bm2-card-badge is-corp">{m}</span>
              ))}
            </div>
          </div>
        )}
        {c.preferred_asset_classes?.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <div className="bm2-detail-kv__key" style={{ marginBottom: 5 }}>Asset Classes</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {c.preferred_asset_classes.slice(0, 5).map(a => (
                <span key={a} className="bm2-card-badge">{a}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Purchase Trail */}
      {purchases.length > 0 && (
        <div className="bm2-detail-section">
          <div className="bm2-detail-section__head">Purchase Trail</div>
          <div className="bm2-trail">
            {purchases.slice(0, 8).map((p, i) => (
              <div key={i} className="bm2-trail-item">
                <div className="bm2-trail-item__head">
                  <span className="bm2-trail-item__addr">{p.property_address_full || 'Unknown Address'}</span>
                  {p.purchase_price && <span className="bm2-trail-item__price">{fmt$(p.purchase_price)}</span>}
                </div>
                <div className="bm2-trail-item__meta">
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

      {/* Actions */}
      <div className="bm2-detail-actions">
        {!packageSent ? (
          <button className="bm2-detail-action is-primary" onClick={onSendPackage}>📤 Send Package</button>
        ) : (
          <button className="bm2-detail-action is-sent" disabled style={{ opacity: 0.7 }}>✓ Package Sent {fmtDate(c.package_sent_at)}</button>
        )}
        {!isInterested && !isPassed && (
          <button className="bm2-detail-action is-success" onClick={onMarkInterested}>✓ Mark Interested</button>
        )}
        {isInterested && <span className="bm2-detail-action is-success" style={{ textAlign: 'center' }}>🟢 Interested</span>}
        {!isSelected ? (
          <button className="bm2-detail-action is-primary" onClick={onSelectBuyer} style={{ flex: '1 1 100%' }}>⭐ Select as Buyer</button>
        ) : (
          <span className="bm2-detail-action is-success" style={{ textAlign: 'center', flex: '1 1 100%' }}>✓ Selected Buyer</span>
        )}
        {!isPassed && (
          <button className="bm2-detail-action is-danger" onClick={onMarkPassed}>✗ Pass</button>
        )}
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function BuyerMatchWorkspace({
  propertySnapshot,
  isOutsideFilter = false,
  onClearFilters,
  onPinSelected,
  paneWidth = '100',
}: BuyerMatchWorkspaceProps) {
  const [candidates, setCandidates] = useState<BuyerMatchCandidate[]>([])
  const [purchases, setPurchases] = useState<PurchaseEvent[]>([])
  const [latestRun, setLatestRun] = useState<MatchRun | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [demandStats, setDemandStats] = useState<{ entity_count: number; match_count: number } | null>(null)

  const { property_id, address, market, zip, state, county, property_type, asset_class, estimated_value } = propertySnapshot

  // Load initial data (demand summary)
  useEffect(() => {
    if (!property_id) return
    let active = true

    const load = async () => {
      try {
        const supabase = getSupabaseClient()
        const { data: property } = await supabase.from('properties').select('market').eq('property_id', property_id).maybeSingle()
        const { data: latest_run } = await supabase.from('buyer_match_runs').select('*').eq('property_id', property_id).order('created_at', { ascending: false }).limit(1).maybeSingle()
        
        let entity_count = 0
        if (property?.market) {
          const { count } = await supabase.from('buyer_entities_v2').select('*', { count: 'exact', head: true }).contains('markets_active', [property.market])
          entity_count = count ?? 0
        }

        if (!active) return
        setLatestRun(latest_run ?? null)
        setDemandStats({ entity_count, match_count: latest_run?.candidate_count ?? 0 })
      } catch (err) {
        console.warn(err)
      }
    }

    void load()
    return () => { active = false }
  }, [property_id])

  // Load candidates from last run
  useEffect(() => {
    if (!latestRun?.buyer_match_run_id) return
    let active = true
    const load = async () => {
      try {
        const supabase = getSupabaseClient()
        const { data } = await supabase.from('buyer_match_candidates')
          .select('*, buyer_entities_v2!buyer_match_candidates_buyer_entity_id_fkey(*)')
          .eq('buyer_match_run_id', latestRun.buyer_match_run_id)
          .limit(150)
        
        if (!active || !data) return
        const mapped = data.map((c: any) => ({
          ...c,
          ...c.buyer_entities_v2,
        }))
        setCandidates(mapped)
      } catch (err) {
        console.warn(err)
      }
    }
    void load()
    return () => { active = false }
  }, [latestRun?.buyer_match_run_id, property_id])

  // Load purchase trail for selected buyer
  useEffect(() => {
    setPurchases([])
    const sel = candidates.find(c => c.buyer_key === selectedKey)
    if (!sel?.buyer_entity_id) return
    let active = true
    const load = async () => {
      try {
        const supabase = getSupabaseClient()
        const { data } = await supabase.from('buyer_purchase_events_v2')
          .select('*')
          .eq('buyer_entity_id', sel.buyer_entity_id)
          .order('sale_date', { ascending: false })
          .limit(20)
        if (!active || !data) return
        setPurchases(data)
      } catch (err) {
        console.warn(err)
      }
    }
    void load()
    return () => { active = false }
  }, [selectedKey, candidates])

  const runMatch = useCallback(async () => {
    if (!property_id || running) return
    setRunning(true)
    setLoading(true)
    setCandidates([])

    try {
      const supabase = getSupabaseClient()
      const { data, error } = await supabase.rpc('get_buyer_match_candidates', {
        p_market: market,
        p_zip: zip,
        p_state: state,
        p_county: county,
        p_asset_class: asset_class || property_type,
        p_property_type: property_type,
        p_estimated_value: estimated_value,
        p_limit: 100
      })
      
      if (error) throw error

      const candidatesList = data || []
      
      // Store the run
      const { data: runData } = await supabase.from('buyer_match_runs').insert({
        property_id,
        run_status: 'complete',
        buyer_count: candidatesList.length,
        high_fit_count: candidatesList.filter((c: any) => c.match_grade === 'A+' || c.match_grade === 'A').length,
        demand_score: Math.round(candidatesList.slice(0, 20).reduce((s: number, c: any) => s + c.total_match_score, 0) / Math.max(1, Math.min(20, candidatesList.length))),
      }).select().maybeSingle()

      if (runData) {
        setLatestRun(runData)
        // Store candidates
        const candidateInserts = candidatesList.slice(0, 25).map((c: any) => ({
          buyer_match_run_id: runData.buyer_match_run_id,
          property_id,
          buyer_entity_id: c.buyer_entity_id,
          buyer_key: c.buyer_key,
          match_grade: c.match_grade,
          total_match_score: c.total_match_score,
          match_reasoning: c.reason_for_match,
        }))
        if (candidateInserts.length > 0) {
          await supabase.from('buyer_match_candidates').insert(candidateInserts)
        }
      }
      
      setCandidates(candidatesList)
    } catch (err) {
      console.warn('Failed to run match:', err)
    } finally {
      setRunning(false)
      setLoading(false)
    }
  }, [property_id, market, zip, state, county, asset_class, property_type, estimated_value, running])

  const updateCandidateStatus = useCallback(async (candidateId: string | undefined, updates: Record<string, unknown>) => {
    if (!candidateId) return
    const supabase = getSupabaseClient()
    const { error } = await supabase.from('buyer_match_candidates').update(updates).eq('buyer_match_candidate_id', candidateId)
    if (!error) {
      setCandidates(prev => prev.map(c =>
        c.buyer_match_candidate_id === candidateId ? { ...c, ...updates } : c
      ))
    }
  }, [])

  const sendPackage = useCallback(async (candidateId: string | undefined) => {
    if (!candidateId) return
    const supabase = getSupabaseClient()
    const package_sent_at = new Date().toISOString()
    const { error } = await supabase.from('buyer_match_candidates').update({ package_sent_at, buyer_response_status: 'package_sent' }).eq('buyer_match_candidate_id', candidateId)
    if (!error) {
      setCandidates(prev => prev.map(c =>
        c.buyer_match_candidate_id === candidateId ? { ...c, package_sent_at, buyer_response_status: 'package_sent' } : c
      ))
    }
  }, [])

  const selectBuyer = useCallback(async (candidateId: string | undefined) => {
    if (!candidateId) return
    const supabase = getSupabaseClient()
    const { error } = await supabase.from('buyer_match_candidates').update({ selected: true }).eq('buyer_match_candidate_id', candidateId)
    if (!error) {
      setCandidates(prev => prev.map(c =>
        c.buyer_match_candidate_id === candidateId ? { ...c, selected: true } : c
      ))
    }
  }, [])

  // Filtered + sorted candidates
  const filteredCandidates = useMemo(() => {
    return candidates.filter(c => {
      if (gradeFilter !== 'all' && c.match_grade !== gradeFilter) return false
      if (typeFilter === 'corporate' && !c.is_corporate_buyer) return false
      if (typeFilter === 'repeat' && !c.is_repeat_buyer) return false
      if (typeFilter === 'institutional' && c.buyer_type !== 'institutional') return false
      return true
    })
  }, [candidates, gradeFilter, typeFilter])

  const selectedCandidate = candidates.find(c => c.buyer_key === selectedKey) ?? null

  // Grade counts
  const gradeCounts = useMemo(() => ({
    aplus:  candidates.filter(c => c.match_grade === 'A+').length,
    a:      candidates.filter(c => c.match_grade === 'A').length,
    b:      candidates.filter(c => c.match_grade === 'B').length,
    other:  candidates.filter(c => c.match_grade === 'C' || c.match_grade === 'D').length,
  }), [candidates])

  const demandScore = latestRun?.demand_score ?? (candidates.length > 0
    ? Math.round(candidates.slice(0, 20).reduce((s, c) => s + c.total_match_score, 0) / Math.min(20, candidates.length))
    : null)

  const hasRealData = candidates.length > 0 || (latestRun && latestRun.run_status === 'complete')
  const hasEntityGraph = (demandStats?.entity_count ?? 0) > 0

  return (
    <div className={`bm2-workspace is-pane-${paneWidth}`}>
      {/* Outside-filter banner */}
      {isOutsideFilter && (
        <div className="bm2-filter-banner">
          <span className="bm2-filter-banner__icon">⚠</span>
          <span>Selected property is outside the current filter — showing deal snapshot below.</span>
          <div className="bm2-filter-banner__actions">
            {onClearFilters && (
              <button className="bm2-filter-banner__btn" onClick={onClearFilters}>Clear Filters</button>
            )}
            {onPinSelected && (
              <button className="bm2-filter-banner__btn is-primary" onClick={onPinSelected}>Pin Selected</button>
            )}
          </div>
        </div>
      )}

      {/* ── LEFT: Deal Snapshot ── */}
      <aside className="bm2-left" style={{ paddingTop: isOutsideFilter ? 44 : 0 }}>
        <div className="bm2-deal-snapshot">
          <div className="bm2-deal-eyebrow">Deal Snapshot</div>

          <div>
            <div className="bm2-deal-address">{address || 'Property Address Unknown'}</div>
            <div className="bm2-deal-subaddress">
              {[market, state].filter(Boolean).join(' · ') || 'Market Unknown'}
            </div>
          </div>

          <div className="bm2-deal-badge-row">
            {market && <span className="bm2-deal-badge is-market">{market}</span>}
            {property_type && <span className="bm2-deal-badge is-type">{property_type}</span>}
            {propertySnapshot.dispo_strategy && (
              <span className="bm2-deal-badge is-strategy">{propertySnapshot.dispo_strategy}</span>
            )}
          </div>

          <div className="bm2-deal-stats">
            <div className="bm2-deal-stat">
              <span className="bm2-deal-stat__label">Est. Value</span>
              <span className="bm2-deal-stat__value">{fmt$(estimated_value)}</span>
            </div>
            <div className="bm2-deal-stat">
              <span className="bm2-deal-stat__label">Purchase</span>
              <span className="bm2-deal-stat__value">{fmt$(propertySnapshot.purchase_price)}</span>
            </div>
            {propertySnapshot.potential_spread != null && (
              <div className="bm2-deal-stat">
                <span className="bm2-deal-stat__label">Spread</span>
                <span className="bm2-deal-stat__value is-positive">{fmt$(propertySnapshot.potential_spread)}</span>
              </div>
            )}
            {propertySnapshot.arv != null && (
              <div className="bm2-deal-stat">
                <span className="bm2-deal-stat__label">ARV</span>
                <span className="bm2-deal-stat__value is-amber">{fmt$(propertySnapshot.arv)}</span>
              </div>
            )}
            {(propertySnapshot.beds != null || propertySnapshot.sqft != null) && (
              <div className="bm2-deal-stat">
                <span className="bm2-deal-stat__label">Property</span>
                <span className="bm2-deal-stat__value" style={{ fontSize: '0.76rem' }}>
                  {[
                    propertySnapshot.beds != null ? `${propertySnapshot.beds}bd` : null,
                    propertySnapshot.baths != null ? `${propertySnapshot.baths}ba` : null,
                    propertySnapshot.sqft != null ? `${fmtNum(propertySnapshot.sqft)}sf` : null,
                    propertySnapshot.units != null && propertySnapshot.units > 1 ? `${propertySnapshot.units}u` : null,
                  ].filter(Boolean).join(' / ') || '—'}
                </span>
              </div>
            )}
            <div className="bm2-deal-stat">
              <span className="bm2-deal-stat__label">ZIP</span>
              <span className="bm2-deal-stat__value">{zip || '—'}</span>
            </div>
          </div>

          {/* Demand bar */}
          <div className="bm2-demand-bar">
            <div className="bm2-demand-bar__head">
              <span>Buyer Demand</span>
              <span className="bm2-demand-bar__score">
                {demandScore != null ? demandScore : (hasEntityGraph ? '—' : 'No data')}
              </span>
            </div>
            <div className="bm2-demand-bar__track">
              <div
                className="bm2-demand-bar__fill"
                style={{ width: demandScore != null ? `${demandScore}%` : '0%' }}
              />
            </div>
            <div className="bm2-demand-bar__stats">
              <span><strong>{fmtNum(demandStats?.entity_count ?? candidates.length)}</strong> entities</span>
              {gradeCounts.aplus > 0 && <span><strong>{gradeCounts.aplus}</strong> A+</span>}
              {gradeCounts.a > 0    && <span><strong>{gradeCounts.a}</strong> A</span>}
              {gradeCounts.b > 0    && <span><strong>{gradeCounts.b}</strong> B</span>}
            </div>
          </div>

          {/* Run button */}
          <button
            className={`bm2-run-btn ${running ? 'is-running' : ''}`}
            disabled={running || !property_id}
            onClick={runMatch}
          >
            {running ? (
              <><span style={{ animation: 'bm2-shimmer 1s linear infinite' }}>⟳</span> Running Match…</>
            ) : hasRealData ? (
              <><Icon name="refresh-cw" size={14} /> Rerun Match</>
            ) : (
              <><Icon name="zap" size={14} /> Run Buyer Match</>
            )}
          </button>

          {latestRun && (
            <div style={{ fontSize: '0.64rem', color: 'rgba(219,229,255,0.30)', textAlign: 'center', marginTop: -4 }}>
              Last run: {fmtDaysAgo(latestRun.created_at)}
            </div>
          )}
        </div>
      </aside>

      {/* ── CENTER: Buyer Card List ── */}
      <main className="bm2-center">
        {/* Toolbar */}
        <div className="bm2-toolbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span className="bm2-toolbar__title">Buyers</span>
            {filteredCandidates.length > 0 && (
              <span className="bm2-toolbar__count">{filteredCandidates.length}</span>
            )}
          </div>
          <div className="bm2-toolbar__filters">
            <button
              className={`bm2-filter-pill is-gold ${gradeFilter === 'A+' ? 'is-gold is-active' : ''}`}
              onClick={() => setGradeFilter(f => f === 'A+' ? 'all' : 'A+')}
            >
              A+ {gradeCounts.aplus > 0 ? `(${gradeCounts.aplus})` : ''}
            </button>
            <button
              className={`bm2-filter-pill ${gradeFilter === 'A' ? 'is-active' : ''}`}
              onClick={() => setGradeFilter(f => f === 'A' ? 'all' : 'A')}
            >
              A {gradeCounts.a > 0 ? `(${gradeCounts.a})` : ''}
            </button>
            <button
              className={`bm2-filter-pill ${gradeFilter === 'B' ? 'is-active' : ''}`}
              onClick={() => setGradeFilter(f => f === 'B' ? 'all' : 'B')}
            >
              B {gradeCounts.b > 0 ? `(${gradeCounts.b})` : ''}
            </button>
            <button
              className={`bm2-filter-pill is-purple ${typeFilter === 'corporate' ? 'is-purple is-active' : ''}`}
              onClick={() => setTypeFilter(f => f === 'corporate' ? 'all' : 'corporate')}
            >Corp</button>
            <button
              className={`bm2-filter-pill ${typeFilter === 'repeat' ? 'is-active' : ''}`}
              onClick={() => setTypeFilter(f => f === 'repeat' ? 'all' : 'repeat')}
            >Repeat</button>
          </div>
        </div>

        {/* Card list */}
        <div className="bm2-card-list">
          {loading && <SkeletonCards />}

          {!loading && !hasEntityGraph && candidates.length === 0 && (
            <div className="bm2-empty-state">
              <div className="bm2-empty-icon">🏗</div>
              <div className="bm2-empty-title">Buyer Entity Graph Not Built</div>
              <div className="bm2-empty-desc">
                No buyer entities have been built from sold data yet. Run Buyer Match to generate the graph, or ensure recently_sold_properties has data.
              </div>
              <button className="bm2-empty-action" onClick={runMatch} disabled={running}>
                {running ? 'Building…' : '⚡ Build Buyer Graph'}
              </button>
            </div>
          )}

          {!loading && hasEntityGraph && candidates.length === 0 && !running && (
            <div className="bm2-empty-state">
              <div className="bm2-empty-icon">🎯</div>
              <div className="bm2-empty-title">Run Buyer Match</div>
              <div className="bm2-empty-desc">
                Click "Run Buyer Match" to score {fmtNum(demandStats?.entity_count)} buyer entities against this property.
              </div>
            </div>
          )}

          {!loading && filteredCandidates.length === 0 && candidates.length > 0 && (
            <div className="bm2-empty-state">
              <div className="bm2-empty-icon">🔍</div>
              <div className="bm2-empty-title">No Results</div>
              <div className="bm2-empty-desc">No buyers match the current filters. Try clearing grade or type filters.</div>
              <button className="bm2-empty-action" onClick={() => { setGradeFilter('all'); setTypeFilter('all') }}>
                Clear Filters
              </button>
            </div>
          )}

          {filteredCandidates.map(c => (
            <BuyerCard
              key={c.buyer_key}
              candidate={c}
              isSelected={selectedKey === c.buyer_key}
              onSelect={() => setSelectedKey(k => k === c.buyer_key ? null : c.buyer_key)}
              onSendPackage={() => sendPackage(c.buyer_match_candidate_id)}
              onMarkInterested={() => updateCandidateStatus(c.buyer_match_candidate_id, { buyer_response_status: 'interested' })}
              onMarkPassed={() => updateCandidateStatus(c.buyer_match_candidate_id, { buyer_response_status: 'passed' })}
            />
          ))}
        </div>
      </main>

      {/* ── RIGHT: Detail Panel ── */}
      <aside className="bm2-right">
        <DetailPanel
          candidate={selectedCandidate}
          purchases={purchases}
          onSendPackage={() => sendPackage(selectedCandidate?.buyer_match_candidate_id)}
          onSelectBuyer={() => selectBuyer(selectedCandidate?.buyer_match_candidate_id)}
          onMarkInterested={() => updateCandidateStatus(selectedCandidate?.buyer_match_candidate_id, { buyer_response_status: 'interested' })}
          onMarkPassed={() => updateCandidateStatus(selectedCandidate?.buyer_match_candidate_id, { buyer_response_status: 'passed' })}
        />
      </aside>
    </div>
  )
}

export default BuyerMatchWorkspace

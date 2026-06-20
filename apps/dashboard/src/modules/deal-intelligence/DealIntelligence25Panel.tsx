import React, { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../shared/icons'
import { formatCurrency, formatInteger, formatPercent } from '../../shared/formatters'
import { buildPropertyExternalLinks } from '../../domain/inbox/inbox-normalization'
import { useDealIntelligenceDossier } from '../../domain/deal-intelligence/useDealIntelligenceDossier'
import type { CompRecord, DealIntelligenceDossier } from '../../domain/deal-intelligence/deal-intelligence.types'
import { humanizeEnum, priorityFlags } from '../../domain/deal-intelligence/deal-intelligence-humanize'
import { getBackendBaseUrl } from '../../lib/api/backendClient'
import './deal-intelligence-25.css'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')

const fmtMoney = (v: number | null | undefined) => (v != null && v > 0 ? formatCurrency(v) : null)
const fmtPct = (v: number | null | undefined) => (v != null && v >= 0 ? formatPercent(v) : null)
const fmtScore = (v: number | null | undefined) => (v != null ? String(Math.round(v * 10) / 10) : null)
const has = (v: unknown) => v !== null && v !== undefined && v !== ''

type MediaTab = 'street' | 'aerial'
type MediaMode = 'embed' | 'image' | 'unavailable' | 'loading'

interface DealIntelligence25PanelProps {
  threadKey?: string
  propertyId?: string
  prospectId?: string
  masterOwnerId?: string
  canonicalE164?: string
  fallbackAddress?: string | null
}

async function resolveInteractiveEmbed(type: MediaTab, dossier: DealIntelligenceDossier | null, address?: string | null) {
  const lat = dossier?.property?.latitude
  const lng = dossier?.property?.longitude
  const qs = new URLSearchParams()
  qs.set('type', type === 'street' ? 'streetview' : 'aerial')
  if (lat && lng) {
    qs.set('lat', String(lat))
    qs.set('lng', String(lng))
  } else if (address) {
    qs.set('address', address)
  } else return null
  try {
    const res = await fetch(`${getBackendBaseUrl()}/api/maps/embed?${qs.toString()}`)
    const payload = await res.json()
    return payload?.ok ? payload.embed_url : null
  } catch {
    return null
  }
}

const DetailSection = ({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) => {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="nx-di25-detail">
      <button type="button" className="nx-di25-detail__toggle" onClick={() => setOpen((v) => !v)}>
        <span>{title}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} />
      </button>
      {open ? <div className="nx-di25-detail__body">{children}</div> : null}
    </section>
  )
}

const FieldRow = ({ label, value }: { label: string; value: React.ReactNode }) => {
  if (!has(value)) return null
  return (
    <div className="nx-di25-field">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

const SnapshotCard = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) => (
  <div className="nx-di25-snap-card">
    <span>{label}</span>
    <strong>{value}</strong>
    {sub ? <em>{sub}</em> : null}
  </div>
)

const ScoreChip = ({ label, value, tone = 'default' }: { label: string; value: string | null; tone?: string }) => {
  if (!value) return null
  return (
    <div className={cls('nx-di25-score-chip', `is-${tone}`)}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

const ValuationBand = ({
  low, mid, high, offer, minOffer, ceiling,
}: {
  low?: number | null; mid?: number | null; high?: number | null
  offer?: number | null; minOffer?: number | null; ceiling?: number | null
}) => {
  const values = [low, mid, high, offer, minOffer, ceiling].filter((v) => v != null && v > 0) as number[]
  if (!values.length) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pos = (v: number | null | undefined) => (v != null && v > 0 ? `${((v - min) / span) * 100}%` : null)
  return (
    <div className="nx-di25-val-band">
      <div className="nx-di25-val-band__track">
        {low != null && high != null ? <div className="nx-di25-val-band__range" style={{ left: '0%', right: '0%' }} /> : null}
        {mid != null ? <i className="nx-di25-val-band__tick is-mid" style={{ left: pos(mid) || '50%' }} title={`Mid ${fmtMoney(mid)}`} /> : null}
        {offer != null ? <i className="nx-di25-val-band__tick is-offer" style={{ left: pos(offer) || '40%' }} title={`Offer ${fmtMoney(offer)}`} /> : null}
        {ceiling != null ? <i className="nx-di25-val-band__tick is-ceiling" style={{ left: pos(ceiling) || '80%' }} title={`Ceiling ${fmtMoney(ceiling)}`} /> : null}
      </div>
      <div className="nx-di25-val-band__labels">
        <span>{fmtMoney(low) ?? '—'}</span>
        <span>{fmtMoney(high) ?? '—'}</span>
      </div>
    </div>
  )
}

const STRATEGY_WINNER_KEYS: Record<string, string> = {
  CASH_ASSIGNMENT: 'aos_score',
  SUBJECT_TO: 'subject_to_score',
  SELLER_FINANCE: 'seller_finance_score',
  LEASE_OPTION: 'lease_option_score',
  NOVATION: 'novation_score',
}

const StrategyBars = ({ engine }: Record<string, unknown>) => {
  const strategies = [
    { key: 'aos_score', label: 'Cash Assignment' },
    { key: 'subject_to_score', label: 'Subject-To' },
    { key: 'seller_finance_score', label: 'Seller Finance' },
    { key: 'lease_option_score', label: 'Lease Option' },
    { key: 'novation_score', label: 'Novation' },
  ]
  const scores = strategies
    .map((s) => ({ ...s, value: Number(engine[s.key]) || 0 }))
    .filter((s) => s.value > 0)
  if (!scores.length) return null
  const max = Math.max(...scores.map((s) => s.value), 1)
  const winnerKey = STRATEGY_WINNER_KEYS[String(engine.best_strategy || '').toUpperCase()]
  return (
    <div className="nx-di25-strategy-bars">
      {scores.map((s) => (
        <div key={s.key} className={cls('nx-di25-strategy-row', winnerKey === s.key && 'is-winner')}>
          <span>{s.label}</span>
          <div className="nx-di25-strategy-row__bar"><i style={{ width: `${(s.value / max) * 100}%` }} /></div>
          <strong>{Math.round(s.value)}</strong>
        </div>
      ))}
    </div>
  )
}

const TxProbability = ({ engine }: Record<string, unknown>) => {
  const rows = [
    { label: '90 days', value: Number(engine.transaction_probability_90) || 0 },
    { label: '180 days', value: Number(engine.transaction_probability_180) || 0 },
    { label: '365 days', value: Number(engine.transaction_probability_365) || 0 },
  ].filter((r) => r.value > 0)
  if (!rows.length) return null
  return (
    <div className="nx-di25-tx-prob">
      {rows.map((r) => (
        <div key={r.label} className="nx-di25-tx-prob__row">
          <span>{r.label}</span>
          <div><i style={{ width: `${Math.min(100, r.value)}%` }} /></div>
          <strong>{Math.round(r.value)}%</strong>
        </div>
      ))}
    </div>
  )
}

const DebtComposition = ({ value, equity, loan, repairs }: { value?: number | null; equity?: number | null; loan?: number | null; repairs?: number | null }) => {
  const total = (value || 0) || (Number(equity || 0) + Number(loan || 0) + Number(repairs || 0))
  if (!total) return null
  const segments = [
    { label: 'Equity', amount: Number(equity || 0), tone: 'equity' },
    { label: 'Debt', amount: Number(loan || 0), tone: 'debt' },
    { label: 'Repairs', amount: Number(repairs || 0), tone: 'repair' },
  ].filter((s) => s.amount > 0)
  return (
    <div className="nx-di25-debt-bar">
      <div className="nx-di25-debt-bar__track">
        {segments.map((s) => (
          <span key={s.tone} className={`is-${s.tone}`} style={{ width: `${(s.amount / total) * 100}%` }} title={`${s.label} ${fmtMoney(s.amount)}`} />
        ))}
      </div>
    </div>
  )
}

export const DealIntelligence25Panel = ({
  threadKey, propertyId, prospectId, masterOwnerId, canonicalE164, fallbackAddress,
}: DealIntelligence25PanelProps) => {
  const { dossier, loading, error, runDecisionEngine, engineRunning, engineError, engineProgress } = useDealIntelligenceDossier({
    threadKey, propertyId, prospectId, masterOwnerId, canonicalE164,
  })

  const [mediaTab, setMediaTab] = useState<MediaTab>('street')
  const [mediaMode, setMediaMode] = useState<MediaMode>('loading')
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [showAllComps, setShowAllComps] = useState(false)
  const [addrCopied, setAddrCopied] = useState(false)

  const address = dossier?.property?.full_address || fallbackAddress || null
  const links = useMemo(() => buildPropertyExternalLinks(address), [address])
  const snap = dossier?.property_snapshot
  const baseline = dossier?.baseline_scores
  const property = dossier?.property
  const owner = dossier?.master_owner
  const prospect = dossier?.prospect
  const phone = dossier?.phone
  const engine = dossier?.acquisition_decision
  const engineAvailable = engine?.status === 'available'
  const comps = dossier?.comps
  const qual = comps?.qualification

  const flags = useMemo(() => priorityFlags(property?.property_flags || []), [property?.property_flags])
  const visibleFlags = flags.slice(0, 4)
  const overflowCount = property?.property_flags_overflow ?? Math.max(0, flags.length - 4)
  const storedMediaUrl = mediaTab === 'street' ? property?.street_view_url : property?.satellite_url
  const isMultifamily = (property?.units || 0) > 1 || /multi|duplex|triplex|fourplex|apt/i.test(String(property?.property_type || ''))

  useEffect(() => {
    let cancelled = false
    const loadMedia = async () => {
      setMediaMode('loading')
      setMediaUrl(null)
      const stored = mediaTab === 'street' ? property?.street_view_url : property?.satellite_url
      const embed = await resolveInteractiveEmbed(mediaTab, dossier, address)
      if (cancelled) return
      if (embed) {
        setMediaUrl(embed)
        setMediaMode('embed')
        return
      }
      if (stored) {
        setMediaUrl(stored)
        setMediaMode('image')
        return
      }
      setMediaMode('unavailable')
    }
    void loadMedia()
    return () => { cancelled = true }
  }, [mediaTab, dossier, address, property?.street_view_url, property?.satellite_url])

  const handleMediaEmbedError = () => {
    if (storedMediaUrl) {
      setMediaUrl(storedMediaUrl)
      setMediaMode('image')
      return
    }
    setMediaMode('unavailable')
    setMediaUrl(null)
  }

  const copyAddress = () => {
    if (!address) return
    navigator.clipboard.writeText(address).catch(() => undefined)
    setAddrCopied(true)
    setTimeout(() => setAddrCopied(false), 1400)
  }

  if (loading && !dossier) return <div className="nx-deal-compact-shell nx-di25-loading">Loading deal intelligence…</div>
  if (error && !dossier) return <div className="nx-deal-compact-shell nx-di25-error">{error}</div>

  const compRecords = (comps?.records || []) as CompRecord[]
  const visibleComps = showAllComps ? compRecords : compRecords.slice(0, 4)
  const buyerSignal = dossier?.buyer_market?.status === 'no_coverage'
    ? 'No qualified rollup'
    : String(dossier?.buyer_market?.signal || 'Resolving…')

  return (
    <div className="nx-deal-compact-shell">
      {/* Media */}
      <div className="nx-di25-media">
        <div className="nx-di25-media__tabs">
          <button type="button" className={cls('nx-di25-media__tab', mediaTab === 'street' && 'is-active')} onClick={() => setMediaTab('street')}>Street View</button>
          <button type="button" className={cls('nx-di25-media__tab', mediaTab === 'aerial' && 'is-active')} onClick={() => setMediaTab('aerial')}>Aerial</button>
        </div>
        <div className="nx-di25-media__surface">
          {mediaMode === 'loading' ? <div className="nx-di25-media__state">Loading view…</div> : null}
          {mediaMode === 'embed' && mediaUrl ? (
            <iframe title={mediaTab === 'street' ? 'Street View' : 'Aerial'} src={mediaUrl} loading="lazy" referrerPolicy="no-referrer-when-downgrade" onError={handleMediaEmbedError} />
          ) : null}
          {mediaMode === 'image' && mediaUrl ? <img src={mediaUrl} alt={mediaTab} className="nx-di25-media__img" /> : null}
          {mediaMode === 'unavailable' ? <div className="nx-di25-media__state">View unavailable</div> : null}
          <div className="nx-di25-media__gradient" />
        </div>
        <div className="nx-di25-media__actions">
          {links.zillow ? <a href={links.zillow} target="_blank" rel="noopener noreferrer">Zillow</a> : null}
          {links.realtor ? <a href={links.realtor} target="_blank" rel="noopener noreferrer">Realtor</a> : null}
          {links.googleSearch ? <a href={links.googleSearch} target="_blank" rel="noopener noreferrer">Google</a> : null}
          <button type="button" onClick={copyAddress}>{addrCopied ? 'Copied' : 'Copy Address'}</button>
        </div>
      </div>

      {/* Identity */}
      <section className="nx-di25-identity">
        <h2>{address || 'Property unknown'}</h2>
        <div className="nx-di25-identity__meta">
          {property?.market ? <span className="nx-di25-badge">{property.market}</span> : null}
          {property?.property_type ? <span className="nx-di25-badge is-type">{property.property_type}</span> : null}
          {property?.property_class ? <span className="nx-di25-badge">{property.property_class}</span> : null}
          {property?.units && property.units > 1 ? <span className="nx-di25-badge">{property.units} units</span> : null}
          {property?.condition ? <span className="nx-di25-badge is-condition">{property.condition}</span> : null}
        </div>
        {visibleFlags.length ? (
          <div className="nx-di25-flags">
            {visibleFlags.map((flag) => <span key={flag} className="nx-di25-flag">{flag}</span>)}
            {overflowCount > 0 ? <span className="nx-di25-flag is-overflow">+{overflowCount}</span> : null}
          </div>
        ) : null}
      </section>

      {/* Layer A: Property Snapshot */}
      <section className="nx-di25-layer">
        <header className="nx-di25-layer__head"><span>Property Snapshot</span></header>
        <div className="nx-di25-snap-grid">
          <SnapshotCard label="Value" value={fmtMoney(snap?.value) ?? '—'} />
          <SnapshotCard label="Equity" value={fmtMoney(snap?.equity_amount) ?? fmtPct(snap?.equity_percentage) ?? '—'} sub={snap?.equity_percentage != null ? `${Math.round(snap.equity_percentage)}%` : null} />
          <SnapshotCard label="Debt" value={fmtMoney(snap?.total_loan_balance) ?? (snap?.total_loan_balance === 0 ? '$0' : '—')} />
          <SnapshotCard label="Repairs" value={fmtMoney(snap?.repair_estimate) ?? '—'} />
          <SnapshotCard label="Last Sale" value={snap?.last_sale_price ? fmtMoney(snap.last_sale_price) : '—'} sub={snap?.last_sale_date ? String(snap.last_sale_date).slice(0, 10) : null} />
          <SnapshotCard label="Ownership" value={snap?.ownership_years ? `${Math.round(snap.ownership_years)} yrs` : '—'} />
        </div>
        {snap?.appreciation ? (
          <div className="nx-di25-appreciation">
            <span>Last sale → current value</span>
            <strong>{fmtMoney(snap.appreciation.dollar_change)} ({fmtPct(snap.appreciation.percent_change)})</strong>
            <em>{snap.appreciation.holding_period_years} yr hold</em>
          </div>
        ) : null}
        <DebtComposition value={snap?.value} equity={snap?.equity_amount} loan={snap?.total_loan_balance} repairs={snap?.repair_estimate} />
      </section>

      {/* Layer B: Baseline */}
      <section className="nx-di25-layer is-baseline">
        <header className="nx-di25-layer__head"><span>Baseline Property Intelligence</span></header>
        <div className="nx-di25-baseline__grid">
          <ScoreChip label="Acquisition" value={fmtScore(baseline?.acquisition_score)} tone="heat" />
          <ScoreChip label="Deal Strength" value={fmtScore(baseline?.deal_strength_score)} tone="strength" />
          <ScoreChip label="Motivation" value={fmtScore(baseline?.motivation_score)} tone="motivation" />
          <ScoreChip label="Distress" value={fmtScore(baseline?.distress_score)} tone="distress" />
          <ScoreChip label="AI Signal" value={fmtScore(baseline?.ai_score)} tone="ai" />
        </div>
      </section>

      {/* Layer C: Engine */}
      <section className="nx-di25-layer is-engine">
        <header className="nx-di25-layer__head">
          <span>Acquisition Decision Engine</span>
          {engineAvailable ? <em className="nx-di25-engine-badge">AOS {fmtScore(Number(engine.aos_score))}</em> : null}
        </header>

        {engineAvailable ? (
          <div className="nx-di25-engine-results">
            <div className="nx-di25-engine-hero">
              <div>
                <span>Acquisition Opportunity Score</span>
                <strong>{fmtScore(Number(engine.aos_score)) ?? '—'}</strong>
              </div>
              {engine.decision_tier ? <span className="nx-di25-tier">{humanizeEnum(String(engine.decision_tier))}</span> : null}
            </div>
            <FieldRow label="Confidence" value={engine.confidence != null ? `${engine.confidence}%` : null} />
            <FieldRow label="Best Strategy" value={humanizeEnum(String(engine.best_strategy || ''))} />
            <FieldRow label="Recommended Cash Offer" value={fmtMoney(Number(engine.recommended_cash_offer))} />
            <FieldRow label="Minimum Acceptable" value={fmtMoney(Number(engine.minimum_acceptable_offer))} />
            <FieldRow label="Assignment Fee" value={fmtMoney(Number(engine.expected_assignment_fee))} />
            <FieldRow label="Comps" value={engine.comp_count != null ? `${engine.comp_count} weighted · score ${engine.weighted_comp_score ?? '—'}` : null} />
            <FieldRow label="Buyer Demand" value={engine.buyer_demand_score != null ? String(Math.round(Number(engine.buyer_demand_score))) : null} />
            <FieldRow label="Liquidity" value={engine.liquidity_score != null ? String(Math.round(Number(engine.liquidity_score))) : null} />
            <FieldRow label="Owner Situation" value={humanizeEnum(String(engine.owner_situation_primary || ''))} />
            <FieldRow label="Conversation Angle" value={humanizeEnum(String(engine.recommended_conversation_angle || ''))} />
            <ValuationBand
              low={Number(engine.valuation_low)}
              mid={Number(engine.valuation_mid)}
              high={Number(engine.valuation_high)}
              offer={Number(engine.recommended_cash_offer)}
              minOffer={Number(engine.minimum_acceptable_offer)}
              ceiling={Number(engine.investor_ceiling_mid)}
            />
            <StrategyBars engine={engine} />
            <TxProbability engine={engine} />
            {engine.computed_at ? <div className="nx-di25-engine-ts">Run {String(engine.computed_at).slice(0, 16).replace('T', ' ')}</div> : null}
            {!engineRunning ? (
              <button type="button" className="nx-di25-engine-btn is-secondary" onClick={() => void runDecisionEngine()}>Re-run Decision Engine</button>
            ) : null}
          </div>
        ) : (
          <div className="nx-di25-engine-cta">
            <p>Full Decision Engine has not been run for this property.</p>
            <button type="button" className="nx-di25-engine-btn" disabled={engineRunning} onClick={() => void runDecisionEngine()}>
              {engineRunning ? 'Running…' : 'Run Full Decision Engine'}
            </button>
          </div>
        )}

        {engineRunning ? (
          <div className="nx-di25-engine-overlay">
            <div className="nx-di25-engine-overlay__pulse" aria-hidden />
            <div className="nx-di25-engine-overlay__panel">
              <span className="nx-di25-engine-overlay__title">Decision Engine</span>
              <ul>
                {engineProgress.map((step) => (
                  <li key={step.stage} className={cls(step.status === 'done' && 'is-done', step.status === 'running' && 'is-running', step.status === 'error' && 'is-error')}>
                    {step.label}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        {engineError ? <div className="nx-di25-engine-error">Engine failed — prior results retained. {engineError}</div> : null}
      </section>

      {/* Multifamily */}
      {isMultifamily && dossier?.multifamily?.status === 'available' ? (
        <section className="nx-di25-layer">
          <header className="nx-di25-layer__head"><span>Multifamily Intelligence</span></header>
          <div className="nx-di25-field-grid">
            <FieldRow label="Units" value={dossier.multifamily.total_units as number} />
            <FieldRow label="PPU" value={fmtMoney(dossier.multifamily.price_per_unit as number)} />
            <FieldRow label="Comp PPU" value={fmtMoney(dossier.multifamily.comp_median_ppu as number)} />
            <FieldRow label="Avg SF/Unit" value={dossier.multifamily.average_sqft_per_unit ? formatInteger(dossier.multifamily.average_sqft_per_unit as number) : null} />
            <FieldRow label="Buyer PPU" value={fmtMoney(dossier.multifamily.buyer_market_ppu as number)} />
            <FieldRow label="Dominant Buyer" value={humanizeEnum(String(dossier.multifamily.dominant_buyer_type || ''))} />
          </div>
        </section>
      ) : null}

      {/* Signal strip */}
      <section className="nx-di25-strip">
        <div><span>Buyer Market</span><strong>{buyerSignal}</strong></div>
        <div><span>Confidence</span><strong>{engineAvailable && engine.confidence != null ? `${engine.confidence}%` : '—'}</strong></div>
        <div><span>Comps</span><strong>{qual?.candidates_found != null ? `${qual.weighted_usable ?? 0} / ${qual.candidates_found}` : '—'}</strong></div>
        <div><span>Strategy</span><strong>{engineAvailable ? humanizeEnum(String(engine.best_strategy || '')) : 'Run Engine'}</strong></div>
      </section>

      {/* Comps */}
      <DetailSection title="Comparable Sales" defaultOpen>
        {comps?.label ? <p className="nx-di25-muted-note">{comps.label}</p> : null}
        {qual ? (
          <div className="nx-di25-comp-qual">
            <span>{qual.candidates_found ?? 0} candidates</span>
            <span>{qual.asset_type_matches ?? 0} asset match</span>
            <span>{qual.location_qualified ?? 0} location</span>
            <span>{qual.similarity_qualified ?? 0} similarity</span>
            <strong>{qual.weighted_usable ?? 0} weighted usable</strong>
          </div>
        ) : null}
        <FieldRow label="Median Sale" value={fmtMoney(comps?.median_sale)} />
        <FieldRow label="PPSF / PPU" value={
          comps?.median_ppsf ? `$${Math.round(Number(comps.median_ppsf))} PPSF`
            : comps?.median_ppu ? `$${Math.round(Number(comps.median_ppu))} PPU` : null
        } />
        <FieldRow label="Confidence" value={comps?.confidence != null ? `${comps.confidence}%` : null} />
        {visibleComps.map((comp) => (
          <details key={String(comp.id)} className={cls('nx-di25-comp-card', comp.included && 'is-included')}>
            <summary>
              <strong>{comp.address || 'Comp'}</strong>
              <span>{fmtMoney(comp.sale_price)} · {comp.distance_miles != null ? `${comp.distance_miles} mi` : '—'}</span>
            </summary>
            <div className="nx-di25-comp-card__body">
              <FieldRow label="Sale Date" value={comp.sale_date ? String(comp.sale_date).slice(0, 10) : null} />
              <FieldRow label="Type / Units" value={`${comp.property_type || '—'} · ${comp.units ?? '—'}`} />
              <FieldRow label="Beds / Baths" value={`${comp.bedrooms ?? '—'} / ${comp.bathrooms ?? '—'}`} />
              <FieldRow label="Sq Ft" value={comp.sqft ? formatInteger(comp.sqft) : null} />
              <FieldRow label="Similarity" value={comp.similarity_score != null ? `${Math.round(comp.similarity_score)}%` : null} />
              <FieldRow label="Status" value={comp.included ? 'Included' : comp.exclusion_reason} />
            </div>
          </details>
        ))}
        {compRecords.length > 4 ? (
          <button type="button" className="nx-di25-link-btn" onClick={() => setShowAllComps((v) => !v)}>
            {showAllComps ? 'Show fewer comps' : `View all ${compRecords.length} comps`}
          </button>
        ) : null}
      </DetailSection>

      {/* Owner */}
      <DetailSection title="Master Owner">
        <div className="nx-di25-field-grid">
          <FieldRow label="Owner" value={String(owner?.display_name || '')} />
          <FieldRow label="Owner Priority" value={fmtScore(Number(owner?.priority_score))} />
          <FieldRow label="Priority Tier" value={humanizeEnum(String(owner?.priority_tier || ''))} />
          <FieldRow label="Type" value={humanizeEnum(String(owner?.owner_type || ''))} />
          <FieldRow label="Occupancy" value={owner?.absentee_owner ? 'Absentee' : owner?.absentee_owner === false ? 'Owner Occupied' : null} />
          <FieldRow label="Out-of-State" value={owner?.out_of_state_owner ? 'Yes' : owner?.out_of_state_owner === false ? 'No' : null} />
          <FieldRow label="Contact Window" value={String(owner?.contact_window || '')} />
          <FieldRow label="Financial Pressure" value={fmtScore(Number(owner?.financial_pressure_score))} />
          <FieldRow label="Urgency" value={fmtScore(Number(owner?.urgency_score))} />
          <FieldRow label="Contactability" value={owner?.contactability_score != null ? String(owner.contactability_score) : null} />
          <FieldRow label="Best Phone 1" value={String(owner?.best_phone_1 || '')} />
          <FieldRow label="Best Phone 2" value={String(owner?.best_phone_2 || '')} />
          <FieldRow label="Best Email" value={String(owner?.best_email_1 || '')} />
          <FieldRow label="Portfolio Value" value={fmtMoney(Number(owner?.portfolio_value))} />
          <FieldRow label="Portfolio Equity" value={fmtMoney(Number(owner?.portfolio_equity))} />
          <FieldRow label="Properties" value={owner?.property_count != null ? String(owner.property_count) : null} />
          <FieldRow label="Ownership" value={owner?.ownership_years ? `${Math.round(Number(owner.ownership_years))} yrs` : null} />
        </div>
      </DetailSection>

      {/* Prospect */}
      <DetailSection title="Prospect Intelligence">
        <div className="nx-di25-field-grid">
          <FieldRow label="Name" value={String(prospect?.name || '')} />
          <FieldRow label="Age" value={prospect?.age != null ? String(prospect.age) : null} />
          <FieldRow label="Language" value={String(prospect?.language || '')} />
          <FieldRow label="Occupation" value={String(prospect?.occupation || prospect?.occupation_group || '')} />
          <FieldRow label="Income" value={String(prospect?.household_income || '')} />
          <FieldRow label="Net Assets" value={String(prospect?.net_asset_value || '')} />
          <FieldRow label="Contact Score" value={prospect?.contact_score != null ? String(prospect.contact_score) : null} />
        </div>
        {(prospect?.person_flags as string[] | undefined)?.length ? (
          <div className="nx-di25-flags">{((prospect.person_flags as string[]) || []).map((f) => <span key={f} className="nx-di25-flag">{f}</span>)}</div>
        ) : null}
      </DetailSection>

      {/* Phone */}
      <DetailSection title="Phone Intelligence">
        <div className="nx-di25-field-grid">
          <FieldRow label="Primary" value={String(phone?.number || '')} />
          <FieldRow label="Type" value={String(phone?.type || '')} />
          <FieldRow label="Activity" value={String(phone?.activity_status || '')} />
          <FieldRow label="Usage" value={String(phone?.usage || '')} />
          <FieldRow label="Score" value={phone?.contact_score != null ? String(phone.contact_score) : null} />
          <FieldRow label="Window" value={String(phone?.contact_window || '')} />
          <FieldRow label="Wrong Number" value={phone?.wrong_number ? 'Yes' : phone?.wrong_number === false ? 'No' : null} />
        </div>
      </DetailSection>

      {/* Property detail groups */}
      {dossier?.property_detail ? Object.entries(dossier.property_detail).map(([group, fields]) => (
        Object.keys(fields).length ? (
          <DetailSection key={group} title={group.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}>
            <div className="nx-di25-field-grid">
              {Object.entries(fields).map(([key, val]) => (
                <FieldRow key={key} label={key.replace(/_/g, ' ')} value={
                  typeof val === 'number' && (key.includes('value') || key.includes('price') || key.includes('balance') || key.includes('payment') || key.includes('repair'))
                    ? fmtMoney(val) ?? (val === 0 ? '$0' : String(val))
                    : Array.isArray(val) ? val.join(', ') : String(val)
                } />
              ))}
            </div>
          </DetailSection>
        ) : null
      )) : null}

      {/* Activity */}
      <DetailSection title="Activity Timeline">
        {(dossier?.activity_timeline || []).map((event) => (
          <div key={`${event.type}-${event.timestamp}`} className={cls('nx-di25-activity', event.tone && `is-${event.tone}`)}>
            <i />
            <div>
              <strong>{event.label}</strong>
              <span>{event.timestamp ? String(event.timestamp).slice(0, 16).replace('T', ' ') : '—'}</span>
              {event.source ? <em>{event.source}</em> : null}
            </div>
          </div>
        ))}
      </DetailSection>

      {dossier?.census?.status === 'pending' ? (
        <DetailSection title="Census">
          <p className="nx-di25-muted-note">Census enrichment pending</p>
        </DetailSection>
      ) : null}
    </div>
  )
}
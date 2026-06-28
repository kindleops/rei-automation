import React, { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../shared/icons'
import { buildPropertyExternalLinks } from '../../domain/inbox/inbox-normalization'
import { useDealIntelligenceDossier } from '../../domain/deal-intelligence/useDealIntelligenceDossier'
import type { CompRecord } from '../../domain/deal-intelligence/deal-intelligence.types'
import { ENGINE_STAGE_DISPLAY_ORDER, ENGINE_STAGE_LABELS } from '../../domain/deal-intelligence/deal-intelligence.types'
import { humanizeEnum, parseFlagBadges, priorityFlags } from '../../domain/deal-intelligence/deal-intelligence-humanize'
import {
  fmtDiBool,
  fmtDiDate,
  fmtDiFieldValue,
  fmtDiMoney,
  fmtDiPct,
  fmtDiPhone,
  fmtDiScore,
  fmtDiSqft,
  fmtDiText,
  fmtDiUnits,
  fmtPhoneType,
  scoreTone,
} from '../../domain/deal-intelligence/deal-intelligence-format'
import { DealIntelligenceMedia, type MediaTab } from './DealIntelligenceMedia'
import {
  DealIntelligenceCommandRow,
  DealIntelligenceTemperatureBadge,
  type DealIntelligenceLeadStateData,
} from './DealIntelligenceLeadStateBar'
import {
  CONTACTABILITY_META,
  DISPOSITION_META,
  normalizeContactability,
  normalizeDisposition,
} from '../../domain/lead-state/universal-lead-state-registry'
import './deal-intelligence-25.css'
import { useBreakpoint } from '../mobile/useBreakpoint'
import { MobileDealIntelligenceNav, type DealIntelligenceMobileSection } from '../mobile/MobileDealIntelligenceNav'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')
const has = (v: unknown) => v !== null && v !== undefined && v !== ''

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

const FieldRow = ({ label, value, full = false }: { label: string; value: React.ReactNode; full?: boolean }) => {
  if (!has(value)) return null
  return (
    <div className={cls('nx-di25-field', full && 'is-full')}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

const MetricGrid = ({ children }: { children: React.ReactNode }) => (
  <div className="nx-di25-metric-grid">{children}</div>
)

const SnapshotCard = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) => (
  <div className="nx-di25-snap-card">
    <span>{label}</span>
    <strong>{value}</strong>
    {sub ? <em>{sub}</em> : null}
  </div>
)

const EquityDebtBar = ({ equity, loan }: { equity?: number | null; loan?: number | null }) => {
  const eq = Math.max(0, Number(equity) || 0)
  const debt = Math.max(0, Number(loan) || 0)
  const total = eq + debt
  if (!total) return null
  const eqPct = Math.round((eq / total) * 100)
  const debtPct = 100 - eqPct
  return (
    <div className="nx-di25-equity-bar">
      <div className="nx-di25-equity-bar__track">
        {eq > 0 ? <span className="is-equity" style={{ width: `${eqPct}%` }} title={`Equity ${fmtDiMoney(eq)}`} /> : null}
        {debt > 0 ? <span className="is-debt" style={{ width: `${debtPct}%` }} title={`Debt ${fmtDiMoney(debt)}`} /> : null}
        {eq > 0 && debt === 0 ? <span className="is-equity" style={{ width: '100%' }} /> : null}
      </div>
      <div className="nx-di25-equity-bar__labels">
        <span>Equity {fmtDiMoney(eq)} ({eqPct}%)</span>
        <span>Debt {fmtDiMoney(debt)} ({debtPct}%)</span>
      </div>
    </div>
  )
}

const BaselineHero = ({
  acquisition,
  strength,
  motivation,
  distress,
}: {
  acquisition?: number | null
  strength?: number | null
  motivation?: number | null
  distress?: number | null
}) => {
  const score = Number(acquisition) || 0
  const tone = scoreTone(score)
  const circumference = 2 * Math.PI * 42
  const dash = (Math.min(100, Math.max(0, score)) / 100) * circumference
  return (
    <div className="nx-di25-baseline-hero">
      <div className={cls('nx-di25-radial', `is-${tone}`, 'nx-di25-radial--animate')}>
        <svg viewBox="0 0 100 100" aria-hidden>
          <circle className="nx-di25-radial__track" cx="50" cy="50" r="42" />
          <circle
            className="nx-di25-radial__fill"
            cx="50"
            cy="50"
            r="42"
            strokeDasharray={`${dash} ${circumference}`}
            transform="rotate(-90 50 50)"
          />
        </svg>
        <div className="nx-di25-radial__value">
          <strong>{fmtDiScore(score) ?? '—'}</strong>
          <span>Acquisition</span>
        </div>
      </div>
      <div className="nx-di25-baseline-secondary">
        {strength != null ? <div><span>Strength</span><strong>{fmtDiScore(strength)}</strong></div> : null}
        {motivation != null ? <div><span>Motivation</span><strong>{fmtDiScore(motivation)}</strong></div> : null}
        {distress != null ? <div><span>Distress</span><strong>{fmtDiScore(distress)}</strong></div> : null}
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

const StrategyBars = ({ engine }: { engine: Record<string, unknown> }) => {
  const strategies = [
    { key: 'subject_to_score', label: 'Subject-To' },
    { key: 'seller_finance_score', label: 'Seller Finance' },
    { key: 'lease_option_score', label: 'Lease Option' },
    { key: 'novation_score', label: 'Novation' },
  ]
  const scores = strategies.map((s) => ({ ...s, value: Number(engine[s.key]) || 0 })).filter((s) => s.value > 0)
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

const ValuationBand = ({ low, mid, high, offer, ceiling }: {
  low?: number | null; mid?: number | null; high?: number | null; offer?: number | null; ceiling?: number | null
}) => {
  const values = [low, mid, high, offer, ceiling].filter((v) => v != null && v > 0) as number[]
  if (!values.length) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pos = (v: number | null | undefined) => (v != null && v > 0 ? `${((v - min) / span) * 100}%` : null)
  return (
    <div className="nx-di25-val-band">
      <div className="nx-di25-val-band__track">
        <div className="nx-di25-val-band__range" />
        {mid != null ? <i className="nx-di25-val-band__tick is-mid" style={{ left: pos(mid) || '50%' }} /> : null}
        {offer != null ? <i className="nx-di25-val-band__tick is-offer" style={{ left: pos(offer) || '40%' }} /> : null}
        {ceiling != null ? <i className="nx-di25-val-band__tick is-ceiling" style={{ left: pos(ceiling) || '80%' }} /> : null}
      </div>
      <div className="nx-di25-val-band__labels">
        <span>{fmtDiMoney(low) ?? '—'}</span>
        <span>{fmtDiMoney(high) ?? '—'}</span>
      </div>
    </div>
  )
}

const CompCard = ({ comp, isMultifamily }: { comp: CompRecord; isMultifamily: boolean }) => {
  const state = comp.included ? 'included' : comp.similarity_score && Number(comp.similarity_score) >= 30 ? 'candidate' : 'excluded'
  const mapsLink = comp.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(comp.address)}` : null
  return (
    <article className={cls('nx-di25-comp-tile', `is-${state}`)}>
      <header>
        <div>
          <strong>{comp.address || 'Comparable'}</strong>
          <span>{comp.distance_miles != null ? `${comp.distance_miles.toFixed(2)} mi` : '—'}</span>
        </div>
        <em className={cls('nx-di25-comp-state', `is-${state}`)}>
          {state === 'included' ? 'Included' : state === 'candidate' ? 'Candidate' : 'Excluded'}
        </em>
      </header>
      <MetricGrid>
        <FieldRow label="Sale" value={fmtDiMoney(comp.sale_price)} />
        <FieldRow label="Date" value={fmtDiDate(comp.sale_date)} />
        <FieldRow label="Type" value={fmtDiText(comp.property_type)} />
        <FieldRow label="Units" value={fmtDiUnits(comp.units, !isMultifamily)} />
        <FieldRow label="Beds/Baths" value={comp.bedrooms || comp.bathrooms ? `${comp.bedrooms ?? '—'} / ${comp.bathrooms ?? '—'}` : null} />
        <FieldRow label="Sq Ft" value={fmtDiSqft(comp.sqft)} />
        <FieldRow label={isMultifamily ? 'PPU' : 'PPSF'} value={isMultifamily ? fmtDiMoney(comp.ppu) : fmtDiMoney(comp.ppsf)} />
          <FieldRow label="Similarity" value={comp.similarity_score != null ? fmtDiPct(comp.similarity_score) : null} />
        <FieldRow label="Weight" value={comp.weight != null ? fmtDiScore(comp.weight) : null} />
        <FieldRow label="Reason" value={comp.included ? null : fmtDiText(comp.exclusion_reason)} full />
      </MetricGrid>
      {mapsLink ? <a className="nx-di25-comp-link" href={mapsLink} target="_blank" rel="noopener noreferrer">View property</a> : null}
    </article>
  )
}

const EngineGroup = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="nx-di25-engine-group">
    <h4>{title}</h4>
    {children}
  </div>
)

export const DealIntelligence25Panel = ({
  threadKey, propertyId, prospectId, masterOwnerId, canonicalE164, fallbackAddress,
}: {
  threadKey?: string
  propertyId?: string
  prospectId?: string
  masterOwnerId?: string
  canonicalE164?: string
  fallbackAddress?: string | null
}) => {
  const { dossier, loading, error, refresh, runDecisionEngine, engineRunning, engineError, engineProgress } = useDealIntelligenceDossier({
    threadKey, propertyId, prospectId, masterOwnerId, canonicalE164,
  })

  const { isMobile } = useBreakpoint()
  const [mobileSection, setMobileSection] = useState<DealIntelligenceMobileSection>('overview')
  const [mediaTab, setMediaTab] = useState<MediaTab>('street')
  const [showAllComps, setShowAllComps] = useState(false)
  const [addrCopied, setAddrCopied] = useState(false)
  const [activityAsc, setActivityAsc] = useState(false)
  const showDi = (section: DealIntelligenceMobileSection) => !isMobile || mobileSection === section

  const address = dossier?.property?.full_address || fallbackAddress || null
  const links = useMemo(() => buildPropertyExternalLinks(address), [address])
  const snap = dossier?.property_snapshot
  const baseline = dossier?.baseline_scores
  const property = dossier?.property
  const owner = dossier?.master_owner
  const prospect = dossier?.prospect
  const phone = dossier?.phone
  const convo = dossier?.conversation_intelligence
  const engine = dossier?.acquisition_decision
  const engineAvailable = engine?.status === 'available'
  const comps = dossier?.comps
  const qual = comps?.qualification
  const isSfr = !((property?.units || 0) > 1) && !/multi|duplex|triplex|fourplex|apt/i.test(String(property?.property_type || ''))
  const isMultifamily = !isSfr

  const flags = useMemo(() => priorityFlags(property?.property_flags || []), [property?.property_flags])
  const visibleFlags = flags.slice(0, 4)
  const overflowCount = Math.max(0, flags.length - 4)

  useEffect(() => {
    document.body.classList.toggle('nx-di25-engine-active', engineRunning)
    return () => document.body.classList.remove('nx-di25-engine-active')
  }, [engineRunning])

  const copyAddress = () => {
    if (!address) return
    navigator.clipboard.writeText(address).catch(() => undefined)
    setAddrCopied(true)
    setTimeout(() => setAddrCopied(false), 1400)
  }

  const displayProgress = useMemo(
    () => ENGINE_STAGE_DISPLAY_ORDER.map((stage) => {
      const match = engineProgress.find((s) => s.stage === stage)
      return {
        stage,
        status: match?.status || 'running',
        label: ENGINE_STAGE_LABELS[stage],
      }
    }),
    [engineProgress],
  )

  if (loading) {
    return (
      <div className="nx-deal-compact-shell nx-di25-loading">
        {fallbackAddress ? <p className="nx-di25-loading__address">{fallbackAddress}</p> : null}
        <p>Loading deal intelligence…</p>
      </div>
    )
  }
  if (error && !dossier) return <div className="nx-deal-compact-shell nx-di25-error">{error}</div>

  const compRecords = (comps?.records || []) as CompRecord[]
  const visibleComps = showAllComps ? compRecords : compRecords.slice(0, 4)
  const buyerSignal = dossier?.buyer_market?.status === 'no_coverage'
    ? 'No qualified rollup'
    : String(dossier?.buyer_market?.signal || 'Resolving…')

  const activityEvents = [...(dossier?.activity_timeline || [])].sort((a, b) => {
    const at = new Date(a.timestamp || 0).getTime()
    const bt = new Date(b.timestamp || 0).getTime()
    return activityAsc ? at - bt : bt - at
  })

  const relationshipFlags = parseFlagBadges(prospect?.relationship_flags || prospect?.matching_flags)
  const personFlags = parseFlagBadges(prospect?.person_flags)

  const leadStateData: DealIntelligenceLeadStateData | null = threadKey ? {
    threadKey,
    lifecycle_stage: convo?.lifecycle_stage,
    operational_status: convo?.operational_status,
    lead_temperature: convo?.lead_temperature,
    is_starred: convo?.is_starred,
    is_pinned: convo?.is_pinned,
    is_archived: convo?.is_archived,
    snoozed_until: convo?.snoozed_until,
    manual_stage_lock: convo?.manual_stage_lock,
    manual_temperature_lock: convo?.manual_temperature_lock,
  } : null

  const dispositionCode = convo?.disposition ? normalizeDisposition(String(convo.disposition)) : null
  const dispositionMeta = dispositionCode && dispositionCode !== 'none'
    ? DISPOSITION_META[dispositionCode]
    : null
  const contactabilityCode = convo?.contactability_status
    ? normalizeContactability(String(convo.contactability_status))
    : phone?.contactability_status
      ? normalizeContactability(String(phone.contactability_status))
      : null
  const contactabilityMeta = contactabilityCode ? CONTACTABILITY_META[contactabilityCode] : null

  return (
    <div className={cls('nx-deal-compact-shell', engineRunning && 'is-engine-running', isMobile && 'is-mobile-di')}>
      {isMobile ? (
        <MobileDealIntelligenceNav active={mobileSection} onChange={setMobileSection} />
      ) : null}
      {showDi('overview') ? (
      <>
      <div className="nx-di25-media">
        <div className="nx-di25-media__tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mediaTab === 'street'} className={cls('nx-di25-media__tab', mediaTab === 'street' && 'is-active')} onClick={() => setMediaTab('street')}>Street View</button>
          <button type="button" role="tab" aria-selected={mediaTab === 'aerial'} className={cls('nx-di25-media__tab', mediaTab === 'aerial' && 'is-active')} onClick={() => setMediaTab('aerial')}>Aerial</button>
        </div>
        <DealIntelligenceMedia
          activeTab={mediaTab}
          address={address}
          lat={property?.latitude}
          lng={property?.longitude}
          streetStoredUrl={property?.street_view_url}
          aerialStoredUrl={property?.satellite_url}
        />
        <div className="nx-di25-media__actions">
          {links.zillow ? <a href={links.zillow} target="_blank" rel="noopener noreferrer">Zillow</a> : null}
          {links.realtor ? <a href={links.realtor} target="_blank" rel="noopener noreferrer">Realtor</a> : null}
          {links.googleSearch ? <a href={links.googleSearch} target="_blank" rel="noopener noreferrer">Google</a> : null}
          <button type="button" onClick={copyAddress}>{addrCopied ? 'Copied' : 'Copy Address'}</button>
        </div>
      </div>

      {leadStateData ? (
        <DealIntelligenceCommandRow data={leadStateData} onPatched={() => void refresh()} />
      ) : null}

      <section className="nx-di25-identity">
        <div className="nx-di25-identity__head">
          <h2>{address || 'Property unknown'}</h2>
          {threadKey ? (
            <DealIntelligenceTemperatureBadge
              threadKey={threadKey}
              temperature={convo?.lead_temperature}
              manualTemperatureLock={convo?.manual_temperature_lock}
              onPatched={() => void refresh()}
            />
          ) : null}
        </div>
        <div className="nx-di25-identity__meta">
          {property?.market ? <span className="nx-di25-badge">{property.market}</span> : null}
          {property?.property_type ? <span className="nx-di25-badge is-type">{property.property_type}</span> : null}
          {property?.property_class ? <span className="nx-di25-badge">{property.property_class}</span> : null}
          {fmtDiUnits(property?.units, isSfr) ? <span className="nx-di25-badge">{fmtDiUnits(property?.units, isSfr)}</span> : null}
          {property?.condition ? <span className="nx-di25-badge is-condition">{property.condition}</span> : null}
        </div>
        {visibleFlags.length ? (
          <div className="nx-di25-flags">
            {visibleFlags.map((flag) => <span key={flag} className="nx-di25-flag">{flag}</span>)}
            {overflowCount > 0 ? <span className="nx-di25-flag is-overflow">+{overflowCount}</span> : null}
          </div>
        ) : null}
      </section>
      </>
      ) : null}

      {showDi('property') ? (
      <>
      <section className="nx-di25-layer">
        <header className="nx-di25-layer__head"><span>Property Snapshot</span></header>
        <div className="nx-di25-snap-grid">
          <SnapshotCard label="Value" value={fmtDiMoney(snap?.value) ?? '—'} />
          <SnapshotCard label="Equity" value={fmtDiMoney(snap?.equity_amount) ?? '—'} sub={snap?.equity_percentage != null ? fmtDiPct(snap.equity_percentage) : null} />
          <SnapshotCard label="Debt" value={snap?.total_loan_balance != null ? fmtDiMoney(snap.total_loan_balance) ?? '$0' : '—'} />
          <SnapshotCard label="Repairs" value={fmtDiMoney(snap?.repair_estimate) ?? '—'} />
          <SnapshotCard label="Last Sale" value={fmtDiMoney(snap?.last_sale_price) ?? '—'} sub={fmtDiDate(snap?.last_sale_date)} />
          <SnapshotCard label="Ownership" value={snap?.ownership_years ? `${Math.round(snap.ownership_years)} yrs` : '—'} />
        </div>
        {snap?.appreciation ? (
          <div className="nx-di25-appreciation">
            <span>Last sale → current value</span>
            <strong>{fmtDiMoney(snap.appreciation.dollar_change)} ({fmtDiPct(snap.appreciation.percent_change)})</strong>
            <em>{snap.appreciation.holding_period_years} yr hold</em>
          </div>
        ) : null}
        <EquityDebtBar equity={snap?.equity_amount} loan={snap?.total_loan_balance} />
      </section>
      <section className="nx-di25-layer is-baseline">
        <header className="nx-di25-layer__head"><span>Baseline Property Intelligence</span></header>
        <BaselineHero
          acquisition={baseline?.acquisition_score ?? (engineAvailable ? Number(engine.aos_score) : null)}
          strength={baseline?.deal_strength_score}
          motivation={baseline?.motivation_score}
          distress={baseline?.distress_score}
        />
      </section>
      </>
      ) : null}

      {showDi('deal') ? (
      <section className="nx-di25-layer is-engine">
        <header className="nx-di25-layer__head">
          <span>Full Acquisition Decision Engine</span>
          {engineAvailable ? <em className="nx-di25-engine-badge">AOS {fmtDiScore(Number(engine.aos_score))}</em> : null}
        </header>

        <div className="nx-di25-engine-body">
          {!engineAvailable && !engineRunning ? (
            <div className="nx-di25-engine-cta">
              <p>Run the full engine to generate AOS, valuation range, strategy comparison, and offer stack from qualified comps.</p>
              <MetricGrid>
                <FieldRow label="Baseline Acquisition" value={fmtDiScore(baseline?.acquisition_score)} />
                <FieldRow label="Candidates" value={qual?.candidates_found != null ? String(qual.candidates_found) : null} />
                <FieldRow label="Qualified" value={qual?.weighted_usable != null ? String(qual.weighted_usable) : null} />
              </MetricGrid>
              <button type="button" className="nx-di25-engine-btn" onClick={() => void runDecisionEngine()}>Run Full Decision Engine</button>
            </div>
          ) : null}

          {engineAvailable ? (
            <div className="nx-di25-engine-results">
              <EngineGroup title="Decision">
                <MetricGrid>
                  <FieldRow label="AOS" value={fmtDiScore(Number(engine.aos_score))} />
                  <FieldRow label="Confidence" value={engine.confidence != null ? fmtDiPct(Number(engine.confidence)) : null} />
                  <FieldRow label="Tier" value={humanizeEnum(String(engine.decision_tier || ''))} />
                  <FieldRow label="Computed" value={fmtDiDate(String(engine.computed_at || ''))} full />
                </MetricGrid>
              </EngineGroup>
              <EngineGroup title="Offer">
                <MetricGrid>
                  <FieldRow label="Cash Offer" value={fmtDiMoney(Number(engine.recommended_cash_offer))} />
                  <FieldRow label="Minimum" value={fmtDiMoney(Number(engine.minimum_acceptable_offer))} />
                  <FieldRow label="Assignment Fee" value={fmtDiMoney(Number(engine.expected_assignment_fee))} />
                  <FieldRow label="Ceiling Mid" value={fmtDiMoney(Number(engine.investor_ceiling_mid))} />
                </MetricGrid>
                <ValuationBand
                  low={Number(engine.valuation_low)}
                  mid={Number(engine.valuation_mid)}
                  high={Number(engine.valuation_high)}
                  offer={Number(engine.recommended_cash_offer)}
                  ceiling={Number(engine.investor_ceiling_mid)}
                />
              </EngineGroup>
              <EngineGroup title="Strategy">
                <FieldRow label="Best Strategy" value={humanizeEnum(String(engine.best_strategy || ''))} full />
                <StrategyBars engine={engine} />
              </EngineGroup>
              <EngineGroup title="Pressure & Probability">
                <MetricGrid>
                  <FieldRow label="Seller Pressure" value={fmtDiScore(Number(engine.seller_financial_pressure_score))} />
                  <FieldRow label="Forced Sale" value={fmtDiScore(Number(engine.forced_sale_pressure_score))} />
                  <FieldRow label="Foreclosure Risk" value={fmtDiScore(Number(engine.foreclosure_risk_score))} />
                  <FieldRow label="90d Probability" value={engine.transaction_probability_90 != null ? fmtDiPct(Number(engine.transaction_probability_90)) : null} />
                  <FieldRow label="180d Probability" value={engine.transaction_probability_180 != null ? fmtDiPct(Number(engine.transaction_probability_180)) : null} />
                  <FieldRow label="365d Probability" value={engine.transaction_probability_365 != null ? fmtDiPct(Number(engine.transaction_probability_365)) : null} />
                  <FieldRow label="Landlord Fatigue" value={fmtDiScore(Number(engine.landlord_fatigue_score))} />
                  <FieldRow label="Tax Pain" value={fmtDiScore(Number(engine.tax_pain_score))} />
                  <FieldRow label="Equity Unlock" value={fmtDiScore(Number(engine.equity_unlock_score))} />
                  <FieldRow label="Debt Pressure" value={fmtDiScore(Number(engine.debt_pressure_score))} />
                  <FieldRow label="Repair Burden" value={fmtDiScore(Number(engine.repair_burden_score))} />
                </MetricGrid>
              </EngineGroup>
              <EngineGroup title="Recommended Execution">
                <MetricGrid>
                  <FieldRow label="Owner Situation" value={humanizeEnum(String(engine.owner_situation_primary || ''))} full />
                  <FieldRow label="Conversation Angle" value={humanizeEnum(String(engine.recommended_conversation_angle || ''))} full />
                  <FieldRow label="Next Action" value={humanizeEnum(String(dossier?.decision_snapshot?.recommended_next_action || ''))} full />
                </MetricGrid>
              </EngineGroup>
              {!engineRunning ? (
                <button type="button" className="nx-di25-engine-btn is-secondary" onClick={() => void runDecisionEngine()}>Re-run Decision Engine</button>
              ) : null}
            </div>
          ) : null}

          {engineRunning ? (
            <div className="nx-di25-engine-overlay" role="status" aria-live="polite">
              <div className="nx-di25-engine-overlay__pulse" aria-hidden />
              <div className="nx-di25-engine-overlay__panel">
                <span className="nx-di25-engine-overlay__title">Decision Engine</span>
                <ul>
                  {displayProgress.map((step) => (
                    <li key={step.stage} className={cls(step.status === 'done' && 'is-done', step.status === 'running' && 'is-running', step.status === 'error' && 'is-error')}>
                      {step.label}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
          {engineError ? (
          <div className="nx-di25-engine-error">
            Engine failed — prior results retained. {humanizeEnum(engineError.replace(/_/g, ' ')) || engineError}
          </div>
        ) : null}
        </div>
      </section>
      ) : null}

      {showDi('property') && isMultifamily && dossier?.multifamily?.status === 'available' ? (
        <section className="nx-di25-layer">
          <header className="nx-di25-layer__head"><span>Multifamily Intelligence</span></header>
          <MetricGrid>
            <FieldRow label="Units" value={dossier.multifamily.total_units as number} />
            <FieldRow label="PPU" value={fmtDiMoney(dossier.multifamily.price_per_unit as number)} />
            <FieldRow label="Comp PPU" value={fmtDiMoney(dossier.multifamily.comp_median_ppu as number)} />
          </MetricGrid>
        </section>
      ) : null}

      {showDi('overview') ? (
      <section className="nx-di25-strip">
        <div><span>Buyer Market</span><strong>{buyerSignal}</strong></div>
        <div><span>Confidence</span><strong>{engineAvailable && engine.confidence != null ? fmtDiPct(Number(engine.confidence)) : '—'}</strong></div>
        <div><span>Comps</span><strong>{qual?.candidates_found != null ? `${qual.weighted_usable ?? 0} / ${qual.candidates_found}` : '—'}</strong></div>
        <div><span>Strategy</span><strong>{engineAvailable ? humanizeEnum(String(engine.best_strategy || '')) : 'Run Engine'}</strong></div>
      </section>
      ) : null}

      {showDi('comps') ? (
      <DetailSection title="Comparable Sales" defaultOpen>
        {comps?.label ? <p className="nx-di25-muted-note nx-di25-warning">{comps.label}</p> : null}
        {qual ? (
          <div className="nx-di25-comp-qual">
            <span>{qual.candidates_found ?? 0} candidates</span>
            <span>{qual.asset_type_matches ?? 0} asset match</span>
            <span>{qual.location_qualified ?? 0} location</span>
            <span>{qual.similarity_qualified ?? 0} similarity</span>
            <strong>{qual.weighted_usable ?? 0} weighted usable</strong>
          </div>
        ) : null}
        <MetricGrid>
          <FieldRow label="Median Sale" value={fmtDiMoney(comps?.median_sale)} />
          <FieldRow label={isMultifamily ? 'Median PPU' : 'Median PPSF'} value={isMultifamily ? fmtDiMoney(comps?.median_ppu) : fmtDiMoney(comps?.median_ppsf)} />
          <FieldRow label="Confidence" value={comps?.confidence != null && (qual?.weighted_usable || 0) >= 3 ? fmtDiPct(comps.confidence) : (qual?.weighted_usable || 0) < 3 ? 'Low sample' : null} />
        </MetricGrid>
        <div className="nx-di25-comp-list">
          {visibleComps.map((comp) => <CompCard key={String(comp.id)} comp={comp} isMultifamily={isMultifamily} />)}
        </div>
        {compRecords.length > 4 ? (
          <button type="button" className="nx-di25-link-btn" onClick={() => setShowAllComps((v) => !v)}>
            {showAllComps ? 'Show fewer comps' : `View all ${compRecords.length} comps`}
          </button>
        ) : null}
      </DetailSection>
      ) : null}

      {showDi('seller') && convo?.status === 'available' ? (
        <DetailSection title="Conversation Intelligence" defaultOpen>
          <MetricGrid>
            <FieldRow label="Reply Intent" value={humanizeEnum(String(convo.reply_intent || convo.latest_intent || ''))} />
            {(has(convo.seller_state) || dispositionMeta) ? (
              <FieldRow
                label="Seller State"
                value={(
                  <span className="nx-di25-seller-state">
                    {has(convo.seller_state) ? humanizeEnum(String(convo.seller_state || '')) : '—'}
                    {dispositionMeta ? (
                      <span
                        className="nx-di25-disposition-chip"
                        style={{
                          color: dispositionMeta.color,
                          borderColor: `color-mix(in srgb, ${dispositionMeta.color} 36%, transparent)`,
                          background: `color-mix(in srgb, ${dispositionMeta.color} 12%, transparent)`,
                        }}
                      >
                        {dispositionMeta.label}
                      </span>
                    ) : null}
                  </span>
                )}
              />
            ) : null}
            <FieldRow label="Sentiment" value={humanizeEnum(String(convo.sentiment || ''))} />
            <FieldRow label="Language" value={fmtDiText(convo.language)} />
            <FieldRow label="Last Response" value={fmtDiDate(String(convo.last_seller_response_at || ''))} />
            <FieldRow label="Next Follow-up" value={fmtDiDate(String(convo.next_follow_up_at || ''))} />
            <FieldRow label="Conversation Angle" value={humanizeEnum(String(convo.recommended_conversation_angle || ''))} full />
            <FieldRow label="Latest Inbound" value={String(convo.latest_inbound_summary || '').slice(0, 160)} full />
          </MetricGrid>
        </DetailSection>
      ) : null}

      {showDi('seller') ? (
      <>
      <DetailSection title="Master Owner">
        <MetricGrid>
          <FieldRow label="Owner" value={fmtDiText(owner?.display_name)} full />
          <FieldRow label="Owner Priority" value={fmtDiScore(Number(owner?.priority_score))} />
          <FieldRow label="Type" value={humanizeEnum(String(owner?.owner_type || ''))} />
          <FieldRow label="Portfolio Value" value={fmtDiMoney(Number(owner?.portfolio_value))} />
          <FieldRow label="Properties" value={owner?.property_count != null ? String(owner.property_count) : null} />
        </MetricGrid>
      </DetailSection>
      <DetailSection title="Prospect Intelligence">
        <MetricGrid>
          <FieldRow label="Name" value={fmtDiText(prospect?.name)} full />
          <FieldRow label="Age" value={prospect?.age != null ? String(prospect.age) : null} />
          <FieldRow label="Gender" value={fmtDiText(prospect?.gender)} />
          <FieldRow label="Marital Status" value={fmtDiText(prospect?.marital_status)} />
          <FieldRow label="Language" value={fmtDiText(prospect?.language)} />
          <FieldRow label="Education" value={fmtDiText(prospect?.education)} />
          <FieldRow label="Occupation Group" value={fmtDiText(prospect?.occupation_group)} />
          <FieldRow label="Occupation" value={fmtDiText(prospect?.occupation)} />
          <FieldRow label="Income" value={fmtDiText(prospect?.household_income)} />
          <FieldRow label="Net Assets" value={fmtDiText(prospect?.net_asset_value)} />
          <FieldRow label="Buying Power" value={fmtDiText(prospect?.buying_power)} />
          <FieldRow label="Likely Owner" value={fmtDiBool(prospect?.likely_owner as boolean)} />
          <FieldRow label="Likely Renter" value={fmtDiBool(prospect?.likely_renter as boolean)} />
          <FieldRow label="Best Email" value={fmtDiText(prospect?.best_email)} full />
        </MetricGrid>
        {relationshipFlags.length ? (
          <div className="nx-di25-flags">{relationshipFlags.map((f) => <span key={f} className="nx-di25-flag is-relationship">{humanizeEnum(f)}</span>)}</div>
        ) : null}
        {personFlags.length ? (
          <div className="nx-di25-flags">{personFlags.map((f) => <span key={f} className="nx-di25-flag">{f}</span>)}</div>
        ) : null}
      </DetailSection>
      </>
      ) : null}

      {showDi('contact') ? (
      <DetailSection title="Phone Intelligence">
        {contactabilityMeta ? (
          <div
            className={cls('nx-di25-contactability', contactabilityMeta.blocksSend && 'is-blocked')}
            style={{
              color: contactabilityMeta.color,
              borderColor: `color-mix(in srgb, ${contactabilityMeta.color} 40%, transparent)`,
              background: `color-mix(in srgb, ${contactabilityMeta.color} ${contactabilityMeta.blocksSend ? '16' : '10'}%, transparent)`,
            }}
          >
            <strong>{contactabilityMeta.label}</strong>
            {contactabilityMeta.blocksSend ? <span>Outbound messaging blocked</span> : <span>Eligible for outreach</span>}
          </div>
        ) : null}
        <MetricGrid>
          <FieldRow label="Primary" value={fmtDiPhone(String(phone?.number || ''))} full />
          {(phone?.alternate_numbers as string[] | undefined)?.map((alt, i) => (
            <FieldRow key={alt} label={`Alternate ${i + 1}`} value={fmtDiPhone(alt)} full />
          ))}
          <FieldRow label="Type" value={fmtPhoneType(String(phone?.type || ''))} />
          <FieldRow label="Activity" value={fmtDiText(phone?.activity_status)} />
          <FieldRow label="Usage" value={fmtDiText(phone?.usage)} />
          <FieldRow label="Phone Score" value={fmtDiScore(Number(phone?.phone_score))} />
          <FieldRow label="Contact Score" value={fmtDiScore(Number(phone?.contact_score))} />
          <FieldRow label="Contact Window" value={fmtDiText(phone?.contact_window)} />
          <FieldRow label="Timezone" value={fmtDiText(phone?.timezone)} />
          <FieldRow label="Wrong Number" value={fmtDiBool(phone?.wrong_number as boolean)} />
          <FieldRow label="SMS Eligible" value={fmtDiBool(phone?.sms_eligible as boolean)} />
          <FieldRow label="Suppressed" value={phone?.suppressed ? `Yes${phone?.suppression_reason ? ` · ${phone.suppression_reason}` : ''}` : phone?.suppressed === false ? 'No' : null} full />
        </MetricGrid>
      </DetailSection>
      ) : null}

      {showDi('property') && dossier?.property_detail ? Object.entries(dossier.property_detail).map(([group, fields]) => (
        Object.keys(fields).length ? (
          <DetailSection key={group} title={group.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}>
            <MetricGrid>
              {Object.entries(fields).map(([key, val]) => (
                <FieldRow
                  key={key}
                  label={key.replace(/_/g, ' ')}
                  value={fmtDiFieldValue(key, val, isSfr)}
                  full={key.includes('flags') || String(val).length > 28}
                />
              ))}
            </MetricGrid>
          </DetailSection>
        ) : null
      )) : null}

      {showDi('activity') ? (
      <DetailSection title="Activity Timeline">
        <button type="button" className="nx-di25-link-btn nx-di25-sort-btn" onClick={() => setActivityAsc((v) => !v)}>
          {activityAsc ? 'Oldest first' : 'Newest first'}
        </button>
        {activityEvents.map((event) => (
          <div key={`${event.type}-${event.timestamp}-${event.label}`} className={cls('nx-di25-activity', event.tone && `is-${event.tone}`)}>
            <i />
            <div>
              <strong>{event.label}</strong>
              <span>{event.timestamp ? fmtDiDate(event.timestamp) : '—'}</span>
              {event.source ? <em>{event.source}</em> : null}
              {event.detail ? <p>{event.detail}</p> : null}
            </div>
          </div>
        ))}
      </DetailSection>
      ) : null}

      {showDi('property') && dossier?.census?.status === 'pending' ? (
        <DetailSection title="Census">
          <p className="nx-di25-muted-note">Census enrichment pending</p>
        </DetailSection>
      ) : null}
    </div>
  )
}
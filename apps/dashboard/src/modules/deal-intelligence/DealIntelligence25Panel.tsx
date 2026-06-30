import React, { useEffect, useMemo, useState } from 'react'
import { formatInteger } from '../../shared/formatters'
import { Icon, type IconName } from '../../shared/icons'
import { buildPropertyExternalLinks } from '../../domain/inbox/inbox-normalization'
import { useDealIntelligenceDossier } from '../../domain/deal-intelligence/useDealIntelligenceDossier'
import type { EngineRunPhase } from '../../domain/deal-intelligence/useDealIntelligenceDossier'
import type {
  ActivityEvent,
  CompQualification,
  CompRecord,
  DealIntelligenceDossier,
  DealIntelligenceProperty,
  EngineProgressStage,
} from '../../domain/deal-intelligence/deal-intelligence.types'
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
import { buildMapFocusCompFromRecord, openInboxMapComp } from '../../views/map/command-map-bridge'
import './deal-intelligence-25.css'

type DealIntelligenceSection =
  | 'overview'
  | 'property'
  | 'seller'
  | 'deal'
  | 'comps'
  | 'contact'
  | 'activity'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')
const has = (v: unknown) => v !== null && v !== undefined && v !== ''

const splitPropertyAddress = (address?: string | null, market?: string | null) => {
  const raw = String(address || '').trim()
  if (!raw) {
    return { street: 'Property unknown', locality: market?.trim() || null }
  }
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length >= 2) {
    return { street: parts[0], locality: parts.slice(1).join(', ') }
  }
  return { street: raw, locality: market?.trim() || null }
}

type IntelTone =
  | 'conversation'
  | 'owner'
  | 'prospect'
  | 'phone'
  | 'valuation'
  | 'sale'
  | 'physical'
  | 'distress'
  | 'activity'

const INTEL_LAYER_HINTS: Record<IntelTone, string> = {
  conversation: 'Thread signals & seller posture',
  owner: 'Portfolio & entity profile',
  prospect: 'Person-level enrichment',
  phone: 'Reachability & routing',
  valuation: 'Value, equity & debt stack',
  sale: 'Transfer & recording trail',
  physical: 'Building & site profile',
  distress: 'Risk & motivation signals',
  activity: 'Operational event history',
}

const IntelligenceLayer = ({
  title,
  tone,
  hint,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string
  tone: IntelTone
  hint?: string
  badge?: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) => {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={cls('nx-di25-intel', `is-${tone}`, open && 'is-open')}>
      <button type="button" className="nx-di25-intel__toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <div className="nx-di25-intel__title">
          <span>{title}</span>
          <em>{hint || INTEL_LAYER_HINTS[tone]}</em>
        </div>
        <div className="nx-di25-intel__meta">
          {badge ? <span className="nx-di25-intel__badge">{badge}</span> : null}
          <Icon name={open ? 'chevron-up' : 'chevron-down'} />
        </div>
      </button>
      {open ? <div className="nx-di25-intel__body">{children}</div> : null}
    </section>
  )
}

const IntelHeroStrip = ({ children }: { children: React.ReactNode }) => (
  <div className="nx-di25-intel-hero">{children}</div>
)

const IntelHeroMetric = ({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  accent?: boolean
}) => (
  <div className={cls('nx-di25-intel-hero__metric', accent && 'is-accent')}>
    <span>{label}</span>
    <strong>{value}</strong>
    {sub ? <em>{sub}</em> : null}
  </div>
)

const IntelTileGrid = ({ children }: { children: React.ReactNode }) => (
  <div className="nx-di25-intel-tiles">{children}</div>
)

const IntelTile = ({ label, value }: { label: string; value: React.ReactNode }) => {
  if (!has(value)) return null
  return (
    <div className="nx-di25-intel-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

const IntelInsight = ({ label, value }: { label: string; value: React.ReactNode }) => {
  if (!has(value)) return null
  return (
    <div className="nx-di25-intel-insight">
      <span>{label}</span>
      <p>{value}</p>
    </div>
  )
}

const IntelStatusCard = ({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: React.ReactNode
  tone?: 'neutral' | 'positive' | 'warning' | 'danger'
}) => {
  if (!has(value)) return null
  return (
    <div className={cls('nx-di25-intel-status', `is-${tone}`)}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

const DetailSection = ({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) => (
  <IntelligenceLayer title={title} tone="activity" hint="Supplemental enrichment" defaultOpen={defaultOpen}>
    {children}
  </IntelligenceLayer>
)

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

const ScoreRadial = ({
  score,
  label,
  sublabel,
  size = 'md',
  variant = 'default',
  showDenom = false,
}: {
  score?: number | null
  label: string
  sublabel?: string
  size?: 'md' | 'lg'
  variant?: 'default' | 'aos'
  showDenom?: boolean
}) => {
  const numeric = score != null && Number.isFinite(Number(score)) ? Number(score) : null
  const tone = numeric != null ? scoreTone(numeric) : 'muted'
  const progress = numeric != null ? Math.min(100, Math.max(0, numeric)) : 0
  const display = numeric != null ? (fmtDiScore(numeric) ?? '—') : '—'

  return (
    <div className={cls('nx-di25-score-radial', `is-${tone}`, `is-${size}`, variant === 'aos' && 'is-aos-variant')}>
      <div
        className={cls('nx-di25-radial-dial', `is-${tone}`, numeric != null && 'is-animated')}
        style={{ ['--ring-progress' as string]: `${progress}%` }}
        aria-label={`${label} ${display}`}
      >
        <div className="nx-di25-radial-dial__inner">
          <strong className="nx-di25-radial-dial__score">{display}</strong>
          {showDenom ? <span className="nx-di25-radial-dial__denom">/100</span> : null}
        </div>
      </div>
      <div className="nx-di25-radial__caption">
        <span>{label}</span>
        {sublabel ? <em>{sublabel}</em> : null}
      </div>
    </div>
  )
}



const BaselineMetricRow = ({
  shortLabel,
  fullLabel,
  value,
  tone,
}: {
  shortLabel: string
  fullLabel: string
  value?: number | null
  tone: 'strength' | 'motivation' | 'distress'
}) => {
  const numeric = value != null && Number.isFinite(Number(value)) ? Number(value) : null
  const display = numeric != null ? (fmtDiScore(numeric) ?? '—') : '—'
  const fill = numeric != null ? Math.min(100, Math.max(0, numeric)) : 0
  const heat = numeric != null ? scoreTone(numeric) : 'muted'

  return (
    <div className={cls('nx-di25-baseline-metric', `is-${tone}`, `is-heat-${heat}`)}>
      <div className="nx-di25-baseline-metric__row">
        <div className="nx-di25-baseline-metric__copy">
          <span className="nx-di25-baseline-metric__short">{shortLabel}</span>
          <em className="nx-di25-baseline-metric__full">{fullLabel}</em>
        </div>
        <strong className="nx-di25-baseline-metric__value">{display}</strong>
      </div>
      <div className="nx-di25-baseline-metric__track" aria-hidden>
        <span className="nx-di25-baseline-metric__fill" style={{ width: `${fill}%` }} />
      </div>
    </div>
  )
}

const BaselineHero = ({
  finalAcq,
  dealStrength,
  structuredMotivation,
  tagDistress,
}: {
  finalAcq?: number | null
  dealStrength?: number | null
  structuredMotivation?: number | null
  tagDistress?: number | null
}) => {
  const acqTone = finalAcq != null && Number.isFinite(Number(finalAcq)) ? scoreTone(Number(finalAcq)) : 'muted'

  return (
    <div className="nx-di25-baseline-hero">
      <div className={cls('nx-di25-baseline-hero__anchor', `is-${acqTone}`)}>
        <ScoreRadial score={finalAcq} label="Final Acq" sublabel="Property baseline" showDenom />
      </div>
      <div className="nx-di25-baseline-metrics">
        <BaselineMetricRow shortLabel="Motivation" fullLabel="Structured motivation" value={structuredMotivation} tone="motivation" />
        <BaselineMetricRow shortLabel="Strength" fullLabel="Deal strength" value={dealStrength} tone="strength" />
        <BaselineMetricRow shortLabel="Distress" fullLabel="Tag distress" value={tagDistress} tone="distress" />
      </div>
    </div>
  )
}

const ENGINE_FEATURES = [
  { icon: 'target' as const, label: 'AOS score' },
  { icon: 'dollar-sign' as const, label: 'Offer stack' },
  { icon: 'briefcase' as const, label: 'Strategy fit' },
  { icon: 'stats' as const, label: 'Valuation' },
]

const ENGINE_STAGE_ICONS: Record<EngineProgressStage, IconName> = {
  resolving_property: 'home',
  loading_comps: 'database',
  qualifying_comps: 'filter',
  calculating_valuation: 'stats',
  measuring_buyer_demand: 'users',
  evaluating_seller_pressure: 'activity',
  comparing_strategies: 'briefcase',
  building_offer_stack: 'dollar-sign',
  calculating_confidence: 'target',
  persisting_decision: 'database',
  decision_ready: 'check-double',
}

type EngineRunStep = {
  stage: EngineProgressStage
  status: 'pending' | 'running' | 'done' | 'error'
  label: string
}

const formatEngineElapsed = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`
}

const EngineRunTheater = ({
  steps,
  phase,
  elapsedMs,
}: {
  steps: EngineRunStep[]
  phase: EngineRunPhase
  elapsedMs: number
}) => {
  const total = steps.length || 1
  const doneCount = steps.filter((step) => step.status === 'done').length
  const runningStep = steps.find((step) => step.status === 'running')
  const runningIndex = runningStep ? steps.findIndex((step) => step.stage === runningStep.stage) : doneCount
  const progressPct = phase === 'success'
    ? 100
    : Math.round(((doneCount + (runningStep ? 0.42 : 0)) / total) * 100)

  const headline = phase === 'success'
    ? 'Decision engine complete'
    : phase === 'error'
      ? 'Engine interrupted'
      : runningStep?.label || 'Initializing acquisition engine'

  return (
    <div
      className={cls('nx-di25-engine-theater', `is-${phase}`)}
      role="status"
      aria-live="polite"
      aria-label={`Decision engine ${phase === 'success' ? 'complete' : phase === 'error' ? 'failed' : 'running'}`}
    >
      <div className="nx-di25-engine-theater__backdrop" aria-hidden />
      <div className="nx-di25-engine-theater__grid" aria-hidden />
      <div className="nx-di25-engine-theater__scan" aria-hidden />

      <div className="nx-di25-engine-theater__core">
        <div className="nx-di25-engine-theater__orb" style={{ ['--engine-progress' as string]: `${progressPct}%` }}>
          <span className="nx-di25-engine-theater__ring is-outer" aria-hidden />
          <span className="nx-di25-engine-theater__ring is-mid" aria-hidden />
          <span className="nx-di25-engine-theater__ring is-inner" aria-hidden />
          <div className="nx-di25-engine-theater__dial">
            {phase === 'success' ? (
              <Icon name="check-double" />
            ) : phase === 'error' ? (
              <Icon name="alert-circle" />
            ) : (
              <>
                <strong>{progressPct}</strong>
                <em>%</em>
              </>
            )}
          </div>
        </div>

        <div className="nx-di25-engine-theater__stage">
          <span className="nx-di25-engine-theater__kicker">Acquisition Decision Engine</span>
          <strong className="nx-di25-engine-theater__headline">{headline}</strong>
          <div className="nx-di25-engine-theater__meter" aria-hidden>
            <span className="nx-di25-engine-theater__meter-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="nx-di25-engine-theater__meta">
            <span>
              {phase === 'success'
                ? 'All stages verified'
                : phase === 'error'
                  ? 'Check error details below'
                  : `Stage ${Math.min(runningIndex + 1, total)} of ${total}`}
            </span>
            <em>{formatEngineElapsed(elapsedMs)}</em>
          </div>
        </div>
      </div>

      <ol className="nx-di25-engine-theater__timeline">
        {steps.map((step, index) => (
          <li
            key={step.stage}
            className={cls(
              'nx-di25-engine-theater__step',
              step.status === 'done' && 'is-done',
              step.status === 'running' && 'is-running',
              step.status === 'error' && 'is-error',
              step.status === 'pending' && 'is-pending',
            )}
            style={{ ['--step-index' as string]: String(index) }}
          >
            <span className="nx-di25-engine-theater__node" aria-hidden>
              {step.status === 'done' ? (
                <Icon name="check" />
              ) : step.status === 'error' ? (
                <Icon name="alert" />
              ) : step.status === 'running' ? (
                <span className="nx-di25-engine-theater__node-pulse" />
              ) : (
                <Icon name={ENGINE_STAGE_ICONS[step.stage]} />
              )}
            </span>
            <span className="nx-di25-engine-theater__label">{step.label}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

const EngineReadinessCard = ({ label, value }: { label: string; value: string }) => (
  <div className="nx-di25-engine-readiness">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
)

const EngineCta = ({
  candidates,
  qualified,
  onRun,
}: {
  candidates?: number | null
  qualified?: number | null
  onRun: () => void
}) => (
  <div className="nx-di25-engine-cta">
    <div className="nx-di25-engine-cta__intro">
      <div className="nx-di25-engine-cta__icon" aria-hidden>
        <Icon name="cpu" />
      </div>
      <div className="nx-di25-engine-cta__copy">
        <strong>Full acquisition analysis</strong>
        <p>Run the decision engine to compute AOS, valuation range, strategy comparison, and your offer stack from qualified comps.</p>
      </div>
    </div>
    <div className="nx-di25-engine-cta__features" aria-label="Engine outputs">
      {ENGINE_FEATURES.map((feature) => (
        <span key={feature.label} className="nx-di25-engine-cta__feature">
          <Icon name={feature.icon} />
          {feature.label}
        </span>
      ))}
    </div>
    <div className="nx-di25-engine-cta__readiness">
      <EngineReadinessCard label="Comp candidates" value={candidates != null ? String(candidates) : '—'} />
      <EngineReadinessCard label="Qualified comps" value={qualified != null ? String(qualified) : '—'} />
    </div>
    <p className="nx-di25-engine-cta__note">AOS is calculated here only after you run the decision engine.</p>
    <button type="button" className="nx-di25-engine-btn" onClick={onRun}>
      <Icon name="zap" />
      <span>Run Full Decision Engine</span>
    </button>
  </div>
)

const EngineHero = ({
  aos,
  confidence,
  tier,
  computedAt,
}: {
  aos?: number | null
  confidence?: number | null
  tier?: string | null
  computedAt?: string | null
}) => {
  const confidenceLabel = confidence != null ? fmtDiPct(Number(confidence)) : null
  const confidenceNumeric = confidence != null && Number.isFinite(Number(confidence)) ? Number(confidence) : null
  const confidenceFill = confidenceNumeric != null
    ? Math.min(100, Math.max(0, confidenceNumeric <= 1 ? confidenceNumeric * 100 : confidenceNumeric))
    : 0
  const aosTone = aos != null && Number.isFinite(Number(aos)) ? scoreTone(Number(aos)) : 'muted'

  return (
    <div className="nx-di25-engine-hero">
      <div className={cls('nx-di25-engine-hero__anchor', `is-${aosTone}`)}>
        <ScoreRadial score={aos} label="AOS" sublabel="Decision engine" size="lg" variant="aos" showDenom />
      </div>
      <div className="nx-di25-engine-hero-meta">
        {tier ? <span className="nx-di25-tier">{humanizeEnum(String(tier))}</span> : null}
        {confidenceLabel ? (
          <div className="nx-di25-engine-confidence">
            <div className="nx-di25-engine-confidence__row">
              <span>Confidence</span>
              <strong>{confidenceLabel}</strong>
            </div>
            <div className="nx-di25-engine-confidence__track" aria-hidden>
              <span className="nx-di25-engine-confidence__fill" style={{ width: `${confidenceFill}%` }} />
            </div>
          </div>
        ) : null}
        {computedAt ? <span className="nx-di25-engine-ts">Computed {fmtDiDate(computedAt)}</span> : null}
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

const asNum = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

type CompDisposition = 'included' | 'candidate' | 'excluded'

const resolveCompDisposition = (comp: CompRecord): CompDisposition => {
  if (comp.included) return 'included'
  if (comp.similarity_score != null && Number(comp.similarity_score) >= 30) return 'candidate'
  return 'excluded'
}

const fmtBedPerUnit = (beds: number | null | undefined, units: number | null | undefined) => {
  if (beds == null || units == null || units <= 0) return null
  return (beds / units).toFixed(1)
}

const fmtSqftPerUnit = (sqft: number | null | undefined, units: number | null | undefined) => {
  if (sqft == null || units == null || units <= 0) return null
  return formatInteger(Math.round(sqft / units))
}

const hasPositiveMoney = (value: number | null | undefined) => value != null && Number.isFinite(value) && value > 0

const MultifamilyIntelligencePanel = ({
  multifamily,
  property,
}: {
  multifamily: Record<string, unknown>
  property?: DealIntelligenceProperty
}) => {
  const units = asNum(multifamily.total_units) ?? asNum(property?.units)
  const avgSqftPerUnit = asNum(multifamily.average_sqft_per_unit)
    ?? (asNum(property?.square_feet) && units ? Math.round(asNum(property?.square_feet)! / units) : null)
  const bedsPerUnit = asNum(multifamily.beds_per_unit)
    ?? (asNum(property?.bedrooms) && units ? Math.round((asNum(property?.bedrooms)! / units) * 10) / 10 : null)

  const impliedPpu = asNum(multifamily.price_per_unit)
  const compMedianPpu = asNum(multifamily.comp_median_ppu)
  const buyerMarketPpu = asNum(multifamily.buyer_market_ppu)
  const valuationLow = asNum(multifamily.valuation_low)
  const valuationHigh = asNum(multifamily.valuation_high)

  const marketBenchmarks = [
    hasPositiveMoney(compMedianPpu) ? { label: 'Comp median', value: fmtDiMoney(compMedianPpu)! } : null,
    hasPositiveMoney(buyerMarketPpu) ? { label: 'Buyer market', value: fmtDiMoney(buyerMarketPpu)! } : null,
  ].filter(Boolean) as Array<{ label: string; value: string }>

  const hasValuationBand = hasPositiveMoney(valuationLow) || hasPositiveMoney(valuationHigh)
  const buyerType = multifamily.dominant_buyer_type ? humanizeEnum(String(multifamily.dominant_buyer_type)) : null

  return (
    <section className="nx-di25-layer is-multifamily is-elevated">
      <header className="nx-di25-layer__head nx-di25-layer__head--multifamily">
        <div className="nx-di25-layer__title">
          <span>Multifamily Intelligence</span>
          <em className="nx-di25-layer__hint">Unit economics & buyer-market alignment</em>
        </div>
        <span className="nx-di25-mf-badge">{units != null ? `${units} units` : 'Multifamily'}</span>
      </header>

      <div className="nx-di25-mf-strip">
        <div className="nx-di25-mf-strip__economics">
          <span>Implied price / unit</span>
          <strong>{hasPositiveMoney(impliedPpu) ? fmtDiMoney(impliedPpu) : '—'}</strong>
        </div>
        <div className="nx-di25-mf-strip__mix">
          <div className="nx-di25-mf-mix-chip is-sqft">
            <em>Avg sqft / unit</em>
            <strong>{avgSqftPerUnit != null ? `${formatInteger(avgSqftPerUnit)} sf` : '—'}</strong>
          </div>
          <div className="nx-di25-mf-mix-chip is-beds">
            <em>Avg bed / unit</em>
            <strong>{bedsPerUnit != null ? bedsPerUnit.toFixed(1) : '—'}</strong>
          </div>
        </div>
      </div>

      {marketBenchmarks.length ? (
        <div className="nx-di25-mf-benchmarks" aria-label="Market benchmarks">
          {marketBenchmarks.map((item) => (
            <div key={item.label} className="nx-di25-mf-benchmark">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      ) : (
        <p className="nx-di25-mf-pending">Comp and buyer-market benchmarks will populate after qualified comps load.</p>
      )}

      {hasValuationBand || buyerType ? (
        <div className="nx-di25-mf-context">
          {hasValuationBand ? (
            <span>
              Valuation band {fmtDiMoney(hasPositiveMoney(valuationLow) ? valuationLow : null) ?? '—'}
              {' – '}
              {fmtDiMoney(hasPositiveMoney(valuationHigh) ? valuationHigh : null) ?? '—'}
            </span>
          ) : null}
          {buyerType ? <em>{buyerType} buyer demand</em> : null}
        </div>
      ) : null}
    </section>
  )
}

const CompQualificationFunnel = ({ qual }: { qual?: CompQualification }) => {
  if (!qual) return null

  const candidates = Math.max(qual.candidates_found ?? 0, 0)
  const stages = [
    { key: 'asset', label: 'Asset match', value: qual.asset_type_matches ?? 0, tone: 'asset' },
    { key: 'location', label: 'Location', value: qual.location_qualified ?? 0, tone: 'location' },
    { key: 'similarity', label: 'Similarity', value: qual.similarity_qualified ?? 0, tone: 'similarity' },
    { key: 'usable', label: 'Weighted usable', value: qual.weighted_usable ?? 0, tone: 'usable' },
  ]
  const base = Math.max(candidates, 1)

  const bottleneck = stages.reduce<{ key: string; drop: number } | null>((worst, stage, index) => {
    const prev = index === 0 ? candidates : (stages[index - 1]?.value ?? 0)
    const drop = Math.max(0, prev - stage.value)
    if (!worst || drop > worst.drop) return { key: stage.key, drop }
    return worst
  }, null)

  return (
    <div className="nx-di25-comp-funnel" aria-label="Comp qualification funnel">
      <header className="nx-di25-comp-funnel__head">
        <div>
          <span>Qualification funnel</span>
          <em>How candidates filter into usable comps</em>
        </div>
        <strong>{candidates}</strong>
      </header>

      <div className="nx-di25-comp-funnel__lane">
        <div className="nx-di25-comp-funnel__origin">
          <span>Candidates</span>
          <strong>{candidates}</strong>
        </div>

        {stages.map((stage, index) => {
          const prev = index === 0 ? candidates : (stages[index - 1]?.value ?? 0)
          const pct = Math.round((stage.value / base) * 100)
          const retention = prev > 0 ? Math.round((stage.value / prev) * 100) : 0
          const drop = Math.max(0, prev - stage.value)
          const isBottleneck = bottleneck?.key === stage.key && drop > 0

          return (
            <div key={stage.key} className={cls('nx-di25-comp-funnel__segment', `is-${stage.tone}`, isBottleneck && 'is-bottleneck')}>
              <div className="nx-di25-comp-funnel__connector" aria-hidden>
                <span className="nx-di25-comp-funnel__connector-line" />
                {drop > 0 ? <em className="nx-di25-comp-funnel__drop">−{drop}</em> : null}
              </div>
              <div
                className="nx-di25-comp-funnel__node"
                style={{ ['--funnel-pct' as string]: `${pct}%`, ['--funnel-retention' as string]: `${retention}%` }}
              >
                <div className="nx-di25-comp-funnel__ring" aria-hidden>
                  <span />
                </div>
                <div className="nx-di25-comp-funnel__node-copy">
                  <strong>{stage.value}</strong>
                  <span>{stage.label}</span>
                  <em>{pct}% of pool · {retention}% retained</em>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {(qual.rejected ?? 0) > 0 ? (
        <footer className="nx-di25-comp-funnel__foot">
          <span>Rejected after scoring</span>
          <strong>{qual.rejected}</strong>
        </footer>
      ) : null}
    </div>
  )
}

const CompChannelBadge = ({ kind }: { kind: 'mls' | 'off_market' | 'corporate' | 'llc' | 'individual' }) => {
  const labels = {
    mls: 'MLS',
    off_market: 'Off-market',
    corporate: 'Corporate',
    llc: 'LLC',
    individual: 'Individual',
  }
  return <span className={cls('nx-di25-comp-channel', `is-${kind}`)}>{labels[kind]}</span>
}

const CompMarketHero = ({
  comps,
  qual,
  isMultifamily,
}: {
  comps: DealIntelligenceDossier['comps']
  qual?: CompQualification
  isMultifamily: boolean
}) => {
  const confidenceLabel = comps?.confidence != null && (qual?.weighted_usable || 0) >= 3
    ? fmtDiPct(comps.confidence)
    : (qual?.weighted_usable || 0) < 3
      ? 'Low sample'
      : null

  const channelPills = [
    (comps?.mls_sale_count || 0) > 0 ? { label: 'MLS', value: comps?.mls_sale_count, tone: 'mls' } : null,
    (comps?.off_market_count || 0) > 0 ? { label: 'Off-market', value: comps?.off_market_count, tone: 'off' } : null,
    (comps?.corporate_buyer_count || 0) > 0 ? { label: 'Corporate', value: comps?.corporate_buyer_count, tone: 'corp' } : null,
  ].filter(Boolean) as Array<{ label: string; value?: number | null; tone: string }>

  const heroPrimary = isMultifamily
    ? { label: 'Median PPU', value: fmtDiMoney(comps?.median_ppu) ?? '—', sub: hasPositiveMoney(comps?.avg_ppu) ? `Avg ${fmtDiMoney(comps?.avg_ppu)}` : null }
    : { label: 'Median PPSF', value: fmtDiMoney(comps?.median_ppsf) ?? '—', sub: hasPositiveMoney(comps?.avg_ppsf) ? `Avg ${fmtDiMoney(comps?.avg_ppsf)}` : null }

  return (
    <div className="nx-di25-comp-hero">
      <div className="nx-di25-comp-hero__primary">
        <span>{heroPrimary.label}</span>
        <strong>{heroPrimary.value}</strong>
        {heroPrimary.sub ? <em>{heroPrimary.sub}</em> : null}
      </div>

      <div className="nx-di25-comp-hero__grid">
        <div className="nx-di25-comp-hero__metric">
          <span>Median sale</span>
          <strong>{fmtDiMoney(comps?.median_sale) ?? '—'}</strong>
        </div>
        {isMultifamily ? (
          <>
            <div className="nx-di25-comp-hero__metric is-accent">
              <span>Avg PPSF</span>
              <strong>{fmtDiMoney(comps?.avg_ppsf) ?? '—'}</strong>
            </div>
            <div className="nx-di25-comp-hero__metric">
              <span>Median PPSF</span>
              <strong>{fmtDiMoney(comps?.median_ppsf) ?? '—'}</strong>
            </div>
          </>
        ) : (
          <div className="nx-di25-comp-hero__metric">
            <span>Avg PPSF</span>
            <strong>{fmtDiMoney(comps?.avg_ppsf) ?? '—'}</strong>
          </div>
        )}
        <div className="nx-di25-comp-hero__metric">
          <span>Valuation mid</span>
          <strong>{fmtDiMoney(comps?.valuation_mid) ?? '—'}</strong>
        </div>
        <div className="nx-di25-comp-hero__metric">
          <span>Confidence</span>
          <strong>{confidenceLabel ?? '—'}</strong>
          {qual ? <em>{qual.weighted_usable ?? 0} usable</em> : null}
        </div>
        <div className="nx-di25-comp-hero__metric">
          <span>Freshness</span>
          <strong>{comps?.freshness ? humanizeEnum(String(comps.freshness)) : '—'}</strong>
        </div>
      </div>

      {hasPositiveMoney(comps?.valuation_low) || hasPositiveMoney(comps?.valuation_high) ? (
        <div className="nx-di25-comp-hero__band">
          <span>Valuation band</span>
          <strong>
            {fmtDiMoney(hasPositiveMoney(comps?.valuation_low) ? comps?.valuation_low : null) ?? '—'}
            {' – '}
            {fmtDiMoney(hasPositiveMoney(comps?.valuation_high) ? comps?.valuation_high : null) ?? '—'}
          </strong>
        </div>
      ) : null}

      {channelPills.length ? (
        <div className="nx-di25-comp-hero__channels" aria-label="Transaction channel mix">
          {channelPills.map((pill) => (
            <span key={pill.label} className={cls('nx-di25-comp-hero__channel', `is-${pill.tone}`)}>
              <em>{pill.label}</em>
              <strong>{pill.value}</strong>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

const CompPricingTrio = ({ comp, isMultifamily }: { comp: CompRecord; isMultifamily: boolean }) => (
  <div className={cls('nx-di25-comp-pricing', isMultifamily && 'is-multifamily')}>
    <div className="nx-di25-comp-pricing__cell">
      <span>Sale</span>
      <strong>{fmtDiMoney(comp.sale_price) ?? '—'}</strong>
    </div>
    {isMultifamily ? (
      <div className="nx-di25-comp-pricing__cell is-primary">
        <span>PPU</span>
        <strong>{fmtDiMoney(comp.ppu) ?? '—'}</strong>
      </div>
    ) : null}
    <div className={cls('nx-di25-comp-pricing__cell', !isMultifamily && 'is-primary')}>
      <span>PPSF</span>
      <strong>{fmtDiMoney(comp.ppsf) ?? '—'}</strong>
    </div>
  </div>
)

const CompDetailChips = ({ comp, isMultifamily }: { comp: CompRecord; isMultifamily: boolean }) => {
  const units = asNum(comp.units)
  const beds = asNum(comp.bedrooms)
  const baths = asNum(comp.bathrooms)
  const sqft = asNum(comp.sqft)
  const bedPerUnit = asNum(comp.avg_beds_per_unit) ?? (isMultifamily ? fmtBedPerUnit(beds, units) : null)
  const sqftPerUnit = asNum(comp.avg_sqft_per_unit) ?? (isMultifamily && fmtSqftPerUnit(sqft, units) != null ? Number(fmtSqftPerUnit(sqft, units)) : null)

  const chips = [
    units != null ? `${units}u` : null,
    isMultifamily && bedPerUnit != null ? `${Number(bedPerUnit).toFixed(1)} bed/u` : beds != null ? `${beds} bd` : null,
    isMultifamily && sqftPerUnit != null ? `${formatInteger(sqftPerUnit)} sf/u` : sqft != null ? `${formatInteger(sqft)} sf` : null,
    baths != null ? `${baths} ba` : null,
    comp.year_built != null ? `Built ${comp.year_built}` : null,
    comp.condition ? humanizeEnum(String(comp.condition)) : null,
    comp.construction_type ? humanizeEnum(String(comp.construction_type)) : null,
    comp.lot_sqft != null ? `${formatInteger(comp.lot_sqft)} lot` : null,
  ].filter(Boolean) as string[]

  if (!chips.length) return null

  return (
    <div className="nx-di25-comp-chips" aria-label="Property details">
      {chips.map((chip) => <span key={chip}>{chip}</span>)}
    </div>
  )
}

const CompCard = ({ comp, isMultifamily, spotlight = false }: { comp: CompRecord; isMultifamily: boolean; spotlight?: boolean }) => {
  const state = resolveCompDisposition(comp)
  const canOpenOnMap = Boolean((comp.latitude != null && comp.longitude != null) || comp.address)
  const handleOpenOnMap = () => openInboxMapComp(buildMapFocusCompFromRecord(comp))
  const similarity = asNum(comp.similarity_score)
  const similarityPct = similarity != null ? Math.min(100, Math.max(0, similarity <= 1 ? similarity * 100 : similarity)) : 0
  const buyerLabel = comp.buyer_name ? fmtDiText(comp.buyer_name) : null

  const channelBadges: Array<'mls' | 'off_market' | 'corporate' | 'llc' | 'individual'> = []
  if (comp.is_mls_sale) channelBadges.push('mls')
  else if (comp.is_off_market) channelBadges.push('off_market')
  if (comp.buyer_type === 'llc_corporate') channelBadges.push('llc')
  else if (comp.is_corporate_buyer) channelBadges.push('corporate')
  else if (comp.buyer_type === 'individual') channelBadges.push('individual')

  return (
    <article className={cls('nx-di25-comp-card', `is-${state}`, spotlight && 'is-spotlight')}>
      <header className="nx-di25-comp-card__head">
        <div className="nx-di25-comp-card__identity">
          <div className="nx-di25-comp-card__title-row">
            <span className={cls('nx-di25-comp-state', `is-${state}`)}>
              {state === 'included' ? 'Included' : state === 'candidate' ? 'Candidate' : 'Excluded'}
            </span>
            {similarity != null ? (
              <span className="nx-di25-comp-card__match">{fmtDiPct(similarity)} match</span>
            ) : null}
          </div>
          <strong>{comp.address || 'Comparable property'}</strong>
          <div className="nx-di25-comp-card__meta">
            <span>{comp.distance_miles != null ? `${comp.distance_miles.toFixed(2)} mi` : 'Distance —'}</span>
            {comp.sale_date ? <span>{fmtDiDate(comp.sale_date)}</span> : null}
            {comp.property_type ? <span>{fmtDiText(comp.property_type)}</span> : null}
            {comp.asset_class ? <span>{fmtDiText(comp.asset_class)}</span> : null}
          </div>
        </div>
        <div className="nx-di25-comp-card__headline">
          <strong>{fmtDiMoney(comp.sale_price) ?? '—'}</strong>
          {comp.weight != null ? <em>Weight {fmtDiScore(comp.weight)}</em> : null}
        </div>
      </header>

      <CompPricingTrio comp={comp} isMultifamily={isMultifamily} />

      {channelBadges.length || buyerLabel ? (
        <div className="nx-di25-comp-card__buyer-row">
          <div className="nx-di25-comp-card__channels">
            {channelBadges.map((badge) => <CompChannelBadge key={badge} kind={badge} />)}
          </div>
          {buyerLabel ? (
            <div className="nx-di25-comp-card__buyer">
              <span>Buyer</span>
              <strong>{buyerLabel}</strong>
            </div>
          ) : null}
        </div>
      ) : null}

      {similarity != null ? (
        <div className="nx-di25-comp-card__similarity">
          <span>Match strength</span>
          <div className="nx-di25-comp-card__similarity-track" aria-hidden>
            <span style={{ width: `${similarityPct}%` }} />
          </div>
        </div>
      ) : null}

      <CompDetailChips comp={comp} isMultifamily={isMultifamily} />

      {(comp.subdivision || comp.school_district || comp.document_type) ? (
        <div className="nx-di25-comp-card__context">
          {comp.subdivision ? <span>{fmtDiText(comp.subdivision)}</span> : null}
          {comp.school_district ? <span>{fmtDiText(comp.school_district)}</span> : null}
          {comp.document_type ? <span>{humanizeEnum(String(comp.document_type))}</span> : null}
        </div>
      ) : null}

      {!comp.included && comp.exclusion_reason ? (
        <p className="nx-di25-comp-card__exclusion">{fmtDiText(comp.exclusion_reason)}</p>
      ) : null}

      {canOpenOnMap ? (
        <button type="button" className="nx-di25-comp-card__map" onClick={handleOpenOnMap}>
          <Icon name="map" />
          <span>Open in Command Map</span>
        </button>
      ) : null}
    </article>
  )
}

const CompsWorkbench = ({
  comps,
  qual,
  compRecords,
  visibleComps,
  isMultifamily,
  showAllComps,
  onToggleShowAll,
}: {
  comps: DealIntelligenceDossier['comps']
  qual?: CompQualification
  compRecords: CompRecord[]
  visibleComps: CompRecord[]
  isMultifamily: boolean
  showAllComps: boolean
  onToggleShowAll: () => void
}) => {
  const included = visibleComps.filter((comp) => resolveCompDisposition(comp) === 'included')
  const candidates = visibleComps.filter((comp) => resolveCompDisposition(comp) === 'candidate')
  const excluded = visibleComps.filter((comp) => resolveCompDisposition(comp) === 'excluded')

  const spotlightComp = included[0] ?? candidates[0] ?? null

  const renderGroup = (title: string, items: CompRecord[], tone: CompDisposition, skipSpotlight = false) => {
    if (!items.length) return null
    const list = skipSpotlight && spotlightComp
      ? items.filter((comp) => String(comp.id) !== String(spotlightComp.id))
      : items
    if (!list.length) return null
    return (
      <div className={cls('nx-di25-comp-group', `is-${tone}`)}>
        <header className="nx-di25-comp-group__head">
          <span>{title}</span>
          <em>{list.length}</em>
        </header>
        <div className="nx-di25-comp-list">
          {list.map((comp) => <CompCard key={String(comp.id)} comp={comp} isMultifamily={isMultifamily} />)}
        </div>
      </div>
    )
  }

  return (
    <section className="nx-di25-layer is-comps is-elevated">
      <header className="nx-di25-layer__head nx-di25-layer__head--comps">
        <div className="nx-di25-layer__title">
          <span>Comparable Sales</span>
          <em className="nx-di25-layer__hint">Qualified comps powering valuation</em>
        </div>
        <span className="nx-di25-comp-badge">
          {qual?.weighted_usable ?? 0} usable · {compRecords.length} total
        </span>
      </header>

      {comps?.label ? <p className="nx-di25-comp-note nx-di25-warning">{comps.label}</p> : null}
      <CompMarketHero comps={comps} qual={qual} isMultifamily={isMultifamily} />
      <CompQualificationFunnel qual={qual} />

      {spotlightComp ? (
        <div className="nx-di25-comp-spotlight">
          <header className="nx-di25-comp-spotlight__head">
            <span>Top comp</span>
            <em>{resolveCompDisposition(spotlightComp) === 'included' ? 'Included in valuation' : 'Leading candidate'}</em>
          </header>
          <CompCard comp={spotlightComp} isMultifamily={isMultifamily} spotlight />
        </div>
      ) : null}

      {compRecords.length ? (
        <>
          {renderGroup('Included comps', included, 'included', Boolean(spotlightComp))}
          {renderGroup('Candidate comps', candidates, 'candidate', Boolean(spotlightComp))}
          {showAllComps ? renderGroup('Excluded comps', excluded, 'excluded') : null}
          {compRecords.length > 4 ? (
            <button type="button" className="nx-di25-comp-expand" onClick={onToggleShowAll}>
              <Icon name={showAllComps ? 'chevron-up' : 'chevron-down'} />
              <span>{showAllComps ? 'Show fewer comps' : `View all ${compRecords.length} comps`}</span>
            </button>
          ) : null}
        </>
      ) : (
        <p className="nx-di25-comp-empty">No comparable records loaded for this property yet.</p>
      )}
    </section>
  )
}

const ConversationIntelligencePanel = ({
  convo,
  dispositionMeta,
}: {
  convo: Record<string, unknown>
  dispositionMeta: { label: string; color: string } | null
}) => {
  const replyIntent = humanizeEnum(String(convo.reply_intent || convo.latest_intent || ''))
  const sentiment = humanizeEnum(String(convo.sentiment || ''))
  const sellerState = has(convo.seller_state) ? humanizeEnum(String(convo.seller_state || '')) : null

  return (
    <IntelligenceLayer title="Conversation Intelligence" tone="conversation" defaultOpen badge={replyIntent || sentiment || 'Live'}>
      <IntelHeroStrip>
        <IntelHeroMetric label="Reply intent" value={replyIntent ?? '—'} accent />
        <IntelHeroMetric label="Sentiment" value={sentiment ?? '—'} />
        <IntelHeroMetric label="Last response" value={fmtDiDate(String(convo.last_seller_response_at || '')) ?? '—'} />
      </IntelHeroStrip>

      {(sellerState || dispositionMeta) ? (
        <div className="nx-di25-intel-status-row">
          {sellerState ? <IntelStatusCard label="Seller state" value={sellerState} tone="neutral" /> : null}
          {dispositionMeta ? (
            <div
              className="nx-di25-intel-disposition"
              style={{
                color: dispositionMeta.color,
                borderColor: `color-mix(in srgb, ${dispositionMeta.color} 36%, transparent)`,
                background: `color-mix(in srgb, ${dispositionMeta.color} 12%, transparent)`,
              }}
            >
              <span>Disposition</span>
              <strong>{dispositionMeta.label}</strong>
            </div>
          ) : null}
        </div>
      ) : null}

      <IntelTileGrid>
        <IntelTile label="Language" value={fmtDiText(convo.language)} />
        <IntelTile label="Next follow-up" value={fmtDiDate(String(convo.next_follow_up_at || ''))} />
      </IntelTileGrid>

      <IntelInsight label="Conversation angle" value={humanizeEnum(String(convo.recommended_conversation_angle || ''))} />
      <IntelInsight label="Latest inbound" value={String(convo.latest_inbound_summary || '').slice(0, 220)} />
    </IntelligenceLayer>
  )
}

const MasterOwnerPanel = ({ owner }: { owner: Record<string, unknown> }) => (
  <IntelligenceLayer
    title="Master Owner"
    tone="owner"
    badge={owner?.property_count != null ? `${owner.property_count} props` : null}
  >
    <IntelHeroStrip>
      <IntelHeroMetric label="Owner" value={fmtDiText(owner?.display_name) ?? '—'} accent />
      <IntelHeroMetric
        label="Priority"
        value={fmtDiScore(Number(owner?.priority_score)) ?? '—'}
        sub={fmtDiText(owner?.priority_tier)}
      />
      <IntelHeroMetric label="Portfolio" value={fmtDiMoney(Number(owner?.portfolio_value)) ?? '—'} />
    </IntelHeroStrip>
    <IntelTileGrid>
      <IntelTile label="Entity type" value={humanizeEnum(String(owner?.owner_type || ''))} />
      <IntelTile label="Financial pressure" value={fmtDiScore(Number(owner?.financial_pressure_score))} />
      <IntelTile label="Urgency" value={fmtDiScore(Number(owner?.urgency_score))} />
      <IntelTile label="Priority tier" value={fmtDiText(owner?.priority_tier)} />
      <IntelTile label="Portfolio equity" value={fmtDiMoney(Number(owner?.portfolio_equity))} />
      <IntelTile label="Portfolio loan balance" value={fmtDiMoney(Number(owner?.portfolio_loan_balance))} />
      <IntelTile label="Portfolio loan payment" value={fmtDiMoney(Number(owner?.portfolio_loan_payment))} />
      <IntelTile label="Portfolio tax amount" value={fmtDiMoney(Number(owner?.portfolio_tax_amount))} />
      <IntelTile label="Portfolio units" value={owner?.total_units != null ? String(owner.total_units) : null} />
      <IntelTile label="Property count" value={owner?.property_count != null ? String(owner.property_count) : null} />
      <IntelTile label="Tax delinquent count" value={owner?.tax_delinquent_count != null ? String(owner.tax_delinquent_count) : null} />
      <IntelTile label="Active lien count" value={owner?.active_lien_count != null ? String(owner.active_lien_count) : null} />
    </IntelTileGrid>
  </IntelligenceLayer>
)

const ProspectIntelligencePanel = ({
  prospect,
  relationshipFlags,
  personFlags,
}: {
  prospect: Record<string, unknown>
  relationshipFlags: string[]
  personFlags: string[]
}) => (
  <IntelligenceLayer title="Prospect Intelligence" tone="prospect" badge={fmtDiText(prospect?.name) || 'Profile'}>
    <IntelHeroStrip>
      <IntelHeroMetric label="Prospect" value={fmtDiText(prospect?.name) ?? '—'} accent />
      <IntelHeroMetric label="Household income" value={fmtDiText(prospect?.household_income) ?? '—'} />
      <IntelHeroMetric label="Buying power" value={fmtDiText(prospect?.buying_power) ?? '—'} />
    </IntelHeroStrip>
    <IntelTileGrid>
      <IntelTile label="Age" value={prospect?.age != null ? String(prospect.age) : null} />
      <IntelTile label="Gender" value={fmtDiText(prospect?.gender)} />
      <IntelTile label="Marital status" value={fmtDiText(prospect?.marital_status)} />
      <IntelTile label="Language" value={fmtDiText(prospect?.language)} />
      <IntelTile label="Education" value={fmtDiText(prospect?.education)} />
      <IntelTile label="Occupation" value={fmtDiText(prospect?.occupation)} />
      <IntelTile label="Occupation group" value={fmtDiText(prospect?.occupation_group)} />
      <IntelTile label="Net assets" value={fmtDiText(prospect?.net_asset_value)} />
      <IntelTile label="Likely owner" value={fmtDiBool(prospect?.likely_owner as boolean)} />
      <IntelTile label="Likely renter" value={fmtDiBool(prospect?.likely_renter as boolean)} />
    </IntelTileGrid>
    <IntelInsight label="Best email" value={fmtDiText(prospect?.best_email)} />
    {relationshipFlags.length ? (
      <div className="nx-di25-intel-flags is-relationship">
        <span>Relationship signals</span>
        <div>{relationshipFlags.map((f) => <em key={f}>{humanizeEnum(f)}</em>)}</div>
      </div>
    ) : null}
    {personFlags.length ? (
      <div className="nx-di25-intel-flags">
        <span>Person flags</span>
        <div>{personFlags.map((f) => <em key={f}>{f}</em>)}</div>
      </div>
    ) : null}
  </IntelligenceLayer>
)

const PhoneIntelligencePanel = ({
  phone,
  contactabilityMeta,
}: {
  phone: Record<string, unknown>
  contactabilityMeta: { label: string; color: string; blocksSend: boolean } | null
}) => (
  <IntelligenceLayer title="Phone Intelligence" tone="phone" badge={fmtDiPhone(String(phone?.number || '')) || 'Phone'}>
    {contactabilityMeta ? (
      <div
        className={cls('nx-di25-intel-contact', contactabilityMeta.blocksSend && 'is-blocked')}
        style={{
          color: contactabilityMeta.color,
          borderColor: `color-mix(in srgb, ${contactabilityMeta.color} 40%, transparent)`,
          background: `color-mix(in srgb, ${contactabilityMeta.color} ${contactabilityMeta.blocksSend ? '16' : '10'}%, transparent)`,
        }}
      >
        <div>
          <span>Contactability</span>
          <strong>{contactabilityMeta.label}</strong>
        </div>
        <em>{contactabilityMeta.blocksSend ? 'Outbound messaging blocked' : 'Eligible for outreach'}</em>
      </div>
    ) : null}

    <IntelHeroStrip>
      <IntelHeroMetric label="Primary" value={fmtDiPhone(String(phone?.number || '')) ?? '—'} accent />
      <IntelHeroMetric label="Phone score" value={fmtDiScore(Number(phone?.phone_score)) ?? '—'} />
      <IntelHeroMetric label="Contact score" value={fmtDiScore(Number(phone?.contact_score)) ?? '—'} />
    </IntelHeroStrip>

    <IntelTileGrid>
      <IntelTile label="Line type" value={fmtPhoneType(String(phone?.type || ''))} />
      <IntelTile label="Phone owner" value={fmtDiText(phone?.phone_owner ?? phone?.carrier)} />
      <IntelTile label="Activity" value={fmtDiText(phone?.activity_status)} />
      <IntelTile label="Usage" value={fmtDiText(phone?.usage)} />
      <IntelTile label="Contact window" value={fmtDiText(phone?.contact_window)} />
      <IntelTile label="Timezone" value={fmtDiText(phone?.timezone)} />
      <IntelTile label="SMS eligible" value={fmtDiBool(phone?.sms_eligible as boolean)} />
      <IntelTile label="Wrong number" value={fmtDiBool(phone?.wrong_number as boolean)} />
    </IntelTileGrid>

    {(phone?.alternate_numbers as string[] | undefined)?.map((alt, i) => (
      <IntelInsight key={alt} label={`Alternate ${i + 1}`} value={fmtDiPhone(alt)} />
    ))}

    {phone?.suppressed != null ? (
      <IntelInsight
        label="Suppression"
        value={phone.suppressed ? `Yes${phone?.suppression_reason ? ` · ${phone.suppression_reason}` : ''}` : 'No'}
      />
    ) : null}
  </IntelligenceLayer>
)

const ValuationDebtPanel = ({
  fields,
  snap,
}: {
  fields?: Record<string, unknown>
  snap?: DealIntelligenceDossier['property_snapshot']
}) => {
  if (!fields || !Object.keys(fields).length) return null
  return (
    <IntelligenceLayer title="Valuation & Debt" tone="valuation" badge={fmtDiMoney(Number(fields.estimated_value)) || 'Value'}>
      <IntelHeroStrip>
        <IntelHeroMetric label="Estimated value" value={fmtDiFieldValue('estimated_value', fields.estimated_value) ?? '—'} accent />
        <IntelHeroMetric
          label="Equity"
          value={fmtDiFieldValue('equity_amount', fields.equity_amount) ?? '—'}
          sub={fmtDiFieldValue('equity_percentage', fields.equity_percentage)}
        />
        <IntelHeroMetric label="Repair est." value={fmtDiFieldValue('repair_estimate', fields.repair_estimate) ?? '—'} />
      </IntelHeroStrip>
      <EquityDebtBar
        equity={asNum(fields.equity_amount) ?? snap?.equity_amount}
        loan={asNum(fields.total_loan_balance) ?? snap?.total_loan_balance}
      />
      <IntelTileGrid>
        <IntelTile label="Loan balance" value={fmtDiFieldValue('total_loan_balance', fields.total_loan_balance)} />
        <IntelTile label="Loan amount" value={fmtDiFieldValue('total_loan_amount', fields.total_loan_amount)} />
        <IntelTile label="Loan payment" value={fmtDiFieldValue('loan_payment', fields.loan_payment)} />
        <IntelTile label="Assessed total" value={fmtDiFieldValue('assessed_total_value', fields.assessed_total_value)} />
        <IntelTile label="Assessed improvement" value={fmtDiFieldValue('assessed_improvement_value', fields.assessed_improvement_value)} />
        <IntelTile label="Assessed land" value={fmtDiFieldValue('assessed_land_value', fields.assessed_land_value)} />
      </IntelTileGrid>
    </IntelligenceLayer>
  )
}

const SaleRecordingPanel = ({ fields }: { fields?: Record<string, unknown> }) => {
  if (!fields || !Object.keys(fields).length) return null
  return (
    <IntelligenceLayer title="Sale & Recording" tone="sale" badge={fmtDiDate(String(fields.last_sale_date || '')) || 'Recording'}>
      <IntelHeroStrip>
        <IntelHeroMetric label="Last sale" value={fmtDiFieldValue('last_sale_price', fields.last_sale_price) ?? '—'} accent />
        <IntelHeroMetric label="Sale date" value={fmtDiFieldValue('last_sale_date', fields.last_sale_date) ?? '—'} />
        <IntelHeroMetric label="Recorded" value={fmtDiFieldValue('recording_date', fields.recording_date) ?? '—'} />
      </IntelHeroStrip>
      <IntelTileGrid>
        <IntelTile label="Document type" value={fmtDiFieldValue('document_type', fields.document_type)} />
        <IntelTile label="Last sale doc type" value={fmtDiFieldValue('last_sale_doc_type', fields.last_sale_doc_type)} />
        <IntelTile label="Default date" value={fmtDiFieldValue('default_date', fields.default_date)} />
      </IntelTileGrid>
    </IntelligenceLayer>
  )
}

const PhysicalPanel = ({ fields, isSfr }: { fields?: Record<string, unknown>; isSfr: boolean }) => {
  if (!fields || !Object.keys(fields).length) return null
  return (
    <IntelligenceLayer title="Physical Profile" tone="physical" badge={fmtDiFieldValue('square_feet', fields.square_feet) || 'Site'}>
      <IntelHeroStrip>
        <IntelHeroMetric label="Building" value={fmtDiFieldValue('square_feet', fields.square_feet) ?? '—'} accent />
        <IntelHeroMetric
          label="Unit mix"
          value={fmtDiFieldValue('units', fields.units, isSfr) ?? fmtDiFieldValue('bedrooms', fields.bedrooms) ?? '—'}
          sub={fields.bedrooms != null || fields.bathrooms != null ? `${fields.bedrooms ?? '—'} bd / ${fields.bathrooms ?? '—'} ba` : null}
        />
        <IntelHeroMetric label="Year built" value={fmtDiFieldValue('year_built', fields.year_built) ?? '—'} />
      </IntelHeroStrip>
      <IntelTileGrid>
        <IntelTile label="Effective year" value={fmtDiFieldValue('effective_year_built', fields.effective_year_built)} />
        <IntelTile label="Lot acreage" value={fmtDiFieldValue('lot_acreage', fields.lot_acreage)} />
        <IntelTile label="Lot sqft" value={fmtDiFieldValue('lot_square_feet', fields.lot_square_feet)} />
        <IntelTile label="Stories" value={fmtDiFieldValue('stories', fields.stories)} />
        <IntelTile label="Property class" value={fmtDiFieldValue('property_class', fields.property_class)} />
        <IntelTile label="Construction" value={fmtDiFieldValue('construction_type', fields.construction_type)} />
        <IntelTile label="Quality" value={fmtDiFieldValue('building_quality', fields.building_quality)} />
        <IntelTile label="Condition" value={fmtDiFieldValue('building_condition', fields.building_condition)} />
        <IntelTile label="Rehab level" value={fmtDiFieldValue('rehab_level', fields.rehab_level)} />
        <IntelTile label="Air conditioning" value={fmtDiFieldValue('air_conditioning', fields.air_conditioning)} />
        <IntelTile label="Basement" value={fmtDiFieldValue('basement', fields.basement)} />
        <IntelTile label="Exterior walls" value={fmtDiFieldValue('exterior_walls', fields.exterior_walls)} />
        <IntelTile label="Floor cover" value={fmtDiFieldValue('floor_cover', fields.floor_cover)} />
        <IntelTile label="Garage" value={fmtDiFieldValue('garage', fields.garage)} />
        <IntelTile label="Heating fuel" value={fmtDiFieldValue('heating_fuel_type', fields.heating_fuel_type)} />
        <IntelTile label="Heating type" value={fmtDiFieldValue('heating_type', fields.heating_type)} />
        <IntelTile label="Interior walls" value={fmtDiFieldValue('interior_walls', fields.interior_walls)} />
        <IntelTile label="Pool" value={fmtDiFieldValue('pool', fields.pool)} />
        <IntelTile label="Porch" value={fmtDiFieldValue('porch', fields.porch)} />
        <IntelTile label="Patio" value={fmtDiFieldValue('patio', fields.patio)} />
        <IntelTile label="Deck" value={fmtDiFieldValue('deck', fields.deck)} />
        <IntelTile label="Driveway" value={fmtDiFieldValue('driveway', fields.driveway)} />
        <IntelTile label="Roof cover" value={fmtDiFieldValue('roof_cover', fields.roof_cover)} />
        <IntelTile label="Roof type" value={fmtDiFieldValue('roof_type', fields.roof_type)} />
        <IntelTile label="Sewer" value={fmtDiFieldValue('sewer', fields.sewer)} />
        <IntelTile label="Water" value={fmtDiFieldValue('water', fields.water)} />
        <IntelTile label="Zoning" value={fmtDiFieldValue('zoning', fields.zoning)} />
        <IntelTile label="Subdivision" value={fmtDiFieldValue('subdivision_name', fields.subdivision_name)} />
        <IntelTile label="School district" value={fmtDiFieldValue('school_district_name', fields.school_district_name)} />
        <IntelTile label="Flood zone" value={fmtDiFieldValue('flood_zone', fields.flood_zone)} />
        <IntelTile label="HOA name" value={fmtDiFieldValue('hoa1_name', fields.hoa1_name)} />
        <IntelTile label="HOA type" value={fmtDiFieldValue('hoa1_type', fields.hoa1_type)} />
        <IntelTile label="HOA fee" value={fmtDiFieldValue('hoa_fee_amount', fields.hoa_fee_amount)} />
      </IntelTileGrid>
    </IntelligenceLayer>
  )
}

const DistressFlagsPanel = ({ fields }: { fields?: Record<string, unknown> }) => {
  if (!fields || !Object.keys(fields).length) return null
  const propertyFlags = Array.isArray(fields.property_flags) ? fields.property_flags.map(String).filter(Boolean) : []
  const flagCount = propertyFlags.length
    + (fields.tax_delinquent === true ? 1 : 0)
    + (fields.active_lien === true ? 1 : 0)

  return (
    <IntelligenceLayer title="Distress Flags" tone="distress" badge={flagCount ? `${flagCount} signals` : 'Clear'}>
      <div className="nx-di25-intel-status-row">
        <IntelStatusCard
          label="Tax delinquent"
          value={fields.tax_delinquent === true ? 'Yes' : fields.tax_delinquent === false ? 'No' : null}
          tone={fields.tax_delinquent === true ? 'danger' : 'positive'}
        />
        <IntelStatusCard
          label="Active lien"
          value={fields.active_lien === true ? 'Yes' : fields.active_lien === false ? 'No' : null}
          tone={fields.active_lien === true ? 'warning' : 'positive'}
        />
      </div>
      {propertyFlags.length ? (
        <div className="nx-di25-intel-flags is-distress">
          <span>Property flags</span>
          <div>{propertyFlags.map((f) => <em key={f}>{humanizeEnum(f)}</em>)}</div>
        </div>
      ) : (
        <p className="nx-di25-intel-empty">No active distress flags on record.</p>
      )}
    </IntelligenceLayer>
  )
}

const ActivityTimelinePanel = ({
  events,
  ascending,
  onToggleSort,
}: {
  events: ActivityEvent[]
  ascending: boolean
  onToggleSort: () => void
}) => (
  <IntelligenceLayer title="Activity Timeline" tone="activity" badge={`${events.length} events`} defaultOpen>
    <div className="nx-di25-intel-timeline-head">
      <span>Operational history for this deal</span>
      <button type="button" className="nx-di25-intel-sort" onClick={onToggleSort}>
        <Icon name={ascending ? 'chevron-up' : 'chevron-down'} />
        <span>{ascending ? 'Oldest first' : 'Newest first'}</span>
      </button>
    </div>
    {events.length ? (
      <div className="nx-di25-intel-timeline">
        {events.map((event, index) => (
          <article
            key={`${event.type}-${event.timestamp}-${event.label}-${index}`}
            className={cls('nx-di25-intel-timeline__event', event.tone && `is-${event.tone}`)}
          >
            <div className="nx-di25-intel-timeline__rail" aria-hidden>
              <span className="nx-di25-intel-timeline__node" />
              {index < events.length - 1 ? <span className="nx-di25-intel-timeline__line" /> : null}
            </div>
            <div className="nx-di25-intel-timeline__card">
              <header>
                <strong>{event.label}</strong>
                <span>{event.timestamp ? fmtDiDate(event.timestamp) : '—'}</span>
              </header>
              {event.source ? <em>{event.source}</em> : null}
              {event.detail ? <p>{event.detail}</p> : null}
            </div>
          </article>
        ))}
      </div>
    ) : (
      <p className="nx-di25-intel-empty">No activity recorded for this deal yet.</p>
    )}
  </IntelligenceLayer>
)

const EngineGroup = ({
  title,
  children,
  variant,
}: {
  title: string
  children: React.ReactNode
  variant?: 'offer' | 'strategy' | 'pressure' | 'execution'
}) => (
  <section className={cls('nx-di25-engine-group', variant && `is-${variant}`)}>
    <header className="nx-di25-engine-group__head">
      <h4>{title}</h4>
    </header>
    <div className="nx-di25-engine-group__body">{children}</div>
  </section>
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
  const { dossier, loading, error, refresh, runDecisionEngine, engineRunning, engineRunPhase, engineError, engineProgress } = useDealIntelligenceDossier({
    threadKey, propertyId, prospectId, masterOwnerId, canonicalE164,
  })

  const [mediaTab, setMediaTab] = useState<MediaTab>('street')
  const [showAllComps, setShowAllComps] = useState(false)
  const [addrCopied, setAddrCopied] = useState(false)
  const [engineElapsedMs, setEngineElapsedMs] = useState(0)
  const [activityAsc, setActivityAsc] = useState(false)
  const showDi = (_section: DealIntelligenceSection) => true

  const address = dossier?.property?.full_address || fallbackAddress || null
  const links = useMemo(() => buildPropertyExternalLinks(address), [address])
  const snap = dossier?.property_snapshot
  const baseline = dossier?.baseline_scores
  const property = dossier?.property
  const propertyScores = property as {
    acquisition_score?: number | null
    deal_strength_score?: number | null
    motivation_score?: number | null
    distress_score?: number | null
  } | undefined
  const propertyBaseline = useMemo(() => ({
    finalAcq: baseline?.acquisition_score ?? propertyScores?.acquisition_score,
    dealStrength: baseline?.deal_strength_score ?? propertyScores?.deal_strength_score,
    structuredMotivation: baseline?.motivation_score ?? propertyScores?.motivation_score,
    tagDistress: baseline?.distress_score ?? propertyScores?.distress_score,
  }), [baseline, propertyScores])
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

  useEffect(() => {
    if (!engineRunning) {
      setEngineElapsedMs(0)
      return undefined
    }
    const startedAt = Date.now()
    const tick = () => setEngineElapsedMs(Date.now() - startedAt)
    tick()
    const id = window.setInterval(tick, 120)
    return () => window.clearInterval(id)
  }, [engineRunning])

  useEffect(() => {
    const scrollBody = document.querySelector('.nx-intelligence-panel.is-layout-compact .nx-intel-scroll-body') as HTMLElement | null
    if (!scrollBody) return
    scrollBody.style.removeProperty('overflow-y')
    scrollBody.style.removeProperty('overflow')
  }, [threadKey, propertyId])

  const copyAddress = () => {
    if (!address) return
    navigator.clipboard.writeText(address).catch(() => undefined)
    setAddrCopied(true)
    setTimeout(() => setAddrCopied(false), 1400)
  }

  const displayProgress = useMemo<EngineRunStep[]>(
    () => ENGINE_STAGE_DISPLAY_ORDER.map((stage) => {
      const match = engineProgress.find((s) => s.stage === stage)
      return {
        stage,
        status: match?.status || 'pending',
        label: ENGINE_STAGE_LABELS[stage],
      }
    }),
    [engineProgress],
  )

  const compRecords = useMemo(() => {
    const records = (comps?.records || []) as CompRecord[]
    const order: Record<CompDisposition, number> = { included: 0, candidate: 1, excluded: 2 }
    return [...records].sort((a, b) => {
      const left = order[resolveCompDisposition(a)]
      const right = order[resolveCompDisposition(b)]
      if (left !== right) return left - right
      return (asNum(b.weight) || 0) - (asNum(a.weight) || 0)
    })
  }, [comps?.records])

  const visibleComps = useMemo(() => {
    if (showAllComps) return compRecords
    const included = compRecords.filter((comp) => resolveCompDisposition(comp) === 'included')
    const candidates = compRecords.filter((comp) => resolveCompDisposition(comp) === 'candidate')
    const primary = [...included, ...candidates]
    if (primary.length >= 4) return primary.slice(0, 4)
    const excluded = compRecords.filter((comp) => resolveCompDisposition(comp) === 'excluded')
    return [...primary, ...excluded].slice(0, 4)
  }, [compRecords, showAllComps])

  if (loading) {
    return (
      <div className="nx-deal-compact-shell nx-di25-loading">
        <div className="nx-di25-loading__hero" aria-hidden />
        <div className="nx-di25-loading__lines">
          <span /><span /><span />
        </div>
        {fallbackAddress ? <p className="nx-di25-loading__address">{fallbackAddress}</p> : null}
        <p>Loading deal intelligence…</p>
      </div>
    )
  }
  if (error && !dossier) return <div className="nx-deal-compact-shell nx-di25-error">{error}</div>

  const activityEvents = [...(dossier?.activity_timeline || [])].sort((a, b) => {
    const at = new Date(a.timestamp || 0).getTime()
    const bt = new Date(b.timestamp || 0).getTime()
    return activityAsc ? at - bt : bt - at
  })

  const relationshipFlags = parseFlagBadges(prospect?.relationship_flags || prospect?.matching_flags)
  const personFlags = parseFlagBadges(prospect?.person_flags)

  const convoState = convo as Record<string, unknown> | null | undefined
  const leadStateData: DealIntelligenceLeadStateData | null = threadKey ? {
    threadKey,
    lifecycle_stage: convoState?.lifecycle_stage as string | null | undefined,
    operational_status: convoState?.operational_status as string | null | undefined,
    lead_temperature: convoState?.lead_temperature as string | null | undefined,
    is_starred: convoState?.is_starred as boolean | null | undefined,
    is_pinned: convoState?.is_pinned as boolean | null | undefined,
    is_archived: convoState?.is_archived as boolean | null | undefined,
    snoozed_until: convoState?.snoozed_until as string | null | undefined,
    manual_stage_lock: convoState?.manual_stage_lock as boolean | null | undefined,
    manual_temperature_lock: convoState?.manual_temperature_lock as boolean | null | undefined,
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

  const propertyDetail = dossier?.property_detail as Record<string, Record<string, unknown>> | undefined
  const valuationDebtFields = propertyDetail?.valuation_debt
  const saleRecordingFields = propertyDetail?.sale_recording
  const physicalFields = propertyDetail?.physical
  const distressFields = propertyDetail?.distress_flags

  const { street: addressStreet, locality: addressLocality } = splitPropertyAddress(address, property?.market)
  const propertyTypeLabel = property?.property_type ? humanizeEnum(String(property.property_type)) : null
  const propertyClassLabel = property?.property_class ? humanizeEnum(String(property.property_class)) : null
  const conditionLabel = property?.condition ? humanizeEnum(String(property.condition)) : null
  const unitsLabel = fmtDiUnits(property?.units, isSfr)

  const profileChips = [
    property?.market ? { key: 'market', label: property.market, tone: 'market' as const } : null,
    propertyTypeLabel ? { key: 'type', label: propertyTypeLabel, tone: 'type' as const } : null,
    propertyClassLabel ? { key: 'class', label: propertyClassLabel, tone: 'neutral' as const } : null,
    unitsLabel ? { key: 'units', label: unitsLabel, tone: 'neutral' as const } : null,
    conditionLabel ? { key: 'condition', label: conditionLabel, tone: 'condition' as const } : null,
  ].filter(Boolean) as Array<{ key: string; label: string; tone: 'market' | 'type' | 'condition' | 'neutral' }>

  return (
    <div className={cls('nx-deal-compact-shell', engineRunning && 'is-engine-running')}>
      {showDi('overview') ? (
      <>
      <section className="nx-di25-media-block" aria-label="Property imagery">
        <div className="nx-di25-media__tabs" role="tablist" aria-label="Imagery mode">
          <button type="button" role="tab" aria-selected={mediaTab === 'street'} className={cls('nx-di25-media__tab', mediaTab === 'street' && 'is-active')} onClick={() => setMediaTab('street')}>
            Street View
          </button>
          <button type="button" role="tab" aria-selected={mediaTab === 'aerial'} className={cls('nx-di25-media__tab', mediaTab === 'aerial' && 'is-active')} onClick={() => setMediaTab('aerial')}>
            Aerial
          </button>
        </div>
        <DealIntelligenceMedia
          activeTab={mediaTab}
          address={address}
          lat={property?.latitude}
          lng={property?.longitude}
          streetStoredUrl={property?.street_view_url}
          aerialStoredUrl={property?.satellite_url}
        />
      </section>

      <section className="nx-di25-property-deck is-elevated" aria-label="Property identity">
        <div className="nx-di25-property-deck__identity">
          <div className="nx-di25-property-deck__address">
            <span className="nx-di25-property-deck__eyebrow">Subject Property</span>
            <h2 className="nx-di25-property-deck__street">{addressStreet}</h2>
            {addressLocality ? <p className="nx-di25-property-deck__locality">{addressLocality}</p> : null}
          </div>
          {threadKey ? (
            <DealIntelligenceTemperatureBadge
              threadKey={threadKey}
              temperature={convoState?.lead_temperature as string | null | undefined}
              manualTemperatureLock={convoState?.manual_temperature_lock as boolean | null | undefined}
              onPatched={() => void refresh()}
            />
          ) : null}
        </div>

        {profileChips.length || visibleFlags.length ? (
          <div className="nx-di25-property-deck__signals is-strip">
            {profileChips.map((chip) => (
              <span key={chip.key} className={cls('nx-di25-profile-chip', `is-${chip.tone}`)}>{chip.label}</span>
            ))}
            {visibleFlags.map((flag) => (
              <span key={flag} className="nx-di25-profile-chip is-flag">{humanizeEnum(flag)}</span>
            ))}
            {overflowCount > 0 ? <span className="nx-di25-profile-chip is-overflow">+{overflowCount}</span> : null}
          </div>
        ) : null}

        <div className="nx-di25-property-deck__action-rail" role="toolbar" aria-label="Property actions">
          {links.zillow ? (
            <a
              className="nx-di25-action-btn"
              href={links.zillow}
              target="_blank"
              rel="noopener noreferrer"
              title="Open on Zillow"
              aria-label="Open on Zillow"
            >
              <Icon name="external-link" />
              <span>Zillow</span>
            </a>
          ) : null}
          {links.realtor ? (
            <a
              className="nx-di25-action-btn"
              href={links.realtor}
              target="_blank"
              rel="noopener noreferrer"
              title="Open on Realtor"
              aria-label="Open on Realtor"
            >
              <Icon name="external-link" />
              <span>Realtor</span>
            </a>
          ) : null}
          {links.googleSearch ? (
            <a
              className="nx-di25-action-btn"
              href={links.googleSearch}
              target="_blank"
              rel="noopener noreferrer"
              title="Search property"
              aria-label="Search property"
            >
              <Icon name="globe" />
              <span>Search</span>
            </a>
          ) : null}
          <button
            type="button"
            className={cls('nx-di25-action-btn', addrCopied && 'is-success')}
            onClick={copyAddress}
            title={addrCopied ? 'Address copied' : 'Copy address'}
            aria-label={addrCopied ? 'Address copied' : 'Copy address'}
          >
            <Icon name={addrCopied ? 'check' : 'link'} />
            <span>{addrCopied ? 'Done' : 'Copy'}</span>
          </button>
        </div>

        {leadStateData ? (
          <div className="nx-di25-property-deck__pipeline">
            <header className="nx-di25-property-deck__pipeline-head">
              <span className="nx-di25-pipeline-head__glyph" aria-hidden="true">
                <Icon name="layers" />
              </span>
              <div className="nx-di25-pipeline-head__copy">
                <strong>Deal Pipeline</strong>
                <span>Stage flow & triage status</span>
              </div>
            </header>
            <DealIntelligenceCommandRow data={leadStateData} onPatched={() => void refresh()} />
          </div>
        ) : null}
      </section>
      </>
      ) : null}

      {showDi('property') ? (
      <>
      <section className="nx-di25-layer is-elevated">
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
      <section className="nx-di25-layer is-baseline is-elevated">
        <header className="nx-di25-layer__head nx-di25-layer__head--baseline">
          <div className="nx-di25-layer__title">
            <span>Baseline Property Intelligence</span>
            <em className="nx-di25-layer__hint">Recorded property scores</em>
          </div>
          <span className="nx-di25-baseline-badge">Baseline</span>
        </header>
        <BaselineHero
          finalAcq={propertyBaseline.finalAcq}
          dealStrength={propertyBaseline.dealStrength}
          structuredMotivation={propertyBaseline.structuredMotivation}
          tagDistress={propertyBaseline.tagDistress}
        />
      </section>
      </>
      ) : null}

      {showDi('deal') ? (
      <section className="nx-di25-layer is-engine is-elevated">
        <header className="nx-di25-layer__head nx-di25-layer__head--engine">
          <div className="nx-di25-layer__title">
            <span>Full Acquisition Decision Engine</span>
            <em className="nx-di25-layer__hint">
              {engineAvailable ? 'Live engine output' : 'Run to compute AOS & offer stack'}
            </em>
          </div>
          <span className={cls('nx-di25-engine-status', engineRunning && 'is-running', !engineRunning && engineAvailable && 'is-live')}>
            {engineRunning ? 'Running' : engineAvailable ? 'Live' : 'Ready'}
          </span>
        </header>

        <div className={cls('nx-di25-engine-body', engineRunning && 'is-theater-active')}>
          {!engineAvailable && !engineRunning ? (
            <EngineCta
              candidates={qual?.candidates_found != null ? Number(qual.candidates_found) : null}
              qualified={qual?.weighted_usable != null ? Number(qual.weighted_usable) : null}
              onRun={() => void runDecisionEngine()}
            />
          ) : null}

          {engineAvailable ? (
            <div className="nx-di25-engine-results">
              <EngineHero
                aos={engine.aos_score != null ? Number(engine.aos_score) : null}
                confidence={engine.confidence != null ? Number(engine.confidence) : null}
                tier={String(engine.decision_tier || '')}
                computedAt={String(engine.computed_at || '')}
              />
              <EngineGroup title="Offer Stack" variant="offer">
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
              <EngineGroup title="Strategy Fit" variant="strategy">
                <FieldRow label="Best Strategy" value={humanizeEnum(String(engine.best_strategy || ''))} full />
                <StrategyBars engine={engine} />
              </EngineGroup>
              <EngineGroup title="Pressure & Probability" variant="pressure">
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
              <EngineGroup title="Recommended Execution" variant="execution">
                <MetricGrid>
                  <FieldRow label="Owner Situation" value={humanizeEnum(String(engine.owner_situation_primary || ''))} full />
                  <FieldRow label="Conversation Angle" value={humanizeEnum(String(engine.recommended_conversation_angle || ''))} full />
                  <FieldRow label="Next Action" value={humanizeEnum(String(dossier?.decision_snapshot?.recommended_next_action || ''))} full />
                </MetricGrid>
              </EngineGroup>
              {!engineRunning ? (
                <button type="button" className="nx-di25-engine-btn is-secondary" onClick={() => void runDecisionEngine()}>
                  <Icon name="refresh-cw" />
                  <span>Re-run Decision Engine</span>
                </button>
              ) : null}
            </div>
          ) : null}

          {engineRunning && engineRunPhase ? (
            <EngineRunTheater steps={displayProgress} phase={engineRunPhase} elapsedMs={engineElapsedMs} />
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
        <MultifamilyIntelligencePanel multifamily={dossier.multifamily} property={property} />
      ) : null}

      {showDi('comps') && comps ? (
        <CompsWorkbench
          comps={comps}
          qual={qual}
          compRecords={compRecords}
          visibleComps={visibleComps}
          isMultifamily={isMultifamily}
          showAllComps={showAllComps}
          onToggleShowAll={() => setShowAllComps((v) => !v)}
        />
      ) : null}

      {showDi('seller') && convo?.status === 'available' ? (
        <ConversationIntelligencePanel convo={convo as Record<string, unknown>} dispositionMeta={dispositionMeta} />
      ) : null}

      {showDi('seller') && owner ? (
        <MasterOwnerPanel owner={owner as Record<string, unknown>} />
      ) : null}

      {showDi('seller') && prospect ? (
        <ProspectIntelligencePanel
          prospect={prospect as Record<string, unknown>}
          relationshipFlags={relationshipFlags}
          personFlags={personFlags}
        />
      ) : null}

      {showDi('contact') && phone ? (
        <PhoneIntelligencePanel phone={phone as Record<string, unknown>} contactabilityMeta={contactabilityMeta} />
      ) : null}

      {showDi('property') ? (
        <>
          <ValuationDebtPanel fields={valuationDebtFields} snap={snap} />
          <SaleRecordingPanel fields={saleRecordingFields} />
          <PhysicalPanel fields={physicalFields} isSfr={isSfr} />
          <DistressFlagsPanel fields={distressFields} />
        </>
      ) : null}

      {showDi('activity') ? (
        <ActivityTimelinePanel
          events={activityEvents}
          ascending={activityAsc}
          onToggleSort={() => setActivityAsc((v) => !v)}
        />
      ) : null}

      {showDi('property') && dossier?.census?.status === 'pending' ? (
        <DetailSection title="Census">
          <p className="nx-di25-muted-note">Census enrichment pending</p>
        </DetailSection>
      ) : null}
    </div>
  )
}
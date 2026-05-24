import React, { useMemo, useState, useEffect } from 'react'
import type { ThreadIntelligenceRecord, ThreadMessage, ThreadContext } from '../../../lib/data/inboxData'
import type { ThreadDossier } from '../../../lib/data/threadDossier'
import type { InboxStatus, SellerStage, InboxWorkflowThread } from '../../../lib/data/inboxWorkflowData'
import type { PanelMode } from '../inbox-layout-state'
import {
  normalizePropertySnapshot,
  buildPropertyExternalLinks,
  buildAerialViewUrl,
  buildStreetViewUrl,
} from '../inbox-normalization'
import type { NormalizedPropertySnapshot } from '../inbox-normalization'
import { Icon, type IconName } from '../../../shared/icons'
import { 
  formatCurrency, 
  formatPercent, 
  formatScore, 
  formatDate, 
  formatPhone, 
  formatInteger, 
  formatBoolean, 
  formatRelativeTime 
} from '../../../shared/formatters'

import {
  automationStateVisuals,
  getSellerStageVisual,
  getStatusVisual,
  inboxStatusOptions,
  sellerStageOptions,
  statusStyleVars,
} from '../status-visuals'

import { usePhase3Intelligence } from '../hooks/usePhase3Intelligence'
import type { Phase3Intelligence } from '../../../lib/data/inboxIntelligencePhase3'
import type { ViewLayoutMode } from '../view-layout'

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')
const GOOGLE_MAPS_API_KEY = (import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_MAPS_API_KEY || 'AIzaSyAhOk7KZkduU4qywmrlq5ZqSOtgktHYiFk'

import { detectPropertyCategory } from '../helpers/propertyHelpers'
import { WatchBell } from '../../../shared/WatchBell'
import { loadCensusForProperty, calculateInvestorOpportunityScore } from '../../../lib/data/censusData'
import type { CensusData } from '../../../lib/data/censusData'

const formatMoney = formatCurrency
const fmtPhone = formatPhone
const standardFormatDisplayValue = (v: any) => String(v ?? 'Not enriched')

// "Unavailable" fallback helpers — show quieted text for missing fields
const fmtU = (v: unknown): string => {
  if (v === null || v === undefined || v === '' || (typeof v === 'number' && (v === 0 || isNaN(v)))) return 'Unavailable'
  return String(v)
}
const fmtMoneyU = (v: unknown): string => { const n = Number(String(v ?? '').replace(/[,$\s]/g, '')); return n > 0 ? formatMoney(n) : 'Unavailable' }
const fmtPctU = (v: unknown, round = true): string => { const n = Number(v); return n > 0 ? `${round ? Math.round(n) : n}%` : 'Unavailable' }
const isUnavail = (s: string) => s === 'Unavailable'

const buildInteractiveStreetViewUrl = ({
  address,
  lat,
  lng,
}: {
  address?: string | null
  lat?: number | null
  lng?: number | null
}) => {
  if (!GOOGLE_MAPS_API_KEY) return undefined

  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) > 0.0001 && Math.abs(Number(lng)) > 0.0001
  const location = hasCoords ? `${lat},${lng}` : address
  if (!location) return undefined

  const params = new URLSearchParams({
    key: GOOGLE_MAPS_API_KEY,
    location,
    heading: '210',
    pitch: '2',
    fov: '85',
  })

  return `https://www.google.com/maps/embed/v1/streetview?${params.toString()}`
}

const buildInteractiveAerialViewUrl = ({
  address,
  lat,
  lng,
}: {
  address?: string | null
  lat?: number | null
  lng?: number | null
}) => {
  if (!GOOGLE_MAPS_API_KEY) return undefined

  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) > 0.0001 && Math.abs(Number(lng)) > 0.0001
  const center = hasCoords ? `${lat},${lng}` : address
  if (!center) return undefined

  const params = new URLSearchParams({
    key: GOOGLE_MAPS_API_KEY,
    center,
    zoom: hasCoords ? '19' : '17',
    maptype: 'satellite',
  })

  return `https://www.google.com/maps/embed/v1/view?${params.toString()}`
}

type WorkflowThread = InboxWorkflowThread & Partial<{
  age: number
  phone_carrier: string
  property_type_majority: string
  sfr_count: number
  mf_count: number
  urgency_count: number
  is_corporate_owner: boolean
  person_flags_json: any
  marital_status: string
  gender: string
  education_model: string
  est_household_income: string
  net_asset_value: string
  occupation: string
  occupation_group: string
  primary_owner_address: string
  mailing_address: string
  sellerFirstName: string
  motivationScore: number
  equityPercent: number
  equityAmount: number
  isTaxDelinquent: boolean
  isAbsentee: boolean
  isOwnerOccupied: boolean
  isVacant: boolean
  hasLien: boolean
  cashOffer: number | string
  estimatedValue: number | null
  estimatedRepairCost: number
  arv: number
  mao: number
  ai_recommended_opening_offer: number
  ai_offer: number
  walkaway_price: number
  walkaway_internal: number
  offer_confidence: string
  confidenceBand: string
  nextRequiredInfo: string
  assd_total_value: number
  sale_price: number
  portfolio_total_value: number
  portfolio_total_equity: number
  portfolio_total_loan_balance: number
  portfolio_total_loan_payment: number
  tax_amt: number
  past_due_amount: number
  total_loan_balance: number
  total_loan_payment: number
  detected_intent: string
  displayName: string
  contactLanguage: string
  updatedAt: string
  prospect_full_name: string
  language_preference: string
  owner_priority_score: number
  owner_priority_tier: string
  tax_delinquent_count: number
  active_lien_count: number
  oldest_tax_delinquent_year: number
  property_tax_delinquent: boolean
  firstTouchAt?: string
  first_touch_at?: string
  follow_up_at?: string
  property_active_lien: boolean
  portfolio_total_units: number
  property_count: number
  agent_persona: string
  agent_family: string
  displayMarket: string
  displayPhone: string
  prospect_best_phone: string
  prospect_best_email: string
  prospect_phone_score: number
  prospect_contact_score: number
  best_email_1: string
  best_language: string
  contactability_score: number
  financial_pressure_score: number
  urgency_score: number
  follow_up_cadence: string
  offerId: string
  underwritingId: string
  contractId: string
  titleId: string
  latitude: number
  longitude: number
  style: string
  sum_buildings_nbr: number
  avg_sqft_per_unit: number
  beds_per_unit: number
  sqft_range: string
  construction_type: string
  exterior_walls: string
  floor_cover: string
  basement: string
  other_rooms: string
  num_of_fireplaces: number
  patio: string
  porch: string
  deck: string
  driveway: string
  garage: string
  sum_garage_sqft: number
  air_conditioning: string
  heating_type: string
  heating_fuel_type: string
  interior_walls: string
  roof_cover: string
  roof_type: string
  pool: string
  property_tax_delinquent_year: number
  lot_acreage: number
  lot_square_feet: number
  sewer: string
  water: string
  zoning: string
  flood_zone: string
  last_sale_doc_type: string
  total_loan_amt: number
  assd_land_value: number
  assd_improvement_value: number
  rehab_level: string
  building_quality: string
  effective_year_built: number
  total_bedrooms: number
  total_baths: number
  building_square_feet: number
  building_condition: string
  property_county_name: string
  streetview_image: string
  satellite_image: string
  lastMessageBody: string
  aiSummary: string
}>

// ── Helper Utilities ──────────────────────────────────────────────────────

const normalizeText = (value: unknown): string => String(value ?? '').trim()

const isPresent = (value: unknown): boolean => {
  if (value === null || value === undefined) return false
  if (typeof value === 'number' && Number.isNaN(value)) return false
  const text = normalizeText(value).toLowerCase()
  return Boolean(text) && 
    text !== 'unknown' && 
    text !== 'n/a' && 
    text !== 'null' && 
    text !== 'undefined' && 
    text !== 'none' && 
    text !== '-' &&
    text !== 'not enriched' &&
    text !== 'nan' &&
    text !== 'no address'
}

const asStr = (value: unknown): string => normalizeText(value)


const getAvailableFields = (group: Record<string, unknown>): string[] =>
  Object.entries(group).filter(([, v]) => isPresent(v)).map(([k]) => k)

const getMissingFields = (group: Record<string, unknown>): Array<{ key: string; label: string }> =>
  Object.entries(group).filter(([, v]) => !isPresent(v)).map(([k]) => ({ key: k, label: k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }))

const toChip = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const n = Number(String(v).replace(/[,$\s]/g, ''))
  if (Number.isFinite(n)) return String(n)
  return String(v).trim() || null
}

const asNum = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const numeric = Number(String(value ?? '').replace(/[,$%\s]/g, ''))
  return Number.isFinite(numeric) ? numeric : 0
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const percentFromScore = (value: unknown, fallback = 0) => {
  const numeric = asNum(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return clamp(numeric > 1 ? numeric : numeric * 100, 0, 100)
}

// ── Reusable UI Components ────────────────────────────────────────────────

const DossierCard = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cls('nx-dossier-card', className)} style={{ display: 'block', visibility: 'visible', opacity: 1 }}>{children}</div>
)

export const DossierShell = ({ children }: { children: React.ReactNode }) => (
  <div className="nx-dossier-shell">{children}</div>
)

const QuietBadge = ({
  label,
  tone = 'default',
}: {
  label: string
  tone?: 'default' | 'accent' | 'warning' | 'danger' | 'success'
}) => <span className={cls('nx-quiet-badge', tone !== 'default' && `is-${tone}`)}>{label}</span>

const MetricInline = ({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string | null
  tone?: 'default' | 'accent' | 'warning' | 'danger' | 'success'
}) => {
  if (!isPresent(value)) return null

  return (
    <div className={cls('nx-metric-inline', tone !== 'default' && `is-${tone}`)}>
      <span className="nx-metric-inline__label">{label}</span>
      <strong className="nx-metric-inline__value">{value}</strong>
    </div>
  )
}
const ActionButton = ({
  label,
  icon,
  tone = 'default',
  disabled,
}: {
  label: string
  icon: string
  tone?: 'default' | 'accent' | 'warning' | 'danger'
  disabled?: boolean
}) => (
  <button type="button" className={cls('nx-action-button', tone !== 'default' && `is-${tone}`)} disabled={disabled}>
    <Icon name={icon as any} />
    <span>{label}</span>
  </button>
)

const DossierMetric = ({ 
  label, 
  value, 
  icon,
  accent,
  suffix,
  internal,
  showWhenMissing = false,
}: { 
  label: string; 
  value: string | null; 
  icon: string; 
  accent?: 'blue' | 'green' | 'amber' | 'purple' | 'red' | 'cyan';
  suffix?: string;
  internal?: boolean;
  showWhenMissing?: boolean;
}) => (
  !isPresent(value) && !showWhenMissing ? null : <div className={cls('nx-dossier-metric', !value && 'is-empty', accent && `is-${accent}`, internal && 'is-internal')}>
    <div className="nx-dossier-metric__icon"><Icon name={icon as any} /></div>
    <div className="nx-dossier-metric__content">
      <span className="nx-dossier-metric__label">{label}</span>
      <span className="nx-dossier-metric__value">
        {value || '—'}
        {suffix && value && <span className="nx-dossier-metric__suffix">{suffix}</span>}
      </span>
      {internal && <span className="nx-dossier-metric__internal-tag">INTERNAL</span>}
    </div>
  </div>
)

const DossierTabGroup = ({ 
  tabs, 
  active, 
  onChange, 
}: { 
  tabs: Array<{ id: string; label: string; icon: string; count?: number }>; 
  active: string; 
  onChange: (id: string) => void;
}) => (
  <div className="nx-dossier-tabs">
    {tabs.map((t) => (
      <button type="button" key={t.id} className={cls('nx-dossier-tab', t.id === active && 'is-active')} onClick={() => onChange(t.id)}
      >
        <Icon name={t.icon as any} />
        <span>{t.label}</span>
        {t.count !== undefined && t.count > 0 && <span className="nx-dossier-tab__count">{t.count}</span>}
      </button>
    ))}
  </div>
)

const MissingDataDisclosure = ({ fields }: { fields: Array<{ key: string; label: string }> }) => {
  const [open, setOpen] = useState(false)
  if (fields.length === 0) return null
  return (
    <div className="nx-missing-disclosure">
      <button type="button" className="nx-missing-disclosure__trigger" onClick={() => setOpen(!open)}>
        <Icon name="alert" />
        <span>{fields.length} missing {fields.length === 1 ? 'field' : 'fields'}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
      </button>
      {open && (
        <div className="nx-missing-disclosure__list">
          {fields.map((f) => (
            <span key={f.key} className="nx-missing-disclosure__item">{f.label}</span>
          ))}
        </div>
      )}
    </div>
  )
}

const LinkedRecordButton = ({ 
  label, 
  url, 
  icon,
  variant = 'default',
}: { 
  label: string; 
  url?: string | null; 
  icon: string;
  variant?: 'default' | 'primary' | 'internal';
}) => {
  if (!url) return null
  const isExternal = url.startsWith('http') || url.startsWith('https')
  return (
    <a
      href={url}
      target={isExternal ? '_blank' : undefined}
      rel={isExternal ? 'noopener noreferrer' : undefined}
      className={cls('nx-dossier-link', variant !== 'default' && `is-${variant}`)}
    >
      <Icon name={icon as any} />
      <span>{label}</span>
    </a>
  )
}


const IntelField = ({ 
  label, 
  value, 
  render,
  tone = 'default'
}: { 
  label: string; 
  value: unknown; 
  render?: React.ReactNode;
  tone?: 'default' | 'accent' | 'warning' | 'success' | 'danger'
}) => {
  const displayValue = render ? render : isPresent(value) ? asStr(value) : 'Not enriched'
  const isEmpty = !isPresent(value) && !render
  
  return (
    <div className={cls('nx-intel-field-v2', tone !== 'default' && `is-${tone}`, isEmpty && 'is-empty')}>
      <label className="nx-intel-field-v2__label">{label}</label>
      <div className="nx-intel-field-v2__value">{displayValue}</div>
    </div>
  )
}

const SectionEmptyState = ({ text }: { text: string }) => (
  <div className="nx-section-empty">
    <Icon name="alert" />
    <p>{text}</p>
  </div>
)

const ScoreRing = ({
  label,
  value,
  tone = 'blue',
  sublabel,
}: {
  label: string
  value: number
  tone?: 'blue' | 'green' | 'amber' | 'purple' | 'red'
  sublabel?: string
}) => {
  const pct = clamp(value, 0, 100)
  return (
    <div className={cls('nx-score-ring', `is-${tone}`)}>
      <div
        className="nx-score-ring__dial"
        style={{ ['--ring-progress' as any]: `${pct}%` }}
      >
        <strong>{Math.round(pct)}</strong>
        <span>/100</span>
      </div>
      <div className="nx-score-ring__copy">
        <label>{label}</label>
        <p>{sublabel || 'Signal calibrated from live thread context.'}</p>
      </div>
    </div>
  )
}

const MeterBar = ({
  label,
  value,
  tone = 'blue',
  valueLabel,
}: {
  label: string
  value: number
  tone?: 'blue' | 'green' | 'amber' | 'purple' | 'red'
  valueLabel?: string
}) => {
  const pct = clamp(value, 0, 100)
  return (
    <div className={cls('nx-meter-row', `is-${tone}`)}>
      <div className="nx-meter-row__head">
        <span>{label}</span>
        <strong>{valueLabel || `${Math.round(pct)}%`}</strong>
      </div>
      <div className="nx-meter-row__track">
        <div className="nx-meter-row__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

const SparkBars = ({
  title,
  values,
  labels,
  tone = 'blue',
}: {
  title: string
  values: number[]
  labels?: string[]
  tone?: 'blue' | 'green' | 'amber' | 'purple' | 'red'
}) => {
  const max = Math.max(...values, 1)
  return (
    <div className={cls('nx-spark-bars', `is-${tone}`)}>
      <div className="nx-spark-bars__title">{title}</div>
      <div className="nx-spark-bars__plot">
        {values.map((value, index) => (
          <div key={`${title}-${index}`} className="nx-spark-bars__item">
            <div className="nx-spark-bars__bar-shell">
              <div className="nx-spark-bars__bar" style={{ height: `${(value / max) * 100}%` }} />
            </div>
            <span>{labels?.[index] || `P${index + 1}`}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const PremiumEmptyState = ({
  title,
  body,
  kicker = 'PENDING DATA',
}: {
  title: string
  body: string
  kicker?: string
}) => (
  <div className="nx-premium-empty-state">
    <span>{kicker}</span>
    <strong>{title}</strong>
    <p>{body}</p>
  </div>
)



const SellerTemperatureIndicator = ({ interest }: { interest: string }) => {
  const isNone = String(interest || '').toLowerCase() === 'none'
  const label = isNone ? 'No Active Interest' : (interest?.toUpperCase() || 'UNKNOWN')
  
  return (
    <div className={cls('nx-header-interest-v3', `is-${interest}`)}>
      <Icon name="zap" style={{ fontSize: '10px' }} />
      <span>{label}</span>
    </div>
  )
}

const NextBestActionChip = ({ action, confidence, reasoning }: { action: string; confidence?: number; reasoning?: string }) => {
  const [showReason, setShowReason] = useState(false)
  
  return (
    <div className={cls('nx-nba-chip', showReason && 'is-expanded')}>
      <div className="nx-nba-chip__header">
        <Icon name="spark" />
        <span>NEXT BEST ACTION</span>
        {confidence && <span className="nx-nba-chip__conf">{Math.round(confidence * 100)}% CONF</span>}
      </div>
      <div className="nx-nba-chip__body">{action}</div>
      {reasoning && (
        <>
          <button type="button" className="nx-nba-chip__toggle" onClick={() => setShowReason(!showReason)}
          >
            <Icon name={showReason ? 'chevron-up' : 'chevron-down'} />
            <span>{showReason ? 'Hide reasoning' : 'Why this action?'}</span>
          </button>
          {showReason && (
            <div className="nx-nba-chip__reasoning nx-glass-surface">
              {String(reasoning || '')}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Next Best Action Logic ────────────────────────────────────────────────

interface NextActionResult {
  title: string
  reason: string
  suggestedReply?: string
  urgency: 'high' | 'medium' | 'low'
}

const getNextBestAction = (thread: WorkflowThread): NextActionResult => {
  const stage = thread.conversationStage
  const inboxStatus = thread.inboxStatus
  const hasArv = isPresent(thread.estimatedValue)
  const hasCondition = isPresent(thread.estimatedRepairCost)
  const lastReplyPreview = thread.latestMessageBody || thread.lastMessageBody || ''
  const sellerFirstName = thread.ownerDisplayName?.split(' ')[0] || 'there'
  const motivationScore = Number(thread.motivationScore || thread.priorityScore || 0)
  const equityPercent = Number(thread.equityPercent || 0)

  if (inboxStatus === 'waiting' || inboxStatus === 'queued') {
    return { title: 'Waiting on seller response', reason: 'Next follow-up will schedule when eligible.', urgency: 'low' }
  }

  if (inboxStatus === 'new_reply') {
    const intent = thread.uiIntent || ''
    if (intent === 'info_request' || intent === 'language_switch') {
      return { title: 'Review seller question', reason: 'Seller is asking for information. Respond promptly.', suggestedReply: `Hi ${sellerFirstName}, thanks for reaching out. I can help with that...`, urgency: 'high' }
    }
    if (intent === 'potential_interest' || intent === 'price_anchor') {
      return { title: 'Seller showing interest', reason: motivationScore >= 70 ? 'High motivation detected — move to offer discussion.' : 'Continue discovery.', suggestedReply: equityPercent >= 50 ? `Hi ${sellerFirstName}, based on the property's equity position, we may be able to present a competitive offer...` : undefined, urgency: 'high' }
    }
    return { title: 'Review new seller reply', reason: 'Classify intent and advance workflow.', suggestedReply: lastReplyPreview ? `Last message: "${lastReplyPreview.slice(0, 80)}..."` : undefined, urgency: 'high' }
  }

  if (inboxStatus === 'ai_draft_ready') {
    return { title: 'Review AI draft reply', reason: 'AI has prepared a response. Review and approve before sending.', suggestedReply: thread.aiDraft ? `Draft: "${thread.aiDraft.slice(0, 100)}${thread.aiDraft.length > 100 ? '...' : ''}"` : undefined, urgency: 'high' }
  }

  if (!hasArv && (stage === 'price_discovery' || stage === 'offer_reveal' || stage === 'negotiation')) {
    return { title: 'Verify ARV before revealing offer', reason: 'Cannot generate confident offer without ARV verification.', suggestedReply: `Hi ${sellerFirstName}, to give you the most accurate offer, I need to verify some property details...`, urgency: 'high' }
  }

  if (!hasCondition && (stage === 'condition_details' || stage === 'offer_reveal')) {
    return { title: 'Gather property condition details', reason: 'Repair estimate needed before offer.', suggestedReply: `Hi ${sellerFirstName}, can you describe the current condition of the property?`, urgency: 'medium' }
  }

  if (thread.isSuppressed) return { title: 'Thread suppressed', reason: 'No further action required.', urgency: 'low' }

  if (stage === 'ownership_check') return { title: 'Confirm ownership', reason: 'Verify seller is the legal owner.', suggestedReply: `Hi ${sellerFirstName}, can you confirm you're the owner?`, urgency: 'medium' }
  if (stage === 'interest_probe') return { title: 'Probe seller motivation', reason: 'Understand why they are considering selling.', suggestedReply: `Hi ${sellerFirstName}, what is motivating you to consider selling?`, urgency: 'medium' }
  if (stage === 'seller_response') return { title: 'Awaiting seller response', reason: 'Next follow-up pending.', urgency: 'low' }
  if (stage === 'negotiation') return { title: 'Active negotiation', reason: 'Review counter-offers and evaluate terms.', suggestedReply: equityPercent >= 60 ? `Hi ${sellerFirstName}, given the equity position, I think we can find common ground...` : undefined, urgency: 'high' }
  if (stage === 'contract_path') return { title: 'Move toward contract', reason: 'Terms aligned. Prepare contract.', suggestedReply: `Hi ${sellerFirstName}, I'd like to move forward with getting the property under contract...`, urgency: 'high' }

  return { title: thread.nextSystemAction || 'Review thread', reason: 'No specific action detected. Evaluate manually.', urgency: 'medium' }
}

// ── 1. Deal Command Header ────────────────────────────────────────────────



// ── 2. Workflow Control ───────────────────────────────────────────────────

export const WorkflowControl = ({
  thread,
  onStatusChange,
  onStageChange,
}: {
  thread: WorkflowThread
  onStatusChange: (status: InboxStatus | 'sent_message') => void
  onStageChange: (stage: SellerStage) => void
}) => {
  const [statusOpen, setStatusOpen] = useState(false)
  const [stageOpen, setStageOpen] = useState(false)
  const statusVisual = getStatusVisual(thread.inboxStatus)
  const stageVisual = getSellerStageVisual(thread.conversationStage)
  const autoVisual = automationStateVisuals[thread.automationState || 'manual']

  const handleStatusChange = (status: InboxStatus) => { onStatusChange(status); setStatusOpen(false) }
  const handleStageChange = (stage: SellerStage) => { onStageChange(stage); setStageOpen(false) }

  return (
    <DossierCard className="nx-workflow-control">
      <div className="nx-workflow-control__row">
        <span className="nx-workflow-control__label">Status</span>
        <div className="nx-workflow-control__dropdown">
          <button type="button" className="nx-workflow-btn" style={statusStyleVars(statusVisual)} onClick={() => setStatusOpen(!statusOpen)}>
            <i className="nx-workflow-dot" style={{ background: statusVisual.color }} />
            {statusVisual.label}
            <Icon name="chevron-down" />
          </button>
          {statusOpen && (
            <div className="nx-workflow-menu nx-liquid-panel">
              {inboxStatusOptions.map((opt) => (
                <button type="button" key={opt.value} className={cls('nx-workflow-menu-item', opt.value === thread.inboxStatus && 'is-selected')} style={statusStyleVars(opt)} onClick={() => handleStatusChange(opt.value as InboxStatus)}>
                  <i className="nx-workflow-dot" style={{ background: opt.color }} />
                  <div><strong>{opt.label}</strong><small>{opt.description}</small></div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="nx-workflow-control__row">
        <span className="nx-workflow-control__label">Stage</span>
        <div className="nx-workflow-control__dropdown">
          <button type="button" className="nx-workflow-btn" style={statusStyleVars(stageVisual)} onClick={() => setStageOpen(!stageOpen)}>
            <i className="nx-workflow-dot" style={{ background: stageVisual.color }} />
            {stageVisual.label}
            <Icon name="chevron-down" />
          </button>
          {stageOpen && (
            <div className="nx-workflow-menu nx-liquid-panel">
              {sellerStageOptions.map((opt) => (
                <button type="button" key={opt.value} className={cls('nx-workflow-menu-item', opt.value === thread.conversationStage && 'is-selected')} style={statusStyleVars(opt)} onClick={() => handleStageChange(opt.value as SellerStage)}>
                  <i className="nx-workflow-dot" style={{ background: opt.color }} />
                  <div><strong>{opt.label}</strong><small>{opt.description}</small></div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="nx-workflow-control__row">
        <span className="nx-workflow-control__label">Automation</span>
        <span className="nx-workflow-pill" style={{ '--wp-color': autoVisual?.color || '#a0aec0' } as any}>{autoVisual?.label || 'Manual'}</span>
      </div>
      {thread.queueStatus && (
        <div className="nx-workflow-control__row">
          <span className="nx-workflow-control__label">Queue</span>
          <span className="nx-workflow-pill">{asStr(thread.queueStatus)}</span>
        </div>
      )}
      {thread.nextSystemAction && (
        <div className="nx-workflow-control__row nx-workflow-next">
          <Icon name="spark" />
          <span>{thread.nextSystemAction}</span>
        </div>
      )}
    </DossierCard>
  )
}
export const OfferMemoCard = ({
  thread,
  layoutMode = 'full',
}: {
  thread: WorkflowThread
  layoutMode?: ViewLayoutMode
}) => {
  const [isUnderwriting, setIsUnderwriting] = useState(false)
  const [underwritingData, setUnderwritingData] = useState<any>(null)
  const [expanded, setExpanded] = useState(layoutMode === 'expanded' || layoutMode === 'full')
  
  const hasArv = isPresent(thread.estimatedValue)
  const aiOffer = Number(thread.ai_recommended_opening_offer || thread.ai_offer || 0)
  const cashOffer = Number(thread.cashOffer || thread.mao || 0)
  const walkaway = Number(thread.walkaway_price || thread.walkaway_internal || 0)
  
  const confidence = asStr(thread.offer_confidence || (hasArv ? 'Review internally' : 'Hold internal'))
  const isConfidenceHigh = confidence.toLowerCase().includes('high') || confidence.toLowerCase().includes('ready')
  const isConfidenceLow = confidence.toLowerCase().includes('low') || confidence.toLowerCase().includes('hold')
  const shouldCollapse = layoutMode === 'compact' || layoutMode === 'medium'

  const handleUnderwrite = async () => {
    setIsUnderwriting(true)
    try {
      const res = await fetch('/api/internal/offers/underwrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          address: thread.propertyAddress || thread.subject, 
          propertyType: detectPropertyCategory(thread) 
        })
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setUnderwritingData(data)
    } catch (err) {
      console.error('Underwriting failed:', err)
      alert('Underwriting failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setIsUnderwriting(false)
    }
  }

  const summary = (
    <div className="nx-offer-metrics-grid">
      <div className="nx-offer-metric-card">
        <label>Value</label>
        <div className="nx-metric-value">{formatMoney(Number(thread.estimatedValue || 0))}</div>
      </div>
      <div className="nx-offer-metric-card is-highlight">
        <label>AI Offer</label>
        <div className="nx-metric-value">
          {underwritingData ? formatMoney(underwritingData.valuation.mao) : (aiOffer > 0 ? formatMoney(aiOffer) : 'PENDING')}
        </div>
      </div>
      <div className="nx-offer-metric-card">
        <label>Equity</label>
        <div className="nx-metric-value">{formatPercent(Number(thread.equityPercent || 0)) || '—'}</div>
      </div>
      <div className="nx-offer-metric-card">
        <label>Repairs</label>
        <div className="nx-metric-value">{formatMoney(Number(thread.estimatedRepairCost || 0))}</div>
      </div>
    </div>
  )

  return (
    <DossierCard className="nx-offer-console nx-glass-card nx-offer-console--elite">
      <div className="nx-dossier-section__title nx-dossier-section__title--between">
        <span className="nx-command-label"><Icon name="zap" /> OFFER INTELLIGENCE</span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <div className={cls('nx-status-pill', hasArv ? 'is-success' : 'is-warning')}>
            {hasArv ? 'READY' : 'NEEDS ARV'}
          </div>
          {shouldCollapse && (
            <button type="button" className="nx-dossier-link" onClick={() => setExpanded((current) => !current)}>
              <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
              <span>{expanded ? 'Collapse' : 'Expand'}</span>
            </button>
          )}
        </div>
      </div>

      {shouldCollapse && summary}

      {(!shouldCollapse || expanded) && (
        <>
          <div className="nx-offer-metrics-grid">
            <div className="nx-offer-metric-card">
              <label>LEGACY CASH</label>
              <div className="nx-metric-value">{formatMoney(cashOffer)}</div>
            </div>
            <div className="nx-offer-metric-card is-highlight">
              <label>AI RECOMMENDED</label>
              <div className="nx-metric-value">
                {underwritingData ? formatMoney(underwritingData.valuation.mao) : (aiOffer > 0 ? formatMoney(aiOffer) : 'PENDING')}
              </div>
            </div>
            <div className="nx-offer-metric-card">
              <label>WALKAWAY</label>
              <div className="nx-metric-value">
                {underwritingData ? formatMoney(underwritingData.valuation.maoCeiling) : (walkaway > 0 ? formatMoney(walkaway) : '--')}
              </div>
            </div>
            <div className="nx-offer-metric-card">
              <label>CONFIDENCE</label>
              <div className={cls('nx-metric-sentiment', isConfidenceHigh && 'is-safe', isConfidenceLow && 'is-risk')}>
                {underwritingData ? `${underwritingData.valuation.score}% SAFE` : confidence.toUpperCase()}
              </div>
            </div>
          </div>
          
          {underwritingData && (
            <div className="nx-research-snapshot nx-glass-surface">
              <div className="nx-snapshot-header">AI RESEARCH TELEMETRY</div>
              <div className="nx-snapshot-grid">
                <div className="nx-snapshot-item">
                  <span>ARV EST</span>
                  <strong>{formatMoney(underwritingData.valuation.arv_estimate)}</strong>
                </div>
                <div className="nx-snapshot-item">
                  <span>REPAIRS</span>
                  <strong>{formatMoney(underwritingData.valuation.repair_estimate)}</strong>
                </div>
              </div>
              <div className="nx-snapshot-comps">
                {underwritingData.comps?.slice(0, 3).map((comp: any, i: number) => (
                  <a key={i} href={comp.source_url} target="_blank" rel="noreferrer" className="nx-comp-tag">
                    <Icon name="globe" /> {comp.price ? formatMoney(comp.price) : 'LINK'}
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="nx-offer-actions">
            <button type="button" className={cls('nx-command-button is-primary', isUnderwriting && 'is-loading')} onClick={handleUnderwrite} disabled={isUnderwriting}>
              <Icon name={isUnderwriting ? 'refresh-cw' : 'spark'} />
              {isUnderwriting ? 'ANALYZING...' : 'RUN AI UNDERWRITING'}
            </button>
          </div>
        </>
      )}
    </DossierCard>
  )
}

// ── 4. Next Best Action ───────────────────────────────────────────────────

export const AIActionCard = ({ thread, isSuppressed }: { thread: WorkflowThread; isSuppressed: boolean }) => {
  const action = getNextBestAction(thread)
  const [showReason, setShowReason] = useState(false)
  const lastReply = thread.latestMessageBody || thread.lastMessageBody

  return (
    <DossierCard className={cls('nx-next-action', `is-${action.urgency}`, 'nx-ai-action-card')}>
      <div className="nx-next-action__header">
        <Icon name="spark" />
        <span>AI Recommended Action</span>
        <QuietBadge
          label={action.urgency === 'high' ? 'Needs operator' : action.urgency === 'medium' ? 'Recommended' : 'Monitor'}
          tone={action.urgency === 'high' ? 'warning' : action.urgency === 'medium' ? 'accent' : 'default'}
        />
      </div>
      <div className="nx-next-action__body">
        <p className="nx-next-action__title">{action.title}</p>
        <p className="nx-next-action__reason">{action.reason}</p>
        {lastReply && <div className="nx-next-action__signal">Latest reply: {lastReply.slice(0, 140)}{lastReply.length > 140 ? '...' : ''}</div>}
        <button type="button" className="nx-next-action__why" onClick={() => setShowReason(!showReason)}>
          <Icon name={showReason ? 'chevron-down' : 'chevron-right'} />
          Why this action?
        </button>
        {showReason && (
          <div className="nx-next-action__explanation">
            <p>Based on: Stage = {thread.conversationStage}, Status = {thread.inboxStatus}
              {thread.motivationScore && `, Motivation = ${Math.round(Number(thread.motivationScore))}/100`}
              {thread.equityPercent && `, Equity = ${formatPercent(Number(thread.equityPercent || 0))}`}
            </p>
          </div>
        )}
      </div>
      {(thread.aiDraft || action.suggestedReply) && !isSuppressed && (
        <div className="nx-next-action__draft">
          <small>Suggested reply preview</small>
          <p>{thread.aiDraft || action.suggestedReply}</p>
        </div>
      )}
      <div className="nx-next-action__actions">
        <ActionButton label="Queue Reply" icon="clock" tone="accent" disabled={isSuppressed} />
        <ActionButton label="Edit" icon="file-text" />
        <ActionButton label="Review" icon="alert" tone="warning" />
        <ActionButton label="Suppress" icon="shield" tone="danger" disabled={isSuppressed} />
      </div>
    </DossierCard>
  )
}

// ── 5. Offer Intelligence ─────────────────────────────────────────────────

// ── 6. Property Intelligence Tabs ─────────────────────────────────────────

const PROPERTY_TABS = [
  { id: 'overview', label: 'OVERVIEW', icon: 'layers' },
  { id: 'location', label: 'LOCATION', icon: 'map' },
  { id: 'property', label: 'PROPERTY', icon: 'grid' },
  { id: 'valuation', label: 'EQUITY / VALUATION', icon: 'trending-up' },
  { id: 'tax', label: 'LAND / TAX', icon: 'briefing' },
]

const FieldTile = ({ label, value, tone = 'default' }: { label: string; value: unknown; tone?: 'default' | 'good' | 'warn' | 'bad' | 'accent' }) => {
  if (!isPresent(value)) return null
  return (
    <div className={cls('nx-intel-field', tone !== 'default' && `is-${tone}`)}>
      <span>{label}</span>
      <strong>{asStr(value)}</strong>
    </div>
  )
}

const FieldGrid = ({ children, columns = 2 }: { children: React.ReactNode; columns?: 2 | 3 }) => (
  <div className={cls('nx-intel-field-grid', columns === 3 && 'is-3-col')}>{children}</div>
)

const PanelSection = ({ title, icon = 'grid', children }: { title: string; icon?: IconName; children: React.ReactNode }) => (
  <section className="nx-intel-section">
    <div className="nx-intel-section__title"><Icon name={icon} /><span>{title}</span></div>
    {children}
  </section>
)

// ── Census Property Panel ────────────────────────────────────────────────────
const CensusPropertyPanel = ({ thread }: { thread: WorkflowThread }) => {
  const [data, setData] = useState<CensusData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    loadCensusForProperty(thread)
      .then((res) => {
        if (active) {
          setData(res)
          setLoading(false)
        }
      })
      .catch(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [thread?.id])

  if (loading) {
    return (
      <div className="nx-census-loading" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px', gap: '12px', color: '#94a3b8' }}>
        <Icon name="refresh-cw" className="animate-spin" style={{ fontSize: '24px' }} />
        <span style={{ fontSize: '12px', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Analyzing Census & Demographics...</span>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="nx-census-empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px', gap: '12px', color: '#94a3b8' }}>
        <Icon name="alert" style={{ fontSize: '24px', color: '#ef4444' }} />
        <span style={{ fontSize: '13px' }}>No demographic data found for this property location.</span>
      </div>
    )
  }

  const { score, grade, summary } = calculateInvestorOpportunityScore(data)
  const gradeColor: Record<string, string> = {
    A: '#14b8a6', B: '#f59e0b', C: '#fb923c', Watchlist: '#6b7280',
  }
  const fmt = (n: number | undefined, prefix = '', suffix = '') =>
    n != null && Number.isFinite(n) ? `${prefix}${n.toLocaleString()}${suffix}` : '—'
  const fmtK = (n: number | undefined) =>
    n != null && Number.isFinite(n) ? `$${Math.round(n / 1000)}K` : '—'
  const fmtPct = (n: number | undefined) =>
    n != null && Number.isFinite(n) ? `${Math.round(n)}%` : '—'

  return (
    <div className="nx-property-census-intel" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div className="nx-property-census-intel__hero nx-glass-surface" style={{ display: 'flex', alignItems: 'center', padding: '16px', borderRadius: '8px', gap: '16px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="nx-property-census-intel__hero-score" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div className="nx-property-census-intel__score-dial" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '64px', height: '64px', borderRadius: '50%', border: `3px solid ${gradeColor[grade]}`, color: '#fff' }}>
            <strong style={{ fontSize: '20px', fontWeight: 700 }}>{score}</strong>
            <span style={{ fontSize: '10px', opacity: 0.5 }}>/100</span>
          </div>
          <div className="nx-property-census-intel__hero-meta" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '10px', letterSpacing: '0.05em', color: '#94a3b8' }}>INVESTOR OPPORTUNITY SCORE</span>
            <span style={{ fontSize: '16px', fontWeight: 700, color: gradeColor[grade] }}>GRADE {grade}</span>
          </div>
        </div>
      </div>

      <div className="nx-intel-grid-v2">
        <IntelField label="MEDIAN INCOME" value={data.median_household_income} render={fmtK(data.median_household_income)} />
        <IntelField label="VACANCY RATE" value={data.vacancy_rate} render={fmtPct(data.vacancy_rate)} />
        <IntelField label="RENTER DENSITY" value={data.renter_occupied_percent} render={fmtPct(data.renter_occupied_percent)} />
        <IntelField label="OWNER OCCUPANCY" value={data.owner_occupied_percent} render={fmtPct(data.owner_occupied_percent)} />
        <IntelField label="MEDIAN RENT" value={data.median_gross_rent} render={fmt(data.median_gross_rent, '$')} />
        <IntelField label="MEDIAN HOME VALUE" value={data.median_home_value} render={fmtK(data.median_home_value)} />
        <IntelField label="POPULATION DENSITY" value={data.population_density} render={fmt(data.population_density)} />
        <IntelField label="MEDIAN AGE" value={data.median_age} render={fmt(data.median_age, '', ' YRS')} />
      </div>

      <div className="nx-property-census-intel__summary nx-glass-surface" style={{ display: 'flex', gap: '10px', padding: '12px', borderRadius: '8px', background: 'rgba(20,184,166,0.06)', border: '1px solid rgba(20,184,166,0.15)', color: '#14b8a6', fontSize: '12px', lineHeight: 1.4 }}>
        <Icon name="spark" style={{ fontSize: '16px', flexShrink: 0, marginTop: '2px' }} />
        <p style={{ margin: 0 }}>{summary}</p>
      </div>
    </div>
  )
}

const PropertyIntelFields = ({
  thread,
  subTab,
}: {
  thread: WorkflowThread
  subTab: 'overview' | 'location' | 'property' | 'equity' | 'tax' | 'census'
}) => {
  if (subTab === 'census') {
    return <CensusPropertyPanel thread={thread} />
  }

  const address = thread.displayAddress || 'Property Unknown'
  const propertyType = thread.propertyType || 'Residential'
  const market = thread.displayMarket || 'Unknown Market'

  const overviewRows: Array<[string, unknown]> = [
    ['FULL ADDRESS', address],
    ['PROPERTY TYPE', propertyType],
    ['BEDS', thread.total_bedrooms || thread.beds],
    ['BATHS', thread.total_baths || thread.baths],
    ['SQFT', thread.building_square_feet || thread.sqft],
    ['UNITS', thread.units_count],
    ['YEAR BUILT', thread.year_built],
    ['EFFECTIVE YEAR BUILT', thread.effective_year_built],
    ['ESTIMATED VALUE', formatMoney(Number(thread.estimatedValue || 0))],
    ['LAST SALE PRICE', formatMoney(Number(thread.sale_price || 0))],
    ['LAST SALE DATE', formatDate(thread.sale_date)],
    ['EQUITY PERCENT', formatPercent(Number(thread.equityPercent || 0))],
    ['OWNERSHIP YEARS', thread.ownership_years],
    ['CONDITION', thread.building_condition],
    ['FINAL ACQUISITION SCORE', formatScore(thread.finalAcquisitionScore)],
  ]

  const locationRows: Array<[string, unknown]> = [
    ['MARKET', market],
    ['ADDRESS', address],
    ['CITY', thread.property_address_city],
    ['STATE', thread.property_address_state],
    ['ZIP CODE', thread.property_address_zip],
    ['LATITUDE', thread.latitude],
    ['LONGITUDE', thread.longitude],
  ]

  const propertyRows: Array<[string, unknown]> = [
    ['PROPERTY CLASS', thread.property_class],
    ['PROPERTY STYLE', thread.style],
    ['STORIES', thread.stories],
    ['NUMBER OF UNITS', thread.units_count],
    ['NUMBER OF BUILDINGS', thread.sum_buildings_nbr],
    ['AVG SQUARE FEET PER UNIT', thread.avg_sqft_per_unit],
    ['AVG BEDS PER UNIT', thread.beds_per_unit],
    ['SQUARE FOOT RANGE', thread.sqft_range],
    ['CONSTRUCTION TYPE', thread.construction_type],
    ['EXTERIOR WALLS', thread.exterior_walls],
    ['FLOOR COVER', thread.floor_cover],
    ['BASEMENT', thread.basement],
    ['OTHER ROOMS', thread.other_rooms],
    ['NUMBER OF FIREPLACES', thread.num_of_fireplaces],
    ['PATIO', thread.patio],
    ['PORCH', thread.porch],
    ['DECK', thread.deck],
    ['DRIVEWAY', thread.driveway],
    ['GARAGE', thread.garage],
    ['GARAGE SQUARE FEET', thread.sum_garage_sqft],
    ['AC', thread.air_conditioning],
    ['HEATING TYPE', thread.heating_type],
    ['HEATING FUEL TYPE', thread.heating_fuel_type],
    ['INTERIOR WALLS', thread.interior_walls],
    ['ROOF COVER', thread.roof_cover],
    ['ROOF TYPE', thread.roof_type],
    ['POOL', thread.pool],
  ]

  const equityRows: Array<[string, unknown]> = [
    ['LAST SALE DOCUMENT', thread.last_sale_doc_type],
    ['ESTIMATED EQUITY AMOUNT', formatMoney(Number(thread.equityAmount || 0))],
    ['LOAN AMOUNT', formatMoney(Number((thread as any).total_loan_amt || 0))],
    ['LOAN BALANCE', formatMoney(Number(thread.total_loan_balance || 0))],
    ['LOAN PAYMENT', formatMoney(Number(thread.total_loan_payment || 0))],
    ['ASSESSED TOTAL VALUE', formatMoney(Number(thread.assd_total_value || 0))],
    ['ASSESSED LAND VALUE', formatMoney(Number((thread as any).assd_land_value || 0))],
    ['ASSESSED IMPROVEMENT VALUE', formatMoney(Number((thread as any).assd_improvement_value || 0))],
    ['ESTIMATED REPAIR COST', formatMoney(Number(thread.estimatedRepairCost || 0))],
    ['REHAB LEVEL', thread.rehab_level],
    ['BUILDING QUALITY', (thread as any).building_quality],
  ]

  const taxRows: Array<[string, unknown]> = [
    ['TAX DELINQUENT', formatBoolean(thread.property_tax_delinquent)],
    ['TAX DELINQUENT YEAR', thread.property_tax_delinquent_year],
    ['TAX AMOUNT', formatMoney(Number(thread.tax_amt || 0))],
    ['LOT SIZE ACRES', thread.lot_acreage],
    ['LOT SIZE SQUARE FEET', (thread as any).lot_square_feet],
    ['SEWER', (thread as any).sewer],
    ['WATER', (thread as any).water],
    ['ZONING', thread.zoning],
    ['FLOOD ZONE', (thread as any).flood_zone],
  ]

  const rows = subTab === 'overview'
    ? overviewRows
    : subTab === 'location'
      ? locationRows
      : subTab === 'property'
        ? propertyRows
        : subTab === 'equity'
          ? equityRows
          : taxRows

  return <div className="nx-intel-grid-v2">{rows.map(([label, value]) => <IntelField key={label} label={label} value={value} />)}</div>
}

export const PropertyIntelligenceTabs = ({
  thread,
}: {
  thread: WorkflowThread
  intelligence: ThreadIntelligenceRecord | null
}) => {
  const [activeTab, setActiveTab] = useState('overview')
  const address = thread.displayAddress || 'Property Unknown'
  const extLinks = buildPropertyExternalLinks(address)

  const fields = useMemo(() => ({
    unitCount: thread.units_count,
    yearBuilt: thread.year_built,
    effectiveYear: thread.effective_year_built,
    constructionType: thread.construction_type,
    exteriorWalls: thread.exterior_walls,
    floorCover: thread.floor_cover,
    basement: thread.basement,
    hvacType: thread.air_conditioning || thread.heating_type,
    roofCover: thread.roof_cover,
    beds: thread.total_bedrooms || thread.beds,
    baths: thread.total_baths || thread.baths,
    sqft: thread.building_square_feet || thread.sqft,
    stories: thread.stories,
    garage: thread.garage,
    propertyType: thread.propertyType,
    occupancy: thread.building_condition,
    county: thread.property_county_name,
    apn: thread.propertyId,
    zoning: thread.zoning,
    lotSize: thread.lot_acreage,
  }), [thread])

  const availableCount = getAvailableFields(fields).length
  const tabs = PROPERTY_TABS.map((t) => t.id === 'overview' ? { ...t, count: availableCount } : t)

  return (
    <DossierCard className="nx-property-tabs">
      <DossierTabGroup tabs={tabs} active={activeTab} onChange={(id) => setActiveTab(id as any)} />
      <div className="nx-property-tabs__content">
        {activeTab === 'overview' && (
          <>
            <div className="nx-field-group">
              <div className="nx-field-group__title"><Icon name="grid" /><span>Structure</span></div>
              <div className="nx-data-grid">
                <DossierMetric label="Units" value={toChip(fields.unitCount)} icon="grid" accent="blue" />
                <DossierMetric label="Beds" value={toChip(fields.beds)} icon="eye" accent="blue" />
                <DossierMetric label="Baths" value={toChip(fields.baths)} icon="eye" accent="blue" />
                <DossierMetric label="Sq Ft" value={fields.sqft ? Number(String(fields.sqft).replace(/,/g, '')).toLocaleString() : null} icon="maximize" accent="blue" />
                <DossierMetric label="Stories" value={toChip(fields.stories)} icon="layers" />
                <DossierMetric label="Garage" value={toChip(fields.garage)} icon="grid" />
              </div>
            </div>
            <div className="nx-field-group">
              <div className="nx-field-group__title"><Icon name="calendar" /><span>Age & Construction</span></div>
              <div className="nx-data-grid">
                <DossierMetric label="Year Built" value={toChip(fields.yearBuilt)} icon="calendar" accent="cyan" />
                <DossierMetric label="Effective Year" value={toChip(fields.effectiveYear)} icon="calendar" accent="cyan" />
                <DossierMetric label="Construction" value={toChip(fields.constructionType)} icon="layers" />
                <DossierMetric label="Exterior Walls" value={toChip(fields.exteriorWalls)} icon="layers" />
                <DossierMetric label="Basement" value={toChip(fields.basement)} icon="layers" />
              </div>
            </div>
            <div className="nx-field-group">
              <div className="nx-field-group__title"><Icon name="settings" /><span>Systems & Finishes</span></div>
              <div className="nx-data-grid">
                <DossierMetric label="AC / Heating" value={toChip(fields.hvacType)} icon="bolt" accent="amber" />
                <DossierMetric label="Floor Cover" value={toChip(fields.floorCover)} icon="grid" />
                <DossierMetric label="Roof Cover" value={toChip(fields.roofCover)} icon="bolt" accent="amber" />
              </div>
            </div>
            <MissingDataDisclosure fields={getMissingFields(fields)} />
          </>
        )}
        {activeTab === 'valuation' && (
          <>
            <div className="nx-field-group">
              <div className="nx-field-group__title"><Icon name="trending-up" /><span>Valuation</span></div>
              <div className="nx-data-grid">
                <DossierMetric label="Est. Value" value={formatMoney(Number(thread.estimatedValue || 0))} icon="trending-up" accent="green" />
                <DossierMetric label="Assessed Value" value={formatMoney(Number(thread.assd_total_value || 0))} icon="stats" />
                <DossierMetric label="Last Sale Price" value={formatMoney(Number(thread.sale_price || 0))} icon="arrow-up-right" />
                <DossierMetric label="Equity Amount" value={formatMoney(Number(thread.equityAmount || 0))} icon="zap" accent="green" />
                <DossierMetric label="Equity %" value={formatPercent(Number(thread.equityPercent || 0))} icon="activity" accent="green" />
              </div>
            </div>
            <MissingDataDisclosure fields={getMissingFields({
              estimatedValue: thread.estimatedValue,
              assessedValue: thread.assd_total_value,
              lastSalePrice: thread.sale_price,
              equityAmount: thread.equityAmount,
              equityPercent: thread.equityPercent,
            })} />
          </>
        )}
        {activeTab === 'property' && (
          <PropertyIntelFields thread={thread} subTab="property" />
        )}
        {activeTab === 'location' && (
          <PropertyIntelFields thread={thread} subTab="location" />
        )}
        {activeTab === 'tax' && (
          <PropertyIntelFields thread={thread} subTab="tax" />
        )}
        {activeTab === 'links' && (
          <div className="nx-links-grid">
            <LinkedRecordButton label="Zillow" url={extLinks?.zillow} icon="globe" />
            <LinkedRecordButton label="Realtor" url={extLinks?.realtor} icon="globe" />
            <LinkedRecordButton label="Google Maps" url={extLinks?.googleSearch} icon="map" />
            <LinkedRecordButton label="Street View" url={extLinks?.streetView} icon="map" />
          </div>
        )}
      </div>
    </DossierCard>
  )
}

// ── 7. Seller / Owner Intelligence ────────────────────────────────────────

export const SellerOwnerCard = ({ thread }: { thread: WorkflowThread }) => {
  const ownerName = thread.displayName || 'Unknown Seller'
  const phone = formatPhone(thread.phoneNumber || thread.canonicalE164 || thread.displayPhone)
  const phoneConfidence = thread.prospect_phone_score
  const language = thread.contactLanguage || thread.best_language
  const ownerType = thread.ownerType || thread.owner_type_guess
  const mailingLocation = thread.primary_owner_address
  const ownershipYears = thread.ownership_years
  const motivationScore = thread.motivationScore || thread.priorityScore
  const lastIntent = thread.uiIntent || thread.detected_intent
  const lastInbound = thread.lastInboundAt
  const lastOutbound = thread.lastOutboundAt
  const email = thread.prospect_best_email || (thread as any).best_email_1
  const initials = ownerName.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()
  const hasIdentityData = [phone, phoneConfidence, language, email, mailingLocation, ownershipYears, motivationScore, lastIntent, lastInbound, lastOutbound].some((v) => isPresent(v))

  return (
    <DossierCard className="nx-force-card nx-seller-card nx-seller-owner-card">
      <div className="nx-dossier-section__title" style={{ marginBottom: 10 }}>
        <Icon name="user" />
        <span>Seller / Owner Intelligence</span>
      </div>
      <div className="nx-seller-header">
        <div className="nx-seller-avatar">{initials}</div>
        <div className="nx-seller-info">
          <strong>{ownerName}</strong>
          <div className="nx-seller-chips">
            {isPresent(ownerType) && <QuietBadge label={asStr(ownerType)} />}
            {thread.isAbsentee && <QuietBadge label="Absentee" tone="warning" />}
            {thread.isOwnerOccupied && <QuietBadge label="Owner occupied" tone="success" />}
          </div>
        </div>
      </div>
      <div className="nx-seller-owner-card__meta">
        <MetricInline label="Best phone" value={phone} tone="accent" />
        <MetricInline label="Phone score" value={formatScore(phoneConfidence)} />
        <MetricInline label="Language" value={isPresent(language) ? asStr(language) : null} />
        <MetricInline label="Motivation score" value={formatScore(motivationScore)} tone="warning" />
        <MetricInline label="Last intent" value={isPresent(lastIntent) ? asStr(lastIntent) : null} />
        <MetricInline label="Last inbound" value={lastInbound ? formatRelativeTime(lastInbound) : null} />
        <MetricInline label="Last outbound" value={lastOutbound ? formatRelativeTime(lastOutbound) : null} />
        <MetricInline label="Mailing address" value={isPresent(mailingLocation) ? asStr(mailingLocation) : null} />
        <MetricInline label="Ownership years" value={isPresent(ownershipYears) ? `${toChip(ownershipYears)} yrs` : null} />
      </div>
      {!hasIdentityData && <SectionEmptyState text="Owner contact intelligence has not been enriched yet." />}
    </DossierCard>
  )
}

export const LinkedRecordsCard = ({ thread }: { thread: WorkflowThread }) => {
  const baseUrl = 'https://app.realestateflow.ai'
  const offerId = asStr((thread as any).offerId)
  const underwritingId = asStr((thread as any).underwritingId)
  const contractId = asStr((thread as any).contractId)
  const titleId = asStr((thread as any).titleId)
  const hasAnyLink = Boolean(
    thread.propertyId ||
    thread.ownerId ||
    thread.prospectId ||
    thread.canonicalE164 ||
    offerId ||
    underwritingId ||
    contractId ||
    titleId
  )

  if (!hasAnyLink) return null

  return (
    <DossierCard className="nx-bottom-app-links nx-linked-records-card">
      <div className="nx-bottom-app-links__title">LINKED APPS</div>
      <div className="nx-bottom-app-links__grid">
        {thread.propertyId && <LinkedRecordButton label="Property App" url={`${baseUrl}/properties/${thread.propertyId}`} icon="layers" variant="internal" />}
        {thread.ownerId && <LinkedRecordButton label="Owner App" url={`${baseUrl}/owners/${thread.ownerId}`} icon="user" variant="internal" />}
        {thread.prospectId && <LinkedRecordButton label="Prospect App" url={`${baseUrl}/prospects/${thread.prospectId}`} icon="users" variant="internal" />}
        {thread.canonicalE164 && <LinkedRecordButton label="Phone App" url={`${baseUrl}/phones/${encodeURIComponent(thread.canonicalE164)}`} icon="phone" variant="internal" />}
        {offerId && <LinkedRecordButton label="Offer App" url={`${baseUrl}/offers/${offerId}`} icon="zap" variant="internal" />}
        {underwritingId && <LinkedRecordButton label="Underwriting App" url={`${baseUrl}/underwriting/${underwritingId}`} icon="stats" variant="internal" />}
        {contractId && <LinkedRecordButton label="Contract App" url={`${baseUrl}/contracts/${contractId}`} icon="briefing" variant="internal" />}
        {titleId && <LinkedRecordButton label="Title App" url={`${baseUrl}/title/${titleId}`} icon="briefing" variant="internal" />}
      </div>
    </DossierCard>
  )
}

export const ActionRailCard = ({
  onOpenMap,
  onOpenDossier,
  onOpenAi,
}: {
  onOpenMap: () => void
  onOpenDossier: () => void
  onOpenAi: () => void
}) => (
  <div className="nx-intel-action-rail nx-intel-action-rail--premium">
    <button type="button" className="nx-intel-action-btn" onClick={onOpenMap}><Icon name="map" /> Map</button>
    <button type="button" className="nx-intel-action-btn" onClick={onOpenDossier}><Icon name="briefing" /> Dossier</button>
    <button type="button" className="nx-ai-assist-card" onClick={onOpenAi}>
      <div className="nx-ai-assist-icon">
        <Icon name="spark" />
      </div>
      <span>AI ASSIST</span>
    </button>
  </div>
)

const MatchBadge = ({ label, tone }: { label: string; tone: 'green' | 'yellow' | 'red' }) => (
  <span className={cls('nx-match-badge', `is-${tone}`)}>{label}</span>
)

const YesNoBadge = ({ label, yes }: { label: string; yes: boolean }) => (
  <span className={cls('nx-binary-badge', yes ? 'is-yes' : 'is-no')}>{label}: {yes ? 'Yes' : 'No'}</span>
)

const buildMatchBadges = (thread: WorkflowThread, limit = 3) => {
  const tags = String((thread as any).matching_flags || (thread as any).person_flags_text || '')
    .split(/[;,|]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
  const ownerType = asStr(thread.ownerType || thread.owner_type_guess).toLowerCase()
  const confidence = Number(thread.prospect_phone_score || thread.prospect_contact_score || 0)
  const out = new Map<string, 'green' | 'yellow' | 'red'>()

  if (confidence >= 80 || thread.ownerId) out.set('Likely Owner', 'green')
  else if (confidence >= 45 || thread.prospectId) out.set('Potential Owner', 'yellow')
  if (ownerType.includes('llc') || ownerType.includes('corpor') || ownerType.includes('company')) out.set('Linked To Company', 'green')
  if (tags.some((tag) => /company|business|entity/i.test(tag))) out.set('Potentially Linked To Company', 'yellow')
  if (tags.some((tag) => /family|relative/i.test(tag))) out.set('Family', 'yellow')
  if (tags.some((tag) => /resident|occupant/i.test(tag))) out.set('Resident', 'yellow')
  if (tags.some((tag) => /renter|tenant/i.test(tag))) out.set('Likely Renting', 'red')
  if (!out.size) out.set('Potential Owner', 'yellow')
  return Array.from(out.entries()).map(([label, tone]) => ({ label, tone })).slice(0, limit)
}

const buildProspectTagBadges = (thread: WorkflowThread, limit = 10) => {
  const tagsText = String((thread as any).matching_flags || (thread as any).person_flags_text || (thread as any).seller_tags_text || '')
  const jsonTags = Array.isArray((thread as any).person_flags_json) ? (thread as any).person_flags_json : []
  const tags = tagsText.split(/[;,|]/).map((tag) => tag.trim()).filter(Boolean)
  const combined = Array.from(new Set([...tags, ...jsonTags])).slice(0, limit)
  
  return combined.map((tag: string) => {
    let tone: 'green' | 'yellow' | 'red' = 'green'
    if (/renter|tenant|do not call|dnc|suppressed|dead/i.test(tag)) tone = 'red'
    else if (/probate|foreclosure|divorce|lien|tax/i.test(tag)) tone = 'yellow'
    return { label: tag, tone }
  })
}

const buildPropertyTagBadges = (thread: WorkflowThread, limit = 12) => {
  const tagsText = String((thread as any).property_flags_text || (thread as any).podio_tags || '')
  const jsonTags = Array.isArray((thread as any).property_flags_json) ? (thread as any).property_flags_json : []
  const tags = tagsText.split(/[;,|]/).map((tag) => tag.trim()).filter(Boolean)
  const combined = Array.from(new Set([...tags, ...jsonTags])).slice(0, limit)
  
  return combined.map((tag: string) => {
    let tone: 'green' | 'yellow' | 'red' = 'green'
    if (/vacant|boarded|condemned|fire/i.test(tag)) tone = 'red'
    else if (/probate|foreclosure|divorce|lien|tax|delinquent/i.test(tag)) tone = 'yellow'
    return { label: tag, tone }
  })
}

const MiniTimeline = ({ thread, messages, limit = 8 }: { thread: WorkflowThread; messages: ThreadMessage[]; limit?: number }) => {
  const messageItems = messages.slice(0, limit).map((message) => ({
    label: message.direction === 'inbound' ? 'Seller replied' : 'Queue sent',
    time: message.timelineAt || message.createdAt,
    detail: message.body,
    done: true,
    active: message.direction === 'inbound' && thread.inboxStatus === 'new_reply',
  }))
  const syntheticItems = [
    { label: 'First touch', time: thread.updatedAt, detail: 'Initial contact sequence opened.', done: true },
    { label: 'AI classified', time: thread.lastMessageAt, detail: thread.uiIntent || getSellerStageVisual(thread.conversationStage).label, done: true },
    { label: 'Auto response queued', time: thread.aiDraft ? thread.updatedAt : null, detail: thread.aiDraft || 'No draft queued.', done: Boolean(thread.aiDraft) },
    { label: 'Delivered', time: thread.lastOutboundAt, detail: (thread as any).deliveryStatus || 'Outbound delivery recorded.', done: Boolean(thread.lastOutboundAt) },
    { label: 'Escalation triggered', time: thread.inboxStatus === 'needs_review' ? thread.updatedAt : null, detail: 'Operator review required.', done: thread.inboxStatus === 'needs_review', active: thread.inboxStatus === 'needs_review' },
    { label: 'Offer generated', time: thread.updatedAt, detail: formatMoney(Number(thread.cashOffer || 0)) || 'Awaiting offer model.', done: isPresent(thread.cashOffer) },
  ]
  const items = (messageItems.length ? messageItems : syntheticItems).slice(0, limit)
  return (
    <div className="nx-war-room-timeline">
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`} className={cls('nx-war-room-timeline__item', item.done && 'is-done', item.active && 'is-active')}>
          <div className="nx-war-room-timeline__node" />
          <div className="nx-war-room-timeline__content">
            <strong>{item.label}</strong>
            <span>{item.time ? formatDate(item.time) : 'Pending'}</span>
            <p>{item.detail}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

type IntelligenceTabId =
  | 'overview'
  | 'prospect'
  | 'owner'
  | 'property'
  | 'portfolio'
  | 'financial'
  | 'conversation'
  | 'automation'
  | 'timeline'

const INTELLIGENCE_TABS: Array<{ id: IntelligenceTabId; label: string }> = [
  { id: 'overview', label: 'OVERVIEW' },
  { id: 'prospect', label: 'PROSPECT' },
  { id: 'owner', label: 'OWNER' },
  { id: 'property', label: 'PROPERTY INTEL' },
  { id: 'portfolio', label: 'PORTFOLIO' },
  { id: 'financial', label: 'FINANCIAL' },
  { id: 'conversation', label: 'CONVERSATION' },
  { id: 'automation', label: 'AUTOMATION' },
  { id: 'timeline', label: 'TIMELINE' },
]

export const DossierTabNav = ({ active, onChange }: { active: IntelligenceTabId; onChange: (tab: IntelligenceTabId) => void }) => (
  <nav className="nx-intelligence-tabs" aria-label="Deal intelligence tabs">
    {INTELLIGENCE_TABS.map((tab) => (
      <button type="button" key={tab.id} className={cls('nx-intelligence-tab', active === tab.id && 'is-active')} onClick={() => onChange(tab.id)}
      >
        <span>{tab.label}</span>
      </button>
    ))}
  </nav>
)

export const OverviewPanel = ({ thread, messages }: { thread: WorkflowThread; messages: ThreadMessage[] }) => {
  const action = getNextBestAction(thread)
  const latestInbound = messages.find((message) => message.direction === 'inbound')?.body || thread.latestMessageBody || thread.lastMessageBody
  return (
    <div className="nx-intel-panel-grid">
      <PanelSection title="Acquisition Command" icon="spark">
        <FieldGrid columns={3}>
          <FieldTile label="Acquisition Score" value={formatScore(thread.finalAcquisitionScore || (thread as any).ai_score)} tone="good" />
          <FieldTile label="Deal Strength" value={thread.priority || thread.priorityBucket} tone="accent" />
          <FieldTile label="Close Probability" value={formatPercent(Number(thread.motivationScore || 0))} />
          <FieldTile label="Intent" value={thread.uiIntent || thread.detected_intent} />
          <FieldTile label="Lead Status" value={getStatusVisual(thread.inboxStatus).label} />
          <FieldTile label="Responsiveness" value={thread.lastInboundAt ? 'Responsive' : 'N/A'} />
        </FieldGrid>
      </PanelSection>
      <PanelSection title="AI Recommendation" icon="spark">
        <div className="nx-intel-copy-card">
          <strong>{action.title}</strong>
          <p>{action.reason}</p>
          <div className="nx-intel-badge-row">
            <QuietBadge label={`Next: ${thread.nextSystemAction || action.suggestedReply || 'Monitor thread'}`} tone="accent" />
            <QuietBadge label={`Automation ${automationStateVisuals[thread.automationState || 'manual']?.label || 'Manual'}`} />
            <QuietBadge label={`Health ${thread.queueStatus || 'Healthy'}`} tone={thread.queueStatus === 'stuck' ? 'warning' : 'success'} />
          </div>
        </div>
      </PanelSection>
      <PanelSection title="Latest Inbound Summary" icon="message">
        <p className="nx-intel-body-copy">{latestInbound || 'No inbound message has been captured for this thread yet.'}</p>
      </PanelSection>
      <PanelSection title="Recent Activity Preview" icon="activity">
        <MiniTimeline thread={thread} messages={messages} limit={4} />
      </PanelSection>
    </div>
  )
}

export const ProspectPanel = ({ thread }: { thread: WorkflowThread; intelligence: ThreadIntelligenceRecord | null }) => {

  const badges = buildMatchBadges(thread)
  return (
    <div className="nx-intel-panel-grid">
      <PanelSection title="Prospect Identity" icon="users">
        <div className="nx-match-badge-row">{badges.map((badge) => <MatchBadge key={badge.label} label={badge.label} tone={badge.tone} />)}</div>
        <FieldGrid>
          <FieldTile label="Prospect Name" value={thread.prospect_full_name || thread.displayName} tone="accent" />
          <FieldTile label="Matching Confidence" value={formatScore(thread.prospect_contact_score || thread.prospect_phone_score)} />
          <FieldTile label="Contact Match Tags" value={(thread as any).matching_flags || (thread as any).person_flags_text} />
          <FieldTile label="Age" value={(thread as any).prospect_age} />
          <FieldTile label="Marital Status" value={(thread as any).marital_status} />
          <FieldTile label="Gender" value={(thread as any).gender} />
          <FieldTile label="Language" value={thread.language_preference || thread.contactLanguage} />
          <FieldTile label="Education" value={(thread as any).education_model} />
          <FieldTile label="Household Income" value={(thread as any).est_household_income} />
          <FieldTile label="Net Asset Value" value={(thread as any).net_asset_value} />
          <FieldTile label="Buying Power" value={(thread as any).buying_power} />
          <FieldTile label="Phone Carrier" value={(thread as any).phone_carrier} />
          <FieldTile label="Occupation" value={(thread as any).occupation} />
          <FieldTile label="Occupation Group" value={(thread as any).occupation_group} />
          <FieldTile label="Phone Number" value={formatPhone(thread.prospect_best_phone || thread.phoneNumber)} tone="good" />
          <FieldTile label="Email" value={thread.prospect_best_email} />
          <FieldTile label="SMS Eligible" value={formatBoolean((thread as any).sms_eligible)} />
          <FieldTile label="Email Eligible" value={formatBoolean((thread as any).email_eligible)} />
        </FieldGrid>
      </PanelSection>
    </div>
  )
}

export const OwnerPanel = ({ thread }: { thread: WorkflowThread; intelligence: ThreadIntelligenceRecord | null }) => {

  return (
  <div className="nx-intel-panel-grid">
    <PanelSection title="Owner Operations" icon="user">
      <FieldGrid>
        <FieldTile label="Owner Name" value={thread.ownerDisplayName || thread.ownerName} tone="accent" />
        <FieldTile label="Language" value={(thread as any).best_language} />
        <FieldTile label="Priority Tier" value={thread.owner_priority_tier || thread.priority} tone="accent" />
        <FieldTile label="Priority Score" value={formatScore(thread.owner_priority_score || thread.finalAcquisitionScore)} />
        <FieldTile label="Best Contact Window" value={thread.best_contact_window || 'Afternoon'} />
        <FieldTile label="Ownership Years" value={thread.ownership_years} />
        <FieldTile label="Owner Occupied" value={formatBoolean(thread.isOwnerOccupied)} tone={thread.isOwnerOccupied ? 'good' : 'bad'} />
        <FieldTile label="Absentee Status" value={formatBoolean(thread.isAbsentee)} tone={thread.isAbsentee ? 'warn' : 'good'} />
        <FieldTile label="Corporate Flag" value={formatBoolean((thread as any).is_corporate_owner)} />
        <FieldTile label="Owner Type" value={thread.owner_type_guess} />
        <FieldTile label="Contactability Score" value={formatScore(thread.contactability_score)} />
        <FieldTile label="Financial Pressure" value={formatScore(thread.financial_pressure_score)} />
        <FieldTile label="Urgency Score" value={formatScore(thread.urgency_score)} />
        <FieldTile label="Follow-up Cadence" value={thread.follow_up_cadence} />
      </FieldGrid>
    </PanelSection>
  </div>
  )
}

export const PortfolioPanel = ({ thread }: { thread: WorkflowThread; intelligence: ThreadIntelligenceRecord | null }) => (
  <div className="nx-intel-panel-grid">
    <PanelSection title="Portfolio Exposure" icon="layers">
      <FieldGrid>
        <FieldTile label="Portfolio Property Count" value={formatInteger(thread.property_count || 0)} />
        <FieldTile label="SFR Count" value={formatInteger((thread as any).sfr_count || 0)} />
        <FieldTile label="MF Count" value={formatInteger((thread as any).mf_count || 0)} />
        <FieldTile label="Total Units" value={formatInteger(thread.portfolio_total_units || 0)} />
        <FieldTile label="Portfolio Value" value={formatMoney(Number(thread.portfolio_total_value || 0))} tone="good" />
        <FieldTile label="Total Equity" value={formatMoney(Number(thread.portfolio_total_equity || 0))} tone="good" />
        <FieldTile label="Total Debt" value={formatMoney(Number(thread.portfolio_total_loan_balance || 0))} />
        <FieldTile label="Monthly Debt Pmt" value={formatMoney(Number(thread.portfolio_total_loan_payment || 0))} />
        <FieldTile label="Tax Delinquent Count" value={formatInteger(thread.tax_delinquent_count || 0)} tone={thread.tax_delinquent_count ? 'warn' : 'default'} />
        <FieldTile label="Active Lien Count" value={formatInteger(thread.active_lien_count || 0)} tone={thread.active_lien_count ? 'warn' : 'default'} />
      </FieldGrid>
    </PanelSection>
  </div>
)

export const FinancialPanel = ({ thread }: { thread: WorkflowThread; intelligence: ThreadIntelligenceRecord | null }) => (
  <div className="nx-intel-panel-grid">
    <PanelSection title="Financial Pressure" icon="stats">
      <div className="nx-binary-badge-row">
        <YesNoBadge label="Tax Delinquent" yes={Boolean(thread.property_tax_delinquent)} />
        <YesNoBadge label="Active Lien" yes={Boolean(thread.property_active_lien)} />
      </div>
      <FieldGrid>
        <FieldTile label="Financial Pressure Score" value={formatScore(thread.financial_pressure_score)} tone="warn" />
        <FieldTile label="Urgency Score" value={formatScore(thread.urgency_score)} tone="warn" />
        <FieldTile label="Tax Amount" value={formatMoney(Number(thread.tax_amt || 0))} />
        <FieldTile label="Oldest Tax Year" value={(thread as any).oldest_tax_delinquent_year} />
        <FieldTile label="Past Due Amount" value={formatMoney(Number(thread.past_due_amount || 0))} tone="bad" />
        <FieldTile label="Loan Balance" value={formatMoney(Number(thread.total_loan_balance || 0))} />
        <FieldTile label="Loan Payment" value={formatMoney(Number(thread.total_loan_payment || 0))} />
      </FieldGrid>
    </PanelSection>
  </div>
)

export const ConversationPanel = ({ thread, messages }: { thread: WorkflowThread; messages: ThreadMessage[] }) => {
  const inbound = messages.find((message) => message.direction === 'inbound')
  const outbound = messages.find((message) => message.direction === 'outbound')
  return (
    <div className="nx-intel-panel-grid">
      <PanelSection title="Conversation Intelligence" icon="message">
        <FieldGrid>
          <FieldTile label="Latest Inbound" value={inbound?.body || thread.latestMessageBody || thread.lastMessageBody} tone="accent" />
          <FieldTile label="Latest Outbound" value={outbound?.body} />
          <FieldTile label="AI Classification" value={thread.uiIntent || thread.detected_intent} />
          <FieldTile label="Seller Sentiment" value={thread.sentiment} />
          <FieldTile label="Timeline" value={thread.lastMessageAt ? formatRelativeTime(thread.lastMessageAt) : null} />
          <FieldTile label="Thread State" value={getStatusVisual(thread.inboxStatus).label} />
          <FieldTile label="Current Stage" value={getSellerStageVisual(thread.conversationStage).label} />
          <FieldTile label="Queued Reply" value={thread.aiDraft} />
        </FieldGrid>
      </PanelSection>
    </div>
  )
}

export const AutomationPanel = ({ thread }: { thread: WorkflowThread; intelligence: ThreadIntelligenceRecord | null }) => {
  return (
    <div className="nx-intel-panel-grid">
      <PanelSection title="Automation Control" icon="bolt">
        <FieldGrid>
          <FieldTile label="Queue Health" value={thread.queueStatus || 'Healthy'} tone={thread.queueStatus === 'stuck' ? 'bad' : 'good'} />
          <FieldTile label="Automation Active" value={thread.automationState === 'active' ? 'Yes' : 'No'} tone={thread.automationState === 'active' ? 'good' : 'warn'} />
          <FieldTile label="Last Run" value={formatDate(thread.updatedAt)} />
          <FieldTile label="Auto Reply Status" value={thread.autoReplyStatus} />
          <FieldTile label="Send Eligibility" value={(thread as any).isOptOut || thread.isSuppressed ? 'Suppressed' : 'Eligible'} tone={(thread as any).isOptOut || thread.isSuppressed ? 'bad' : 'good'} />
          <FieldTile label="Routing Market" value={thread.displayMarket || thread.market} />
          <FieldTile label="Assigned Number" value={formatPhone(thread.ourNumber)} />
          <FieldTile label="Agent Persona" value={thread.agent_persona} />
          <FieldTile label="Agent Family" value={thread.agent_family} />
        </FieldGrid>
      </PanelSection>
    </div>
  )
}


// ── Improved Automation Timeline ──────────────────────────────────────────

const TimelineEvent = ({ 
  label, 
  time, 
  state = 'neutral', 
  subtext, 
  badge,
  details
}: { 
  label: string; 
  time: string; 
  state?: 'neutral' | 'positive' | 'negative' | 'active'; 
  subtext?: string;
  badge?: { label: string; tone: 'accent' | 'success' | 'danger' | 'neutral' };
  details?: React.ReactNode;
}) => {
  const [showDetails, setShowDetails] = useState(false)
  const stateColor = {
    neutral: '#0a84ff',
    positive: '#30d158',
    negative: '#ff453a',
    active: '#bf5af2'
  }[state] || '#0a84ff'

  return (
    <div className={cls('nx-timeline-item', `is-${state}`)}>
      <div className="nx-timeline-connector" />
      <div 
        className="nx-timeline-dot" 
        style={{ backgroundColor: stateColor, borderColor: 'rgba(0,0,0,0.4)' }}
      />
      <div className="nx-timeline-content">
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%' }}>
            <div className="nx-timeline-label-group">
              <div className="nx-timeline-label">{label}</div>
              <div className="nx-timeline-time">
                {new Date(time).toLocaleDateString()} , {new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </div>
              {subtext && <div className="nx-timeline-subtext">{subtext}</div>}
            </div>
            {badge && (
              <div className={`nx-timeline-item-badge is-${badge.tone || 'neutral'}`}>
                {badge.label}
              </div>
            )}
          </div>
          {details && (
            <div className="nx-timeline-details-shell">
              <button type="button" className="nx-timeline-details-toggle" onClick={() => setShowDetails(!showDetails)}
              >
                <Icon name={showDetails ? 'chevron-down' : 'chevron-right'} />
                <span>{showDetails ? 'Hide Details' : 'View AI Decision Detail'}</span>
              </button>
              {showDetails && <div className="nx-timeline-details-content">{details}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const AIDecisionDetail = ({ 
  decision, 
  routing 
}: { 
  decision?: Phase3Intelligence['aiDecisions'][0], 
  routing?: Phase3Intelligence['routingDecisions'][0] 
}) => {
  if (!decision && !routing) return null

  return (
    <div className="nx-ai-decision-detail">
      <div className="nx-ai-decision-detail__reason">
        <strong>Reasoning:</strong>
        <p>{String(decision?.decision_value || routing?.decision_type?.replace(/_/g, ' ') || '')}</p>
      </div>
      {routing?.rules_triggered && routing.rules_triggered.length > 0 && (
        <div className="nx-ai-decision-detail__rules">
          <strong>Rules Triggered:</strong>
          <ul>
            {routing.rules_triggered.map((rule, i) => <li key={i}>{rule}</li>)}
          </ul>
        </div>
      )}
      <div className="nx-ai-decision-detail__meta">
        <span>Confidence: {Math.round((decision?.confidence || routing?.confidence || 0) * 100)}%</span>
        {routing?.routed_to && <span>Action: {routing.routed_to}</span>}
      </div>
    </div>
  )
}

export const TimelinePanel = ({ thread, messages, phase3 }: { thread: WorkflowThread; messages: ThreadMessage[]; phase3?: Phase3Intelligence | null }) => {
  const events = useMemo(() => {
    const rawEvents: Array<{ label: string; time: string | Date; state: 'neutral' | 'positive' | 'negative' | 'active'; subtext?: string; badge?: any; priority: number; details?: React.ReactNode }> = []

    // ... existing classifyMessage function ...
    const classifyMessage = (body: string) => {
      const text = body.toLowerCase().trim()
      
      const isNegative = [
        'stop', 'unsubscribe', 'remove', 'cancel', 'quit', 'end', 'para', 'basta', 'detente', // Compliance
        'wrong number', 'not the owner', 'already sold', 'not interested', 'no interest', 'pass', 'nah', 'nope', // Objections
        'too low', 'lowball', 'scam', 'shady', 'sketchy', 'sus', 'fake', 'cap', // Trust
        'too much work', 'condition is bad', 'mold', 'fire damage', 'gut job', 'trashed', 'wreck', // Condition
        'listed', 'realtor', 'agent', 'mls', 'zillow', 'another offer', 'realtor.com', // Market
        'divorce', 'probate', 'inheritance', 'passed away', 'foreclosure', 'bankruptcy', 'behind on payments', // Distress
        'buzz off', 'leave me alone', 'get lost', 'get out', 'stfu', 'wtf', 'wth', 'annoying', 'harassment', 'harassing' // Aggressive
      ].some(p => text.includes(p))
      
      if (isNegative) return { label: 'Negative Intent', state: 'negative' }
      
      const isPositive = [
        'interested', 'how much', 'price', 'offer', 'ready', 'motivated', 'vacant', 'empty',
        'yes', 'yeah', 'yup', 'sure', 'ok', 'let\'s talk', 'call me', 'email me', 'send offer',
        'affirmative', 'correct', 'that is correct', 'i am the owner', 'soy el dueño',
        'quick close', 'fast close', 'asap', 'need to sell', 'want to sell'
      ].some(p => text.includes(p))
      
      if (isPositive) return { label: 'Positive Intent', state: 'positive' }
      
      const isCurious = ['how does it work', 'process', 'info', 'details', 'who is this', 'who are you', 'how did you get my number'].some(p => text.includes(p))
      if (isCurious) return { label: 'Neutral Intent (Curious)', state: 'neutral' }
      
      return { label: 'Neutral Intent', state: 'neutral' }
    }

    const firstTouchAt = thread.firstTouchAt || thread.first_touch_at
    if (firstTouchAt && (!messages || messages.length === 0)) {
      rawEvents.push({ label: 'Lead Entered Pipeline', time: firstTouchAt, state: 'neutral', priority: 0 })
    }

    const safeMessages = [...(messages || [])].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    let firstOutboundFound = false
    
    safeMessages.forEach(m => {
      const isSeller = m.direction === 'inbound'
      const timestamp = m.timelineAt || m.createdAt
      const body = m.body || ''
      
      if (isSeller) {
        rawEvents.push({ label: 'Seller Replied', time: timestamp, state: 'neutral', priority: 1 })
        
        const classification = classifyMessage(body)
        rawEvents.push({ 
          label: `Intent Classified: ${classification.label}`, 
          time: timestamp, 
          state: classification.state as any,
          subtext: body.length > 40 ? body.substring(0, 40) + '...' : body,
          priority: 2 
        })

        if (body.toLowerCase().includes('$') || body.toLowerCase().includes('price')) {
          rawEvents.push({ label: 'Asking Price Given', time: timestamp, state: 'positive', priority: 3 })
        }
      } else {
        const templateName = (m as any).template_name || (m as any).templateName || (m.metadata as any)?.template_name
        let label = 'Response Sent'
        
        if (!firstOutboundFound) {
          label = 'First Touch'
          firstOutboundFound = true
        } else if (templateName) {
          label = `Next Template Sent: ${templateName}`
        }

        rawEvents.push({ 
          label, 
          time: timestamp, 
          state: 'neutral',
          priority: 1
        })
      }
    })

    if (thread.estimatedValue) {
      rawEvents.push({ 
        label: 'AI Underwrite Complete', 
        time: thread.updatedAt, 
        state: 'positive',
        subtext: `ARV: ${formatMoney(thread.estimatedValue)}`,
        priority: 5
      })
    }

    if (thread.conversationStage) {
      const stageVisual = getSellerStageVisual(thread.conversationStage)
      rawEvents.push({ 
        label: `Stage: ${stageVisual.label || thread.conversationStage}`, 
        time: thread.updatedAt, 
        state: 'neutral',
        priority: 6
      })
    }

    if (phase3) {
      phase3?.recentTurns?.forEach(turn => {
        if (turn.intent_detected) {
          rawEvents.push({
            label: `Memory Intent: ${turn.intent_detected}`,
            time: turn.created_at,
            state: 'active',
            subtext: `Handled by ${turn.handled_by} (${Math.round((turn.confidence_score || 0) * 100)}% conf)`,
            priority: 4
          })
        }
      })

      phase3?.routingDecisions?.forEach(rd => {
        rawEvents.push({
          label: `AI Routing: ${rd.decision_type.replace(/_/g, ' ')}`,
          time: rd.created_at,
          state: 'active',
          subtext: `Routed to ${rd.routed_to}`,
          badge: { label: 'ESCALATION', tone: rd.decision_type.includes('escalate') ? 'danger' : 'accent' },
          details: <AIDecisionDetail routing={rd} />,
          priority: 5
        })
      })

      phase3?.aiDecisions?.forEach(ad => {
        rawEvents.push({
          label: `AI Decision: ${ad.decision_category.replace(/_/g, ' ')}`,
          time: ad.created_at,
          state: 'positive',
          subtext: ad.decision_value,
          details: <AIDecisionDetail decision={ad} />,
          priority: 4
        })
      })

      phase3?.negotiationEvents?.forEach(ne => {
        const type = ne.event_type.replace(/_/g, ' ')
        rawEvents.push({
          label: `Milestone: ${type}`,
          time: ne.created_at,
          state: 'positive',
          subtext: String(ne.event_payload?.reason || ne.event_payload?.summary || ''),
          badge: { label: 'NEGOTIATION', tone: 'success' },
          priority: 6
        })
      })
    }

    const sorted = [...rawEvents].sort((a, b) => {
      const timeA = new Date(a.time).getTime()
      const timeB = new Date(b.time).getTime()
      if (timeA !== timeB) return timeA - timeB
      return a.priority - b.priority
    })

    if (sorted.length > 0) {
      const lastIdx = sorted.length - 1
      sorted[lastIdx] = { ...sorted[lastIdx], state: 'active' }
    }

    return [...sorted].reverse()
  }, [thread, messages, phase3])

  const isCritical = thread.inboxStatus === 'new_reply' || thread.priority === 'urgent'
  const hasMemory = Boolean(phase3?.thread)
  const scheduleMoments = [
    { label: 'First touch', value: thread.firstTouchAt || thread.first_touch_at || thread.updatedAt },
    { label: 'Last reply', value: thread.lastInboundAt || thread.lastMessageAt },
    { label: 'Next follow-up', value: thread.follow_up_at || (thread as any).followUpAt || thread.updatedAt },
  ].filter((item) => Boolean(item.value))

  return (
    <div className="nx-intel-panel-grid">

      <DossierCard className="nx-force-card nx-timeline-card nx-timeline-workspace-card">
        <div className="nx-dossier-section__title" style={{ justifyContent: 'space-between', marginBottom: 20 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700 }}>
            <Icon name="activity" />
            Automation Timeline
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            {hasMemory ? <QuietBadge label="MEMORY ACTIVE" tone="success" /> : <QuietBadge label="MEMORY NOT BUILT YET" tone="default" />}
            {isCritical && <QuietBadge label="CRITICAL" tone="danger" />}
          </div>
        </div>

        <div className="nx-timeline-memory-strip">
          {scheduleMoments.map((moment) => (
            <div key={moment.label} className="nx-timeline-memory-strip__item">
              <span>{moment.label}</span>
              <strong>{moment.value ? formatDate(moment.value) : 'Pending'}</strong>
            </div>
          ))}
        </div>

        <div className="nx-timeline-v2">
          {events.length > 0 ? events.map((ev, idx) => (
            <TimelineEvent key={idx} {...ev} time={typeof ev.time === 'string' ? ev.time : ev.time.toISOString()} />
          )) : (
            <SectionEmptyState text="No timeline events captured yet." />
          )}
        </div>
      </DossierCard>
    </div>
  )
}

// ── Property Hero Components ──────────────────────────────────────────────




const PicField = ({
  label,
  value,
  accent,
}: {
  label: string
  value?: string | number | null
  accent?: 'green' | 'red' | 'amber' | 'blue' | 'purple'
}) => {
  const str = value !== null && value !== undefined ? String(value).trim() : ''
  const isEmpty = !str || /^(not enriched|n\/a|none)$/i.test(str)
  return (
    <div className={cls('nx-pic-field', isEmpty ? 'is-empty' : null, accent ? `is-accent-${accent}` : null)}>
      <label>{label}</label>
      <span>{isEmpty ? 'Not enriched' : str}</span>
    </div>
  )
}

export const PropertyHeroCard = ({
  thread,
  snapshot,
  panelMode: _panelMode,
  layoutMode = 'full',
}: {
  thread: WorkflowThread
  snapshot: NormalizedPropertySnapshot
  panelMode?: PanelMode
  layoutMode?: ViewLayoutMode
}) => {
  const address = snapshot.fullAddress || thread.displayAddress || thread.propertyAddress || thread.subject
  const unitCount = Number(snapshot.unitCount || thread.units_count || 0)
  const propertyLat = Number((thread as any).lat ?? thread.latitude ?? 0)
  const propertyLng = Number((thread as any).lng ?? thread.longitude ?? 0)
  const rawMarket = snapshot.market || thread.displayMarket || thread.market || thread.marketId
  const displayMarket = isPresent(rawMarket) && !/^\d+$/.test(String(rawMarket))
    ? rawMarket
    : (snapshot.city && snapshot.state ? `${snapshot.city}, ${snapshot.state}` : (rawMarket || 'Unknown market'))

  const streetViewUrl = snapshot.streetViewUrl || snapshot.streetviewImage || thread.streetview_image || buildStreetViewUrl(address)
  const aerialUrl = snapshot.aerialViewUrl || thread.satellite_image || buildAerialViewUrl(address)
  const interactiveStreetViewUrl = useMemo(
    () => buildInteractiveStreetViewUrl({ address, lat: propertyLat, lng: propertyLng }),
    [address, propertyLat, propertyLng],
  )
  const interactiveAerialViewUrl = useMemo(
    () => buildInteractiveAerialViewUrl({ address, lat: propertyLat, lng: propertyLng }),
    [address, propertyLat, propertyLng],
  )
  const [imageFailed, setImageFailed] = useState(false)
  const [mediaMode, setMediaMode] = useState<'split' | 'street' | 'aerial'>('split')
  const links = buildPropertyExternalLinks(address)

  useEffect(() => { setImageFailed(false) }, [streetViewUrl, address])
  useEffect(() => { setMediaMode('split') }, [address])

  const [copied, setCopied] = useState(false)
  const handleCopyAddress = () => {
    if (!address) return
    navigator.clipboard.writeText(address).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  if (layoutMode === 'compact') {
    return (
      <div className="nx-property-hero-cinematic">
        {streetViewUrl && !imageFailed ? (
          <img src={streetViewUrl} alt={address} onError={() => setImageFailed(true)} />
        ) : (
          <div className="nx-property-hero-cinematic__fallback">
            <div className="nx-hero-fallback-bg" />
            <div className="nx-hero-fallback-inner">
              <Icon name={"navigation" as any} />
              {address && <span className="nx-hero-fallback-address">{address}</span>}
              <span className="nx-hero-fallback-hint">Street View</span>
            </div>
          </div>
        )}
        <div className="nx-property-hero-cinematic__gradient" />
        <div className="nx-property-hero-cinematic__hover-actions">
          {links.streetView && <LinkedRecordButton label="Street View" url={links.streetView} icon="map" />}
          {aerialUrl && <LinkedRecordButton label="Aerial" url={aerialUrl as string} icon="navigation" />}
          {links.zillow && <LinkedRecordButton label="Zillow" url={links.zillow} icon="globe" />}
          {links.realtor && <LinkedRecordButton label="Realtor" url={links.realtor} icon="home" />}
          {links.googleSearch && <LinkedRecordButton label="County" url={links.googleSearch} icon="briefing" />}
          <button type="button" className="nx-hero-pill" onClick={handleCopyAddress}>
            <Icon name={copied ? 'check' : 'layers'} />
            {copied ? 'Copied' : 'Copy Addr'}
          </button>
        </div>
      </div>
    )
  }

  // ── Unified media + intel console for medium / expanded / full ───────────

  const renderStreetPanel = (label: string) => (
    <div className="nx-prop-media-panel is-street">
      <div className="nx-panel-label">{label}</div>
      {interactiveStreetViewUrl ? (
        <iframe
          src={interactiveStreetViewUrl}
          title={`Street view for ${address}`}
          className="nx-property-panel__iframe"
          loading="eager"
          allowFullScreen
          referrerPolicy="no-referrer-when-downgrade"
        />
      ) : streetViewUrl && !imageFailed ? (
        <img src={streetViewUrl} alt="Street view" onError={() => setImageFailed(true)} />
      ) : (
        <div className="nx-panel-fallback"><Icon name="eye" /></div>
      )}
    </div>
  )

  const renderAerialPanel = (label: string) => (
    <div className="nx-prop-media-panel is-aerial">
      <div className="nx-panel-label">{label}</div>
      {interactiveAerialViewUrl ? (
        <iframe
          src={interactiveAerialViewUrl}
          title={`Aerial view for ${address}`}
          className="nx-property-panel__iframe"
          loading="eager"
          allowFullScreen
          referrerPolicy="no-referrer-when-downgrade"
        />
      ) : aerialUrl ? (
        <img src={aerialUrl as string | undefined} alt="Aerial view" />
      ) : (
        <div className="nx-panel-fallback"><Icon name="map" /><span>Unavailable</span></div>
      )}
    </div>
  )

  const isStackedSplit = mediaMode === 'split' && layoutMode === 'medium'

  const renderMediaWorkspace = () => {
    if (mediaMode === 'street') {
      return (
        <div className="nx-prop-media-workspace is-single">
          {renderStreetPanel('INTERACTIVE STREET VIEW')}
        </div>
      )
    }
    if (mediaMode === 'aerial') {
      return (
        <div className="nx-prop-media-workspace is-single">
          {renderAerialPanel('INTERACTIVE AERIAL VIEW')}
        </div>
      )
    }
    return (
      <div className={cls('nx-prop-media-workspace is-split', isStackedSplit && 'is-stacked')}>
        {renderStreetPanel('STREET VIEW')}
        {renderAerialPanel('AERIAL VIEW')}
      </div>
    )
  }

  const renderConsole = () => {
    const estValue = snapshot.estimatedValue || thread.estimatedValue
    const equityPct = snapshot.equityPercent
    const equityAmt = snapshot.equityAmount
    const repairCost = snapshot.repairCost || thread.estimatedRepairCost
    const finalScore = snapshot.finalScore
    const rehabLevel = thread.rehab_level || ''
    const condition = thread.building_condition || ''
    const isTaxDelinquent = snapshot.taxDelinquent && /^(yes|true|1)/i.test(String(snapshot.taxDelinquent))
    const sqft = snapshot.sqft || thread.building_square_feet || thread.sqft
    const beds = snapshot.beds || thread.total_bedrooms || thread.beds
    const baths = snapshot.baths || thread.total_baths || thread.baths
    const hasExec = !!(finalScore || estValue || equityAmt || equityPct || repairCost || rehabLevel || condition)

    // ── Hero signals ────────────────────────────────────────────────────────
    const propType = snapshot.propertyType || thread.propertyType
    const identityHero = [propType, displayMarket].filter(Boolean).join(' · ') || null
    const physicalHero = [
      beds && baths ? `${beds} Bed / ${baths} Bath` : null,
      sqft ? `${formatInteger(Number(sqft))} sqft` : null,
    ].filter(Boolean).join(' · ') || null
    const constructionHero = [
      thread.heating_type || null,
      thread.roof_cover ? `${thread.roof_cover} Roof` : null,
      thread.air_conditioning ? `AC ${thread.air_conditioning}` : null,
    ].filter(Boolean).join(' · ') || null
    const lotAcres = snapshot.lotSizeAcres || thread.lot_acreage
    const lotSqft = snapshot.lotSize || thread.lot_square_feet
    const siteHero = [
      lotAcres ? `${lotAcres} ac` : null,
      lotSqft ? `${formatInteger(Number(lotSqft))} sqft lot` : null,
    ].filter(Boolean).join(' · ') || null
    const equityHero = [
      equityAmt ? `${formatMoney(Number(equityAmt))} Equity` : null,
      equityPct ? equityPct : null,
    ].filter(Boolean).join(' · ') || null
    const delinqYear = thread.property_tax_delinquent_year || thread.oldest_tax_delinquent_year
    const taxHero = isTaxDelinquent
      ? `TAX DELINQUENT${delinqYear ? ` · ${delinqYear}` : ''}`
      : snapshot.taxAmount ? `Tax ${formatMoney(Number(snapshot.taxAmount))}/yr` : null

    // ── Signal chips ─────────────────────────────────────────────────────────
    const floodZone = snapshot.floodZone || thread.flood_zone
    const identityChips: Array<{ label: string; tone: string }> = [
      floodZone && !/^X$/i.test(String(floodZone)) ? { label: `Flood Zone ${floodZone}`, tone: 'warning' } : null,
    ].filter(Boolean) as Array<{ label: string; tone: string }>

    const yearBuilt = Number(snapshot.yearBuilt || thread.year_built || 0)
    const physicalChips: Array<{ label: string; tone: string }> = [
      yearBuilt && yearBuilt < 1960 ? { label: 'Long Hold', tone: 'muted' } : null,
    ].filter(Boolean) as Array<{ label: string; tone: string }>

    const rehabStr = String(rehabLevel).toLowerCase()
    const constructionChips: Array<{ label: string; tone: string }> = [
      rehabStr && /full|heavy|major/i.test(rehabStr) ? { label: 'Full Rehab', tone: 'warning' } : null,
      repairCost && Number(repairCost) > 40000 ? { label: 'High Repair Load', tone: 'warning' } : null,
    ].filter(Boolean) as Array<{ label: string; tone: string }>

    const equityPctNum = parseFloat(String(equityPct || '0').replace(/[^0-9.]/g, ''))
    const loanBal = snapshot.loanBalance
    const equityChips: Array<{ label: string; tone: string }> = [
      equityPctNum >= 95 ? { label: '100% Equity', tone: 'success' } : null,
      equityPctNum >= 60 && equityPctNum < 95 ? { label: 'Strong Equity', tone: 'success' } : null,
      (!loanBal || Number(loanBal) === 0) && equityAmt ? { label: 'Free & Clear', tone: 'success' } : null,
    ].filter(Boolean) as Array<{ label: string; tone: string }>

    const riskChips: Array<{ label: string; tone: string }> = [
      isTaxDelinquent ? { label: 'Tax Delinquent', tone: 'danger' } : null,
    ].filter(Boolean) as Array<{ label: string; tone: string }>

    return (
      <div className={cls('nx-pic-console', `is-layout-${layoutMode}`)}>
        {/* A. Executive Snapshot */}
        {hasExec && (
          <div className="nx-pic-exec-row">
            {finalScore ? (
              <div className="nx-pic-exec-card is-score">
                <label>Acquisition Score</label>
                <span>{finalScore}/100</span>
              </div>
            ) : null}
            {estValue ? (
              <div className="nx-pic-exec-card is-value">
                <label>Est. Value</label>
                <span>{formatMoney(Number(estValue))}</span>
              </div>
            ) : null}
            {equityAmt ? (
              <div className="nx-pic-exec-card is-equity">
                <label>Equity</label>
                <span>{formatMoney(Number(equityAmt))}</span>
              </div>
            ) : null}
            {equityPct ? (
              <div className="nx-pic-exec-card is-equity-pct">
                <label>Equity %</label>
                <span>{equityPct}</span>
              </div>
            ) : null}
            {repairCost ? (
              <div className="nx-pic-exec-card is-repair">
                <label>Repair Est.</label>
                <span>{formatMoney(Number(repairCost))}</span>
              </div>
            ) : null}
            {rehabLevel ? (
              <div className="nx-pic-exec-card is-rehab">
                <label>Rehab Level</label>
                <span>{rehabLevel}</span>
              </div>
            ) : null}
            {condition ? (
              <div className="nx-pic-exec-card is-condition">
                <label>Condition</label>
                <span>{condition}</span>
              </div>
            ) : null}
          </div>
        )}

        {/* B–G: Grouped intelligence sections */}
        <div className="nx-pic-sections">
          {/* B. Property Identity */}
          <div className="nx-pic-section is-cat-identity">
            <div className="nx-pic-section__header">
              <span className="nx-pic-section__dot" />
              <strong>Property Identity</strong>
            </div>
            {identityHero && <p className="nx-pic-hero-signal">{identityHero}</p>}
            {identityChips.length > 0 && (
              <div className="nx-pic-chips">
                {identityChips.map((c) => <span key={c.label} className={`nx-pic-chip is-${c.tone}`}>{c.label}</span>)}
              </div>
            )}
            <div className="nx-pic-section__grid">
              <PicField label="Type" value={snapshot.propertyType || thread.propertyType} />
              <PicField label="Class" value={snapshot.propertyClass} />
              <PicField label="Style" value={snapshot.propertyStyle || thread.style} />
              <PicField label="Market" value={displayMarket} />
              <PicField label="City" value={snapshot.city || thread.property_address_city} />
              <PicField label="ZIP" value={snapshot.zip} />
              <PicField label="County" value={thread.property_county_name} />
              <PicField label="Zoning" value={snapshot.zoning || thread.zoning} />
              <PicField label="Flood Zone" value={snapshot.floodZone || thread.flood_zone} />
              <PicField label="Occupancy" value={snapshot.occupancy} />
            </div>
          </div>

          {/* C. Physical Profile */}
          <div className="nx-pic-section is-cat-physical">
            <div className="nx-pic-section__header">
              <span className="nx-pic-section__dot" />
              <strong>Physical Profile</strong>
            </div>
            {physicalHero && <p className="nx-pic-hero-signal">{physicalHero}</p>}
            {physicalChips.length > 0 && (
              <div className="nx-pic-chips">
                {physicalChips.map((c) => <span key={c.label} className={`nx-pic-chip is-${c.tone}`}>{c.label}</span>)}
              </div>
            )}
            <div className="nx-pic-section__grid">
              <PicField label="Beds" value={beds} />
              <PicField label="Baths" value={baths} />
              <PicField label="Sq Ft" value={sqft ? formatInteger(Number(sqft)) : null} />
              <PicField label="Units" value={unitCount > 0 ? unitCount : null} />
              <PicField label="Buildings" value={thread.sum_buildings_nbr} />
              <PicField label="Stories" value={thread.stories} />
              <PicField label="Avg Sqft/Unit" value={thread.avg_sqft_per_unit ? formatInteger(Number(thread.avg_sqft_per_unit)) : null} />
              <PicField label="Beds/Unit" value={thread.beds_per_unit} />
              <PicField label="Sqft Range" value={thread.sqft_range} />
              <PicField label="Year Built" value={snapshot.yearBuilt || thread.year_built} />
              <PicField label="Eff. Year" value={snapshot.effectiveYear || thread.effective_year_built} />
            </div>
          </div>

          {/* D. Construction / Systems */}
          <div className="nx-pic-section is-cat-construction">
            <div className="nx-pic-section__header">
              <span className="nx-pic-section__dot" />
              <strong>Construction / Systems</strong>
            </div>
            {constructionHero && <p className="nx-pic-hero-signal">{constructionHero}</p>}
            {constructionChips.length > 0 && (
              <div className="nx-pic-chips">
                {constructionChips.map((c) => <span key={c.label} className={`nx-pic-chip is-${c.tone}`}>{c.label}</span>)}
              </div>
            )}
            <div className="nx-pic-section__grid">
              <PicField label="Construction" value={thread.construction_type} />
              <PicField label="Ext. Walls" value={thread.exterior_walls} />
              <PicField label="Roof Cover" value={thread.roof_cover} />
              <PicField label="Roof Type" value={thread.roof_type} />
              <PicField label="AC" value={thread.air_conditioning} />
              <PicField label="Heating" value={thread.heating_type} />
              <PicField label="Heat Fuel" value={thread.heating_fuel_type} />
              <PicField label="Int. Walls" value={thread.interior_walls} />
              <PicField label="Floor Cover" value={thread.floor_cover} />
              <PicField label="Basement" value={thread.basement} />
              <PicField label="Other Rooms" value={thread.other_rooms} />
              <PicField label="Fireplaces" value={thread.num_of_fireplaces} />
              <PicField label="Bldg Quality" value={thread.building_quality} />
            </div>
          </div>

          {/* E. Site / Lot / Utilities */}
          <div className="nx-pic-section is-cat-site">
            <div className="nx-pic-section__header">
              <span className="nx-pic-section__dot" />
              <strong>Site / Lot / Utilities</strong>
            </div>
            {siteHero && <p className="nx-pic-hero-signal">{siteHero}</p>}
            <div className="nx-pic-section__grid">
              <PicField label="Lot Acres" value={snapshot.lotSizeAcres || thread.lot_acreage} />
              <PicField label="Lot Sqft" value={snapshot.lotSize || thread.lot_square_feet ? formatInteger(Number(snapshot.lotSize || thread.lot_square_feet)) : null} />
              <PicField label="Sewer" value={thread.sewer} />
              <PicField label="Water" value={thread.water} />
              <PicField label="Patio" value={thread.patio} />
              <PicField label="Porch" value={thread.porch} />
              <PicField label="Deck" value={thread.deck} />
              <PicField label="Driveway" value={thread.driveway} />
              <PicField label="Garage" value={thread.garage} />
              <PicField label="Garage Sqft" value={thread.sum_garage_sqft ? formatInteger(Number(thread.sum_garage_sqft)) : null} />
              <PicField label="Pool" value={thread.pool} />
            </div>
          </div>

          {/* F. Sale / Loan / Equity */}
          <div className="nx-pic-section is-cat-equity">
            <div className="nx-pic-section__header">
              <span className="nx-pic-section__dot" />
              <strong>Sale / Loan / Equity</strong>
            </div>
            {equityHero && <p className="nx-pic-hero-signal">{equityHero}</p>}
            {equityChips.length > 0 && (
              <div className="nx-pic-chips">
                {equityChips.map((c) => <span key={c.label} className={`nx-pic-chip is-${c.tone}`}>{c.label}</span>)}
              </div>
            )}
            <div className="nx-pic-section__grid">
              <PicField label="Last Sale" value={thread.sale_price ? formatMoney(Number(thread.sale_price)) : null} accent="green" />
              <PicField label="Sale Date" value={thread.sale_date} />
              <PicField label="Sale Doc" value={thread.last_sale_doc_type} />
              <PicField label="Loan Amount" value={snapshot.loanAmount ? formatMoney(Number(snapshot.loanAmount)) : null} />
              <PicField label="Loan Balance" value={snapshot.loanBalance ? formatMoney(Number(snapshot.loanBalance)) : null} />
              <PicField label="Loan Pmt" value={snapshot.loanPayment ? formatMoney(Number(snapshot.loanPayment)) : null} />
              <PicField label="Equity Amt" value={equityAmt ? formatMoney(Number(equityAmt)) : null} accent="green" />
              <PicField label="Equity %" value={equityPct} accent="purple" />
            </div>
          </div>

          {/* G. Tax / Assessment / Risk */}
          <div className="nx-pic-section is-cat-risk">
            <div className="nx-pic-section__header">
              <span className="nx-pic-section__dot" />
              <strong>Tax / Assessment / Risk</strong>
            </div>
            {taxHero && <p className={cls('nx-pic-hero-signal', isTaxDelinquent && 'is-alert')}>{taxHero}</p>}
            {riskChips.length > 0 && (
              <div className="nx-pic-chips">
                {riskChips.map((c) => <span key={c.label} className={`nx-pic-chip is-${c.tone}`}>{c.label}</span>)}
              </div>
            )}
            <div className="nx-pic-section__grid">
              <PicField label="Tax Delinquent" value={snapshot.taxDelinquent} accent={isTaxDelinquent ? 'red' : undefined} />
              <PicField label="Delinq. Year" value={thread.property_tax_delinquent_year || thread.oldest_tax_delinquent_year} accent={isTaxDelinquent ? 'amber' : undefined} />
              <PicField label="Tax Amount" value={snapshot.taxAmount ? formatMoney(Number(snapshot.taxAmount)) : null} />
              <PicField label="Assessed Total" value={snapshot.assessedTotalValue ? formatMoney(Number(snapshot.assessedTotalValue)) : null} />
              <PicField label="Assessed Land" value={snapshot.assessedLandValue ? formatMoney(Number(snapshot.assessedLandValue)) : null} />
              <PicField label="Assessed Imprv" value={snapshot.assessedImprovementValue ? formatMoney(Number(snapshot.assessedImprovementValue)) : null} />
            </div>
          </div>
        </div>

        <div className="nx-pic-links-bar">
          <LinkedRecordButton label="Zillow" url={links.zillow} icon="globe" />
          <LinkedRecordButton label="Maps" url={links.streetView} icon="map" />
          <LinkedRecordButton label="Realtor" url={links.realtor} icon="globe" />
          <LinkedRecordButton label="County" url={links.googleSearch} icon="briefing" />
        </div>
      </div>
    )
  }

  return (
    <DossierCard className={cls('nx-property-hero-shell nx-glass-card nx-prop-media-card', `is-layout-${layoutMode}`)}>
      <div className="nx-prop-media-tabs">
        {(['split', 'street', 'aerial'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={cls('nx-prop-media-tabs__btn', mediaMode === mode && 'is-active')}
            onClick={() => setMediaMode(mode)}
          >
            {mode.charAt(0).toUpperCase() + mode.slice(1)}
          </button>
        ))}
      </div>
      {renderMediaWorkspace()}
      {renderConsole()}
    </DossierCard>
  )
}


const ContactIntelligenceCard = ({
  thread,
  snapshot,
}: {
  thread: WorkflowThread
  snapshot: NormalizedPropertySnapshot
  intelligence: ThreadIntelligenceRecord | null
}) => {
  const [activeTab, setActiveTab] = useState<'prospect' | 'owner' | 'portfolio' | 'financial' | 'property' | 'phone' | 'email'>('prospect')
  const [propertyTab, setPropertyTab] = useState<'overview' | 'location' | 'property' | 'equity' | 'tax' | 'census'>('overview')

  const sellerName = snapshot.ownerDisplayName || snapshot.ownerName || thread.displayName || thread.ownerDisplayName || thread.ownerName || 'Unknown seller'
  const initials = sellerName.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()
  const headlineAddress = snapshot.fullAddress || thread.displayAddress || thread.propertyAddress || thread.subject
  const propertyType = snapshot.propertyType || thread.propertyType || 'Not enriched'
  const prospectMatchBadges = useMemo(() => buildMatchBadges(thread), [thread])
  const propertyTagBadges = useMemo(() => buildPropertyTagBadges(thread), [thread])
  const ownerIdentityBadge = [asStr(snapshot.ownerType || thread.ownerType || thread.owner_type_guess || 'Individual').toUpperCase(), thread.isAbsentee ? 'ABSENTEE' : null]
    .filter(Boolean)
    .join(' | ')

  const topTabs = [
    { id: 'prospect', label: 'PROSPECT', icon: 'users' },
    { id: 'owner', label: 'OWNER', icon: 'user' },
    { id: 'phone', label: 'PHONE', icon: 'phone' },
    { id: 'email', label: 'EMAIL', icon: 'mail' },
    { id: 'portfolio', label: 'PORTFOLIO', icon: 'layers' },
    { id: 'financial', label: 'FINANCIAL', icon: 'trending-up' },
    { id: 'property', label: 'PROPERTY', icon: 'home' },
  ] as const

  const prospectTagBadges = useMemo(() => buildProspectTagBadges(thread), [thread])

  const prospectRows: Array<{ label: string; value?: unknown; render?: React.ReactNode; tone?: any }> = [
    { label: 'PROSPECT NAME', value: snapshot.prospectFullName || thread.prospect_full_name || thread.displayName },
    { label: 'AGE', value: (thread as any).prospect_age || thread.age },
    { label: 'MARITAL STATUS', value: thread.marital_status },
    { label: 'GENDER', value: snapshot.gender || thread.gender },
    { label: 'LANGUAGE', value: snapshot.language || thread.language_preference || thread.contactLanguage, tone: 'accent' },
    { label: 'EDUCATION', value: thread.education_model },
    { label: 'HOUSEHOLD INCOME', value: snapshot.householdIncome || thread.est_household_income, tone: 'success' },
    { label: 'NET ASSET VALUE', value: snapshot.netAssetValue || thread.net_asset_value, tone: 'success' },
    { label: 'BUYING POWER', value: (thread as any).buying_power, tone: 'accent' },
    { label: 'OCCUPATION', value: thread.occupation },
    { label: 'OCCUPATION GROUP', value: snapshot.occupationGroup || thread.occupation_group },
    { 
      label: 'PROSPECT TAGS', 
      value: prospectTagBadges.length ? 'has_tags' : null,
      render: prospectTagBadges.length > 0 ? (
        <div className="nx-contact-intel-v2__tag-cloud">
          {prospectTagBadges.map((badge, i) => <MatchBadge key={i} label={badge.label} tone={badge.tone} />)}
        </div>
      ) : null
    },
    { label: 'PHONE NUMBER', value: fmtPhone(thread.prospect_best_phone || thread.phoneNumber || thread.canonicalE164), tone: 'accent' },
    { label: 'PHONE CARRIER', value: snapshot.phoneCarrier || (thread as any).phone_carrier },
  ]

  const ownerRows: Array<{ label: string; value?: unknown; render?: React.ReactNode; tone?: any }> = [
    { label: 'OWNER ADDRESS', value: snapshot.ownerAddress || thread.primary_owner_address || thread.mailing_address },
    { label: 'PRIORITY TIER', value: snapshot.priorityTier || thread.owner_priority_tier || thread.priority, tone: 'warning' },
    { label: 'PRIORITY SCORE /100', value: snapshot.finalScore || formatScore(thread.owner_priority_score || thread.finalAcquisitionScore), tone: 'accent' },
    { label: 'BEST CONTACT WINDOW', value: snapshot.bestContactWindow || (thread as any).best_contact_window },
    { label: 'LANGUAGE', value: snapshot.language || thread.language_preference || thread.contactLanguage },
  ]

  const portfolioRows: Array<{ label: string; value?: unknown; render?: React.ReactNode; tone?: any }> = [
    { label: 'PORTFOLIO PROPERTY COUNT', value: snapshot.portfolioPropertyCount || thread.property_count, tone: 'accent' },
    { label: 'PROPERTY TYPE MAJORITY', value: snapshot.propertyType || thread.property_type_majority || thread.propertyType },
    { label: 'SFR COUNT', value: snapshot.sfrCount || (thread as any).sfr_count },
    { label: 'MF COUNT', value: snapshot.mfCount || (thread as any).mf_count },
    { label: 'TOTAL UNITS', value: snapshot.unitCount || thread.portfolio_total_units, tone: 'accent' },
    { label: 'PORTFOLIO VALUE', value: formatMoney(Number(snapshot.portfolioValue || thread.portfolio_total_value || 0)), tone: 'success' },
    { label: 'TOTAL EQUITY', value: formatMoney(Number(snapshot.equityAmount || thread.portfolio_total_equity || 0)), tone: 'success' },
    { label: 'TOTAL DEBT', value: formatMoney(Number(snapshot.loanAmount || thread.portfolio_total_loan_balance || 0)), tone: 'warning' },
    { label: 'TOTAL DEBT PAYMENT', value: formatMoney(Number(snapshot.loanPayment || thread.portfolio_total_loan_payment || 0)) },
  ]

  const financialRows: Array<{ label: string; value?: unknown; render?: React.ReactNode; tone?: any }> = [
    { label: 'FINANCIAL PRESSURE SCORE', value: snapshot.financialScore || formatScore(thread.financial_pressure_score), tone: 'warning' },
    { label: 'URGENCY COUNT', value: snapshot.urgencyCount || thread.urgency_count || formatScore(thread.urgency_score), tone: 'danger' },
    { label: 'PORTFOLIO TAX DELINQUENT COUNT', value: snapshot.taxDelinquentCount || thread.tax_delinquent_count, tone: (Number(snapshot.taxDelinquentCount || thread.tax_delinquent_count) > 0) ? 'danger' : 'neutral' },
    { label: 'TAX DELINQUENT BADGE', value: snapshot.taxDelinquent || formatBoolean(thread.property_tax_delinquent) },
    { label: 'PORTFOLIO LIEN COUNT', value: snapshot.lienCount || thread.active_lien_count, tone: (Number(snapshot.lienCount || thread.active_lien_count) > 0) ? 'warning' : 'neutral' },
    { label: 'ACTIVE LIEN BADGE', value: formatBoolean(thread.property_active_lien) },
    { label: 'OLDEST TAX DELINQUENT YEAR', value: snapshot.oldestTaxYear || thread.oldest_tax_delinquent_year },
    { label: 'TOTAL TAX AMOUNT', value: formatMoney(Number(snapshot.taxAmount || thread.tax_amt || thread.past_due_amount || 0)), tone: 'danger' },
  ]

  const phoneRows: Array<{ label: string; value?: unknown; render?: React.ReactNode; tone?: any }> = [
    { label: 'BEST PHONE', value: fmtPhone(thread.prospect_best_phone || thread.phoneNumber || thread.canonicalE164), tone: 'accent' },
    { label: 'DISPLAY PHONE', value: fmtPhone(thread.displayPhone) },
    { label: 'PHONE CARRIER', value: snapshot.phoneCarrier || (thread as any).phone_carrier },
    { label: 'CONTACTABILITY SCORE', value: formatScore(thread.contactability_score), tone: 'success' },
    { label: 'PHONE MATCH SCORE', value: formatScore(thread.prospect_phone_score || thread.prospect_contact_score) },
    { label: 'SMS ELIGIBLE', value: formatBoolean((thread as any).sms_eligible) },
    { label: 'LANGUAGE', value: snapshot.language || thread.language_preference || thread.contactLanguage },
  ]

  const emailRows: Array<{ label: string; value?: unknown; render?: React.ReactNode; tone?: any }> = [
    { label: 'BEST EMAIL', value: thread.prospect_best_email || (thread as any).best_email_1, tone: 'accent' },
    { label: 'EMAIL ELIGIBLE', value: formatBoolean((thread as any).email_eligible) },
    { label: 'CONTACT NAME', value: snapshot.prospectFullName || thread.prospect_full_name || thread.displayName },
    { label: 'OWNER NAME', value: snapshot.ownerDisplayName || thread.ownerDisplayName || thread.ownerName },
    { label: 'LAST MESSAGE CONTEXT', value: thread.latestMessageBody || thread.lastMessageBody },
  ]

  const activeRows = activeTab === 'prospect'
    ? prospectRows
    : activeTab === 'owner'
      ? ownerRows
      : activeTab === 'phone'
        ? phoneRows
        : activeTab === 'email'
          ? emailRows
      : activeTab === 'portfolio'
        ? portfolioRows
        : financialRows
  const visibleActiveRows = activeRows.filter(({ value, render }) => Boolean(render) || isPresent(value))

  return (
    <DossierCard className="nx-contact-intel-v2 nx-glass-card">
      <div className="nx-dossier-section__title">
        <Icon name="user" /> 
        <span>Contact & Ownership Intelligence</span>
      </div>

      <div className="nx-segmented-control-wrapper">
        <div className="nx-segmented-control">
          {topTabs.map((t) => (
            <button type="button" key={t.id} className={cls('nx-segmented-control__btn', activeTab === t.id && 'is-active')} onClick={() => setActiveTab(t.id as any)}
            >
              <Icon name={t.icon as any} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="nx-contact-intel-v2__identity nx-glass-surface">
        <div className="nx-contact-intel-v2__avatar-box">
          <div className="nx-contact-intel-v2__avatar nx-elite-gradient">
            {activeTab === 'property' ? <Icon name="home" /> : initials}
          </div>
          {activeTab === 'prospect' && prospectMatchBadges.length > 0 && (
            <div className="nx-contact-intel-v2__badge-overlap">
              <Icon name="check" />
            </div>
          )}
        </div>
        
        <div className="nx-contact-intel-v2__identity-copy">
          <div className="nx-contact-intel-v2__headline-row">
            <strong>{activeTab === 'property' ? headlineAddress || 'No linked property' : sellerName}</strong>
            {activeTab === 'prospect' && prospectMatchBadges.length > 0 && (
              <div className="nx-contact-intel-v2__match-badges">
                {prospectMatchBadges.map((badge) => <MatchBadge key={badge.label} label={badge.label} tone={badge.tone} />)}
              </div>
            )}
          </div>
          
          <div className="nx-contact-intel-v2__sub-headline">
            {activeTab === 'property'
              ? <QuietBadge label={standardFormatDisplayValue(propertyType).toUpperCase()} />
              : <QuietBadge label={ownerIdentityBadge} />}
          </div>
        </div>
      </div>

      <div className="nx-contact-intel-v2__content">
        {activeTab === 'property' ? (
          <>
            <div className="nx-intel-grid-v2">
              <IntelField 
                label="PROPERTY FLAGS" 
                value={propertyTagBadges.length ? 'has_tags' : null} 
                render={propertyTagBadges.length > 0 ? (
                  <div className="nx-contact-intel-v2__tag-cloud">
                    {propertyTagBadges.map((badge, i) => <MatchBadge key={i} label={badge.label} tone={badge.tone as any} />)}
                  </div>
                ) : null}
              />
            </div>
            <div className="nx-segmented-control-wrapper is-subtabs">
              <div className="nx-segmented-control is-subtabs">
                {[
                  ['overview', 'OVERVIEW', 'layers'],
                  ['location', 'LOCATION', 'map'],
                  ['property', 'PROPERTY', 'grid'],
                  ['equity', 'EQUITY', 'trending-up'],
                  ['tax', 'TAX', 'briefing'],
                  ['census', 'CENSUS INTEL', 'grid'],
                ].map(([id, label, icon]) => (
                  <button type="button" key={id} className={cls('nx-segmented-control__btn', propertyTab === id && 'is-active')} onClick={() => setPropertyTab(id as any)}
                  >
                    <Icon name={icon as any} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>
            <PropertyIntelFields thread={thread} subTab={propertyTab} />
          </>
        ) : (
          <div className="nx-intel-grid-v2">
            {visibleActiveRows.length > 0 ? visibleActiveRows.map(({ label, value, render, tone }) => (
              <IntelField key={label} label={label} value={value} render={render} tone={tone} />
            )) : <PremiumEmptyState title="Not enriched yet" body="Additional contact and ownership fields will appear here when enrichment finishes." kicker="LOWER SIGNAL" />}
          </div>
        )}
      </div>
    </DossierCard>
  )
}

export const SellerCommandCard = ({
  thread,
  phase3,
  onStatusChange,
  onStageChange,
}: {
  thread: WorkflowThread
  phase3: Phase3Intelligence | null
  onStatusChange: (status: InboxStatus | 'sent_message') => void
  onStageChange: (stage: SellerStage) => void
}) => {
  const [statusOpen, setStatusOpen] = useState(false)
  const [stageOpen, setStageOpen] = useState(false)

  const stageVisual = getSellerStageVisual(thread.conversationStage)
  const statusVisual = getStatusVisual(thread.inboxStatus)
  const finalScore = thread.finalAcquisitionScore || (thread as any).ai_score || thread.motivationScore
  const lastContact = thread.lastOutboundAt || thread.lastMessageAt
  const sellerName = thread.displayName || 'Unknown Seller'
  const rawMarket = thread.displayMarket || thread.market
  const marketLabel = isPresent(rawMarket) ? asStr(rawMarket) : 'Market Pending'
  
  const ownerType = asStr(thread.ownerType || thread.owner_type_guess)
  const priorityScore = formatScore(finalScore)
  const automationActive = thread.automationState === 'active'
  const memoryActive = Boolean(phase3?.thread || (thread as any).is_memory_active)
  const sellerInterest = phase3?.latestSnapshot?.state_data?.seller_interest || 'none'

  // Metadata grouping: Individual • Absentee • Market Pending
  const metadataParts = [
    ownerType,
    thread.isAbsentee ? 'Absentee' : null,
    marketLabel
  ].filter(Boolean).join(' • ')

  return (
    <DossierCard className="nx-seller-command-card-v3">
      <div className="nx-dossier-header-v3">
        <div className="nx-header-identity-row-v3">
          <div className="nx-header-avatar-v3">
            {sellerName.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()}
          </div>
          <div className="nx-header-main-v3">
            <h2 className="nx-header-name-v3">{sellerName}</h2>
            <div className="nx-header-meta-v3">
              {metadataParts}
            </div>
          </div>
          <SellerTemperatureIndicator interest={sellerInterest} />
        </div>

        <div className="nx-header-actions-v3">
          <div className="nx-header-dropdown-v3">
            <button type="button" onClick={() => setStatusOpen(!statusOpen)}>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <i className="nx-dot" style={{ background: statusVisual.color }} />
                {statusVisual.label}
              </div>
              <Icon name="chevron-down" />
            </button>
            {statusOpen && (
              <div className="nx-workflow-menu-v3" style={{ top: 'calc(100% + 4px)', left: 0, right: 0 }}>
                {inboxStatusOptions.map((opt) => (
                  <button type="button" key={opt.value} className={cls('nx-workflow-menu-item-v3', opt.value === thread.inboxStatus && 'is-selected')} onClick={() => { onStatusChange(opt.value as InboxStatus); setStatusOpen(false) }}>
                    <strong>{opt.label}</strong>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="nx-header-dropdown-v3">
            <button type="button" onClick={() => setStageOpen(!stageOpen)}>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <i className="nx-dot" style={{ background: stageVisual.color }} />
                {stageVisual.label}
              </div>
              <Icon name="chevron-down" />
            </button>
            {stageOpen && (
              <div className="nx-workflow-menu-v3" style={{ top: 'calc(100% + 4px)', left: 0, right: 0 }}>
                {sellerStageOptions.map((opt) => (
                  <button type="button" key={opt.value} className={cls('nx-workflow-menu-item-v3', opt.value === thread.conversationStage && 'is-selected')} onClick={() => { onStageChange(opt.value as SellerStage); setStageOpen(false) }}>
                    <strong>{opt.label}</strong>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="nx-header-telemetry-rail-v3">
          <div className={cls('nx-telemetry-item-v3', automationActive && 'is-active')}>
            <div className="nx-dot" />
            {automationActive ? 'Automation Active' : 'Automation Paused'}
          </div>
          <div className={cls('nx-telemetry-item-v3', memoryActive && 'is-active')}>
            <div className="nx-dot" />
            {memoryActive ? 'Memory Synced' : 'Cold Memory'}
          </div>
          <div className="nx-telemetry-item-v3 is-active">
            <div className="nx-dot" />
            Score <span className="nx-header-score-v3">{priorityScore || '—'}</span>
          </div>
          <div className="nx-telemetry-item-v3">
            <div className="nx-dot" />
            Last Contact {lastContact ? formatRelativeTime(lastContact) : 'None'}
          </div>
        </div>
      </div>

      {phase3?.latestSnapshot?.state_data?.next_best_action && (
        <div style={{ marginTop: '12px' }}>
          <NextBestActionChip 
            action={phase3.latestSnapshot.state_data.next_best_action} 
            confidence={phase3.latestSnapshot.state_data.confidence} 
            reasoning={phase3.latestSnapshot.state_data.reasoning || phase3.latestSnapshot.capture_reason}
          />
        </div>
      )}
    </DossierCard>
  )
}

const DealCommandHeader = ({
  thread,
  snapshot,
  phase3,
}: {
  thread: WorkflowThread
  snapshot: NormalizedPropertySnapshot
  phase3: Phase3Intelligence | null
}) => {
  // ── Zone A: Deal Identity ─────────────────────────────────────────────────
  const sellerName =
    snapshot.ownerDisplayName ||
    snapshot.ownerName ||
    thread.ownerDisplayName ||
    thread.ownerName ||
    thread.prospect_full_name ||
    thread.displayName ||
    'Unknown Seller'

  const address =
    snapshot.fullAddress ||
    thread.displayAddress ||
    thread.propertyAddress ||
    thread.subject ||
    'Property Unknown'

  // Guard raw meta values against "unknown", "n/a" etc. using the existing isPresent helper
  const sanitizeMeta = (v: string) => isPresent(v) ? v.trim() : ''

  const zip = sanitizeMeta(snapshot.zip || thread.property_address_zip || '')
  const county = sanitizeMeta(thread.property_county_name || '')

  const marketRaw = sanitizeMeta(
    snapshot.market ||
    thread.displayMarket ||
    thread.market ||
    (snapshot.city && snapshot.state
      ? `${snapshot.city}, ${snapshot.state}`
      : snapshot.city || snapshot.state || '')
  )
  // Show "Market Pending" only when we have no usable geo anchor at all
  const market = marketRaw || (zip || county ? '' : 'Market Pending')
  const phone = fmtPhone(
    thread.prospect_best_phone || thread.phoneNumber || thread.displayPhone || thread.canonicalE164
  ) || ''

  const PROPERTY_CATEGORY_LABELS: Record<string, string> = {
    sfh: 'Single Family',
    multifamily: 'Multi-Family',
    hotel: 'Hotel',
    storage: 'Self Storage',
    retail: 'Retail',
    office: 'Office',
    industrial: 'Industrial',
    land: 'Land',
  }
  const propertyType = PROPERTY_CATEGORY_LABELS[detectPropertyCategory(thread as any) || ''] || ''
  const metaParts = [market, zip, county, phone, propertyType].filter(Boolean)

  // ── Zone B: Workflow State ────────────────────────────────────────────────
  const status = getStatusVisual(thread.inboxStatus)
  const stage = getSellerStageVisual(thread.conversationStage)
  const automation = automationStateVisuals[thread.automationState || 'manual']
  const isHot = thread.priority === 'urgent' || thread.inboxStatus === 'new_reply'
  const isSuppressed = Boolean(thread.isSuppressed)
  const isUnread = thread.inboxStatus === 'new_reply'
  const priority = (thread.priority || thread.priorityBucket || 'normal').toLowerCase()
  const isHighPriority = priority === 'urgent' || priority === 'high'
  const isAutoActive = thread.automationState === 'active'
  const lastContactStr = thread.lastMessageAt ? formatRelativeTime(thread.lastMessageAt) : null

  type ChipTone = 'status' | 'stage' | 'urgent' | 'active' | 'hot' | 'unread' | 'suppressed' | 'neutral'
  const chips: Array<{ key: string; label: string; tone: ChipTone }> = []
  if (status?.label) chips.push({ key: 'status', label: status.label.toUpperCase(), tone: 'status' })
  if (stage?.label) chips.push({ key: 'stage', label: stage.label.toUpperCase(), tone: 'stage' })
  chips.push({ key: 'priority', label: `${priority.toUpperCase()} PRIORITY`, tone: isHighPriority ? 'urgent' : 'neutral' })
  if (automation?.label) chips.push({ key: 'auto', label: `AUTO ${automation.label.toUpperCase()}`, tone: isAutoActive ? 'active' : 'neutral' })
  if (lastContactStr) chips.push({ key: 'last', label: `LAST ${lastContactStr.toUpperCase()}`, tone: 'neutral' })
  if (isHot && !isUnread) chips.push({ key: 'hot', label: 'HOT LEAD', tone: 'hot' })
  if (isUnread) chips.push({ key: 'unread', label: 'UNREAD', tone: 'unread' })
  if (isSuppressed) chips.push({ key: 'sup', label: 'SUPPRESSED', tone: 'suppressed' })

  // ── Zone C: Decision Rail ─────────────────────────────────────────────────
  const score = percentFromScore(
    thread.finalAcquisitionScore || (thread as any).ai_score || thread.motivationScore,
    42
  )
  const confidence = clamp(
    (isPresent(thread.estimatedValue) ? 38 : 12) +
    (isPresent(thread.estimatedRepairCost) ? 22 : 0) +
    (isPresent(thread.equityPercent) ? 16 : 0) +
    (isPresent(thread.contactability_score) ? 10 : 0),
    18, 96
  )
  const dataConfidence = clamp(
    (isPresent(snapshot.fullAddress) ? 24 : 0) +
    (isPresent(snapshot.estimatedValue || thread.estimatedValue) ? 22 : 0) +
    (isPresent(snapshot.repairCost || thread.estimatedRepairCost) ? 18 : 0) +
    (isPresent(thread.property_county_name) ? 12 : 0) +
    (isPresent(thread.phoneNumber || thread.prospect_best_phone) ? 12 : 0),
    22, 94
  )

  const ringTone = isHot ? 'red' : score >= 70 ? 'green' : score >= 45 ? 'blue' : 'amber'
  const scorePct = `${clamp(score, 0, 100)}%`
  const scoreDisplay = Math.round(score) > 0 ? String(Math.round(score)) : '—'

  const acquisitionState = isSuppressed
    ? 'Suppressed contact · no automation'
    : isAutoActive
    ? 'Automation active · monitoring replies'
    : phase3?.latestSnapshot?.capture_reason ||
      getNextBestAction(thread).reason ||
      thread.nextSystemAction ||
      'Monitoring active signals'

  return (
    <div className={cls('dch-root', isHot && 'is-hot', isSuppressed && 'is-suppressed')}>
      <div className="dch-accent-line" aria-hidden />
      <div className="dch-zones">

        {/* ── Zone A + B: Identity & Workflow State ── */}
        <div className="dch-zone-a">
          <div className="dch-eyebrow-row">
            <span className="dch-eyebrow">DEAL COMMAND DOSSIER</span>
            <WatchBell
              watch_type="thread"
              watch_key={thread.id}
              label={sellerName}
              thread_key={thread.id}
              address={address !== 'Property Unknown' ? address : undefined}
              owner_id={thread.ownerDisplayName ? thread.id : undefined}
            />
          </div>
          <h2 className="dch-address">{address}</h2>
          <div className="dch-seller">{sellerName}</div>

          {metaParts.length > 0 && (
            <div className="dch-meta">
              {metaParts.map((part, i) => (
                <React.Fragment key={part + String(i)}>
                  {i > 0 && <span className="dch-meta-sep" aria-hidden>•</span>}
                  <span className="dch-meta-item">{part}</span>
                </React.Fragment>
              ))}
            </div>
          )}

          {chips.length > 0 && (
            <div className="dch-chips">
              {chips.map((chip) => (
                <span key={chip.key} className={cls('dch-chip', `is-${chip.tone}`)}>
                  {chip.label}
                </span>
              ))}
            </div>
          )}

          <div className="dch-actions">
            {(['Draft Reply', 'Run Underwriting', 'Open Comps', 'Show Buyers', 'Pause Auto'] as const).map(
              (action, i) => (
                <button key={action} type="button" className={cls('dch-action', i === 0 && 'is-primary')}>
                  {action}
                </button>
              )
            )}
          </div>
        </div>

        {/* ── Zone C: Decision Rail ── */}
        <div className="dch-zone-c">
          {/* Score dial + label + state line — horizontal row */}
          <div className="dch-score-block">
            <div
              className={cls('dch-dial', `is-${ringTone}`)}
              style={{ ['--dch-ring-progress' as any]: scorePct }}
              aria-label={`Deal Score ${scoreDisplay} out of 100`}
            >
              <strong className="dch-dial__number">{scoreDisplay}</strong>
              <span className="dch-dial__denom">/100</span>
            </div>
            <div className="dch-score-info">
              <span className="dch-dial-label">DEAL SCORE</span>
              <p className="dch-state-line">{acquisitionState}</p>
            </div>
          </div>

          {/* Confidence + data pill — below dial row */}
          <div className="dch-confidence-rail">
            <div className="dch-conf-metric">
              <span className="dch-conf-metric__label">CONFIDENCE</span>
              <strong className="dch-conf-metric__value">{Math.round(confidence)}</strong>
            </div>
            <div className="dch-conf-divider" aria-hidden />
            <div className="dch-conf-metric">
              <span className="dch-conf-metric__label">DATA</span>
              <strong className="dch-conf-metric__value">{Math.round(dataConfidence)}</strong>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const DealDecisionStrip = ({ thread }: { thread: WorkflowThread }) => {
  const arv = asNum(thread.estimatedValue || thread.arv)
  const investorExit = arv ? Math.round(arv * 0.82) : 0
  const repairs = asNum(thread.estimatedRepairCost)
  const spread = Math.max(Math.round(arv * 0.18), 25000)
  const mao = Math.max(arv - repairs - spread, 0)
  const offer = asNum(thread.ai_recommended_opening_offer || thread.ai_offer || thread.cashOffer || thread.mao || mao)
  const walkaway = asNum(thread.walkaway_price || thread.walkaway_internal || mao * 1.05)
  const confidence = clamp((arv ? 40 : 18) + (repairs ? 18 : 0) + (thread.contactability_score ? 8 : 0) + (thread.finalAcquisitionScore ? 16 : 0), 24, 96)
  const offerFloor = offer ? Math.round(offer * 0.94) : Math.round(mao * 0.94)
  const offerCeiling = offer ? Math.round(offer * 1.03) : Math.round(mao * 1.03)
  const decisionTone = confidence >= 72 ? 'pursue' : confidence >= 52 ? 'review' : 'pass'
  const decisionLabel = decisionTone === 'pursue' ? 'Pursue' : decisionTone === 'review' ? 'Review' : 'Pass'
  const decisionReasons = [
    isPresent(thread.equityPercent) ? `${formatPercent(thread.equityPercent)} equity supports acquisition spread.` : 'Equity position still needs validation.',
    repairs ? `${formatMoney(repairs)} repair load priced into the decision range.` : 'Repair estimate still pending.',
    thread.inboxStatus === 'new_reply' ? 'Seller just replied, timing is favorable for action.' : 'Seller timing is still moderate.',
  ]
  const waterfall = [
    { label: 'Retail ARV', value: arv, tone: 'green' },
    { label: 'Investor Exit', value: investorExit, tone: 'purple' },
    { label: 'Repair Estimate', value: repairs, tone: 'amber' },
    { label: 'Target Spread', value: spread, tone: 'red' },
    { label: 'MAO', value: mao, tone: 'blue' },
    { label: 'AI Recommended Offer', value: offer, tone: 'green' },
  ]

  if (!arv) {
    return (
      <DossierCard className="nx-command-module nx-deal-decision-strip">
        <div className="nx-command-module__head">
          <div>
            <span>DEAL DECISION</span>
            <strong>Underwriting is waiting on valuation support</strong>
          </div>
        </div>
        <PremiumEmptyState
          title="Offer decision pending"
          body="Retail comps, repair assumptions, and buyer demand are required before this deal can move into a confident pursue / review / pass lane."
        />
      </DossierCard>
    )
  }

  const maxWaterfall = Math.max(...waterfall.map((item) => item.value), 1)

  return (
    <DossierCard className="nx-command-module nx-deal-decision-strip">
      <div className="nx-command-module__head">
        <div>
          <span>DEAL DECISION</span>
          <strong>Offer range, waterfall, and pursue signal</strong>
        </div>
        <button type="button" className="nx-command-module__cta">Run Underwriting</button>
      </div>
      <div className="nx-deal-decision-strip__grid">
        <div className="nx-deal-decision-strip__hero">
          <span>AI Recommended Offer</span>
          <strong>{formatMoney(offer)}</strong>
          <p>{formatMoney(offerFloor)} - {formatMoney(offerCeiling)}</p>
          <div className="nx-deal-decision-strip__microcopy">
            Walkaway {formatMoney(walkaway)} • Confidence {Math.round(confidence)}/100
          </div>
        </div>
        <div className="nx-deal-decision-strip__waterfall">
          {waterfall.map((item) => (
            <div key={item.label} className={cls('nx-deal-decision-strip__step', `is-${item.tone}`)}>
              <div className="nx-deal-decision-strip__step-head">
                <span>{item.label}</span>
                <strong>{formatMoney(item.value)}</strong>
              </div>
              <div className="nx-offer-waterfall__track">
                <div className="nx-offer-waterfall__fill" style={{ width: `${(item.value / maxWaterfall) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
        <div className={cls('nx-deal-decision-strip__decision', `is-${decisionTone}`)}>
          <span>{decisionLabel}</span>
          <strong>{decisionTone === 'pursue' ? 'Deal support is strong enough to lean in.' : decisionTone === 'review' ? 'Signal set is mixed. Operator review recommended.' : 'Risk outweighs support right now.'}</strong>
          <ul>
            {decisionReasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </div>
      </div>
    </DossierCard>
  )
}

const CompIntelligenceModule = ({ thread, snapshot }: { thread: WorkflowThread; snapshot: NormalizedPropertySnapshot }) => {
  const arv = asNum(thread.estimatedValue || snapshot.estimatedValue)
  const sqft = asNum(thread.building_square_feet || thread.sqft || snapshot.sqft)
  const address = snapshot.fullAddress || thread.displayAddress || thread.propertyAddress || thread.subject || 'Property Unknown'
  const propertyLat = Number((thread as any).lat ?? thread.latitude ?? 0)
  const propertyLng = Number((thread as any).lng ?? thread.longitude ?? 0)
  const compMapUrl = buildInteractiveAerialViewUrl({ address, lat: propertyLat, lng: propertyLng })
  if (!arv) {
    return (
      <DossierCard className="nx-command-module nx-comp-module">
        <div className="nx-command-module__head">
          <div>
            <span>COMP INTELLIGENCE</span>
            <strong>Comp workspace staged inside the dossier</strong>
          </div>
        </div>
        <PremiumEmptyState title="Needs comps" body="Attach retail or investor comps to light up ARV ranges, comp chips, and the subject map." />
      </DossierCard>
    )
  }

  const compBase = [
    { label: 'Subject', price: arv, distance: 0, ppsf: sqft ? Math.round(arv / sqft) : 247, score: 100, selected: true },
    { label: 'Comp A', price: Math.round(arv * 0.97), distance: 0.3, ppsf: sqft ? Math.round((arv * 0.97) / Math.max(sqft - 120, 1)) : 242, score: 94, selected: true },
    { label: 'Comp B', price: Math.round(arv * 1.04), distance: 0.6, ppsf: sqft ? Math.round((arv * 1.04) / Math.max(sqft + 65, 1)) : 253, score: 88, selected: true },
    { label: 'Comp C', price: Math.round(arv * 0.9), distance: 0.9, ppsf: sqft ? Math.round((arv * 0.9) / Math.max(sqft - 220, 1)) : 234, score: 78, selected: false },
  ]
  const selectedCount = compBase.filter((item) => item.selected).length
  const excludedCount = compBase.length - selectedCount

  return (
    <DossierCard className="nx-command-module nx-comp-module">
      <div className="nx-command-module__head">
        <div>
          <span>COMP INTELLIGENCE</span>
          <strong>Retail and investor comp workspace</strong>
        </div>
        <div className="nx-command-module__chips">
          <QuietBadge label={`SELECTED ${selectedCount}`} tone="success" />
          <QuietBadge label={`EXCLUDED ${excludedCount}`} tone="warning" />
          <QuietBadge label={`ARV ${formatMoney(Math.round(arv * 0.98))} - ${formatMoney(Math.round(arv * 1.03))}`} tone="accent" />
        </div>
      </div>
      <div className="nx-comp-module__layout">
        <div className="nx-comp-module__map">
          <div className="nx-comp-module__map-title">Radius + comp map</div>
          <div className="nx-comp-module__map-canvas">
            {compMapUrl ? (
              <iframe
                src={compMapUrl}
                title={`Comp map for ${address}`}
                className="nx-comp-module__map-iframe"
                loading="lazy"
                allowFullScreen
                referrerPolicy="no-referrer-when-downgrade"
              />
            ) : null}
            <div className="nx-comp-module__heat is-one" />
            <div className="nx-comp-module__heat is-two" />
            {compBase.map((comp, index) => (
              <button
                key={comp.label}
                type="button"
                className={cls('nx-comp-module__pin', comp.selected && 'is-selected', index === 0 && 'is-subject')}
                style={{ left: `${18 + index * 21}%`, top: `${22 + (index % 3) * 20}%` }}
              >
                {index === 0 ? 'S' : `$${Math.round(comp.price / 1000)}k`}
              </button>
            ))}
          </div>
          <div className="nx-comp-module__filters">
            {['0.5 mi', '90d', 'MLS', 'Investor', 'Outliers Off'].map((chip) => (
              <span key={chip}>{chip}</span>
            ))}
          </div>
        </div>
        <div className="nx-comp-module__visuals">
          <SparkBars title="Comp Price Distribution" values={compBase.map((comp) => comp.price)} labels={compBase.map((comp) => comp.label.replace('Comp ', 'C'))} tone="blue" />
          <SparkBars title="Price / Sqft" values={compBase.map((comp) => comp.ppsf)} labels={['Sub', 'A', 'B', 'C']} tone="green" />
        </div>
      </div>
      <div className="nx-comp-module__table">
        {compBase.map((comp) => (
          <div key={comp.label} className={cls('nx-comp-module__row', comp.selected && 'is-selected')}>
            <div>
              <strong>{comp.label}</strong>
              <span>{formatMoney(comp.price)} • {comp.distance.toFixed(1)} mi</span>
            </div>
            <div>
              <strong>{comp.ppsf}/sf</strong>
              <span>Similarity {comp.score}</span>
            </div>
            <button type="button">{comp.selected ? 'Use' : 'Exclude'}</button>
          </div>
        ))}
      </div>
    </DossierCard>
  )
}

const BuyerMatchingModule = ({ thread, snapshot }: { thread: WorkflowThread; snapshot: NormalizedPropertySnapshot }) => {
  const equity = percentFromScore(snapshot.equityPercent || thread.equityPercent, 38)
  const demand = clamp(percentFromScore(thread.finalAcquisitionScore || thread.priorityScore || 58) * 0.78 + equity * 0.22, 22, 96)
  const avgBuy = asNum(thread.estimatedValue || snapshot.estimatedValue) ? Math.round(asNum(thread.estimatedValue || snapshot.estimatedValue) * 0.72) : 0
  const leaderboard = [
    { name: 'Peachtree Value Fund', type: 'Fund', score: clamp(demand + 6, 0, 100), markets: 'Atlanta South + 30315', recent: 14, avg: avgBuy, max: Math.round(avgBuy * 1.24), last: '12d ago', reason: 'Heavy small multifamily velocity in this ZIP.' },
    { name: 'Northline Cash Buyers', type: 'Local Investor', score: clamp(demand - 4, 0, 100), markets: 'Intown duplexes', recent: 9, avg: Math.round(avgBuy * 0.92), max: Math.round(avgBuy * 1.1), last: '21d ago', reason: 'Matches size and entry price band.' },
    { name: 'Beltline Yield Group', type: 'Rental Operator', score: clamp(demand - 11, 0, 100), markets: 'Multifamily + rental holds', recent: 7, avg: Math.round(avgBuy * 1.08), max: Math.round(avgBuy * 1.36), last: '34d ago', reason: 'Strong hold profile for repaired yield assets.' },
  ]

  if (!avgBuy) {
    return (
      <DossierCard className="nx-command-module nx-buyer-match-module">
        <div className="nx-command-module__head">
          <div>
            <span>BUYER MATCHING</span>
            <strong>Demand layer waiting on dispo signals</strong>
          </div>
        </div>
        <PremiumEmptyState title="Buyer demand layer pending" body="Upload investor buyer comps or purchase history to activate buyer matching." />
      </DossierCard>
    )
  }

  return (
    <DossierCard className="nx-command-module nx-buyer-match-module">
      <div className="nx-command-module__head">
        <div>
          <span>BUYER MATCHING</span>
          <strong>Dispo confidence and top-fit buyers</strong>
        </div>
        <div className="nx-command-module__chips">
          <QuietBadge label={`AVG BUY ${formatMoney(avgBuy)}`} tone="success" />
          <QuietBadge label={`ZIP ${(snapshot.zip || thread.property_address_zip || 'PENDING').toUpperCase()}`} tone="accent" />
        </div>
      </div>
      <div className="nx-buyer-match-module__top">
        <ScoreRing label="Buyer Demand" value={demand} tone="green" sublabel="Modeled from market fit, score, and recent property economics." />
        <div className="nx-buyer-match-module__meters">
          <MeterBar label="Price Fit" value={clamp(demand + 4, 0, 100)} tone="green" />
          <MeterBar label="Asset Fit" value={clamp(demand - 6, 0, 100)} tone="purple" />
          <MeterBar label="Market Fit" value={clamp(demand + 2, 0, 100)} tone="blue" />
          <MeterBar label="Velocity Fit" value={clamp(demand - 10, 0, 100)} tone="amber" />
        </div>
      </div>
      <div className="nx-buyer-match-module__leaderboard">
        {leaderboard.map((buyer, index) => (
          <div key={buyer.name} className="nx-buyer-match-module__card">
            <div>
              <span>TOP MATCH {index + 1} • {buyer.type}</span>
              <strong>{buyer.name}</strong>
              <p>{buyer.markets}</p>
              <p>Recent purchases {buyer.recent} • Avg {formatMoney(buyer.avg)} • Max {formatMoney(buyer.max)} • Last {buyer.last}</p>
              <p>{buyer.reason}</p>
            </div>
            <div className="nx-buyer-match-module__score">{buyer.score}</div>
            <div className="nx-buyer-match-module__actions">
              <button type="button">Generate Dispo Packet</button>
              <button type="button">Add to Buyer Blast</button>
              <button type="button">View Buyer Profile</button>
            </div>
          </div>
        ))}
      </div>
    </DossierCard>
  )
}

const ConversationBrainModule = ({
  thread,
  messages,
  phase3,
}: {
  thread: WorkflowThread
  messages: ThreadMessage[]
  phase3: Phase3Intelligence | null
}) => {
  const latestInbound = messages.find((message) => message.direction === 'inbound') || null
  const latestOutbound = messages.find((message) => message.direction === 'outbound') || null
  const summary = phase3?.latestSnapshot?.capture_reason || thread.aiSummary || thread.aiDraft || 'Conversation intelligence will summarize seller signals here.'
  const intent = thread.uiIntent || thread.detected_intent || 'Intent Pending'
  const sentiment = thread.sentiment || 'Neutral'
  const urgency = percentFromScore(thread.urgency_score || thread.priorityScore, thread.priority === 'urgent' ? 82 : 44)
  const stageFlow = ['Ownership Check', 'Interest Probe', 'Price Discovery', 'Condition', 'Offer', 'Negotiation', 'Contract']
  const currentStageIndex = Math.max(
    0,
    sellerStageOptions.findIndex((option) => option.value === thread.conversationStage),
  )

  return (
    <DossierCard className="nx-command-module nx-conversation-brain-module">
      <div className="nx-command-module__head">
        <div>
          <span>SELLER / AI CONVERSATION BRAIN</span>
          <strong>What the seller is saying and what we do next</strong>
        </div>
        <button type="button" className="nx-command-module__cta">Draft Reply</button>
      </div>
      <div className="nx-conversation-brain-module__top">
        <div className="nx-conversation-brain-module__message">
          <label>LAST INBOUND</label>
          <strong>{latestInbound?.body || thread.latestMessageBody || thread.lastMessageBody || 'No inbound seller reply recorded yet.'}</strong>
          <p>Latest outbound: {latestOutbound?.body || 'Pending operator or automation response.'}</p>
        </div>
        <div className="nx-conversation-brain-module__signals">
          <QuietBadge label={`INTENT ${intent}`} tone="accent" />
          <QuietBadge label={`SENTIMENT ${String(sentiment).toUpperCase()}`} tone="warning" />
          <QuietBadge label={`AUTO ${(automationStateVisuals[thread.automationState || 'manual']?.label || 'Manual').toUpperCase()}`} tone="success" />
        </div>
      </div>
      <div className="nx-conversation-brain-module__stageflow">
        {stageFlow.map((label, index) => (
          <div key={label} className={cls('nx-conversation-brain-module__stage', index <= currentStageIndex && 'is-complete', index === currentStageIndex && 'is-active')}>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="nx-conversation-brain-module__summary">
        <div>
          <label>Conversation Summary</label>
          <p>{summary}</p>
        </div>
        <div className="nx-conversation-brain-module__next">
          <MeterBar label="Urgency" value={urgency} tone={urgency >= 70 ? 'red' : 'amber'} />
          <div className="nx-conversation-brain-module__reply-chips">
            {[
              thread.aiDraft || 'Acknowledge seller and advance discovery',
              'Ask condition follow-up',
              'Move toward offer timing',
            ].map((reply) => (
              <button type="button" key={reply}>{reply}</button>
            ))}
          </div>
        </div>
      </div>
    </DossierCard>
  )
}

const CommandActionDock = ({
  onOpenMap,
  onOpenDossier,
  onOpenAi,
  layoutMode = 'full',
}: {
  onOpenMap: () => void
  onOpenDossier: () => void
  onOpenAi: () => void
  layoutMode?: ViewLayoutMode
}) => (
  <div className={cls('nx-command-action-dock', layoutMode === 'expanded' && 'is-compact')}>
    <div className="nx-command-action-dock__group">
      <span>Communication</span>
      <div>
        <button type="button">Draft Reply</button>
        <button type="button">Send SMS</button>
        <button type="button">Send Email</button>
      </div>
    </div>
    <div className="nx-command-action-dock__group">
      <span>Analysis</span>
      <div>
        <button type="button">Run Underwriting</button>
        <button type="button">Open Comp Workspace</button>
        <button type="button">Show Buyer Matches</button>
      </div>
    </div>
    <div className="nx-command-action-dock__group">
      <span>Navigation</span>
      <div>
        <button type="button" onClick={onOpenMap}>Open Map</button>
        <button type="button" onClick={onOpenDossier}>Open Dossier</button>
        <button type="button" onClick={onOpenAi}>AI Assist</button>
      </div>
    </div>
    <div className="nx-command-action-dock__group is-safety">
      <span>Safety</span>
      <div>
        <button type="button" className="is-warning">Pause Automation</button>
        <button type="button" className="is-danger">Suppress</button>
        <button type="button" className="is-danger">DNC</button>
      </div>
    </div>
  </div>
)

const humanizeIntent = (raw: string): string => {
  const map: Record<string, string> = {
    not_interested: 'Not Interested',
    potential_interest: 'Showing Interest',
    price_anchor: 'Price Anchor',
    info_request: 'Requesting Info',
    language_switch: 'Language Switch',
    ownership_check: 'Confirming Ownership',
    condition_details: 'Condition Details',
    offer_reveal: 'Offer Discussion',
    negotiation: 'Active Negotiation',
    contract_path: 'Contract Path',
    wrong_number: 'Wrong Number',
    opt_out: 'Opt-Out',
    none: 'Pending',
    unknown: 'Unknown',
    pending: 'Pending',
  }
  return map[String(raw || '').toLowerCase()] || String(raw || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const humanizeStage = (raw: string): string => {
  const map: Record<string, string> = {
    ownership_check: 'Ownership Check',
    interest_probe: 'Interest Probe',
    price_discovery: 'Price Discovery',
    condition_details: 'Condition',
    offer_reveal: 'Offer',
    negotiation: 'Negotiation',
    contract_path: 'Contract',
    seller_response: 'Awaiting Reply',
  }
  return map[String(raw || '').toLowerCase()] || String(raw || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const humanizeEducation = (raw: string): string => {
  const map: Record<string, string> = {
    hs_diploma: 'HS Diploma', high_school: 'HS Diploma', some_college: 'Some College',
    bachelor: "Bachelor's", bachelors: "Bachelor's", bachelor_degree: "Bachelor's",
    graduate: 'Graduate Degree', masters: "Master's", doctorate: 'Doctorate',
    trade: 'Trade School', vocational: 'Vocational',
  }
  const key = String(raw || '').toLowerCase().replace(/\s+/g, '_')
  return map[key] || String(raw || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const humanizeGender = (raw: string): string => {
  const r = String(raw || '').toLowerCase()
  if (r === 'm' || r === 'male') return 'Male'
  if (r === 'f' || r === 'female') return 'Female'
  return String(raw || '').replace(/\b\w/g, (c) => c.toUpperCase())
}

const humanizeMaritalStatus = (raw: string): string => {
  const lc = String(raw || '').toLowerCase()
  if (lc === 'married' || lc === 'married_joint') return 'Married'
  if (lc === 'single') return 'Likely Single'
  if (lc === 'divorced') return 'Likely Divorced'
  if (lc === 'widowed' || lc === 'widow') return 'Widowed'
  if (lc === 'separated') return 'Separated'
  return String(raw || '').replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const humanizeOccupation = (raw: string): string => {
  const lc = String(raw || '').toLowerCase().replace(/\s+/g, '_')
  if (/upper.?management|management.?exec|executive/.test(lc)) return 'Executive / Management'
  if (lc === 'professional' || lc === 'white_collar') return 'Professional'
  if (lc === 'blue_collar') return 'Blue Collar'
  if (lc === 'self_employed' || lc === 'business_owner') return 'Self-Employed'
  if (lc === 'retired') return 'Retired'
  if (lc === 'homemaker') return 'Homemaker'
  if (lc === 'student') return 'Student'
  if (lc === 'unemployed') return 'Unemployed'
  return String(raw || '').replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const getSellerPersona = (thread: WorkflowThread, equityPct: number): string | null => {
  const isAbsentee = thread.isAbsentee || (thread as any).isAbsentee === 'true'
  const years = asNum(thread.ownership_years || 0)
  const finPressure = asNum(thread.financial_pressure_score || 0)
  const ownerType = asStr(thread.ownerType || thread.owner_type_guess || '').toLowerCase()
  if (ownerType.includes('llc') || ownerType.includes('corp') || ownerType.includes('trust')) return 'Institutional / Corporate'
  if (finPressure >= 70) return 'Financially Distressed'
  if (isAbsentee && years >= 10) return 'Burned-Out Landlord'
  if (years >= 20 && equityPct >= 80) return 'Legacy Hold Seller'
  if (isAbsentee) return 'Absentee Investor'
  if (equityPct >= 85) return 'Equity-Rich Owner'
  if (years >= 5 && !isAbsentee) return 'Long-Term Homeowner'
  return null
}

const buildPropertyTags = (thread: WorkflowThread, snapshot: NormalizedPropertySnapshot, equityPct: number): Array<{ label: string; tone: string }> => {
  const tags: Array<{ label: string; tone: string }> = []
  const isAbsentee = thread.isAbsentee || (thread as any).isAbsentee === 'true'
  const isVacant = thread.isVacant || (thread as any).isVacant === 'true'
  const isTaxDel = thread.property_tax_delinquent || /^(yes|true|1)/i.test(String(snapshot.taxDelinquent || ''))
  const hasLien = thread.property_active_lien || thread.hasLien
  const rehab = asStr(thread.rehab_level || '').toLowerCase()
  const ownerType = asStr(thread.ownerType || thread.owner_type_guess || '').toLowerCase()
  const finPressure = asNum(thread.financial_pressure_score || 0)
  const ownerYears = asNum(snapshot.ownershipYears || thread.ownership_years || 0)
  const propState = asStr(snapshot.state || thread.property_address_state || '').toUpperCase()
  const mailAddr = asStr(thread.primary_owner_address || thread.mailing_address || '')
  const outOfState = isAbsentee && propState.length === 2 && mailAddr.length > 5 && !mailAddr.toUpperCase().includes(` ${propState}`)

  if (equityPct >= 60) tags.push({ label: 'High Equity', tone: 'green' })
  else if (equityPct >= 35) tags.push({ label: 'Moderate Equity', tone: 'blue' })
  if (isAbsentee) tags.push({ label: 'Absentee Owner', tone: 'amber' })
  if (outOfState) tags.push({ label: 'Out of State', tone: 'amber' })
  if (isVacant) tags.push({ label: 'Vacant', tone: 'amber' })
  if (isTaxDel) tags.push({ label: 'Tax Delinquent', tone: 'red' })
  if (hasLien) tags.push({ label: 'Active Lien', tone: 'red' })
  if (ownerType.includes('llc') || ownerType.includes('corp')) tags.push({ label: 'Investor Owned', tone: 'purple' })
  if (/heavy|full|major/i.test(rehab)) tags.push({ label: 'Heavy Rehab', tone: 'red' })
  else if (/medium|moderate/i.test(rehab)) tags.push({ label: 'Moderate Rehab', tone: 'amber' })
  if (ownerYears >= 15 && !isTaxDel) tags.push({ label: 'Long-Term Hold', tone: 'blue' })
  if (finPressure >= 70 && !isTaxDel) tags.push({ label: 'Distressed', tone: 'red' })
  else if (finPressure >= 50 && !isTaxDel && !isAbsentee) tags.push({ label: 'Financial Pressure', tone: 'amber' })
  return tags.slice(0, 8)
}

const BuyerSignalBar = ({ label, value, tone = 'blue', showBar = true, trend }: { label: string; value: string | number | null; tone?: 'blue' | 'green' | 'amber' | 'red' | 'purple'; showBar?: boolean; trend?: 'up' | 'down' | 'flat' | null }) => {
  const num = typeof value === 'number' ? value : null
  const isMissing = value === null || value === undefined || value === ''
  return (
    <div className="nx-bsig-row">
      <div className="nx-bsig-row__head">
        <span className="nx-bsig-row__label">{label}</span>
        <div className="nx-bsig-row__right">
          {trend && <span className={cls('nx-bsig-row__trend', `is-${trend}`)}>{trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'}</span>}
          <span className={cls('nx-bsig-row__value', isMissing && 'is-muted')}>
            {isMissing ? 'Unavailable' : String(value)}
          </span>
        </div>
      </div>
      {showBar && num !== null && !isMissing && (
        <div className="nx-bsig-track">
          <div className={cls('nx-bsig-fill', `is-${tone}`)} style={{ width: `${clamp(num, 0, 100)}%` }} />
        </div>
      )}
    </div>
  )
}

const CompactDealIntelligenceCapsule = ({
  thread,
  snapshot,
  messages,
}: {
  thread: WorkflowThread
  snapshot: NormalizedPropertySnapshot
  messages: ThreadMessage[]
}) => {
  const [addrCopied, setAddrCopied] = useState(false)
  const handleCopyAddr = () => {
    const addr = snapshot.fullAddress || thread.displayAddress || thread.propertyAddress || thread.subject || ''
    if (!addr) return
    navigator.clipboard.writeText(addr).catch(() => undefined)
    setAddrCopied(true)
    setTimeout(() => setAddrCopied(false), 1400)
  }

  const address = snapshot.fullAddress || thread.displayAddress || thread.propertyAddress || thread.subject || ''
  const heroLinks = buildPropertyExternalLinks(address)
  const encodedAddr = address ? encodeURIComponent(address) : ''
  const redfinUrl = encodedAddr ? `https://www.redfin.com/query?query=${encodedAddr}` : null

  const heatScore = percentFromScore(thread.finalAcquisitionScore || (thread as any).ai_score || thread.priorityScore || thread.motivationScore, 42)

  // Property metrics
  const beds = snapshot.beds || thread.total_bedrooms || thread.beds
  const baths = snapshot.baths || thread.total_baths || thread.baths
  const sqft = snapshot.sqft || thread.building_square_feet || thread.sqft
  const yearBuilt = snapshot.yearBuilt || thread.year_built
  const estValue = asNum(snapshot.estimatedValue || thread.estimatedValue)
  const equityPctNum = asNum(snapshot.equityPercent || thread.equityPercent || 0)
  const repairs = asNum(snapshot.repairCost || thread.estimatedRepairCost)
  const offer = asNum(thread.ai_recommended_opening_offer || thread.ai_offer || thread.cashOffer || thread.mao)

  // Condition
  const rawCondition = asStr(thread.building_condition || '')
  let conditionLabel: string | null = null
  let conditionTone: 'green' | 'amber' | 'red' = 'amber'
  if (rawCondition) {
    const lc = rawCondition.toLowerCase()
    if (/excellent|new|very good/i.test(lc)) { conditionLabel = 'Excellent'; conditionTone = 'green' }
    else if (/good/i.test(lc)) { conditionLabel = 'Good'; conditionTone = 'green' }
    else if (/fair|average|moderate/i.test(lc)) { conditionLabel = 'Fair'; conditionTone = 'amber' }
    else if (/poor|bad|below/i.test(lc)) { conditionLabel = 'Poor'; conditionTone = 'red' }
    else if (/heavy|full rehab|major/i.test(lc)) { conditionLabel = 'Heavy Rehab'; conditionTone = 'red' }
    else { conditionLabel = rawCondition.replace(/\b\w/g, (c) => c.toUpperCase()); conditionTone = 'amber' }
  }

  // Buyer demand signals
  const demand = clamp(percentFromScore(thread.finalAcquisitionScore || thread.priorityScore || 58) * 0.78 + (equityPctNum || 38) * 0.22, 22, 96)
  const avgBuy = estValue ? Math.round(estValue * 0.72) : 0
  const sqftNum = asNum(sqft || 0)
  const avgPpsf = avgBuy > 0 && sqftNum > 0 ? Math.round(avgBuy / sqftNum) : 0
  const bedsNum = asNum(beds || 0)
  const bathsNum = asNum(baths || 0)

  // Prospect identity
  const prospectName = thread.prospect_full_name || snapshot.ownerDisplayName || snapshot.ownerName || thread.ownerDisplayName || thread.ownerName || thread.displayName || 'Unknown Prospect'
  const language = thread.language_preference || thread.contactLanguage || 'English'
  const occupation = thread.occupation
  const maritalStatus = thread.marital_status
  const prospectAge = (thread as any).prospect_age || (thread as any).age
  const education = thread.education_model
  const gender = thread.gender

  // Motivation signals
  const householdIncome = thread.est_household_income
  const netAssetValue = thread.net_asset_value
  const financialPressureScore = asNum(thread.financial_pressure_score || 0)
  const contactQuality = asNum(thread.contactability_score || thread.prospect_contact_score || 0)
  const sellerPersona = getSellerPersona(thread, equityPctNum)
  const stage = getSellerStageVisual(thread.conversationStage).label
  const lastIntent = thread.uiIntent || thread.detected_intent || 'Pending'
  const motivationPct = percentFromScore(thread.motivationScore || thread.priorityScore, 0)

  // Risk signals
  const isOutOfState = (() => {
    const propState = asStr(snapshot.state || thread.property_address_state || '').toUpperCase()
    const mailAddr = asStr(thread.primary_owner_address || thread.mailing_address || '')
    const isAbsentee = thread.isAbsentee || (thread as any).isAbsentee === 'true'
    return isAbsentee && propState.length === 2 && mailAddr.length > 5 && !mailAddr.toUpperCase().includes(` ${propState}`)
  })()
  const isVacant = thread.isVacant || (thread as any).isVacant === 'true'
  const daysSinceResponse = thread.lastInboundAt
    ? Math.floor((Date.now() - new Date(String(thread.lastInboundAt)).getTime()) / 86400000)
    : null

  const latestEvents = messages.slice(-5).reverse()

  // Property type classification
  const isMultifamily = asStr(thread.propertyType || '').toLowerCase().includes('multi') || asStr(snapshot.propertyType || '').toLowerCase().includes('multi')
  const unitCount = Number(snapshot.unitCount || thread.units_count || 0)
  const isCommercial = asStr(snapshot.propertyType || '').toLowerCase().includes('commercial')
  const isLand = asStr(snapshot.propertyType || '').toLowerCase().includes('land') || asStr(snapshot.propertyType || '').toLowerCase().includes('lot')

  // Multifamily per-unit metrics (computed after unitCount + isMultifamily are available)
  const unitCountSafe = Math.max(unitCount, 1)
  const avgBedPerUnit = isMultifamily && unitCount > 1 && bedsNum > 0 ? (bedsNum / unitCountSafe).toFixed(1) : null
  const avgBathPerUnit = isMultifamily && unitCount > 1 && bathsNum > 0 ? (bathsNum / unitCountSafe).toFixed(1) : null
  const avgSqftPerUnit = isMultifamily && unitCount > 1 && sqftNum > 0 ? Math.round(sqftNum / unitCountSafe) : 0
  const repairsPerUnit = isMultifamily && unitCount > 1 && repairs > 0 ? Math.round(repairs / unitCountSafe) : 0

  let propTypeColor = 'neutral'
  let displayPropType = 'Unknown'
  if (isMultifamily) {
    propTypeColor = 'purple'
    displayPropType = `Multifamily${unitCount > 0 ? ` · ${unitCount} Units` : ''}`
  } else if (isCommercial) {
    propTypeColor = 'blue'
    displayPropType = 'Commercial'
  } else if (isLand) {
    propTypeColor = 'amber'
    displayPropType = 'Land'
  } else {
    propTypeColor = 'red'
    displayPropType = 'Single Family'
  }

  const rawMarket = snapshot.market || thread.displayMarket || thread.market || thread.marketId
  const displayMarket = isPresent(rawMarket) && !/^\d+$/.test(String(rawMarket))
    ? rawMarket
    : (snapshot.city && snapshot.state ? `${snapshot.city}, ${snapshot.state}` : (rawMarket || 'Unknown market'))

  // Heat color scale: 0-40=blue, 40-60=amber, 60-80=orange, 80+=red
  let heatColor = 'blue'
  if (heatScore >= 80) heatColor = 'red'
  else if (heatScore >= 60) heatColor = 'orange'
  else if (heatScore >= 40) heatColor = 'amber'

  // Address identity decomposition
  const addrParts = address.split(',')
  const streetAddress = (addrParts[0] || '').trim().toUpperCase()
  const cityStateZip = addrParts.slice(1).map((s) => s.trim()).filter(Boolean).join(', ')
  const addressMetaLine = [
    cityStateZip || displayMarket,
    displayPropType,
    isMultifamily && unitCount > 0 ? `${unitCount} Units` : null,
  ].filter(Boolean).join(' • ')

  // Jarvis-style acquisition recommendation
  const aiRecText = (() => {
    const base = getNextBestAction(thread)
    const days = daysSinceResponse
    const finP = financialPressureScore
    const stg = thread.conversationStage || ''
    if (thread.isSuppressed) return 'Remove from active rotation'
    if (finP >= 75) return 'High financial pressure — escalate now'
    if (equityPctNum >= 80 && motivationPct >= 70) return 'Prime target — move to offer discussion'
    if (stg === 'negotiation' && equityPctNum >= 60) return 'High leverage negotiation opportunity'
    if (stg === 'contract_path') return 'Escalate to acquisitions team'
    if (days !== null && days > 21) return `${days}d dormant — re-engage or archive`
    if (days !== null && days >= 3 && days <= 5) return 'Optimal window — delay follow-up 48h'
    if (thread.inboxStatus === 'new_reply') return 'New reply — classify intent and respond'
    if (base.title.toLowerCase().includes('waiting')) return 'Monitor — follow up in 3–5 days'
    return base.title
  })()

  // Hedge fund / institutional derived intel
  const instIntelLabel = (() => {
    if (isMultifamily && demand >= 72) return 'Active MF Inst. Acquisitions'
    if (demand >= 75) return 'Active Institutional Market'
    if (demand >= 55) return 'Moderate Inst. Interest'
    return 'Low Institutional Penetration'
  })()
  const instChipTone = demand >= 70 ? 'is-warning' : demand >= 55 ? 'is-purple' : 'is-muted'

  const propertyTags = buildPropertyTags(thread, snapshot, equityPctNum)

  return (
    <div className="nx-deal-capsule-shell">
      <PropertyHeroCard thread={thread} snapshot={snapshot} panelMode="half" layoutMode="compact" />

      <div className="nx-hero-link-bar">
        {heroLinks.streetView && (
          <a href={heroLinks.streetView} target="_blank" rel="noopener noreferrer" className="nx-hero-link">
            <Icon name="map" />Street View
          </a>
        )}
        {heroLinks.zillow && (
          <a href={heroLinks.zillow} target="_blank" rel="noopener noreferrer" className="nx-hero-link">
            <Icon name="globe" />Zillow
          </a>
        )}
        {redfinUrl && (
          <a href={redfinUrl} target="_blank" rel="noopener noreferrer" className="nx-hero-link">
            <Icon name="home" />Redfin
          </a>
        )}
        {heroLinks.realtor && (
          <a href={heroLinks.realtor} target="_blank" rel="noopener noreferrer" className="nx-hero-link">
            <Icon name="home" />Realtor
          </a>
        )}
        {heroLinks.googleSearch && (
          <a href={heroLinks.googleSearch} target="_blank" rel="noopener noreferrer" className="nx-hero-link">
            <Icon name={"briefing" as any} />County
          </a>
        )}
        <button type="button" className={cls('nx-hero-link', addrCopied && 'is-copied')} onClick={handleCopyAddr}>
          <Icon name={addrCopied ? 'check' : 'layers'} />
          {addrCopied ? 'Copied!' : 'Copy Addr'}
        </button>
      </div>

      <div className="nx-deal-capsule__content">
        {/* Address identity anchor */}
        {streetAddress && (
          <div className="nx-capsule-address-identity">
            <div className="nx-capsule-address__street">{streetAddress}</div>
            <div className="nx-capsule-address__meta">{addressMetaLine}</div>
          </div>
        )}

        {propertyTags.length > 0 && (
          <div className="nx-property-tags">
            {propertyTags.map((tag, i) => (
              <span key={tag.label} className={`nx-property-tag is-${tag.tone}${i === 0 ? ' is-lead' : ''}`}>{tag.label}</span>
            ))}
          </div>
        )}

        <div className="nx-capsule-identity-row">
          <span className="nx-capsule-identity-market">{displayMarket}</span>
          <span className={`nx-prop-type-badge is-${propTypeColor}`}>{displayPropType}</span>
          <div className="nx-capsule-live-pulse">
            <div className="nx-capsule-live-dot" />
            <span className="nx-capsule-live-label">Live</span>
          </div>
        </div>

        <div className={`nx-heat-pulse is-${heatColor}`}>
          <div className="nx-heat-pulse__ring">
            <div className="nx-heat-bloom" />
            <div className="nx-heat-wave" />
            <div className="nx-heat-wave nx-heat-wave--2" />
            <svg viewBox="0 0 36 36" className="nx-heat-pulse__svg">
              <path className="nx-heat-pulse__bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
              <path className="nx-heat-pulse__fill" strokeDasharray={`${heatScore}, 100`} d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
            </svg>
            <strong>{Math.round(heatScore)}</strong>
          </div>
          <div className="nx-heat-pulse__info">
            <label>ACQUISITION HEAT</label>
            <p>
              {heatScore >= 80 ? 'High equity • Active buyer demand'
                : heatScore >= 60 ? 'Moderate equity • Buyer demand present'
                : heatScore >= 40 ? 'Low signal • Enrich property data'
                : 'Minimal signal • Needs enrichment'}
            </p>
          </div>
        </div>

        <div className="nx-capsule-section">
          <span className="nx-capsule-section__title">
            {isMultifamily ? 'MULTIFAMILY METRICS' : 'PROPERTY & VALUE'}
          </span>
          {isMultifamily ? (
            <div className="nx-mf-metric-groups">
              <div className="nx-mf-group">
                <div className="nx-mf-group__label">ACQUISITION</div>
                <div className="nx-compact-metric-grid">
                  <div className={cls('nx-metric-chip', estValue ? 'is-green' : 'is-neutral')}>
                    <Icon name="dollar-sign" /><span>{estValue ? formatMoney(estValue) : 'Value Pending'}</span>
                  </div>
                  {equityPctNum > 0 && <div className="nx-metric-chip is-green"><Icon name="trending-up" /><span>{equityPctNum}% Equity</span></div>}
                  {repairs > 0 && <div className="nx-metric-chip is-amber"><Icon name={"tool" as any} /><span>{formatMoney(repairs)} Repairs</span></div>}
                  {offer > 0 && <div className="nx-metric-chip is-violet"><Icon name={"tag" as any} /><span>{formatMoney(offer)} Offer</span></div>}
                </div>
              </div>
              <div className="nx-mf-group">
                <div className="nx-mf-group__label">UNIT INTEL</div>
                <div className="nx-compact-metric-grid">
                  {unitCount > 0 && <div className="nx-metric-chip is-purple"><Icon name={"grid" as any} /><span>{unitCount} Units</span></div>}
                  {unitCount > 0 && estValue > 0 && <div className="nx-metric-chip is-violet"><Icon name={"tag" as any} /><span>{formatMoney(Math.round(estValue / unitCountSafe))} / Unit</span></div>}
                  {avgBedPerUnit && <div className="nx-metric-chip is-neutral"><Icon name={"bed" as any} /><span>{avgBedPerUnit} Bed/Unit</span></div>}
                  {avgBathPerUnit && <div className="nx-metric-chip is-neutral"><Icon name={"droplet" as any} /><span>{avgBathPerUnit} Bath/Unit</span></div>}
                  {avgSqftPerUnit > 0 && <div className="nx-metric-chip is-neutral"><Icon name={"maximize" as any} /><span>{formatInteger(avgSqftPerUnit)} Sqft/Unit</span></div>}
                  {repairsPerUnit > 0 && <div className="nx-metric-chip is-amber"><Icon name={"tool" as any} /><span>{formatMoney(repairsPerUnit)}/Unit Repairs</span></div>}
                  {isPresent(snapshot.occupancy) && <div className="nx-metric-chip is-neutral"><Icon name="home" /><span>Occ: {snapshot.occupancy}</span></div>}
                </div>
              </div>
              <div className="nx-mf-group">
                <div className="nx-mf-group__label">PROPERTY</div>
                <div className="nx-compact-metric-grid">
                  {isPresent(yearBuilt) && <div className="nx-metric-chip is-neutral"><Icon name={"calendar" as any} /><span>Built {yearBuilt}</span></div>}
                  {conditionLabel && <div className={cls('nx-metric-chip', `is-${conditionTone}`)}><Icon name="activity" /><span>{conditionLabel}</span></div>}
                  {isPresent(sqft) && <div className="nx-metric-chip is-neutral"><Icon name={"maximize" as any} /><span>{formatInteger(Number(sqft))} Sqft Total</span></div>}
                </div>
              </div>
            </div>
          ) : (
            <div className="nx-compact-metric-grid">
              {isPresent(beds) && <div className="nx-metric-chip is-neutral"><Icon name={"bed" as any} /><span>{beds} Bed</span></div>}
              {isPresent(baths) && <div className="nx-metric-chip is-neutral"><Icon name={"droplet" as any} /><span>{baths} Bath</span></div>}
              {isPresent(sqft) && <div className="nx-metric-chip is-neutral"><Icon name={"maximize" as any} /><span>{formatInteger(Number(sqft))} Sqft</span></div>}
              {isPresent(yearBuilt) && <div className="nx-metric-chip is-neutral"><Icon name={"calendar" as any} /><span>Built {yearBuilt}</span></div>}
              <div className={cls('nx-metric-chip', estValue ? 'is-green' : 'is-neutral')}>
                <Icon name="dollar-sign" /><span>{estValue ? formatMoney(estValue) : 'Valuation Pending'}</span>
              </div>
              {equityPctNum > 0 && <div className="nx-metric-chip is-green"><Icon name="trending-up" /><span>{equityPctNum}% Equity</span></div>}
              {repairs > 0 && <div className="nx-metric-chip is-amber"><Icon name={"tool" as any} /><span>{formatMoney(repairs)} Repairs</span></div>}
              {conditionLabel && <div className={cls('nx-metric-chip', `is-${conditionTone}`)}><Icon name="activity" /><span>{conditionLabel}</span></div>}
              {offer > 0 && <div className="nx-metric-chip is-violet"><Icon name={"tag" as any} /><span>{formatMoney(offer)} Offer</span></div>}
            </div>
          )}
        </div>

        <div className="nx-capsule-section">
          <span className="nx-capsule-section__title">BUYER SIGNAL</span>
          <div className="nx-buyer-signal-v2">
            <div className="nx-bsig-live-header">
              <span className="nx-bsig-live-tag">LIVE MARKET</span>
              <span className={cls('nx-bsig-trend', demand >= 70 ? 'is-up' : demand >= 45 ? 'is-flat' : 'is-down')}>
                {demand >= 70 ? '↑ Hot' : demand >= 45 ? '→ Active' : '↓ Cool'}
              </span>
            </div>
            <BuyerSignalBar
              label="Demand Score"
              value={demand > 0 ? Math.round(demand) : null}
              tone={demand >= 70 ? 'green' : demand >= 45 ? 'blue' : 'amber'}
              trend={demand >= 65 ? 'up' : demand >= 42 ? 'flat' : 'down'}
            />
            <BuyerSignalBar
              label="Buyer Match Count"
              value={demand > 0 ? Math.round(demand / 5) : null}
              showBar={false}
              trend={demand >= 60 ? 'up' : null}
            />
            <BuyerSignalBar
              label="Avg Resale"
              value={avgBuy > 0 ? formatMoney(avgBuy) : null}
              showBar={false}
            />
            {isMultifamily ? (
              <>
                <BuyerSignalBar label="Avg Price / Unit" value={avgBuy > 0 && unitCount > 0 ? formatMoney(Math.round(avgBuy / unitCountSafe)) : null} showBar={false} />
                <BuyerSignalBar label="MF Buyer Activity" value={demand > 0 ? (demand >= 70 ? 'Accelerating' : demand >= 50 ? 'Active' : 'Moderate') : null} showBar={false} trend={demand >= 65 ? 'up' : demand >= 45 ? 'flat' : 'down'} />
                <BuyerSignalBar label="Investor Acquisitions" value={demand > 0 ? `${Math.round(demand / 12)} nearby (6mo)` : null} showBar={false} trend={demand >= 65 ? 'up' : null} />
              </>
            ) : (
              <>
                <BuyerSignalBar label="Avg PPSF" value={avgPpsf > 0 ? `$${avgPpsf.toLocaleString()}` : null} showBar={false} trend={demand >= 65 ? 'up' : null} />
                <BuyerSignalBar label="Investor Acquisitions" value={demand > 0 ? `${Math.round(demand / 10)} nearby (6mo)` : null} showBar={false} trend={demand >= 60 ? 'up' : null} />
              </>
            )}
            <div className="nx-bsig-divider" />
            <div className="nx-bsig-chips">
              {demand >= 70 ? (
                <span className="nx-bsig-chip is-active">↑ Strong Buyer Pressure</span>
              ) : demand >= 45 ? (
                <span className="nx-bsig-chip is-warning">→ Moderate Demand</span>
              ) : (
                <span className="nx-bsig-chip is-muted">↓ Low Demand Signal</span>
              )}
              {avgPpsf > 0 && !isMultifamily && <span className="nx-bsig-chip is-purple">${avgPpsf}/sqft</span>}
              <span className={cls('nx-bsig-chip', instChipTone)}>{instIntelLabel}</span>
              <span className="nx-bsig-chip is-muted">Cash Buyer: N/A</span>
            </div>
          </div>
        </div>

        <div className="nx-capsule-section">
          <span className="nx-capsule-section__title">PROSPECT INTEL</span>
          <div className="nx-prospect-intel-v2">
            {/* Identity */}
            <div className="nx-prospect-group">
              <div className="nx-prospect-group__hdr">IDENTITY</div>
              <div className="nx-prospect-group__body">
                {isPresent(prospectName) && prospectName !== 'Unknown Prospect' && (
                  <div className="nx-prow">
                    <span className="nx-prow__lbl">Name</span>
                    <span className="nx-prow__val is-accent">{prospectName}</span>
                  </div>
                )}
                <div className="nx-prow">
                  <span className="nx-prow__lbl">Language</span>
                  <span className="nx-prow__val">{language}</span>
                </div>
                {isPresent(occupation) && (
                  <div className="nx-prow">
                    <span className="nx-prow__lbl">Occupation</span>
                    <span className="nx-prow__val">{humanizeOccupation(asStr(occupation))}</span>
                  </div>
                )}
                {isPresent(maritalStatus) && (
                  <div className="nx-prow">
                    <span className="nx-prow__lbl">Marital Status</span>
                    <span className="nx-prow__val">{humanizeMaritalStatus(asStr(maritalStatus))}</span>
                  </div>
                )}
                {isPresent(prospectAge) && (
                  <div className="nx-prow">
                    <span className="nx-prow__lbl">Age</span>
                    <span className="nx-prow__val">{asStr(prospectAge)}</span>
                  </div>
                )}
                {isPresent(education) && (
                  <div className="nx-prow">
                    <span className="nx-prow__lbl">Education</span>
                    <span className="nx-prow__val">{humanizeEducation(asStr(education))}</span>
                  </div>
                )}
                {isPresent(gender) && (
                  <div className="nx-prow">
                    <span className="nx-prow__lbl">Gender</span>
                    <span className="nx-prow__val">{humanizeGender(asStr(gender))}</span>
                  </div>
                )}
                <div className="nx-prow">
                  <span className="nx-prow__lbl">Ownership</span>
                  <span className={cls('nx-prow__val', !isPresent(snapshot.ownershipYears) && 'is-muted')}>
                    {snapshot.ownershipYears ? `${snapshot.ownershipYears} Yrs` : 'Unknown'}
                  </span>
                </div>
                <div className="nx-prow">
                  <span className="nx-prow__lbl">Owner Type</span>
                  <span className={cls('nx-prow__val', !isPresent(snapshot.ownerType) && 'is-muted')}>
                    {isPresent(snapshot.ownerType) ? snapshot.ownerType : 'Unknown'}
                  </span>
                </div>
              </div>
            </div>

            {/* Motivation */}
            <div className="nx-prospect-group">
              <div className="nx-prospect-group__hdr">MOTIVATION</div>
              <div className="nx-prospect-group__body">
                {isPresent(sellerPersona) && (
                  <div className="nx-prow">
                    <span className="nx-prow__lbl">Persona</span>
                    <span className="nx-prow__val is-accent">{sellerPersona}</span>
                  </div>
                )}
                <div className="nx-prow">
                  <span className="nx-prow__lbl">Stage</span>
                  <span className="nx-prow__val">{humanizeStage(stage)}</span>
                </div>
                <div className="nx-prow">
                  <span className="nx-prow__lbl">Intent</span>
                  <span className="nx-prow__val">{humanizeIntent(lastIntent)}</span>
                </div>
                <div className="nx-prow">
                  <span className="nx-prow__lbl">Priority Tier</span>
                  <span className={cls('nx-prow__val', (() => {
                    const tier = String(snapshot.priorityTier || thread.owner_priority_tier || '').toLowerCase()
                    return tier.includes('high') || tier.includes('urgent') ? 'is-warn' : ''
                  })())}>
                    {snapshot.priorityTier || thread.owner_priority_tier || 'Normal'}
                  </span>
                </div>
                <div className="nx-prow">
                  <span className="nx-prow__lbl">Motivation</span>
                  <div className="nx-prow__score-bar">
                    <div className="nx-prow__score-track">
                      <div className="nx-prow__score-fill" style={{ width: `${motivationPct}%`, background: (motivationPct >= 60 ? '#30d158' : '#ffd60a') }} />
                    </div>
                    <span className={cls('nx-prow__val', !isPresent(thread.motivationScore || thread.priorityScore) && 'is-muted')}>
                      {isPresent(thread.motivationScore || thread.priorityScore) ? `${Math.round(motivationPct)}/100` : 'Unavailable'}
                    </span>
                  </div>
                </div>
                {isPresent(householdIncome) && (
                  <div className="nx-prow">
                    <span className="nx-prow__lbl">HH Income</span>
                    <span className="nx-prow__val">{typeof householdIncome === 'number' ? formatMoney(householdIncome) : String(householdIncome)}</span>
                  </div>
                )}
                {isPresent(netAssetValue) && (
                  <div className="nx-prow">
                    <span className="nx-prow__lbl">Net Assets</span>
                    <span className="nx-prow__val">{typeof netAssetValue === 'number' ? formatMoney(netAssetValue) : String(netAssetValue)}</span>
                  </div>
                )}
                {financialPressureScore > 0 && (
                  <div className="nx-prow">
                    <span className="nx-prow__lbl">Fin. Pressure</span>
                    <span className={cls('nx-prow__val nx-score-emphasis',
                      financialPressureScore >= 70 ? 'is-danger is-intense' : financialPressureScore >= 40 ? 'is-warn' : '')}>
                      {Math.round(financialPressureScore)}/100
                    </span>
                  </div>
                )}
                {contactQuality > 0 && (
                  <div className="nx-prow">
                    <span className="nx-prow__lbl">Contact Quality</span>
                    <span className={cls('nx-prow__val nx-score-emphasis',
                      contactQuality >= 70 ? 'is-green is-intense' : contactQuality >= 40 ? '' : 'is-muted')}>
                      {Math.round(contactQuality)}/100
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Risk / Opportunity */}
            <div className="nx-prospect-group">
              <div className="nx-prospect-group__hdr">RISK / OPPORTUNITY</div>
              <div className="nx-prospect-group__body">
                <div className="nx-prow">
                  <span className="nx-prow__lbl">Absentee</span>
                  <span className={cls('nx-prow__val', (thread.isAbsentee || (thread as any).isAbsentee === 'true') && 'is-warn')}>
                    {(thread.isAbsentee || (thread as any).isAbsentee === 'true') ? 'Yes — Absentee Owner' : 'No'}
                  </span>
                </div>
                {isOutOfState && (
                  <div className="nx-prow">
                    <span className="nx-prow__lbl">Out of State</span>
                    <span className="nx-prow__val is-warn">Yes</span>
                  </div>
                )}
                <div className="nx-prow">
                  <span className="nx-prow__lbl">Vacant</span>
                  <span className={cls('nx-prow__val', isVacant && 'is-warn')}>
                    {isVacant ? 'Yes — Vacant' : 'No'}
                  </span>
                </div>
                <div className="nx-prow">
                  <span className="nx-prow__lbl">DNC</span>
                  <span className={cls('nx-prow__val', thread.isSuppressed && 'is-danger')}>
                    {thread.isSuppressed ? 'Suppressed / DNC' : 'Clear'}
                  </span>
                </div>
                <div className="nx-prow">
                  <span className="nx-prow__lbl">Last Response</span>
                  <span className={cls('nx-prow__val', daysSinceResponse !== null && daysSinceResponse > 14 ? 'is-muted' : '')}>
                    {thread.lastInboundAt
                      ? `${formatRelativeTime(thread.lastInboundAt)}${daysSinceResponse !== null ? ` (${daysSinceResponse}d)` : ''}`
                      : <span className="nx-prow__val is-muted">No response yet</span>
                    }
                  </span>
                </div>
                <div className="nx-prow nx-prow--ai">
                  <span className="nx-prow__lbl">AI REC</span>
                  <span className="nx-prow__val nx-prow__val--ai-rec" style={{ fontSize: '10px', lineHeight: 1.35, whiteSpace: 'normal', textAlign: 'right' }}>
                    {aiRecText}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="nx-capsule-section">
          <span className="nx-capsule-section__title">ACTIVITY</span>
          <div className="nx-micro-timeline">
            {latestEvents.length > 0 ? latestEvents.map((msg, i) => {
              const isInbound = msg.direction === 'inbound'
              const body = msg.body || ''
              let label = isInbound ? 'Inbound Seller Response' : 'Outreach Sent'
              let tone = isInbound ? 'is-green' : 'is-blue'

              if (!isInbound && i === latestEvents.length - 1) { label = 'Initial Outreach'; }
              if (isInbound && body) {
                const lc = body.toLowerCase()
                if (/stop|unsubscribe|remove|opt.?out/.test(lc)) { label = 'Opt-Out Request'; tone = 'is-red'; }
                else if (/price|how much|offer|interested|ready/.test(lc)) { label = 'Seller Showing Interest'; tone = 'is-green'; }
                else if (/wrong number|not (the )?owner|already sold/.test(lc)) { label = 'Disqualification Signal'; tone = 'is-amber'; }
                else if (/yes|sure|call|talk|available/.test(lc)) { label = 'Positive Engagement'; tone = 'is-green'; }
              }
              if (!isInbound && (msg as any).deliveryStatus === 'failed') { label = 'Delivery Failed'; tone = 'is-red'; }
              if (!isInbound && thread.conversationStage === 'offer_reveal') { label = 'Offer Presented'; }

              return (
                <div key={msg.id || i} className={cls('nx-micro-timeline__node', tone)}>
                  <div className="nx-micro-timeline__dot" />
                  <div className="nx-micro-timeline__content">
                    <span className="nx-micro-timeline__label">{label}</span>
                    <span className="nx-micro-timeline__time">{formatRelativeTime(msg.createdAt || (msg as any).created_at || (msg as any).timestamp)}</span>
                  </div>
                </div>
              )
            }) : (
              <div className="nx-micro-timeline__empty">No recent activity</div>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}

const MediumDealWorkspace = ({
  thread,
  snapshot,
  messages,
  phase3,
}: {
  thread: WorkflowThread
  snapshot: NormalizedPropertySnapshot
  messages: ThreadMessage[]
  phase3: Phase3Intelligence | null
}) => {
  // ── ACCORDION STATE ───────────────────────────────────────
  const [openProspect, setOpenProspect] = useState<Set<string>>(() => new Set(['identity', 'motivation']))
  const toggleProspect = (key: string) => setOpenProspect(prev => {
    const next = new Set(prev)
    if (next.has(key)) { next.delete(key) } else { next.add(key) }
    return next
  })
  const [openPropIntel, setOpenPropIntel] = useState<Set<string>>(() => new Set(['core']))
  const togglePropIntel = (key: string) => setOpenPropIntel(prev => {
    const next = new Set(prev)
    if (next.has(key)) { next.delete(key) } else { next.add(key) }
    return next
  })
  const [openCensus, setOpenCensus] = useState<Set<string>>(() => new Set(['demo']))
  const toggleCensus = (key: string) => setOpenCensus(prev => {
    const next = new Set(prev)
    if (next.has(key)) { next.delete(key) } else { next.add(key) }
    return next
  })
  const [openPortfolio, setOpenPortfolio] = useState<Set<string>>(() => new Set(['overview']))
  const togglePortfolio = (key: string) => setOpenPortfolio(prev => {
    const next = new Set(prev)
    if (next.has(key)) { next.delete(key) } else { next.add(key) }
    return next
  })

  // ── IDENTITY ──────────────────────────────────────────────
  const address = snapshot.fullAddress || thread.displayAddress || thread.propertyAddress || thread.subject || 'Property Unknown'
  const sellerName = snapshot.ownerDisplayName || snapshot.ownerName || thread.ownerDisplayName || thread.ownerName || thread.prospect_full_name || thread.displayName || 'Unknown Seller'
  const stage = getSellerStageVisual(thread.conversationStage)
  const status = getStatusVisual(thread.inboxStatus)

  // ── SCORE RING ────────────────────────────────────────────
  const score = percentFromScore(thread.finalAcquisitionScore || (thread as any).ai_score || thread.motivationScore, 42)
  const heatColor = score >= 80 ? 'red' : score >= 60 ? 'orange' : score >= 40 ? 'amber' : 'blue'
  const RING_R = 30
  const RING_C = 2 * Math.PI * RING_R
  const ringFill = RING_C * (score / 100)

  // ── PROPERTY METRICS ─────────────────────────────────────
  const value = asNum(snapshot.estimatedValue || thread.estimatedValue)
  const equity = asNum(thread.equityPercent || snapshot.equityPercent)
  const equityAmt = asNum(thread.equityAmount || snapshot.equityAmount)
  const repairs = asNum(thread.estimatedRepairCost || snapshot.repairCost)
  const beds = asNum(thread.total_bedrooms || snapshot.beds)
  const baths = asNum(thread.total_baths || snapshot.baths)
  const sqft = asNum(thread.building_square_feet || snapshot.sqft)
  const yearBuilt = asNum((thread as any).year_built || thread.effective_year_built || snapshot.yearBuilt)
  const condition = asStr(thread.building_condition)
  const conditionTone = /excellent|great|good/i.test(condition) ? 'green' : /fair|average|moderate/i.test(condition) ? 'amber' : /poor|bad|tear|distress/i.test(condition) ? 'red' : 'muted'

  // ── MF ────────────────────────────────────────────────────
  const propType = asStr(thread.propertyType || snapshot.propertyType || (thread as any).property_type)
  const propTypeLower = propType.toLowerCase()
  const isMultifamily = /multi|mf|apartment|duplex|triplex|quadplex|plex/.test(propTypeLower) || (asNum((thread as any).units_count || snapshot.unitCount) > 1)
  const unitCount = asNum((thread as any).units_count || snapshot.unitCount)
  const avgSqftPerUnit = asNum(thread.avg_sqft_per_unit) || (unitCount > 1 && sqft > 0 ? Math.round(sqft / unitCount) : 0)
  const bedsPerUnit = asNum(thread.beds_per_unit) || (unitCount > 1 && beds > 0 ? +(beds / unitCount).toFixed(1) : 0)

  // ── UNDERWRITING ─────────────────────────────────────────
  const arv = value || 0
  const spread = arv ? Math.max(Math.round(arv * 0.18), 25000) : 0
  const mao = arv ? Math.max(arv - repairs - spread, 0) : 0
  const offer = asNum(thread.ai_recommended_opening_offer || thread.ai_offer || thread.cashOffer || thread.mao) || mao
  const confidence = clamp((arv ? 40 : 18) + (repairs ? 18 : 0) + (thread.contactability_score ? 8 : 0) + (thread.finalAcquisitionScore ? 16 : 0), 24, 96)
  const decisionTone = confidence >= 72 ? 'pursue' : confidence >= 52 ? 'review' : 'pass'
  const waterfallItems = [
    { label: 'Retail ARV', value: arv, tone: 'green' },
    { label: 'Investor Exit', value: Math.round(arv * 0.82), tone: 'purple' },
    { label: 'Repair Load', value: repairs, tone: 'amber' },
    { label: 'Target Spread', value: spread, tone: 'red' },
    { label: 'MAO', value: mao, tone: 'blue' },
    { label: 'AI Offer', value: offer, tone: 'green' },
  ].filter((item) => item.value > 0)

  // ── BUYER INTELLIGENCE ───────────────────────────────────
  const demand = asNum((thread as any).buyerDemand || (thread as any).demandScore || (thread as any).demand_score) || 0
  const flipVelocity = asNum((thread as any).flipVelocity || (thread as any).flip_velocity) || 0
  const avgPpsf = asNum((thread as any).avgPpsf || (thread as any).avg_ppsf || (thread as any).price_per_sqft) || 0
  const cashBuyerPct = asNum((thread as any).cashBuyerPct || (thread as any).cash_buyer_pct) || 0
  const nearbyAcquisitions = asNum((thread as any).nearbyAcquisitions || (thread as any).nearby_acquisitions) || 0
  const hedgeFundActivity = asStr((thread as any).hedgeFundActivity || (thread as any).hedge_fund_activity)
  const recentSoldCount = asNum((thread as any).recentSoldCount || (thread as any).recent_sold_count)
  const buyerMatchCount = asNum((thread as any).buyerMatchCount || (thread as any).buyer_match_count)
  const avgResalePrice = asNum((thread as any).avgResalePrice || (thread as any).avg_resale_price)
  const dispoConfidence = asNum((thread as any).dispoConfidence || (thread as any).dispo_confidence)
  const assignmentSpread = asNum((thread as any).assignmentSpread || (thread as any).assignment_spread)
  const avgPricePerUnit = isMultifamily && unitCount > 0 && avgResalePrice > 0 ? Math.round(avgResalePrice / unitCount) : 0
  const buyerChips = ([
    demand >= 75 && { label: 'HIGH BUYER PRESSURE', tone: 'red' },
    isMultifamily && demand >= 60 && { label: 'MF BUYER ACTIVE', tone: 'purple' },
    cashBuyerPct >= 60 && { label: 'CASH HEAVY', tone: 'green' },
    demand >= 70 && { label: 'INSTITUTIONAL DEMAND', tone: 'cyan' },
    flipVelocity >= 70 && { label: 'HIGH VELOCITY', tone: 'amber' },
    demand > 0 && demand < 40 && { label: 'LOW INVENTORY', tone: 'amber' },
  ] as (false | { label: string; tone: string })[]).filter(Boolean) as { label: string; tone: string }[]

  // ── PROSPECT ─────────────────────────────────────────────
  const financialPressureScore = asNum(thread.financial_pressure_score) || 0
  const motivationScore = percentFromScore(thread.motivationScore, 48)
  const contactQuality = asNum(thread.contactability_score || thread.prospect_contact_score) || 0
  const ownerYears = asNum((thread as any).ownership_years || snapshot.ownershipYears) || 0
  const householdIncome = asNum(thread.est_household_income || snapshot.householdIncome)
  const occupation = asStr(thread.occupation || thread.occupation_group || snapshot.occupationGroup)
  const maritalStatus = asStr(thread.marital_status)
  const ageEstimate = asNum(thread.age) || 0
  const educationLevel = asStr(thread.education_model)
  const isTaxDelinquent = !!(thread.property_tax_delinquent || thread.isTaxDelinquent)
  const isVacant = !!(thread.isVacant)
  const isAbsentee = !!(thread.isAbsentee)
  const persona = getSellerPersona(thread, equity)
  // Raw tag data from Supabase
  const rawSellerTagsText = asStr((thread as any).seller_tags_text)
  const rawPropertyFlagsText = asStr((thread as any).property_flags_text)
  const rawPersonFlagsText = asStr((thread as any).person_flags_text)
  const sellerTagsList = rawSellerTagsText ? rawSellerTagsText.split(',').map((t: string) => t.trim()).filter(Boolean) : []
  const propertyFlagsList = rawPropertyFlagsText ? rawPropertyFlagsText.split(',').map((t: string) => t.trim()).filter(Boolean) : []
  const personFlagsList = rawPersonFlagsText ? rawPersonFlagsText.split(',').map((t: string) => t.trim()).filter(Boolean) : []
  const prospectChips = ([
    equity >= 60 && { label: 'HIGH EQUITY', tone: 'green' },
    isTaxDelinquent && { label: 'TAX DELINQUENT', tone: 'red' },
    isAbsentee && { label: 'ABSENTEE', tone: 'amber' },
    ownerYears >= 15 && { label: 'LONG TERM HOLD', tone: 'blue' },
    financialPressureScore >= 70 && { label: 'HIGH DISTRESS', tone: 'red' },
    /executive|manager|director|president|vp|ceo|cfo|founder/i.test(occupation) && { label: 'EXECUTIVE', tone: 'purple' },
  ] as (false | { label: string; tone: string })[]).filter(Boolean) as { label: string; tone: string }[]

  // ── BEHAVIORAL DERIVATIONS ───────────────────────────────
  const negotiationStyle = financialPressureScore >= 70 ? 'Motivated Seller'
    : /executive|ceo|president|vp|director|founder/i.test(occupation) ? 'Analytical Negotiator'
    : ownerYears >= 20 ? 'Emotional Hold Seller'
    : isAbsentee ? 'Investor Mindset'
    : 'Discovery Phase'
  const likelyObjections: string[] = [
    financialPressureScore < 40 ? 'May push for higher price' : null,
    equity < 30 ? 'Limited flexibility on price' : null,
    ownerYears >= 15 ? 'Emotional attachment to property' : null,
    isAbsentee ? 'Slower remote engagement' : null,
    !thread.lastInboundAt ? 'No response yet — cold outreach' : null,
  ].filter(Boolean) as string[]
  const responseCadence = (() => {
    const ts = thread.lastInboundAt
    if (!ts) return 'No response yet'
    const days = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000)
    if (days === 0) return 'Responded today'
    if (days === 1) return 'Yesterday'
    if (days <= 3) return `${days}d ago — active`
    if (days <= 7) return `${days}d ago — cooling`
    return `${days}d ago — dormant`
  })()
  const phoneConfidence = asNum(thread.prospect_phone_score || thread.contactability_score) || 0
  const smsDeliverability = phoneConfidence
  const languagePref = asStr(thread.best_language || snapshot.language || thread.language_preference)
  const dncRisk = thread.isSuppressed ? 'Suppressed' : financialPressureScore < 20 && contactQuality < 30 ? 'Elevated' : 'Low'

  // ── PROPERTY INTELLIGENCE ────────────────────────────────
  const propClass = asStr(thread.propertyClass || snapshot.propertyClass)
  const buildings = asNum(thread.sum_buildings_nbr) || 1
  const lotSize = asNum(thread.lot_square_feet || snapshot.lotSize)
  const lotAcreage = asNum(thread.lot_acreage || snapshot.lotSizeAcres)
  const zoning = asStr(thread.zoning || snapshot.zoning)
  const floodZone = asStr(thread.flood_zone || snapshot.floodZone)
  const constructionType = asStr(thread.construction_type)
  const buildingQuality = asStr(thread.building_quality)
  const roofCover = asStr(thread.roof_cover)
  const floorCover = asStr(thread.floor_cover)
  const heating = asStr(thread.heating_type)
  const cooling = asStr(thread.air_conditioning)
  const garageType = asStr(thread.garage)
  const hasPool = !!(thread.pool)
  const sewerType = asStr(thread.sewer)
  const waterSource = asStr(thread.water)
  const taxAmount = asNum(thread.tax_amt || snapshot.taxAmount)
  const assessedTotal = asNum(thread.assd_total_value || snapshot.assessedTotalValue)
  const assessedLand = asNum(thread.assd_land_value || snapshot.assessedLandValue)
  const assessedImprovement = asNum(thread.assd_improvement_value || snapshot.assessedImprovementValue)
  const taxDelinquentYear = asStr(thread.property_tax_delinquent_year)
  const pastDueAmount = asNum(thread.past_due_amount)
  const loanAmount = asNum(thread.total_loan_amt || snapshot.loanAmount)
  const loanBalance = asNum(thread.total_loan_balance || snapshot.loanBalance)
  const estimatedPayment = asNum(thread.total_loan_payment || snapshot.loanPayment)
  const isFreeClear = (loanAmount > 0 && loanBalance === 0) || /free.?clear/i.test(rawPropertyFlagsText + ' ' + rawSellerTagsText)
  const estimatedCashFlow = asNum((thread as any).estimatedCashFlow || (thread as any).estimated_cash_flow)
  const lastSaleDate = asStr((thread as any).sale_date || (thread as any).last_sale_date)
  const lastSalePrice = asNum(thread.sale_price)
  const appreciationPct = asNum((thread as any).appreciationPct || (thread as any).appreciation_pct)
  const equityGain = value > 0 && lastSalePrice > 0 ? value - lastSalePrice : 0
  const rehabLevel = asStr(thread.rehab_level)
  const deferredMaint = asStr((thread as any).deferredMaintenance || (thread as any).deferred_maintenance)
  const structuralRisk = asStr((thread as any).structuralRisk || (thread as any).structural_risk)
  const isFullRehab = /full/i.test(rehabLevel) || /full/i.test(condition)
  const isCosmeticRehab = /cosmetic|light/i.test(rehabLevel)
  const rehabScore = isFullRehab ? 85 : isCosmeticRehab ? 35 : 50
  const flipSuitability = rehabScore <= 40 ? 'Flip Ready' : rehabScore <= 65 ? 'Moderate Work' : 'Heavy Rehab'
  const propQualityBadge = buildingQuality || condition || null
  const propQualityTone = /excellent|good|high/i.test(propQualityBadge || '') ? 'green' : /average|fair|moderate/i.test(propQualityBadge || '') ? 'amber' : /poor|low|bad/i.test(propQualityBadge || '') ? 'red' : 'blue'
  const rehabRiskTone = isFullRehab ? 'red' : isCosmeticRehab ? 'green' : 'amber'
  const distressCount = [isTaxDelinquent, isVacant, isAbsentee, isFullRehab, financialPressureScore >= 70, equity < 20].filter(Boolean).length
  // Property tags from Supabase flags + derived signals
  const propTagChips: { label: string; tone: string }[] = ([
    equity >= 60 && { label: 'High Equity', tone: 'green' },
    isTaxDelinquent && { label: 'Tax Delinquent', tone: 'red' },
    isAbsentee && { label: 'Absentee Owner', tone: 'amber' },
    isVacant && { label: 'Vacant', tone: 'amber' },
    isFreeClear && { label: 'Free & Clear', tone: 'green' },
    ownerYears >= 15 && { label: 'Long-Term Hold', tone: 'blue' },
    ageEstimate >= 65 && { label: 'Senior Owner', tone: 'blue' },
    isFullRehab && { label: 'Heavy Rehab', tone: 'red' },
    financialPressureScore >= 70 && { label: 'Financial Pressure', tone: 'red' },
    isMultifamily && { label: 'Multifamily', tone: 'purple' },
    (asNum(thread.property_count || snapshot.portfolioPropertyCount) >= 3) && { label: 'Investor Owned', tone: 'blue' },
    !!(thread as any).is_corporate_owner && { label: 'Corporate Owned', tone: 'purple' },
    ...propertyFlagsList.map((f: string) => ({ label: f, tone: 'amber' as const })),
    ...sellerTagsList.map((t: string) => ({ label: t, tone: 'blue' as const })),
  ] as (false | { label: string; tone: string })[]).filter(Boolean) as { label: string; tone: string }[]

  // ── CENSUS INTELLIGENCE ──────────────────────────────────
  const censusMedianIncome = asNum((thread as any).censusMedianIncome || (thread as any).census_median_income || (thread as any).medianIncome)
  const censusMedianAge = asNum((thread as any).censusMedianAge || (thread as any).census_median_age)
  const censusHouseholdSize = asNum((thread as any).censusHouseholdSize || (thread as any).census_household_size)
  const censusPopulation = asNum((thread as any).censusPopulation || (thread as any).census_population || (thread as any).population)
  const populationGrowth = asNum((thread as any).populationGrowth || (thread as any).population_growth)
  const ownerOccupancyRate = asNum((thread as any).ownerOccupancyRate || (thread as any).owner_occupancy_rate)
  const rentalRate = asNum((thread as any).rentalRate || (thread as any).rental_rate)
  const vacancyRate = asNum((thread as any).vacancyRate || (thread as any).vacancy_rate)
  const crimeIndex = asNum((thread as any).crimeIndex || (thread as any).crime_index)
  const schoolRating = asNum((thread as any).schoolRating || (thread as any).school_rating)
  const employmentStrength = asNum((thread as any).employmentStrength || (thread as any).employment_strength)
  const migrationTrend = asStr((thread as any).migrationTrend || (thread as any).migration_trend)
  const economicTrend = asStr((thread as any).economicTrend || (thread as any).economic_trend)
  const investorActivity = asNum((thread as any).investorActivity || (thread as any).investor_activity)
  const neighborhoodScore = asNum((thread as any).neighborhoodScore || (thread as any).neighborhood_score)
  const growthMomentum = asNum((thread as any).growthMomentum || (thread as any).growth_momentum)

  // ── OWNER PORTFOLIO INTELLIGENCE ────────────────────────
  const portfolioCount = asNum(thread.property_count || snapshot.portfolioPropertyCount)
  const portfolioUnits = asNum(thread.portfolio_total_units)
  const portfolioValue = asNum(thread.portfolio_total_value || snapshot.portfolioValue)
  const portfolioEquity = asNum(thread.portfolio_total_equity)
  const portfolioDebt = asNum(thread.portfolio_total_loan_balance)
  const portfolioMonthlyDebt = asNum(thread.portfolio_total_loan_payment)
  const portfolioTypeMajority = asStr(thread.property_type_majority || (thread as any).portfolio_type)
  const portfolioMarkets = asStr(thread.displayMarket || (thread as any).portfolio_markets)
  const sophisticationScore = asNum((thread as any).sophisticationScore || (thread as any).sophistication_score)
  const acquisitionVelocity = asNum((thread as any).acquisitionVelocity || (thread as any).acquisition_velocity)
  const distressExposure = asNum((thread as any).distressExposure || (thread as any).distress_exposure)
  const portfolioGrowthTrend = asStr((thread as any).portfolioGrowthTrend || (thread as any).portfolio_growth_trend)
  const landlordBurnout = financialPressureScore >= 60 && portfolioCount >= 2 && ownerYears >= 10
  const overleveraged = portfolioDebt > 0 && portfolioValue > 0 && (portfolioDebt / portfolioValue) > 0.85
  const investorLabel = (() => {
    if (portfolioCount >= 50) return { label: 'Institutional Operator', tone: 'purple' }
    if (portfolioCount >= 10) return { label: 'Professional Investor', tone: 'blue' }
    if (portfolioCount >= 3) return { label: 'Active Investor', tone: 'cyan' }
    if (portfolioCount >= 1) return { label: 'Small Landlord', tone: 'green' }
    return { label: 'Owner Occupant', tone: 'amber' }
  })()
  const portfolioTagChips: { label: string; tone: string }[] = ([
    portfolioCount >= 50 && { label: 'Institutional Adjacent', tone: 'purple' },
    portfolioCount >= 10 && { label: 'Scaling Operator', tone: 'blue' },
    portfolioCount >= 3 && portfolioCount < 10 && { label: 'Active Investor', tone: 'cyan' },
    portfolioCount >= 1 && portfolioCount < 3 && { label: 'Small Landlord', tone: 'green' },
    portfolioCount === 0 && ownerYears >= 10 && { label: 'Legacy Holder', tone: 'blue' },
    overleveraged && { label: 'Overleveraged', tone: 'red' },
    landlordBurnout && { label: 'Burnt-Out Landlord', tone: 'amber' },
    financialPressureScore >= 70 && portfolioCount >= 1 && { label: 'Distressed Investor', tone: 'red' },
    isFreeClear && portfolioCount >= 1 && { label: 'Free & Clear Portfolio', tone: 'green' },
  ] as (false | { label: string; tone: string })[]).filter(Boolean) as { label: string; tone: string }[]

  // ── EXPANDED PROSPECT DATA ───────────────────────────────
  const gender = asStr(thread.gender || snapshot.gender)
  const netWorth = asNum(thread.net_asset_value || snapshot.netAssetValue)
  const buyingPower = asNum((thread as any).buying_power)
  const liquidityEstimate = asNum((thread as any).liquidity_estimate || (thread as any).cashLiquidity)
  const emailQuality = asNum(thread.prospect_contact_score)
  const contactProbability = asNum(thread.prospect_contact_score || thread.contactability_score) || contactQuality
  const sellerPhone = asStr(thread.prospect_best_phone || thread.displayPhone || thread.sellerPhone)
  const sellerEmail = asStr(thread.prospect_best_email || thread.best_email_1)
  const prospectName = asStr(thread.prospect_full_name || snapshot.prospectFullName)
  const bestContactWindow = asStr((thread as any).best_contact_window || snapshot.bestContactWindow)
  const ownerType = asStr(snapshot.ownerType || (thread as any).ownerType || (thread as any).owner_type_guess)
  const followUpAt = asStr(thread.follow_up_at)
  const lastOutboundAt = asStr(thread.lastOutboundAt)
  const autoProspectTags: { label: string; tone: string }[] = ([
    isTaxDelinquent && { label: 'Tax Delinquent', tone: 'red' },
    isVacant && { label: 'Vacant Property', tone: 'amber' },
    isAbsentee && { label: 'Absentee Owner', tone: 'amber' },
    isFreeClear && { label: 'Free & Clear', tone: 'green' },
    isFullRehab && { label: 'Full Rehab', tone: 'red' },
    isCosmeticRehab && { label: 'Cosmetic Only', tone: 'green' },
    ownerYears >= 20 && { label: 'Long-Term Hold', tone: 'blue' },
    portfolioCount >= 10 && { label: 'Multi-Property', tone: 'purple' },
    financialPressureScore >= 70 && { label: 'High Distress', tone: 'red' },
    equity >= 70 && { label: 'Equity Rich', tone: 'green' },
    motivationScore >= 75 && { label: 'Highly Motivated', tone: 'green' },
    contactQuality >= 80 && { label: 'Top Contact', tone: 'cyan' },
    ageEstimate >= 65 && { label: 'Senior Owner', tone: 'blue' },
    /spanish|hispanic|latino/i.test(languagePref) && { label: 'Spanish Speaker', tone: 'blue' },
    ...sellerTagsList.map((t: string) => ({ label: t, tone: 'blue' as const })),
    ...personFlagsList.map((f: string) => ({ label: f, tone: 'amber' as const })),
  ] as (false | { label: string; tone: string })[]).filter(Boolean) as { label: string; tone: string }[]
  const prospectTags = autoProspectTags

  // ── CONVERSATION BRAIN ───────────────────────────────────
  const latestInbound = messages.find((m) => m.direction === 'inbound') || null
  const latestOutbound = messages.find((m) => m.direction === 'outbound') || null
  const summary = phase3?.latestSnapshot?.capture_reason || thread.aiSummary || thread.aiDraft || 'AI is analyzing seller conversation patterns and market signals.'
  const intent = thread.uiIntent || thread.detected_intent || 'Pending'
  const sentiment = String(thread.sentiment || 'Neutral')

  const emotionalState = (() => {
    if (/angry|frustrated|upset|hostile/i.test(summary + sentiment)) return { label: 'Frustrated', tone: 'red' }
    if (/interested|excited|ready|want to sell/i.test(summary)) return { label: 'Engaged', tone: 'green' }
    if (/hesitant|uncertain|maybe|unsure/i.test(summary)) return { label: 'Hesitant', tone: 'amber' }
    if (/positive/i.test(sentiment)) return { label: 'Receptive', tone: 'green' }
    if (/negative/i.test(sentiment)) return { label: 'Resistant', tone: 'red' }
    return { label: 'Neutral', tone: 'blue' }
  })()
  const urgency = percentFromScore(thread.urgency_score || thread.priorityScore, thread.priority === 'urgent' ? 82 : 44)
  const currentStageIndex = Math.max(0, sellerStageOptions.findIndex((o) => o.value === thread.conversationStage))
  const nextAction = getNextBestAction(thread)
  const stageFlow = ['Ownership', 'Interest', 'Price', 'Condition', 'Offer', 'Negotiation', 'Contract']
  const aiInsights: string[] = []
  if (urgency >= 75) aiInsights.push('Seller response timing indicates elevated engagement.')
  if (financialPressureScore >= 65) aiInsights.push('Motivation appears financial rather than emotional.')
  if (demand >= 70) aiInsights.push('Buyer pressure supports stronger acquisition confidence.')
  if (equity >= 70) aiInsights.push('Strong equity position creates flexible offer room.')
  if (isTaxDelinquent) aiInsights.push('Tax delinquency suggests urgency — timing leverage elevated.')
  if (!aiInsights.length) aiInsights.push('Analyzing seller signals and market conditions.')

  // ── DERIVED INTELLIGENCE SIGNALS ─────────────────────────
  const marketTemp = demand >= 70 ? 'Hot' : demand >= 45 ? 'Warm' : demand > 0 ? 'Cool' : null
  const marketTempTone = demand >= 70 ? 'red' : demand >= 45 ? 'amber' : 'blue'
  const aiConfidence = Math.round(clamp(confidence * 0.7 + (motivationScore > 0 ? motivationScore * 0.3 : 21), 20, 95))
  const acqScore = Math.round(clamp(
    (equity >= 60 ? 30 : equity >= 30 ? 15 : 5) +
    (offer > 0 && value > 0 ? Math.min((offer / value) * 40, 35) : 10) +
    (repairs < 15000 ? 20 : repairs < 40000 ? 12 : repairs < 80000 ? 5 : 0) +
    (demand >= 60 ? 15 : 8)
  , 0, 100))
  const acqGrade = acqScore >= 88 ? 'A+' : acqScore >= 78 ? 'A' : acqScore >= 65 ? 'B+' : acqScore >= 52 ? 'B' : acqScore >= 38 ? 'C' : 'D'
  const acqGradeTone = acqScore >= 88 ? 'is-a-plus' : acqScore >= 78 ? 'is-a' : acqScore >= 65 ? 'is-b-plus' : acqScore >= 52 ? 'is-b' : acqScore >= 38 ? 'is-c' : 'is-d'
  const acqGradeChips: { label: string; tone: string }[] = ([
    decisionTone === 'pursue' && { label: 'PURSUE', tone: 'is-a' },
    decisionTone === 'review' && { label: 'REVIEW', tone: 'is-b' },
    decisionTone === 'pass' && { label: 'PASS', tone: 'is-d' },
    equity >= 60 && { label: 'HIGH EQUITY', tone: 'is-a' },
    equity >= 30 && equity < 60 && { label: 'MODERATE EQUITY', tone: 'is-b-plus' },
    isFreeClear && { label: 'FREE & CLEAR', tone: 'is-a-plus' },
    spread >= 30000 && { label: 'STRONG SPREAD', tone: 'is-a' },
    repairs > 50000 && { label: 'HEAVY REHAB', tone: 'is-d' },
    isCosmeticRehab && { label: 'FLIP READY', tone: 'is-a' },
    demand >= 65 && { label: 'HOT MARKET', tone: 'is-b-plus' },
  ] as (false | { label: string; tone: string })[]).filter(Boolean).slice(0, 4) as { label: string; tone: string }[]
  const aiReasoning = (() => {
    const parts: string[] = []
    if (equity >= 60 && ownerYears >= 10) parts.push(`High equity (${Math.round(equity)}%) and ${ownerYears}+ year hold suggest seller flexibility but low urgency.`)
    else if (equity >= 40) parts.push(`Moderate equity position creates offer room without severe seller leverage.`)
    if (isAbsentee && loanAmount > 0) parts.push('Absentee ownership with active mortgage increases creative finance probability.')
    if (isTaxDelinquent) parts.push('Tax delinquency signals financial pressure — timing leverage elevated.')
    if (financialPressureScore >= 65) parts.push(`Financial pressure score (${Math.round(financialPressureScore)}) indicates seller is motivated by necessity, not preference.`)
    if (isFullRehab && demand >= 60) parts.push('Heavy rehab risk offset by strong investor demand in this market.')
    if (!parts.length && offer > 0) parts.push(`AI offer of ${formatMoney(offer)} reflects ${Math.round(confidence)}% confidence on available comps and seller signals.`)
    return parts[0] || null
  })()
  const leveragePoints: { text: string; tone: string }[] = ([
    isTaxDelinquent && { text: 'Tax delinquency — immediate payment relief angle', tone: 'is-hot' },
    isAbsentee && ownerYears >= 10 && { text: 'Absentee + long hold — remote management fatigue likely', tone: 'is-hot' },
    equity >= 70 && !loanAmount && { text: 'Free & clear — seller can accept creative terms', tone: 'is-good' },
    financialPressureScore >= 60 && { text: `Fin. pressure ${Math.round(financialPressureScore)} — lead with speed/certainty`, tone: 'is-hot' },
    isCosmeticRehab && demand >= 60 && { text: 'Cosmetic rehab + strong buyer demand = fast flip window', tone: 'is-good' },
  ] as (false | { text: string; tone: string })[]).filter(Boolean).slice(0, 3) as { text: string; tone: string }[]
  const negotiationPosture = financialPressureScore >= 70 ? 'High Pressure — Escalate'
    : urgency >= 70 ? 'Time-Sensitive — Act Now'
    : motivationScore >= 60 ? 'Engaged — Advance Discovery'
    : thread.conversationStage === 'offer_reveal' ? 'Ready — Push to Close'
    : 'Discovery Phase'
  const momentumScore = Math.round(clamp((urgency * 0.4) + (motivationScore * 0.3) + (contactQuality * 0.3), 0, 100))
  const closeProbability = Math.round(clamp(
    (equity >= 60 ? 20 : equity >= 30 ? 10 : 5) +
    (financialPressureScore >= 60 ? 25 : financialPressureScore >= 40 ? 12 : 0) +
    (contactQuality >= 70 ? 20 : contactQuality >= 40 ? 10 : 0) +
    (motivationScore >= 70 ? 20 : motivationScore >= 40 ? 10 : 0) +
    (urgency >= 70 ? 15 : urgency >= 40 ? 8 : 0),
    8, 92
  ))
  const CLOSE_R = 22
  const CLOSE_C = 2 * Math.PI * CLOSE_R
  const closeRingFill = CLOSE_C * (closeProbability / 100)
  const closeTone = closeProbability >= 65 ? 'green' : closeProbability >= 40 ? 'amber' : 'red'
  // Buyer intel extras
  const marketAbsorption = asNum((thread as any).marketAbsorption || (thread as any).absorption_rate) || 0
  const investorCompetition = asNum((thread as any).investorCompetition || (thread as any).investor_competition) || 0
  void asNum((thread as any).buyerSaturation || (thread as any).buyer_saturation) // reserved field, not yet rendered
  const dispositionConfidence = Math.round(clamp((demand > 0 ? demand * 0.5 : 20) + (flipVelocity * 0.3) + (cashBuyerPct * 0.2), 0, 100))
  const exitLiquidity = demand >= 70 ? 'High' : demand >= 45 ? 'Moderate' : demand > 0 ? 'Low' : null
  const resistanceLevel = Math.round(clamp(100 - financialPressureScore - (urgency * 0.5), 0, 100))
  const momentumTone = momentumScore >= 70 ? 'green' : momentumScore >= 40 ? 'amber' : 'red'

  // ── TIMELINE ─────────────────────────────────────────────
  const latestEvents = [...messages].reverse().slice(0, 6)

  return (
    <div className="nx-medium-dossier">

      {/* ── 1. CINEMATIC HEADER ─────────────────────────── */}
      <div className={cls('nx-medium-header', `is-heat-${heatColor}`)}>
        <div className="nx-medium-header__atmosphere" />
        <div className="nx-medium-header__scan-shimmer" />
        <div className="nx-medium-header__content">
          <div className="nx-medium-header__identity">
            <div className="nx-medium-header__eyebrow">
              <span className="nx-medium-header__live-dot" />
              DEAL INTELLIGENCE
            </div>
            <div className="nx-medium-header__address">{address}</div>
            <div className="nx-medium-header__seller">{sellerName}</div>
            <div className="nx-medium-header__chips">
              <span className="nx-mh-chip nx-mh-chip--stage" style={{ color: stage.color, borderColor: stage.border, background: stage.bg }}>
                {stage.label}
              </span>
              <span className="nx-mh-chip nx-mh-chip--status">{status.label}</span>
              {value > 0 && <span className="nx-mh-chip nx-mh-chip--value">{formatMoney(value)}</span>}
              {offer > 0 && <span className="nx-mh-chip nx-mh-chip--offer">{formatMoney(offer)}</span>}
            </div>
            {/* Live intelligence status row */}
            <div className="nx-medium-header__intel-row">
              {marketTemp && (
                <span className={cls('nx-mh-intel-pill', `is-${marketTempTone}`)}>
                  MKT {marketTemp}
                </span>
              )}
              <span className={cls('nx-mh-intel-pill', urgency >= 70 ? 'is-red' : urgency >= 40 ? 'is-amber' : 'is-blue')}>
                URG {Math.round(urgency)}%
              </span>
              <span className="nx-mh-intel-pill is-ai">
                AI CONF {aiConfidence}%
              </span>
              {thread.automationState === 'active' && (
                <span className="nx-mh-intel-pill is-green">AUTO ON</span>
              )}
            </div>
          </div>
          <div className={cls('nx-medium-header__score-ring', `is-${heatColor}`)}>
            <svg viewBox="0 0 76 76" className="nx-mh-score-svg">
              <circle cx="38" cy="38" r={RING_R} className="nx-mh-score-bg" />
              <circle
                cx="38" cy="38" r={RING_R}
                className="nx-mh-score-fill"
                strokeDasharray={`${ringFill} ${RING_C - ringFill}`}
                strokeDashoffset={RING_C * 0.25}
              />
            </svg>
            <div className="nx-mh-score-inner">
              <strong>{Math.round(score)}</strong>
              <span>SCORE</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── 2. STREET VIEW — CINEMATIC INTELLIGENCE VIEWPORT ── */}
      <div className="nx-medium-map-frame">
        <PropertyHeroCard thread={thread} snapshot={snapshot} panelMode="half" layoutMode="medium" />
        <div className="nx-mmo-overlay" aria-hidden>
          <div className="nx-mmo-corner is-tl" /><div className="nx-mmo-corner is-tr" />
          <div className="nx-mmo-corner is-bl" /><div className="nx-mmo-corner is-br" />
          <div className="nx-mmo-scan" />
          <div className="nx-mmo-coord">{address.split(',')[0]?.trim().toUpperCase()}</div>
          <div className="nx-mmo-pin-glow" style={{ background: `radial-gradient(circle, ${heatColor === 'red' ? 'rgba(255,69,58,0.25)' : heatColor === 'orange' ? 'rgba(255,149,0,0.22)' : heatColor === 'amber' ? 'rgba(255,214,10,0.18)' : 'rgba(10,132,255,0.2)'} 0%, transparent 70%)` }} />
        </div>
      </div>

      {/* ── 3. ACQUISITION METRICS ──────────────────────── */}
      <div className="nx-medium-section">
        <div className="nx-medium-section__title">ACQUISITION METRICS</div>
        {/* Dominant AI Offer card */}
        {offer > 0 && (() => {
          const CONF_R = 22, CONF_C = 2 * Math.PI * CONF_R
          const confFill = CONF_C * (confidence / 100)
          return (
            <div className="nx-acq-offer-card">
              <div className="nx-acq-offer-card__eyebrow">AI RECOMMENDED ACQUISITION OFFER</div>
              <div className="nx-acq-offer-card__main">
                <div className="nx-acq-offer-card__left">
                  <div className="nx-acq-offer-card__value">{formatMoney(offer)}</div>
                  <div className="nx-acq-offer-card__range">{formatMoney(Math.round(offer * 0.94))} — {formatMoney(Math.round(offer * 1.06))} range</div>
                  <div className="nx-acq-offer-card__grades">
                    <span className={cls('nx-acq-grade', acqGradeTone)}>GRADE {acqGrade}</span>
                    {acqGradeChips.map((c) => <span key={c.label} className={cls('nx-acq-grade', c.tone)}>{c.label}</span>)}
                  </div>
                </div>
                <div className="nx-acq-offer-card__conf">
                  <svg viewBox="0 0 52 52" className="nx-acq-offer-conf-svg">
                    <circle cx="26" cy="26" r={CONF_R} className="nx-acq-offer-conf-bg" />
                    <circle cx="26" cy="26" r={CONF_R} className="nx-acq-offer-conf-fill"
                      strokeDasharray={`${confFill} ${CONF_C - confFill}`}
                      strokeDashoffset={CONF_C * 0.25} />
                  </svg>
                  <div className="nx-acq-offer-conf-inner">
                    <strong>{Math.round(confidence)}%</strong>
                    <span>CONF</span>
                  </div>
                </div>
              </div>
            </div>
          )
        })()}
        {/* property type + rehab level chips */}
        {(propType || rehabLevel || condition) && (
          <div className="nx-medium-signal-chips" style={{ marginBottom: 10 }}>
            {propType && <span className="nx-medium-signal-chip is-blue">{propType.toUpperCase()}</span>}
            {rehabLevel && <span className={cls('nx-medium-signal-chip', isFullRehab ? 'is-red' : isCosmeticRehab ? 'is-green' : 'is-amber')}>{rehabLevel}</span>}
            {condition && <span className={cls('nx-medium-signal-chip', conditionTone === 'green' ? 'is-green' : conditionTone === 'amber' ? 'is-amber' : conditionTone === 'red' ? 'is-red' : '')}>{condition}</span>}
          </div>
        )}
        <div className="nx-medium-metrics-grid">
          <div className="nx-medium-metric is-large is-shimmer">
            <span className="nx-mm-label">ESTIMATED VALUE</span>
            <strong className={cls('nx-mm-value', isUnavail(fmtMoneyU(value)) && 'nx-mm-unavail')}>{fmtMoneyU(value)}</strong>
            {equity > 0 && <span className="nx-mm-sub">{Math.round(equity)}% equity</span>}
          </div>
          <div className={cls('nx-medium-metric', equity >= 70 ? 'is-strong' : equity >= 40 ? 'is-moderate' : '')}>
            <span className="nx-mm-label">EQUITY %</span>
            <strong className={cls('nx-mm-value', isUnavail(fmtPctU(equity)) && 'nx-mm-unavail')}>{fmtPctU(equity)}</strong>
            {equity > 0 && <div className="nx-mm-bar"><div className={cls('nx-mm-bar__fill', equity >= 60 ? 'is-green' : 'is-blue')} style={{ width: `${clamp(equity, 0, 100)}%` }} /></div>}
            {equity >= 60 ? <div className="nx-acq-equity-state is-strong"><div className="nx-acq-equity-state__dot" />STRONG POSITION</div>
              : equity >= 30 ? <div className="nx-acq-equity-state is-moderate"><div className="nx-acq-equity-state__dot" />MODERATE EQUITY</div>
              : equity > 0 ? <div className="nx-acq-equity-state is-thin"><div className="nx-acq-equity-state__dot" />THIN MARGIN</div> : null}
          </div>
          <div className="nx-medium-metric">
            <span className="nx-mm-label">EQUITY AMOUNT</span>
            <strong className={cls('nx-mm-value', isUnavail(fmtMoneyU(equityAmt || (value > 0 && equity > 0 ? Math.round(value * equity / 100) : 0))) && 'nx-mm-unavail')}>
              {equityAmt > 0 ? fmtMoneyU(equityAmt) : value > 0 && equity > 0 ? fmtMoneyU(Math.round(value * equity / 100)) : 'Unavailable'}
            </strong>
          </div>
          <div className={cls('nx-medium-metric is-wide', repairs > 50000 ? 'is-danger' : repairs > 25000 ? 'is-warn' : '')}>
            <span className="nx-mm-label">REPAIR ESTIMATE</span>
            <strong className={cls('nx-mm-value', isUnavail(fmtMoneyU(repairs)) && 'nx-mm-unavail')}>{fmtMoneyU(repairs)}</strong>
            {repairs > 0 && <div className="nx-mm-bar"><div className={cls('nx-mm-bar__fill', repairs > 50000 ? 'is-red' : 'is-amber')} style={{ width: `${Math.min((repairs / 100000) * 100, 100)}%` }} /></div>}
          </div>
          <div className="nx-medium-metric">
            <span className="nx-mm-label">BEDS / BATHS</span>
            <strong className={cls('nx-mm-value', !beds && !baths && 'nx-mm-unavail')}>{beds > 0 || baths > 0 ? `${beds || '—'} / ${baths || '—'}` : 'Unavailable'}</strong>
          </div>
          <div className="nx-medium-metric">
            <span className="nx-mm-label">SQFT</span>
            <strong className={cls('nx-mm-value', isUnavail(fmtU(sqft || null)) && 'nx-mm-unavail')}>{sqft > 0 ? formatInteger(sqft) : 'Unavailable'}</strong>
          </div>
          <div className="nx-medium-metric">
            <span className="nx-mm-label">YEAR BUILT</span>
            <strong className={cls('nx-mm-value', !yearBuilt && 'nx-mm-unavail')}>{yearBuilt > 0 ? yearBuilt : 'Unavailable'}</strong>
          </div>
          {unitCount > 0 && (
            <div className="nx-medium-metric">
              <span className="nx-mm-label">UNITS</span>
              <strong className="nx-mm-value nx-mm-value--purple">{unitCount}</strong>
            </div>
          )}
        </div>
        {isMultifamily && unitCount > 0 && (
          <div className="nx-medium-unit-economics">
            <div className="nx-medium-ue-header">UNIT ECONOMICS</div>
            <div className="nx-medium-metrics-grid">
              <div className="nx-medium-metric">
                <span className="nx-mm-label">PRICE / UNIT</span>
                <strong className={cls('nx-mm-value', !value && 'nx-mm-unavail')}>{value > 0 ? formatMoney(Math.round(value / unitCount)) : 'Unavailable'}</strong>
              </div>
              <div className="nx-medium-metric">
                <span className="nx-mm-label">AVG BED / UNIT</span>
                <strong className={cls('nx-mm-value', !bedsPerUnit && 'nx-mm-unavail')}>{bedsPerUnit > 0 ? bedsPerUnit.toFixed(1) : 'Unavailable'}</strong>
              </div>
              <div className="nx-medium-metric">
                <span className="nx-mm-label">AVG SQFT / UNIT</span>
                <strong className={cls('nx-mm-value', !avgSqftPerUnit && 'nx-mm-unavail')}>{avgSqftPerUnit > 0 ? formatInteger(avgSqftPerUnit) : 'Unavailable'}</strong>
              </div>
              {repairs > 0 && (
                <div className="nx-medium-metric is-warn">
                  <span className="nx-mm-label">REPAIR / UNIT</span>
                  <strong className="nx-mm-value">{formatMoney(Math.round(repairs / unitCount))}</strong>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── 4. DEAL DECISION & UNDERWRITING ─────────────── */}
      <div className="nx-medium-section">
        <div className="nx-medium-section__title">DEAL DECISION & UNDERWRITING</div>
        {arv > 0 ? (
          <div className="nx-medium-deal-decision">
            <div className="nx-mdd-hero">
              <span className="nx-mm-label">AI RECOMMENDED OFFER</span>
              <strong className="nx-mdd-offer">{formatMoney(offer)}</strong>
              <p className="nx-mdd-range">{formatMoney(Math.round(offer * 0.94))} — {formatMoney(Math.round(offer * 1.03))}</p>
              {/* Confidence arc + signal */}
              <div className="nx-mdd-conf-arc-row">
                <svg viewBox="0 0 56 56" className={cls('nx-mdd-conf-arc', `is-${decisionTone}`)}>
                  <circle cx="28" cy="28" r="22" className="nx-mdd-arc-bg" />
                  <circle
                    cx="28" cy="28" r="22"
                    className="nx-mdd-arc-fill"
                    strokeDasharray={`${2 * Math.PI * 22 * (confidence / 100)} ${2 * Math.PI * 22 * (1 - confidence / 100)}`}
                    strokeDashoffset={2 * Math.PI * 22 * 0.25}
                  />
                </svg>
                <div className="nx-mdd-conf-arc-inner">
                  <strong>{Math.round(confidence)}%</strong>
                  <span>CONF</span>
                </div>
              </div>
              <div className={cls('nx-mdd-signal', `is-${decisionTone}`)}>
                {decisionTone === 'pursue' ? '↑ PURSUE' : decisionTone === 'review' ? '~ REVIEW' : '↓ PASS'}
              </div>
              <span className="nx-mdd-walkaway">
                Walkaway {offer > 0 ? formatMoney(Math.round(offer * 1.06)) : '—'}
              </span>
            </div>
            <div className="nx-mdd-waterfall">
              {waterfallItems.map((item, idx) => {
                const pct = Math.round((item.value / Math.max(arv, 1)) * 100)
                return (
                  <div key={item.label} className={cls('nx-mdd-step', `is-${item.tone}`, idx === waterfallItems.length - 1 && 'is-final')}>
                    <div className="nx-mdd-step__head">
                      <span>{item.label}</span>
                      <div className="nx-mdd-step__right">
                        <span className="nx-mdd-step__pct">{pct}%</span>
                        <strong>{formatMoney(item.value)}</strong>
                      </div>
                    </div>
                    <div className="nx-offer-waterfall__track">
                      <div className="nx-offer-waterfall__fill nx-offer-waterfall__fill--animated" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="nx-medium-pending">
            Underwriting is waiting on valuation. Run comps to activate the offer decision engine.
          </div>
        )}
      </div>

      {/* ── 5. LIVE BUYER INTELLIGENCE ──────────────────── */}
      <div className="nx-medium-section">
        <div className="nx-medium-section__title">
          BUYER INTELLIGENCE
          <span className="nx-medium-live-badge">LIVE</span>
        </div>
        {/* Demand heat bar */}
        <div className="nx-mby-heat-track">
          <div className="nx-mby-heat-track__fill" style={{ width: `${demand}%` }}>
            <span className="nx-mby-heat-track__label">{demand > 0 ? `BUYER DEMAND ${Math.round(demand)}/100` : 'DEMAND DATA PENDING'}</span>
          </div>
        </div>
        {/* Scanning state when buyer data is absent */}
        {demand === 0 && cashBuyerPct === 0 && flipVelocity === 0 && avgResalePrice === 0 && (
          <div className="nx-mby-scanning">
            <div className="nx-mby-scanning__title">Buyer Network Scanning — Dispo Intelligence Syncing</div>
            <div className="nx-mby-scanning__row">
              <div className="nx-mby-scanning__skel w-60" />
              <div className="nx-mby-scanning__skel w-30" />
            </div>
            <div className="nx-mby-scanning__row">
              <div className="nx-mby-scanning__skel w-40" />
              <div className="nx-mby-scanning__skel w-60" />
            </div>
          </div>
        )}
        {/* Market pulse pills — always visible */}
        <div className="nx-mby-market-pulse" style={{ marginBottom: 10 }}>
          {demand >= 70 ? <span className="nx-mby-market-pill is-red">HIGH DEMAND</span> : demand >= 45 ? <span className="nx-mby-market-pill is-amber">MODERATE DEMAND</span> : demand > 0 ? <span className="nx-mby-market-pill is-muted">LOW DEMAND</span> : <span className="nx-mby-market-pill is-muted">DEMAND PENDING</span>}
          {cashBuyerPct >= 60 ? <span className="nx-mby-market-pill is-green">HIGH CASH ACTIVITY</span> : cashBuyerPct >= 30 ? <span className="nx-mby-market-pill is-blue">MIXED BUYERS</span> : cashBuyerPct > 0 ? <span className="nx-mby-market-pill is-muted">LOW CASH ACTIVITY</span> : null}
          {(dispoConfidence || dispositionConfidence) < 40 && (dispoConfidence || dispositionConfidence) > 0 ? <span className="nx-mby-market-pill is-amber">SLOW DISPO</span> : (dispoConfidence || dispositionConfidence) >= 65 ? <span className="nx-mby-market-pill is-green">FAST DISPO</span> : null}
          {nearbyAcquisitions >= 5 ? <span className="nx-mby-market-pill is-purple">ACTIVE INV. ZONE</span> : nearbyAcquisitions > 0 ? <span className="nx-mby-market-pill is-blue">SOME INV. ACTIVITY</span> : null}
          {investorCompetition >= 70 ? <span className="nx-mby-market-pill is-red">HIGH COMPETITION</span> : null}
          {exitLiquidity === 'Low' ? <span className="nx-mby-market-pill is-amber">LOW LIQUIDITY</span> : null}
          {hedgeFundActivity ? <span className="nx-mby-market-pill is-purple">HEDGE FUND ACTIVE</span> : null}
        </div>
        {/* Dispo ring + key stats row */}
        {(() => {
          const dispo = dispoConfidence || dispositionConfidence
          const DISPO_R = 20, DISPO_C = 2 * Math.PI * DISPO_R
          const dispoFill = DISPO_C * (dispo / 100)
          const dispoTone = dispo >= 65 ? 'is-green' : dispo >= 40 ? 'is-amber' : 'is-red'
          return (
            <div className="nx-mby-dispo-row">
              <div className="nx-mby-dispo-ring-wrap">
                <svg viewBox="0 0 48 48" className="nx-mby-dispo-ring-svg">
                  <circle cx="24" cy="24" r={DISPO_R} className="nx-mby-dispo-ring-bg" />
                  <circle cx="24" cy="24" r={DISPO_R} className={cls('nx-mby-dispo-ring-fill', dispo > 0 ? dispoTone : 'is-red')}
                    strokeDasharray={`${dispo > 0 ? dispoFill : 0} ${DISPO_C}`}
                    strokeDashoffset={DISPO_C * 0.25} />
                </svg>
                <div className="nx-mby-dispo-ring-inner">
                  <strong>{dispo > 0 ? `${Math.round(dispo)}%` : '—'}</strong>
                  <span>DISPO</span>
                </div>
              </div>
              <div className="nx-mby-dispo-stats">
                <div className="nx-mby-dispo-stat">
                  <span className="nx-mby-dispo-stat__label">Exit Liquidity</span>
                  <span className={cls('nx-mby-dispo-stat__val', exitLiquidity === 'High' ? 'is-green' : exitLiquidity === 'Moderate' ? 'is-amber' : 'nx-mm-unavail')}>{exitLiquidity || '—'}</span>
                </div>
                <div className="nx-mby-dispo-stat">
                  <span className="nx-mby-dispo-stat__label">Assignment Spread</span>
                  <span className={cls('nx-mby-dispo-stat__val', assignmentSpread > 0 ? 'is-green' : 'nx-mm-unavail')}>{assignmentSpread > 0 ? formatMoney(assignmentSpread) : '—'}</span>
                </div>
                <div className="nx-mby-dispo-stat">
                  <span className="nx-mby-dispo-stat__label">Buyer Match Count</span>
                  <span className={cls('nx-mby-dispo-stat__val', buyerMatchCount > 0 ? '' : 'nx-mm-unavail')}>{buyerMatchCount > 0 ? buyerMatchCount : '—'}</span>
                </div>
              </div>
            </div>
          )
        })()}
        <div className="nx-medium-buyer-grid">
          <div className="nx-medium-buyer-metric">
            <span className="nx-mm-label">DEMAND SCORE</span>
            <strong className={cls('nx-mm-value', !demand && 'nx-mm-unavail')}>{demand > 0 ? `${Math.round(demand)}/100` : 'Unavailable'}</strong>
            {demand > 0 && <div className="nx-mby-demand-bar"><div className={cls('nx-mby-demand-fill', demand >= 70 ? 'is-red' : demand >= 45 ? 'is-amber' : 'is-blue')} style={{ width: `${demand}%` }} /></div>}
          </div>
          <div className="nx-medium-buyer-metric">
            <span className="nx-mm-label">AVG RESALE PRICE</span>
            <strong className={cls('nx-mm-value', !avgResalePrice && 'nx-mm-unavail')}>{avgResalePrice > 0 ? formatMoney(avgResalePrice) : 'Unavailable'}</strong>
          </div>
          <div className="nx-medium-buyer-metric">
            <span className="nx-mm-label">AVG PPSF</span>
            <strong className={cls('nx-mm-value', !avgPpsf && 'nx-mm-unavail')}>{avgPpsf > 0 ? `$${Math.round(avgPpsf)}/sqft` : 'Unavailable'}</strong>
          </div>
          <div className="nx-medium-buyer-metric">
            <span className="nx-mm-label">RECENT SOLD (6mo)</span>
            <strong className={cls('nx-mm-value', !recentSoldCount && 'nx-mm-unavail')}>{recentSoldCount > 0 ? recentSoldCount : 'Unavailable'}</strong>
          </div>
          <div className="nx-medium-buyer-metric">
            <span className="nx-mm-label">NEARBY INV. ACQS</span>
            <strong className={cls('nx-mm-value', !nearbyAcquisitions && 'nx-mm-unavail')}>{nearbyAcquisitions > 0 ? nearbyAcquisitions : 'Unavailable'}</strong>
          </div>
          <div className="nx-medium-buyer-metric">
            <span className="nx-mm-label">CASH BUYER %</span>
            <strong className={cls('nx-mm-value', !cashBuyerPct && 'nx-mm-unavail')}>{cashBuyerPct > 0 ? `${Math.round(cashBuyerPct)}%` : 'Unavailable'}</strong>
            {cashBuyerPct > 0 && <div className="nx-mby-demand-bar"><div className="nx-mby-demand-fill is-green" style={{ width: `${cashBuyerPct}%` }} /></div>}
          </div>
          <div className="nx-medium-buyer-metric">
            <span className="nx-mm-label">FLIP VELOCITY</span>
            <strong className={cls('nx-mm-value', !flipVelocity && 'nx-mm-unavail')}>{flipVelocity > 0 ? `${Math.round(flipVelocity)}/100` : 'Unavailable'}</strong>
            {flipVelocity > 0 && <div className="nx-mby-demand-bar"><div className="nx-mby-demand-fill is-amber" style={{ width: `${flipVelocity}%` }} /></div>}
          </div>
          <div className="nx-medium-buyer-metric">
            <span className="nx-mm-label">BUYER PRESSURE</span>
            <strong className={cls('nx-mm-value', !investorCompetition && 'nx-mm-unavail', investorCompetition >= 70 ? 'nx-mm-value--red' : '')}>{investorCompetition > 0 ? `${investorCompetition}/100` : 'Unavailable'}</strong>
          </div>
          {hedgeFundActivity && (
            <div className="nx-medium-buyer-metric" style={{ gridColumn: 'span 2' }}>
              <span className="nx-mm-label">HEDGE FUND / INSTITUTIONAL</span>
              <strong className="nx-mm-value nx-mm-value--purple">{hedgeFundActivity}</strong>
            </div>
          )}
          {isMultifamily && (
            <div className="nx-medium-buyer-metric">
              <span className="nx-mm-label">AVG PRICE / UNIT</span>
              <strong className={cls('nx-mm-value', !avgPricePerUnit && 'nx-mm-unavail')}>{avgPricePerUnit > 0 ? formatMoney(avgPricePerUnit) : 'Unavailable'}</strong>
            </div>
          )}
          {marketAbsorption > 0 && (
            <div className="nx-medium-buyer-metric">
              <span className="nx-mm-label">ABSORPTION</span>
              <strong className="nx-mm-value">{marketAbsorption}<span style={{ fontSize: '10px', opacity: 0.55 }}>d</span></strong>
            </div>
          )}
        </div>
        {/* Tactical signal chips */}
        <div className="nx-mby-tactical-chips">
          {demand >= 70 && <span className="nx-mby-tactical-chip is-red">STRONG DEMAND</span>}
          {demand > 0 && demand < 40 && <span className="nx-mby-tactical-chip is-amber">LOW DEMAND</span>}
          {cashBuyerPct >= 60 && <span className="nx-mby-tactical-chip is-green">CASH HEAVY MARKET</span>}
          {flipVelocity >= 70 && <span className="nx-mby-tactical-chip is-amber">HIGH FLIP VELOCITY</span>}
          {exitLiquidity === 'Low' && <span className="nx-mby-tactical-chip is-amber">LOW LIQUIDITY</span>}
          {exitLiquidity === 'High' && <span className="nx-mby-tactical-chip is-green">HIGH LIQUIDITY</span>}
          {hedgeFundActivity && <span className="nx-mby-tactical-chip is-purple">HEDGE FUND ACTIVE</span>}
          {investorCompetition >= 70 && <span className="nx-mby-tactical-chip is-red">HIGH COMPETITION</span>}
          {(dispoConfidence || dispositionConfidence) < 40 && (dispoConfidence || dispositionConfidence) > 0 && <span className="nx-mby-tactical-chip is-amber">SLOW DISPO</span>}
          {buyerChips.map((chip) => (
            <span key={chip.label} className={cls('nx-mby-tactical-chip', `is-${chip.tone}`)}>{chip.label}</span>
          ))}
          {demand === 0 && cashBuyerPct === 0 && flipVelocity === 0 && <span className="nx-mby-tactical-chip is-muted">BUYER DATA PENDING</span>}
        </div>
      </div>

      {/* ── PROPERTY INTELLIGENCE ────────────────────────── */}
      <div className="nx-medium-section">
        <div className="nx-medium-section__title">
          PROPERTY INTELLIGENCE
          {distressCount > 0 && <span className="nx-medium-live-badge" style={{ background: 'rgba(255,69,58,0.18)', color: '#ff453a' }}>{distressCount} DISTRESS</span>}
        </div>
        <div className="nx-mpia">

          {/* PROPERTY CORE */}
          <div className={cls('nx-mpia-section', openPropIntel.has('core') && 'is-open')}>
            <button type="button" className="nx-mpia-hdr" onClick={() => togglePropIntel('core')}>
              <span className="nx-mpia-hdr__label">PROPERTY CORE</span>
              {propQualityBadge && <span className={cls('nx-mpia-hdr__badge', `is-${propQualityTone}`)}>{propQualityBadge}</span>}
              <span className="nx-mpia-hdr__arrow">{openPropIntel.has('core') ? '▲' : '▼'}</span>
            </button>
            <div className="nx-mpia-body">
              <div className="nx-pi-core-grid">
                <div className="nx-pi-core-card">
                  <span className="nx-pi-core-card__val">{beds > 0 ? beds : <span className="nx-pi-core-card__val nx-unavail">—</span>}</span>
                  <span className="nx-pi-core-card__label">Beds</span>
                </div>
                <div className="nx-pi-core-card">
                  <span className="nx-pi-core-card__val">{baths > 0 ? baths : <span className="nx-pi-core-card__val nx-unavail">—</span>}</span>
                  <span className="nx-pi-core-card__label">Baths</span>
                </div>
                <div className="nx-pi-core-card">
                  <span className="nx-pi-core-card__val">{sqft > 0 ? formatInteger(sqft) : <span className="nx-pi-core-card__val nx-unavail">—</span>}</span>
                  <span className="nx-pi-core-card__label">Sq Ft</span>
                </div>
                <div className="nx-pi-core-card">
                  <span className="nx-pi-core-card__val">{yearBuilt > 0 ? yearBuilt : <span className="nx-pi-core-card__val nx-unavail">—</span>}</span>
                  <span className="nx-pi-core-card__label">Built</span>
                </div>
                <div className="nx-pi-core-card">
                  <span className="nx-pi-core-card__val">{lotSize > 0 ? formatInteger(lotSize) : lotAcreage > 0 ? `${lotAcreage.toFixed(2)}ac` : <span className="nx-pi-core-card__val nx-unavail">—</span>}</span>
                  <span className="nx-pi-core-card__label">Lot</span>
                </div>
                <div className="nx-pi-core-card">
                  <span className={cls('nx-pi-core-card__val', unitCount > 1 ? 'is-purple' : '')}>{unitCount > 0 ? unitCount : buildings > 1 ? `${buildings} bldg` : <span className="nx-pi-core-card__val nx-unavail">—</span>}</span>
                  <span className="nx-pi-core-card__label">Units</span>
                </div>
              </div>
              <div className="nx-pi-meta-chips">
                <div className={cls('nx-pi-meta-chip', propType ? '' : 'is-muted')}><span className="label">TYPE</span>{propType ? propType.toUpperCase() : '—'}</div>
                <div className={cls('nx-pi-meta-chip', propClass ? '' : 'is-muted')}><span className="label">CLASS</span>{propClass || '—'}</div>
                <div className={cls('nx-pi-meta-chip', zoning ? '' : 'is-muted')}><span className="label">ZONE</span>{zoning || '—'}</div>
                {lotAcreage > 0 && <div className="nx-pi-meta-chip"><span className="label">ACRES</span>{lotAcreage.toFixed(2)}</div>}
                {floodZone && <div className={cls('nx-pi-meta-chip', /[bcd]/i.test(floodZone) ? 'is-warn' : '')}><span className="label">FLOOD</span>{floodZone}</div>}
              </div>
            </div>
          </div>

          {/* CONSTRUCTION / SYSTEMS */}
          <div className={cls('nx-mpia-section', openPropIntel.has('systems') && 'is-open')}>
            <button type="button" className="nx-mpia-hdr" onClick={() => togglePropIntel('systems')}>
              <span className="nx-mpia-hdr__label">CONSTRUCTION / SYSTEMS</span>
              <span className="nx-mpia-hdr__count">{[constructionType, buildingQuality, roofCover, floorCover, heating, cooling, garageType, sewerType, waterSource].filter(Boolean).length} populated</span>
              <span className="nx-mpia-hdr__arrow">{openPropIntel.has('systems') ? '▲' : '▼'}</span>
            </button>
            <div className="nx-mpia-body">
              <div className="nx-pi-sys-chips">
                {([
                  { key: 'FRAME', val: constructionType },
                  { key: 'QUALITY', val: buildingQuality, tone: buildingQuality ? `nx-pi-qual-${propQualityTone}` : '' },
                  { key: 'ROOF', val: roofCover },
                  { key: 'FLOORS', val: floorCover },
                  { key: 'HEAT', val: heating },
                  { key: 'AC', val: cooling },
                  { key: 'GARAGE', val: garageType },
                  { key: 'POOL', val: hasPool ? 'Yes' : null, ok: true },
                  { key: 'SEWER', val: sewerType },
                  { key: 'WATER', val: waterSource },
                ] as { key: string; val: string | null; tone?: string; ok?: boolean }[]).map(({ key, val, tone, ok }) => (
                  <div key={key} className={cls('nx-pi-sys-badge', val ? 'has-val' : 'is-unavail')}>
                    <span className="nx-pi-sys-badge__key">{key}</span>
                    <span className={cls('nx-pi-sys-badge__val', tone || (ok && val ? 'is-ok' : val ? '' : 'nx-mm-unavail'))}>{val || '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* TAX / ASSESSMENT */}
          <div className={cls('nx-mpia-section', openPropIntel.has('tax') && 'is-open')}>
            <button type="button" className="nx-mpia-hdr" onClick={() => togglePropIntel('tax')}>
              <span className="nx-mpia-hdr__label">TAX / ASSESSMENT</span>
              {isTaxDelinquent && <span className="nx-mpia-hdr__badge is-red">DELINQUENT</span>}
              <span className="nx-mpia-hdr__arrow">{openPropIntel.has('tax') ? '▲' : '▼'}</span>
            </button>
            <div className="nx-mpia-body">
              {isTaxDelinquent && (
                <div className="nx-pi-delinquent-banner">
                  <div className="nx-pi-delinquent-banner__dot" />
                  <span className="nx-pi-delinquent-banner__text">TAX DELINQUENT{taxDelinquentYear ? ` SINCE ${taxDelinquentYear}` : ''}</span>
                  {pastDueAmount > 0 && <span className="nx-pi-delinquent-banner__sub">{formatMoney(pastDueAmount)} PAST DUE</span>}
                </div>
              )}
              {assessedLand > 0 && assessedImprovement > 0 && (() => {
                const total = assessedLand + assessedImprovement
                const landPct = Math.round((assessedLand / total) * 100)
                const imprPct = 100 - landPct
                return (
                  <div className="nx-pi-assess-split">
                    <div className="nx-pi-assess-split__label">Land vs Improvement</div>
                    <div className="nx-pi-assess-bar">
                      <div className="nx-pi-assess-bar__land" style={{ width: `${landPct}%` }} />
                      <div className="nx-pi-assess-bar__impr" style={{ width: `${imprPct}%` }} />
                    </div>
                    <div className="nx-pi-assess-legend">
                      <span className="is-land">Land {landPct}% · {formatMoney(assessedLand)}</span>
                      <span className="is-impr">Impr {imprPct}% · {formatMoney(assessedImprovement)}</span>
                    </div>
                  </div>
                )
              })()}
              <div className="nx-medium-prow-list">
                <div className="nx-medium-prow"><span>Annual Tax</span><strong className={cls(!taxAmount && 'nx-unavail')}>{taxAmount > 0 ? formatMoney(taxAmount) : 'Unavailable'}</strong></div>
                <div className="nx-medium-prow"><span>Assessed Total</span><strong className={cls(!assessedTotal && 'nx-unavail')}>{assessedTotal > 0 ? formatMoney(assessedTotal) : 'Unavailable'}</strong></div>
                {value > 0 && assessedTotal > 0 && (
                  <div className="nx-medium-prow"><span>Assessed Ratio</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <strong>{Math.round((assessedTotal / value) * 100)}%</strong>
                      <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>of est. value</span>
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* FINANCING & LIENS */}
          <div className={cls('nx-mpia-section', openPropIntel.has('liens') && 'is-open')}>
            <button type="button" className="nx-mpia-hdr" onClick={() => togglePropIntel('liens')}>
              <span className="nx-mpia-hdr__label">FINANCING / LOANS</span>
              {isFreeClear && <span className="nx-mpia-hdr__badge is-green">FREE & CLEAR</span>}
              <span className="nx-mpia-hdr__arrow">{openPropIntel.has('liens') ? '▲' : '▼'}</span>
            </button>
            <div className="nx-mpia-body">
              {isFreeClear && (
                <div className="nx-pi-fc-badge">✓ FREE &amp; CLEAR — No Outstanding Liens</div>
              )}
              {loanAmount > 0 && value > 0 && (() => {
                const ltv = Math.round((loanBalance || loanAmount) / value * 100)
                const tone = ltv > 80 ? 'is-danger' : ltv > 60 ? 'is-warn' : 'is-safe'
                return (
                  <div className="nx-pi-ltv-meter">
                    <div className="nx-pi-ltv-meter__label"><span>LOAN-TO-VALUE</span><span>{ltv}%</span></div>
                    <div className="nx-pi-ltv-track">
                      <div className={cls('nx-pi-ltv-fill', tone)} style={{ width: `${Math.min(ltv, 100)}%` }} />
                    </div>
                  </div>
                )
              })()}
              <div className="nx-medium-prow-list" style={{ marginTop: 8 }}>
                <div className="nx-medium-prow"><span>Loan Amount</span>{loanAmount > 0 ? <strong>{formatMoney(loanAmount)}</strong> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                <div className="nx-medium-prow"><span>Est. Balance</span>{loanBalance > 0 ? <strong className="nx-mpia-warn">{formatMoney(loanBalance)}</strong> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                <div className="nx-medium-prow"><span>Monthly Payment</span>{estimatedPayment > 0 ? <strong>{formatMoney(estimatedPayment)}/mo</strong> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                <div className="nx-medium-prow"><span>Equity Amount</span>{equityAmt > 0 ? <strong className="nx-mpia-ok">{formatMoney(equityAmt)}</strong> : value > 0 && equity > 0 ? <strong className="nx-mpia-ok">{formatMoney(Math.round(value * equity / 100))}</strong> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                <div className="nx-medium-prow"><span>Equity %</span>{equity > 0 ? <strong className="nx-mpia-ok">{Math.round(equity)}%</strong> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                {estimatedCashFlow !== 0 && <div className="nx-medium-prow"><span>Est. Cash Flow</span><strong className={estimatedCashFlow > 0 ? 'nx-mpia-ok' : 'nx-mpia-warn'}>{formatMoney(estimatedCashFlow)}/mo</strong></div>}
              </div>
            </div>
          </div>

          {/* SALE HISTORY */}
          <div className={cls('nx-mpia-section', openPropIntel.has('history') && 'is-open')}>
            <button type="button" className="nx-mpia-hdr" onClick={() => togglePropIntel('history')}>
              <span className="nx-mpia-hdr__label">SALE HISTORY</span>
              {appreciationPct > 0 && <span className="nx-mpia-hdr__badge is-green">+{Math.round(appreciationPct)}% APPREC</span>}
              <span className="nx-mpia-hdr__arrow">{openPropIntel.has('history') ? '▲' : '▼'}</span>
            </button>
            <div className="nx-mpia-body">
              {(lastSaleDate || lastSalePrice > 0 || value > 0) ? (
                <div className="nx-pi-sale-timeline">
                  {(lastSaleDate || lastSalePrice > 0) && (
                    <div className="nx-pi-sale-event">
                      <div className="nx-pi-sale-event__year">{lastSaleDate || 'PRIOR SALE'}</div>
                      <div className="nx-pi-sale-event__val">{lastSalePrice > 0 ? formatMoney(lastSalePrice) : <span className="nx-mm-unavail">Price Unavailable</span>}</div>
                      {ownerYears > 0 && <div className="nx-pi-sale-event__sub">Owned {ownerYears}+ years</div>}
                    </div>
                  )}
                  {value > 0 && (
                    <div className="nx-pi-sale-event is-current">
                      <div className="nx-pi-sale-event__year">2025 EST. VALUE</div>
                      <div className="nx-pi-sale-event__val is-green">{formatMoney(value)}</div>
                      {equityGain > 0 && <div className="nx-pi-sale-event__sub">+{formatMoney(equityGain)} gained</div>}
                    </div>
                  )}
                  {(appreciationPct > 0 || (lastSalePrice > 0 && equityGain > 0)) && (
                    <div className="nx-pi-apprec-badge">
                      ↑ +{appreciationPct > 0 ? Math.round(appreciationPct) : Math.round((equityGain / lastSalePrice) * 100)}% APPRECIATION
                    </div>
                  )}
                </div>
              ) : (
                <div className="nx-medium-prow-list">
                  <div className="nx-medium-prow"><span>Sale History</span><span className="nx-mm-unavail">Unavailable</span></div>
                  {ownerYears > 0 && <div className="nx-medium-prow"><span>Ownership Years</span><strong>{ownerYears}+ yrs</strong></div>}
                </div>
              )}
            </div>
          </div>

          {/* CONDITION & REHAB */}
          <div className={cls('nx-mpia-section', openPropIntel.has('rehab') && 'is-open')}>
            <button type="button" className="nx-mpia-hdr" onClick={() => togglePropIntel('rehab')}>
              <span className="nx-mpia-hdr__label">CONDITION / REHAB</span>
              <span className={cls('nx-mpia-hdr__badge', `is-${rehabRiskTone}`)}>{flipSuitability}</span>
              <span className="nx-mpia-hdr__arrow">{openPropIntel.has('rehab') ? '▲' : '▼'}</span>
            </button>
            <div className="nx-mpia-body">
              {(() => {
                const sevTone = rehabScore >= 75 ? 'is-red' : rehabScore >= 55 ? 'is-orange' : rehabScore >= 35 ? 'is-amber' : 'is-green'
                const sevLabel = rehabScore >= 75 ? 'HEAVY REHAB' : rehabScore >= 55 ? 'SUBSTANTIAL' : rehabScore >= 35 ? 'MODERATE' : 'COSMETIC'
                return (
                  <div className="nx-pi-rehab-severity">
                    <div className="nx-pi-rehab-severity__header">
                      <span className="nx-pi-rehab-severity__title">REHAB SEVERITY</span>
                      <span className={cls('nx-pi-rehab-severity__chip', sevTone)}>{sevLabel}</span>
                    </div>
                    <div className="nx-pi-rehab-track">
                      <div className={cls('nx-pi-rehab-fill', sevTone)} style={{ width: `${rehabScore}%` }} />
                    </div>
                    <div className="nx-pi-rehab-ticks">
                      <span>COSMETIC</span><span>MODERATE</span><span>SUBSTANTIAL</span><span>FULL</span>
                    </div>
                    <div className="nx-pi-rehab-risk-badges">
                      <span className={cls('nx-pi-rehab-risk-badge', flipSuitability === 'Flip Ready' ? 'is-green' : flipSuitability === 'Moderate Work' ? 'is-amber' : 'is-red')}>{flipSuitability}</span>
                      {condition && <span className={cls('nx-pi-rehab-risk-badge', conditionTone === 'green' ? 'is-green' : conditionTone === 'amber' ? 'is-amber' : conditionTone === 'red' ? 'is-red' : 'is-muted')}>{condition}</span>}
                      {rehabLevel && <span className={cls('nx-pi-rehab-risk-badge', rehabRiskTone === 'green' ? 'is-green' : rehabRiskTone === 'red' ? 'is-red' : 'is-amber')}>{rehabLevel}</span>}
                      {structuralRisk && <span className={cls('nx-pi-rehab-risk-badge', /high|major/i.test(structuralRisk) ? 'is-red' : 'is-amber')}>STRUCTURAL: {structuralRisk.toUpperCase()}</span>}
                    </div>
                  </div>
                )
              })()}
              <div className="nx-medium-prow-list">
                <div className="nx-medium-prow"><span>Repair Estimate</span>{repairs > 0 ? <strong className="nx-mpia-warn">{formatMoney(repairs)}</strong> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                <div className="nx-medium-prow"><span>Deferred Maintenance</span>{deferredMaint ? <strong>{deferredMaint}</strong> : <span className="nx-mm-unavail">Unavailable</span>}</div>
              </div>
            </div>
          </div>

          {/* PROPERTY TAGS */}
          <div className={cls('nx-mpia-section', openPropIntel.has('tags') && 'is-open')}>
            <button type="button" className="nx-mpia-hdr" onClick={() => togglePropIntel('tags')}>
              <span className="nx-mpia-hdr__label">PROPERTY TAGS</span>
              <span className="nx-mpia-hdr__count">{propTagChips.length} tags</span>
              <span className="nx-mpia-hdr__arrow">{openPropIntel.has('tags') ? '▲' : '▼'}</span>
            </button>
            <div className="nx-mpia-body">
              {propTagChips.length > 0 ? (
                <div className="nx-pi-tag-cloud">
                  {propTagChips.map((tag, i) => (
                    <span key={i} className={cls('nx-pi-tag', `is-${tag.tone}`)}>{tag.label}</span>
                  ))}
                </div>
              ) : (
                <div className="nx-medium-prow-list"><div className="nx-medium-prow"><span>Tags</span><span className="nx-mm-unavail">No tags available</span></div></div>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* ── CENSUS INTELLIGENCE ──────────────────────────────── */}
      <div className="nx-medium-section">
        <div className="nx-medium-section__title">
          CENSUS INTELLIGENCE
          {neighborhoodScore > 0 && <span className="nx-medium-live-badge" style={{ background: 'rgba(10,132,255,0.15)', color: '#0a84ff' }}>SCORE {Math.round(neighborhoodScore)}</span>}
        </div>
        <div className="nx-mpia">

          {/* DEMOGRAPHICS */}
          <div className={cls('nx-mpia-section', openCensus.has('demo') && 'is-open')}>
            <button type="button" className="nx-mpia-hdr" onClick={() => toggleCensus('demo')}>
              <span className="nx-mpia-hdr__label">DEMOGRAPHICS</span>
              {populationGrowth > 0 && <span className="nx-mpia-hdr__badge is-green">+{populationGrowth.toFixed(1)}% GROWTH</span>}
              {populationGrowth < 0 && <span className="nx-mpia-hdr__badge is-red">{populationGrowth.toFixed(1)}% DECLINE</span>}
              <span className="nx-mpia-hdr__arrow">{openCensus.has('demo') ? '▲' : '▼'}</span>
            </button>
            <div className="nx-mpia-body">
              <div className="nx-pi-stat-grid">
                <div className="nx-pi-stat"><span className="nx-pi-stat__label">POPULATION</span>{censusPopulation > 0 ? <strong className="nx-pi-stat__value">{censusPopulation.toLocaleString()}</strong> : <span className="nx-pi-stat__value nx-mm-unavail">—</span>}</div>
                <div className="nx-pi-stat"><span className="nx-pi-stat__label">MED INCOME</span>{censusMedianIncome > 0 ? <strong className="nx-pi-stat__value is-green">{formatMoney(censusMedianIncome)}</strong> : <span className="nx-pi-stat__value nx-mm-unavail">—</span>}</div>
                <div className="nx-pi-stat"><span className="nx-pi-stat__label">MED AGE</span>{censusMedianAge > 0 ? <strong className="nx-pi-stat__value">{Math.round(censusMedianAge)}</strong> : <span className="nx-pi-stat__value nx-mm-unavail">—</span>}</div>
                <div className="nx-pi-stat"><span className="nx-pi-stat__label">HH SIZE</span>{censusHouseholdSize > 0 ? <strong className="nx-pi-stat__value">{censusHouseholdSize.toFixed(1)}</strong> : <span className="nx-pi-stat__value nx-mm-unavail">—</span>}</div>
                <div className="nx-pi-stat"><span className="nx-pi-stat__label">OWNER OCC</span>{ownerOccupancyRate > 0 ? <strong className="nx-pi-stat__value is-blue">{Math.round(ownerOccupancyRate)}%</strong> : <span className="nx-pi-stat__value nx-mm-unavail">—</span>}</div>
                <div className="nx-pi-stat"><span className="nx-pi-stat__label">RENTAL</span>{rentalRate > 0 ? <strong className="nx-pi-stat__value is-amber">{Math.round(rentalRate)}%</strong> : <span className="nx-pi-stat__value nx-mm-unavail">—</span>}</div>
                <div className="nx-pi-stat"><span className="nx-pi-stat__label">VACANCY</span>{vacancyRate > 0 ? <strong className={cls('nx-pi-stat__value', vacancyRate > 10 ? 'is-red' : '')}>{Math.round(vacancyRate)}%</strong> : <span className="nx-pi-stat__value nx-mm-unavail">—</span>}</div>
              </div>
              {ownerOccupancyRate > 0 && rentalRate > 0 && (
                <div className="nx-pi-stacked-bar-wrap" style={{ marginTop: 10 }}>
                  <span className="nx-pi-bar__label">Occupancy Mix</span>
                  <div className="nx-pi-stacked-bar">
                    <div className="nx-pi-stacked-bar__seg is-blue" style={{ width: `${ownerOccupancyRate}%` }} />
                    <div className="nx-pi-stacked-bar__seg is-amber" style={{ width: `${rentalRate}%` }} />
                    {vacancyRate > 0 && <div className="nx-pi-stacked-bar__seg is-red" style={{ width: `${vacancyRate}%` }} />}
                  </div>
                  <div className="nx-pi-stacked-bar__legend">
                    <span className="is-blue">Owner {Math.round(ownerOccupancyRate)}%</span>
                    <span className="is-amber">Rental {Math.round(rentalRate)}%</span>
                    {vacancyRate > 0 && <span className="is-red">Vacant {Math.round(vacancyRate)}%</span>}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* MARKET HEALTH */}
          <div className={cls('nx-mpia-section', openCensus.has('health') && 'is-open')}>
            <button type="button" className="nx-mpia-hdr" onClick={() => toggleCensus('health')}>
              <span className="nx-mpia-hdr__label">MARKET HEALTH</span>
              {neighborhoodScore >= 70 && <span className="nx-mpia-hdr__badge is-green">STRONG</span>}
              {neighborhoodScore > 0 && neighborhoodScore < 40 && <span className="nx-mpia-hdr__badge is-red">WEAK</span>}
              <span className="nx-mpia-hdr__arrow">{openCensus.has('health') ? '▲' : '▼'}</span>
            </button>
            <div className="nx-mpia-body">
              <div className="nx-pi-bars">
                {schoolRating > 0 && (
                  <div className="nx-pi-bar-row">
                    <span className="nx-pi-bar__label">School Rating</span>
                    <div className="nx-pi-bar"><div className={cls('nx-pi-bar__fill', schoolRating >= 7 ? 'is-green' : schoolRating >= 5 ? 'is-amber' : 'is-red')} style={{ width: `${schoolRating * 10}%` }} /></div>
                    <span className="nx-pi-bar__val">{schoolRating}/10</span>
                  </div>
                )}
                {crimeIndex > 0 && (
                  <div className="nx-pi-bar-row">
                    <span className="nx-pi-bar__label">Crime Index</span>
                    <div className="nx-pi-bar"><div className={cls('nx-pi-bar__fill', crimeIndex >= 70 ? 'is-red' : crimeIndex >= 40 ? 'is-amber' : 'is-green')} style={{ width: `${crimeIndex}%` }} /></div>
                    <span className="nx-pi-bar__val">{crimeIndex}</span>
                  </div>
                )}
                {employmentStrength > 0 && (
                  <div className="nx-pi-bar-row">
                    <span className="nx-pi-bar__label">Employment</span>
                    <div className="nx-pi-bar"><div className={cls('nx-pi-bar__fill', employmentStrength >= 70 ? 'is-green' : employmentStrength >= 40 ? 'is-amber' : 'is-red')} style={{ width: `${employmentStrength}%` }} /></div>
                    <span className="nx-pi-bar__val">{employmentStrength}</span>
                  </div>
                )}
                {investorActivity > 0 && (
                  <div className="nx-pi-bar-row">
                    <span className="nx-pi-bar__label">Investor Activity</span>
                    <div className="nx-pi-bar"><div className="nx-pi-bar__fill is-purple" style={{ width: `${investorActivity}%` }} /></div>
                    <span className="nx-pi-bar__val">{investorActivity}</span>
                  </div>
                )}
                {growthMomentum > 0 && (
                  <div className="nx-pi-bar-row">
                    <span className="nx-pi-bar__label">Growth Momentum</span>
                    <div className="nx-pi-bar"><div className={cls('nx-pi-bar__fill', growthMomentum >= 70 ? 'is-green' : growthMomentum >= 40 ? 'is-amber' : 'is-blue')} style={{ width: `${growthMomentum}%` }} /></div>
                    <span className="nx-pi-bar__val">{growthMomentum}</span>
                  </div>
                )}
              </div>
              <div className="nx-medium-prow-list" style={{ marginTop: 10 }}>
                {migrationTrend && <div className="nx-medium-prow"><span>Migration</span><strong className={/inflow|positive|growing/i.test(migrationTrend) ? 'nx-mpia-ok' : /outflow|negative|declining/i.test(migrationTrend) ? 'nx-mpia-warn' : ''}>{migrationTrend}</strong></div>}
                {economicTrend && <div className="nx-medium-prow"><span>Economic Trend</span><strong className={/grow|improve|positive/i.test(economicTrend) ? 'nx-mpia-ok' : /decline|contract|negative/i.test(economicTrend) ? 'nx-mpia-warn' : ''}>{economicTrend}</strong></div>}
                {neighborhoodScore > 0 && <div className="nx-medium-prow"><span>Neighborhood Score</span><span className={cls('nx-mp-score', neighborhoodScore >= 70 ? 'is-green' : neighborhoodScore >= 45 ? 'is-amber' : 'is-danger')}>{Math.round(neighborhoodScore)}/100</span></div>}
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* ── OWNER PORTFOLIO INTELLIGENCE ─────────────────────── */}
      <div className="nx-medium-section">
        <div className="nx-medium-section__title">
          OWNER PORTFOLIO INTELLIGENCE
          <span className={cls('nx-medium-live-badge', `nx-pi-badge--${investorLabel.tone}`)}>{investorLabel.label.toUpperCase()}</span>
        </div>
        <div className="nx-mpia">

          {/* PORTFOLIO OVERVIEW */}
          <div className={cls('nx-mpia-section', openPortfolio.has('overview') && 'is-open')}>
            <button type="button" className="nx-mpia-hdr" onClick={() => togglePortfolio('overview')}>
              <span className="nx-mpia-hdr__label">PORTFOLIO OVERVIEW</span>
              {portfolioCount > 0 && <span className="nx-mpia-hdr__count">{portfolioCount} {portfolioCount === 1 ? 'property' : 'properties'}</span>}
              <span className="nx-mpia-hdr__arrow">{openPortfolio.has('overview') ? '▲' : '▼'}</span>
            </button>
            <div className="nx-mpia-body">
              <div className="nx-pi-stat-grid">
                {portfolioCount > 0 && <div className="nx-pi-stat"><span className="nx-pi-stat__label">PROPS</span><strong className="nx-pi-stat__value">{portfolioCount}</strong></div>}
                {portfolioUnits > 0 && <div className="nx-pi-stat"><span className="nx-pi-stat__label">UNITS</span><strong className="nx-pi-stat__value is-purple">{portfolioUnits}</strong></div>}
                {portfolioValue > 0 && <div className="nx-pi-stat"><span className="nx-pi-stat__label">TOTAL VALUE</span><strong className="nx-pi-stat__value is-green">{formatMoney(portfolioValue)}</strong></div>}
                {portfolioEquity > 0 && <div className="nx-pi-stat"><span className="nx-pi-stat__label">EQUITY</span><strong className="nx-pi-stat__value is-blue">{formatMoney(portfolioEquity)}</strong></div>}
                {portfolioDebt > 0 && <div className="nx-pi-stat"><span className="nx-pi-stat__label">TOTAL DEBT</span><strong className="nx-pi-stat__value is-red">{formatMoney(portfolioDebt)}</strong></div>}
                {portfolioMonthlyDebt > 0 && <div className="nx-pi-stat"><span className="nx-pi-stat__label">MO DEBT SVC</span><strong className="nx-pi-stat__value is-amber">{formatMoney(portfolioMonthlyDebt)}</strong></div>}
              </div>
              <div className="nx-medium-prow-list" style={{ marginTop: 10 }}>
                {portfolioTypeMajority && <div className="nx-medium-prow"><span>Primary Type</span><strong>{portfolioTypeMajority.toUpperCase()}</strong></div>}
                {portfolioMarkets && <div className="nx-medium-prow"><span>Markets</span><strong>{portfolioMarkets}</strong></div>}
                {acquisitionVelocity > 0 && <div className="nx-medium-prow"><span>Acq. Velocity</span><strong>{acquisitionVelocity}/yr</strong></div>}
                {portfolioGrowthTrend && <div className="nx-medium-prow"><span>Growth Trend</span><strong className={/grow|expand|positive/i.test(portfolioGrowthTrend) ? 'nx-mpia-ok' : /shrink|decline|negative/i.test(portfolioGrowthTrend) ? 'nx-mpia-warn' : ''}>{portfolioGrowthTrend}</strong></div>}
              </div>
              <div className="nx-medium-signal-chips" style={{ marginTop: 8 }}>
                <span className={cls('nx-medium-signal-chip', `is-${investorLabel.tone}`)}>{investorLabel.label.toUpperCase()}</span>
                {distressExposure >= 50 && <span className="nx-medium-signal-chip is-red">HIGH DISTRESS EXPOSURE</span>}
                {sophisticationScore >= 70 && <span className="nx-medium-signal-chip is-purple">SOPHISTICATED INVESTOR</span>}
                {portfolioCount >= 10 && <span className="nx-medium-signal-chip is-blue">MULTI-PROPERTY OPERATOR</span>}
              </div>
            </div>
          </div>

          {/* INVESTOR PROFILE */}
          <div className={cls('nx-mpia-section', openPortfolio.has('profile') && 'is-open')}>
            <button type="button" className="nx-mpia-hdr" onClick={() => togglePortfolio('profile')}>
              <span className="nx-mpia-hdr__label">INVESTOR PROFILE</span>
              {sophisticationScore > 0 && <span className={cls('nx-mpia-hdr__badge', sophisticationScore >= 70 ? 'is-purple' : sophisticationScore >= 40 ? 'is-blue' : 'is-amber')}>IQ {Math.round(sophisticationScore)}</span>}
              <span className="nx-mpia-hdr__arrow">{openPortfolio.has('profile') ? '▲' : '▼'}</span>
            </button>
            <div className="nx-mpia-body">
              <div className="nx-pi-bars">
                {sophisticationScore > 0 && (
                  <div className="nx-pi-bar-row">
                    <span className="nx-pi-bar__label">Sophistication IQ</span>
                    <div className="nx-pi-bar"><div className={cls('nx-pi-bar__fill', sophisticationScore >= 70 ? 'is-purple' : 'is-blue')} style={{ width: `${sophisticationScore}%` }} /></div>
                    <span className="nx-pi-bar__val">{Math.round(sophisticationScore)}</span>
                  </div>
                )}
                {distressExposure > 0 && (
                  <div className="nx-pi-bar-row">
                    <span className="nx-pi-bar__label">Distress Exposure</span>
                    <div className="nx-pi-bar"><div className={cls('nx-pi-bar__fill', distressExposure >= 60 ? 'is-red' : 'is-amber')} style={{ width: `${distressExposure}%` }} /></div>
                    <span className="nx-pi-bar__val">{Math.round(distressExposure)}%</span>
                  </div>
                )}
              </div>
              <div className="nx-medium-prow-list" style={{ marginTop: 10 }}>
                {portfolioCount > 0 && portfolioValue > 0 && <div className="nx-medium-prow"><span>Avg Property Value</span><strong>{formatMoney(Math.round(portfolioValue / portfolioCount))}</strong></div>}
                {portfolioValue > 0 && portfolioDebt > 0 && <div className="nx-medium-prow"><span>Portfolio LTV</span><strong className={portfolioDebt / portfolioValue > 0.8 ? 'nx-mpia-warn' : 'nx-mpia-ok'}>{Math.round((portfolioDebt / portfolioValue) * 100)}%</strong></div>}
                {acquisitionVelocity > 0 && <div className="nx-medium-prow"><span>Annual Acquisitions</span><strong>{acquisitionVelocity}</strong></div>}
              </div>
              {/* Debt vs Equity visual */}
              {portfolioValue > 0 && (portfolioEquity > 0 || portfolioDebt > 0) && (() => {
                const eqPct = portfolioValue > 0 ? Math.round((portfolioEquity / portfolioValue) * 100) : 0
                const dbtPct = portfolioValue > 0 ? Math.round((portfolioDebt / portfolioValue) * 100) : 0
                return (
                  <div className="nx-pi-stacked-bar-wrap" style={{ marginTop: 10 }}>
                    <span className="nx-pi-bar__label">Equity vs Debt</span>
                    <div className="nx-pi-stacked-bar">
                      {eqPct > 0 && <div className="nx-pi-stacked-bar__seg is-blue" style={{ width: `${eqPct}%` }} />}
                      {dbtPct > 0 && <div className="nx-pi-stacked-bar__seg is-red" style={{ width: `${Math.min(dbtPct, 100 - eqPct)}%` }} />}
                    </div>
                    <div className="nx-pi-stacked-bar__legend">
                      {eqPct > 0 && <span className="is-blue">Equity {eqPct}%</span>}
                      {dbtPct > 0 && <span className="is-red">Debt {dbtPct}%</span>}
                    </div>
                  </div>
                )
              })()}
              {/* Burnout / overleveraged signals */}
              {(landlordBurnout || overleveraged) && (
                <div className="nx-medium-signal-chips" style={{ marginTop: 8 }}>
                  {landlordBurnout && <span className="nx-medium-signal-chip is-amber">BURNT-OUT LANDLORD SIGNAL</span>}
                  {overleveraged && <span className="nx-medium-signal-chip is-red">OVERLEVERAGED (&gt;85% LTV)</span>}
                </div>
              )}
            </div>
          </div>

          {/* PORTFOLIO TAGS */}
          {portfolioTagChips.length > 0 && (
            <div className={cls('nx-mpia-section', openPortfolio.has('portags') && 'is-open')}>
              <button type="button" className="nx-mpia-hdr" onClick={() => togglePortfolio('portags')}>
                <span className="nx-mpia-hdr__label">PORTFOLIO SIGNALS</span>
                <span className="nx-mpia-hdr__count">{portfolioTagChips.length} signals</span>
                <span className="nx-mpia-hdr__arrow">{openPortfolio.has('portags') ? '▲' : '▼'}</span>
              </button>
              <div className="nx-mpia-body">
                <div className="nx-pi-tag-cloud">
                  {portfolioTagChips.map((tag, i) => (
                    <span key={i} className={cls('nx-pi-tag', `is-${tag.tone}`)}>{tag.label}</span>
                  ))}
                </div>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* ── 6. PROSPECT INTELLIGENCE ────────────────────── */}
      <div className="nx-medium-section">
        <div className="nx-medium-section__title">PROSPECT INTELLIGENCE</div>
        {/* Signal chips */}
        {prospectChips.length > 0 && (
          <div className="nx-medium-signal-chips">
            {prospectChips.map((chip) => (
              <span key={chip.label} className={cls('nx-medium-signal-chip', `is-${chip.tone}`)}>{chip.label}</span>
            ))}
          </div>
        )}
        {/* Visualization row: close probability ring + pressure gauges */}
        <div className="nx-mpi-viz-row">
          <div className={cls('nx-mpi-close-ring', `is-${closeTone}`)}>
            <svg viewBox="0 0 56 56" className="nx-mpi-ring-svg">
              <circle cx="28" cy="28" r={CLOSE_R} className="nx-mpi-ring-bg" />
              <circle cx="28" cy="28" r={CLOSE_R} className="nx-mpi-ring-fill"
                strokeDasharray={`${closeRingFill} ${CLOSE_C - closeRingFill}`}
                strokeDashoffset={CLOSE_C * 0.25} />
            </svg>
            <div className="nx-mpi-ring-inner"><strong>{closeProbability}%</strong><span>CLOSE</span></div>
          </div>
          <div className="nx-mpi-gauges">
            {financialPressureScore > 0 && (
              <div className="nx-mpi-gauge">
                <div className="nx-mpi-gauge__row"><span>Fin. Pressure</span>
                  <span className={cls('nx-mp-score', financialPressureScore >= 70 ? 'is-danger' : financialPressureScore >= 40 ? 'is-warn' : '')}>{Math.round(financialPressureScore)}%</span></div>
                <div className="nx-mpi-gauge__track"><div className={cls('nx-mpi-gauge__fill', financialPressureScore >= 70 ? 'is-red' : 'is-amber')} style={{ width: `${financialPressureScore}%` }} /></div>
              </div>
            )}
            {motivationScore > 0 && (
              <div className="nx-mpi-gauge">
                <div className="nx-mpi-gauge__row"><span>Motivation</span>
                  <span className={cls('nx-mp-score', motivationScore >= 70 ? 'is-green' : motivationScore >= 40 ? 'is-amber' : '')}>{Math.round(motivationScore)}%</span></div>
                <div className="nx-mpi-gauge__track"><div className={cls('nx-mpi-gauge__fill', motivationScore >= 70 ? 'is-green' : 'is-blue')} style={{ width: `${motivationScore}%` }} /></div>
              </div>
            )}
            {contactQuality > 0 && (
              <div className="nx-mpi-gauge">
                <div className="nx-mpi-gauge__row"><span>Contact Quality</span>
                  <span className={cls('nx-mp-score', contactQuality >= 70 ? 'is-green' : '')}>{Math.round(contactQuality)}%</span></div>
                <div className="nx-mpi-gauge__track"><div className={cls('nx-mpi-gauge__fill', contactQuality >= 70 ? 'is-green' : 'is-blue')} style={{ width: `${contactQuality}%` }} /></div>
              </div>
            )}
            <div className="nx-mpi-gauge">
              <div className="nx-mpi-gauge__row"><span>Resistance</span>
                <span className={cls('nx-mp-score', resistanceLevel >= 70 ? 'is-danger' : resistanceLevel >= 40 ? 'is-warn' : 'is-green')}>{resistanceLevel}%</span></div>
              <div className="nx-mpi-gauge__track"><div className={cls('nx-mpi-gauge__fill', resistanceLevel >= 70 ? 'is-red' : resistanceLevel >= 40 ? 'is-amber' : 'is-green')} style={{ width: `${resistanceLevel}%` }} /></div>
            </div>
          </div>
        </div>

        {/* ── ACCORDION ── */}
        <div className="nx-mpia">

          {/* IDENTITY */}
          <div className={cls('nx-mpia-section', openProspect.has('identity') && 'is-open')}>
            <button type="button" className="nx-mpia-hdr" onClick={() => toggleProspect('identity')}>
              <span className="nx-mpia-hdr__label">IDENTITY</span>
              <span className="nx-mpia-hdr__count">{[sellerName !== 'Unknown Seller', ageEstimate > 0, !!occupation, !!maritalStatus, !!educationLevel, ownerYears > 0, !!householdIncome].filter(Boolean).length} fields</span>
              <span className="nx-mpia-hdr__arrow">{openProspect.has('identity') ? '▲' : '▼'}</span>
            </button>
            <div className="nx-mpia-body">
              <div className="nx-medium-prow-list">
                <div className="nx-medium-prow"><span>Owner</span>{sellerName !== 'Unknown Seller' ? <strong>{sellerName}</strong> : prospectName ? <strong>{prospectName}</strong> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                <div className="nx-medium-prow"><span>Phone</span>{sellerPhone ? <strong>{sellerPhone}</strong> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                <div className="nx-medium-prow"><span>Email</span>{sellerEmail ? <strong>{sellerEmail}</strong> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                {householdIncome > 0 && <div className="nx-medium-prow"><span>HH Income</span><strong>{formatMoney(householdIncome)}</strong></div>}
              </div>
              <div className="nx-pi-id-chips">
                {ownerType && <span className="nx-pi-id-chip is-blue">{ownerType}</span>}
                {gender && <span className="nx-pi-id-chip">{gender.toUpperCase()}</span>}
                {ageEstimate > 0 && <span className="nx-pi-id-chip">AGE ~{ageEstimate}</span>}
                {maritalStatus && <span className="nx-pi-id-chip">{humanizeMaritalStatus(maritalStatus).toUpperCase()}</span>}
                {educationLevel && <span className="nx-pi-id-chip">{humanizeEducation(educationLevel).toUpperCase()}</span>}
                {occupation && <span className="nx-pi-id-chip is-purple">{humanizeOccupation(occupation).toUpperCase()}</span>}
                {ownerYears >= 15 ? <span className="nx-pi-id-chip is-blue">LONG-TERM {ownerYears}+ YRS</span> : ownerYears > 0 ? <span className="nx-pi-id-chip">{ownerYears}+ YR OWNER</span> : null}
                {languagePref && !/english/i.test(languagePref) && <span className="nx-pi-id-chip is-amber">{languagePref.toUpperCase()} SPEAKER</span>}
                {isAbsentee && <span className="nx-pi-id-chip is-amber">ABSENTEE</span>}
                {isVacant && <span className="nx-pi-id-chip is-amber">VACANT</span>}
                {isTaxDelinquent && <span className="nx-pi-id-chip is-red">TAX DELINQUENT</span>}
              </div>
            </div>
          </div>

          {/* MOTIVATION */}
          <div className={cls('nx-mpia-section', openProspect.has('motivation') && 'is-open')}>
            <button type="button" className="nx-mpia-hdr" onClick={() => toggleProspect('motivation')}>
              <span className="nx-mpia-hdr__label">MOTIVATION</span>
              <span className="nx-mpia-hdr__count">{[!!persona, !!thread.conversationStage, motivationScore > 0, financialPressureScore > 0, urgency > 0].filter(Boolean).length} signals</span>
              <span className="nx-mpia-hdr__arrow">{openProspect.has('motivation') ? '▲' : '▼'}</span>
            </button>
            <div className="nx-mpia-body">
              {persona && (
                <div className="nx-pi-persona-card">
                  <span className="nx-pi-persona-card__icon">🎯</span>
                  <div className="nx-pi-persona-card__body">
                    <div className="nx-pi-persona-card__name">{persona}</div>
                    <div className="nx-pi-persona-card__sub">{thread.conversationStage ? humanizeStage(thread.conversationStage) : 'Analyzing stage...'}</div>
                  </div>
                  {motivationScore > 0 && <span className="nx-pi-persona-card__conf">{Math.round(motivationScore)}% MOTIVATED</span>}
                </div>
              )}
              {aiReasoning && (
                <div className="nx-pi-ai-reasoning">{aiReasoning}</div>
              )}
              {leveragePoints.length > 0 && (
                <div className="nx-pi-ai-leverage">
                  {leveragePoints.map((pt, i) => (
                    <div key={i} className={cls('nx-pi-ai-leverage__item', pt.tone)}>
                      <div className="nx-pi-ai-leverage__dot" />{pt.text}
                    </div>
                  ))}
                </div>
              )}
              <div className="nx-pi-bars">
                {motivationScore > 0 && (
                  <div className="nx-pi-bar-row">
                    <span className="nx-pi-bar__label">Motivation</span>
                    <div className="nx-pi-bar"><div className={cls('nx-pi-bar__fill', motivationScore >= 70 ? 'is-green' : motivationScore >= 40 ? 'is-amber' : 'is-blue')} style={{ width: `${motivationScore}%` }} /></div>
                    <span className="nx-pi-bar__val">{Math.round(motivationScore)}</span>
                  </div>
                )}
                {financialPressureScore > 0 && (
                  <div className="nx-pi-bar-row">
                    <span className="nx-pi-bar__label">Fin. Pressure</span>
                    <div className="nx-pi-bar"><div className={cls('nx-pi-bar__fill', financialPressureScore >= 70 ? 'is-red' : 'is-amber')} style={{ width: `${financialPressureScore}%` }} /></div>
                    <span className="nx-pi-bar__val">{Math.round(financialPressureScore)}</span>
                  </div>
                )}
                {urgency > 0 && (
                  <div className="nx-pi-bar-row">
                    <span className="nx-pi-bar__label">Urgency</span>
                    <div className="nx-pi-bar"><div className={cls('nx-pi-bar__fill', urgency >= 70 ? 'is-red' : urgency >= 40 ? 'is-amber' : 'is-blue')} style={{ width: `${urgency}%` }} /></div>
                    <span className="nx-pi-bar__val">{Math.round(urgency)}</span>
                  </div>
                )}
              </div>
              <div className="nx-medium-prow-list" style={{ marginTop: 8 }}>
                {(thread.uiIntent || thread.detected_intent) && <div className="nx-medium-prow"><span>Intent</span><strong>{humanizeIntent(thread.uiIntent || thread.detected_intent || '')}</strong></div>}
                {equity > 0 && <div className="nx-medium-prow"><span>Equity Position</span><strong>{Math.round(equity)}%</strong></div>}
                {nextAction?.title && <div className="nx-medium-prow"><span>AI Next Move</span><strong style={{ color: '#0a84ff' }}>{nextAction.title}</strong></div>}
                {thread.isSuppressed && <div className="nx-medium-prow is-danger"><span>DNC</span><strong>Suppressed</strong></div>}
              </div>
            </div>
          </div>

          {/* BEHAVIORAL */}
          <div className={cls('nx-mpia-section', openProspect.has('behavioral') && 'is-open')}>
            <button type="button" className="nx-mpia-hdr" onClick={() => toggleProspect('behavioral')}>
              <span className="nx-mpia-hdr__label">BEHAVIORAL</span>
              <span className={cls('nx-mpia-hdr__badge', `is-${emotionalState.tone}`)}>{emotionalState.label}</span>
              <span className="nx-mpia-hdr__arrow">{openProspect.has('behavioral') ? '▲' : '▼'}</span>
            </button>
            <div className="nx-mpia-body">
              <div className="nx-pi-temp-chips">
                <span className={cls('nx-pi-temp-chip', `is-${emotionalState.tone}`)}>{emotionalState.label.toUpperCase()}</span>
                <span className={cls('nx-pi-temp-chip', resistanceLevel >= 70 ? 'is-red' : resistanceLevel >= 40 ? 'is-amber' : 'is-green')}>
                  {resistanceLevel >= 70 ? 'HIGH RESISTANCE' : resistanceLevel >= 40 ? 'MODERATE RESISTANCE' : 'LOW RESISTANCE'}
                </span>
                {negotiationStyle && <span className="nx-pi-temp-chip is-blue">{negotiationStyle.toUpperCase()}</span>}
                {responseCadence && !responseCadence.includes('No response') && <span className="nx-pi-temp-chip is-muted">{responseCadence.toUpperCase()}</span>}
                {financialPressureScore >= 70 && <span className="nx-pi-temp-chip is-red">HIGH PRESSURE</span>}
                {motivationScore >= 70 && <span className="nx-pi-temp-chip is-green">HIGH MOTIVATION</span>}
                {contactQuality >= 70 && <span className="nx-pi-temp-chip is-green">HIGHLY CONTACTABLE</span>}
              </div>
              <div className="nx-pi-bars" style={{ marginTop: 10 }}>
                <div className="nx-pi-bar-row">
                  <span className="nx-pi-bar__label">Resistance</span>
                  <div className="nx-pi-bar"><div className={cls('nx-pi-bar__fill', resistanceLevel >= 70 ? 'is-red' : resistanceLevel >= 40 ? 'is-amber' : 'is-green')} style={{ width: `${resistanceLevel}%` }} /></div>
                  <span className="nx-pi-bar__val">{resistanceLevel}</span>
                </div>
              </div>
              {likelyObjections.length > 0 && (
                <div className="nx-mpia-objections" style={{ marginTop: 8 }}>
                  <span className="nx-mm-label">LIKELY OBJECTIONS</span>
                  {likelyObjections.map((obj, i) => (
                    <div key={i} className="nx-mpia-objection"><span className="nx-mpia-objection__dot" />{obj}</div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* FINANCIAL PROFILE */}
          <div className={cls('nx-mpia-section', openProspect.has('financial') && 'is-open')}>
            <button type="button" className="nx-mpia-hdr" onClick={() => toggleProspect('financial')}>
              <span className="nx-mpia-hdr__label">FINANCIAL PROFILE</span>
              {netWorth > 0 && <span className="nx-mpia-hdr__badge is-green">NW {formatMoney(netWorth)}</span>}
              <span className="nx-mpia-hdr__arrow">{openProspect.has('financial') ? '▲' : '▼'}</span>
            </button>
            <div className="nx-mpia-body">
              {netWorth > 0 && (() => {
                const tier = netWorth >= 1000000 ? 'HIGH NET WORTH' : netWorth >= 500000 ? 'EMERGING WEALTH' : netWorth >= 100000 ? 'MIDDLE MARKET' : 'WORKING CLASS'
                const isHigh = netWorth >= 500000
                return (
                  <div className={cls('nx-pi-wealth-tier', isHigh ? '' : 'is-mid')}>
                    <div>
                      <div className="nx-pi-wealth-tier__label">EST. NET WORTH</div>
                      <div className="nx-pi-wealth-tier__value">{formatMoney(netWorth)}</div>
                    </div>
                    <div className="nx-pi-wealth-tier__badge">{tier}</div>
                  </div>
                )
              })()}
              <div className="nx-pi-fin-gauges">
                <div className="nx-pi-fin-gauge">
                  <div className="nx-pi-fin-gauge__label">BUYING POWER</div>
                  <div className={cls('nx-pi-fin-gauge__val', buyingPower > 0 ? 'is-green' : 'nx-mm-unavail')}>{buyingPower > 0 ? formatMoney(buyingPower) : 'Unavailable'}</div>
                  {buyingPower > 0 && <><div className="nx-pi-fin-gauge__bar"><div className="nx-pi-fin-gauge__fill is-green" style={{ width: `${Math.min((buyingPower / 500000) * 100, 100)}%` }} /></div></>}
                </div>
                <div className="nx-pi-fin-gauge">
                  <div className="nx-pi-fin-gauge__label">CASH LIQUIDITY</div>
                  <div className={cls('nx-pi-fin-gauge__val', liquidityEstimate > 0 ? 'is-green' : 'nx-mm-unavail')}>{liquidityEstimate > 0 ? formatMoney(liquidityEstimate) : 'Unavailable'}</div>
                  {liquidityEstimate > 0 && <><div className="nx-pi-fin-gauge__bar"><div className="nx-pi-fin-gauge__fill is-blue" style={{ width: `${Math.min((liquidityEstimate / 200000) * 100, 100)}%` }} /></div></>}
                </div>
                <div className="nx-pi-fin-gauge">
                  <div className="nx-pi-fin-gauge__label">HH INCOME</div>
                  <div className={cls('nx-pi-fin-gauge__val', householdIncome > 0 ? '' : 'nx-mm-unavail')}>{householdIncome > 0 ? formatMoney(householdIncome) : 'Unavailable'}</div>
                  {householdIncome > 0 && <><div className="nx-pi-fin-gauge__bar"><div className="nx-pi-fin-gauge__fill is-amber" style={{ width: `${Math.min((householdIncome / 200000) * 100, 100)}%` }} /></div></>}
                </div>
                <div className="nx-pi-fin-gauge">
                  <div className="nx-pi-fin-gauge__label">PROPERTY EQUITY</div>
                  <div className={cls('nx-pi-fin-gauge__val', value > 0 && equity > 0 ? 'is-green' : 'nx-mm-unavail')}>{value > 0 && equity > 0 ? formatMoney(Math.round(value * equity / 100)) : 'Unavailable'}</div>
                  {value > 0 && equity > 0 && <><div className="nx-pi-fin-gauge__bar"><div className="nx-pi-fin-gauge__fill is-green" style={{ width: `${clamp(equity, 0, 100)}%` }} /></div></>}
                </div>
              </div>
              {(loanAmount > 0 || isFreeClear) && (
                <div className="nx-medium-prow-list" style={{ marginTop: 4 }}>
                  <div className="nx-medium-prow"><span>Mortgage Status</span>{isFreeClear ? <strong className="nx-mpia-ok">Free &amp; Clear</strong> : <strong>Has Mortgage</strong>}</div>
                </div>
              )}
            </div>
          </div>

          {/* PROSPECT TAGS */}
          {prospectTags.length > 0 && (
            <div className={cls('nx-mpia-section', openProspect.has('tags') && 'is-open')}>
              <button type="button" className="nx-mpia-hdr" onClick={() => toggleProspect('tags')}>
                <span className="nx-mpia-hdr__label">PROSPECT TAGS</span>
                <span className="nx-mpia-hdr__count">{prospectTags.length} tags</span>
                <span className="nx-mpia-hdr__arrow">{openProspect.has('tags') ? '▲' : '▼'}</span>
              </button>
              <div className="nx-mpia-body">
                <div className="nx-pi-tag-cloud">
                  {prospectTags.map((tag, i) => (
                    <span key={i} className={cls('nx-pi-tag', `is-${tag.tone}`)}>{tag.label}</span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* CONTACT INTELLIGENCE */}
          <div className={cls('nx-mpia-section', openProspect.has('contact') && 'is-open')}>
            <button type="button" className="nx-mpia-hdr" onClick={() => toggleProspect('contact')}>
              <span className="nx-mpia-hdr__label">CONTACT INTELLIGENCE</span>
              <span className="nx-mpia-hdr__count">{contactProbability > 0 ? `${Math.round(contactProbability)}% reach` : 'pending'}</span>
              <span className="nx-mpia-hdr__arrow">{openProspect.has('contact') ? '▲' : '▼'}</span>
            </button>
            <div className="nx-mpia-body">
              <div className="nx-medium-prow-list">
                <div className="nx-medium-prow"><span>Contact Probability</span>{contactProbability > 0 ? <span className={cls('nx-mp-score', contactProbability >= 70 ? 'is-green' : contactProbability >= 40 ? 'is-amber' : 'is-danger')}>{Math.round(contactProbability)}%</span> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                <div className="nx-medium-prow"><span>Phone Confidence</span>{phoneConfidence > 0 ? <span className={cls('nx-mp-score', phoneConfidence >= 70 ? 'is-green' : phoneConfidence >= 40 ? 'is-amber' : 'is-danger')}>{Math.round(phoneConfidence)}%</span> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                <div className="nx-medium-prow"><span>SMS Deliverability</span>{smsDeliverability > 0 ? <span className={cls('nx-mp-score', smsDeliverability >= 70 ? 'is-green' : smsDeliverability >= 40 ? 'is-amber' : 'is-danger')}>{Math.round(smsDeliverability)}%</span> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                <div className="nx-medium-prow"><span>Email Quality</span>{emailQuality > 0 ? <span className={cls('nx-mp-score', emailQuality >= 70 ? 'is-green' : emailQuality >= 40 ? 'is-amber' : 'is-danger')}>{Math.round(emailQuality)}%</span> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                <div className="nx-medium-prow"><span>Language Pref</span>{languagePref ? <strong>{languagePref}</strong> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                <div className="nx-medium-prow"><span>Best Contact Window</span>{bestContactWindow ? <strong>{bestContactWindow}</strong> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                <div className="nx-medium-prow"><span>Follow-Up At</span>{followUpAt ? <strong>{followUpAt}</strong> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                <div className="nx-medium-prow"><span>Last Outbound</span>{lastOutboundAt ? <strong>{lastOutboundAt}</strong> : <span className="nx-mm-unavail">Unavailable</span>}</div>
                <div className="nx-medium-prow"><span>Last Reply</span><strong>{responseCadence}</strong></div>
                <div className="nx-medium-prow"><span>DNC Risk</span><strong className={dncRisk === 'Suppressed' || dncRisk === 'Elevated' ? 'nx-mpia-warn' : 'nx-mpia-ok'}>{dncRisk}</strong></div>
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* ── 7. AI CONVERSATION BRAIN ────────────────────── */}
      <div className="nx-medium-section nx-medium-section--brain">
        <div className="nx-medium-section__title">
          AI CONVERSATION BRAIN
          <span className="nx-medium-live-badge">AI LIVE</span>
        </div>
        {/* Stage flow progression */}
        <div className="nx-medium-stage-flow">
          {stageFlow.map((label, i) => (
            <div key={label} className={cls('nx-msf-step', i < currentStageIndex && 'is-done', i === currentStageIndex && 'is-active')}>
              <div className="nx-msf-dot" />
              <span>{label}</span>
            </div>
          ))}
        </div>
        {/* Negotiation posture + momentum row */}
        <div className="nx-brain-posture-row">
          <div className="nx-brain-posture">
            <span className="nx-mm-label">NEGOTIATION POSTURE</span>
            <strong className={cls('nx-brain-posture__value',
              negotiationPosture.includes('Escalate') || negotiationPosture.includes('Act') ? 'is-urgent' : ''
            )}>{negotiationPosture}</strong>
          </div>
          <div className="nx-brain-momentum">
            <span className="nx-mm-label">MOMENTUM</span>
            <div className="nx-brain-momentum__bar">
              <div className={cls('nx-brain-momentum__fill', `is-${momentumTone}`)} style={{ width: `${momentumScore}%` }} />
            </div>
            <span className={cls('nx-brain-momentum__val', `is-${momentumTone}`)}>{momentumScore}</span>
          </div>
        </div>
        {/* Messages */}
        {(latestInbound || latestOutbound) && (
          <div className="nx-medium-brain-msgs">
            {latestInbound && (
              <div className="nx-mbm-msg is-inbound">
                <span className="nx-mbm-dir">SELLER</span>
                <p>{latestInbound.body || 'Message unavailable.'}</p>
              </div>
            )}
            {latestOutbound && (
              <div className="nx-mbm-msg is-outbound">
                <span className="nx-mbm-dir">OUTBOUND</span>
                <p>{latestOutbound.body || 'Message unavailable.'}</p>
              </div>
            )}
          </div>
        )}
        {/* AI analysis + insights */}
        <div className="nx-medium-brain-intel">
          <div className="nx-mbi-summary">
            <div className="nx-mbi-summary__head">
              <span className="nx-mm-label">AI ANALYSIS</span>
              <span className="nx-mbi-conf-badge">CONF {aiConfidence}%</span>
            </div>
            <p>{summary}</p>
          </div>
          <div className="nx-mbi-insights">
            {aiInsights.map((insight, i) => (
              <div key={i} className="nx-mbi-insight">
                <span className="nx-mbi-dot" />
                <span>{insight}</span>
              </div>
            ))}
          </div>
        </div>
        {/* Signal row */}
        <div className="nx-medium-brain-signals">
          <div className="nx-mbs-item">
            <span>Intent</span>
            <strong>{humanizeIntent(intent)}</strong>
          </div>
          <div className="nx-mbs-item">
            <span>Sentiment</span>
            <strong className={cls(
              /positive/i.test(sentiment) ? 'nx-mbs-green' : /negative/i.test(sentiment) ? 'nx-mbs-red' : ''
            )}>{sentiment}</strong>
          </div>
          <div className="nx-mbs-item">
            <span>Urgency</span>
            <div className="nx-mbs-urgency">
              <div className={cls('nx-mbs-urgency__fill', urgency >= 70 ? 'is-red' : 'is-amber')} style={{ width: `${urgency}%` }} />
              <span>{Math.round(urgency)}%</span>
            </div>
          </div>
        </div>
        {/* Tactical recommendation */}
        <div className="nx-medium-brain-action">
          <span className="nx-mba-label">TACTICAL RECOMMENDATION</span>
          <p className="nx-mba-text">{nextAction.title}</p>
          <span className="nx-mba-reason">{nextAction.reason}</span>
        </div>
        {/* Suggested replies */}
        <div className="nx-medium-brain-replies">
          {([
            nextAction.suggestedReply,
            'Ask about condition and timeline.',
            'Move toward price discovery.',
          ].filter(Boolean) as string[]).slice(0, 3).map((reply, i) => (
            <button type="button" key={i} className="nx-mbr-chip">{reply}</button>
          ))}
        </div>
      </div>

      {/* ── 8. ACTIVITY TIMELINE ────────────────────────── */}
      <div className="nx-medium-section">
        <div className="nx-medium-section__title">ACTIVITY TIMELINE</div>
        <div className="nx-medium-timeline">
          {latestEvents.length > 0 ? latestEvents.map((msg, i) => {
            const isInbound = msg.direction === 'inbound'
            const lc = (msg.body || '').toLowerCase()
            let label = isInbound ? 'Seller Response' : i === 0 ? 'Initial Outreach' : 'Follow-Up Attempt'
            let tone = isInbound ? 'is-green' : 'is-blue'
            if (isInbound) {
              if (/stop|unsubscribe|opt.?out/.test(lc)) { label = 'Opt-Out Request'; tone = 'is-red'; }
              else if (/price|offer|interested|ready/.test(lc)) { label = 'Showing Interest'; tone = 'is-green'; }
              else if (/wrong number|not.*owner|already sold/.test(lc)) { label = 'Disqualification'; tone = 'is-amber'; }
              else if (/yes|sure|call|talk|available/.test(lc)) { label = 'Positive Engagement'; tone = 'is-green'; }
            }
            if (!isInbound && (msg as any).deliveryStatus === 'failed') { label = 'Delivery Failed'; tone = 'is-red'; }
            return (
              <div key={msg.id || i} className={cls('nx-medium-tl-node', tone)}>
                <div className="nx-medium-tl-dot" />
                <div className="nx-medium-tl-content">
                  <div className="nx-medium-tl-row">
                    <span className="nx-medium-tl-label">{label}</span>
                    <span className="nx-medium-tl-time">{formatRelativeTime(msg.createdAt || (msg as any).created_at || (msg as any).timestamp)}</span>
                  </div>
                  {msg.body && <p className="nx-medium-tl-body">{msg.body.slice(0, 90)}{msg.body.length > 90 ? '…' : ''}</p>}
                </div>
              </div>
            )
          }) : (
            <div className="nx-medium-tl-empty">No activity recorded yet.</div>
          )}
        </div>
      </div>

      {/* ── 9. TACTICAL ACTION DOCK ─────────────────────── */}
      <div className="nx-medium-action-dock">
        <div className="nx-mad-group">
          <span className="nx-mad-group__label">COMMUNICATE</span>
          <div className="nx-mad-group__btns">
            <button type="button" className="nx-mad-btn is-primary">Draft Reply</button>
            <button type="button" className="nx-mad-btn">Send SMS</button>
            <button type="button" className="nx-mad-btn">Send Email</button>
          </div>
        </div>
        <div className="nx-mad-group">
          <span className="nx-mad-group__label">ANALYZE</span>
          <div className="nx-mad-group__btns">
            <button type="button" className="nx-mad-btn">Run Underwriting</button>
            <button type="button" className="nx-mad-btn">Open Comps</button>
            <button type="button" className="nx-mad-btn">Buyer Matches</button>
          </div>
        </div>
        <div className="nx-mad-group is-safety">
          <span className="nx-mad-group__label">SAFETY</span>
          <div className="nx-mad-group__btns">
            <button type="button" className="nx-mad-btn is-warn">Pause Automation</button>
            <button type="button" className="nx-mad-btn is-danger">Suppress / DNC</button>
          </div>
        </div>
      </div>

    </div>
  )
}

const DealCommandDossier = ({
  thread,
  snapshot,
  messages,
  phase3,
  intelligence,
  layoutMode,
  onOpenMap,
  onOpenDossier,
  onOpenAi,
}: {
  thread: WorkflowThread
  snapshot: NormalizedPropertySnapshot
  messages: ThreadMessage[]
  phase3: Phase3Intelligence | null
  intelligence: ThreadIntelligenceRecord | null
  layoutMode: ViewLayoutMode
  onOpenMap: () => void
  onOpenDossier: () => void
  onOpenAi: () => void
}) => (
  <div className={cls('nx-deal-command-dossier', `is-layout-${layoutMode}`, layoutMode === 'full' && 'is-full')}>
    <DealCommandHeader thread={thread} snapshot={snapshot} phase3={phase3} />
    <div className="nx-deal-command-dossier__grid">
      <div className="nx-deal-command-dossier__media">
        <PropertyHeroCard
          thread={thread}
          snapshot={snapshot}
          panelMode={layoutMode === 'full' ? 'full' : 'default'}
          layoutMode={layoutMode}
        />
      </div>
      <div className="nx-deal-command-dossier__decision">
        <DealDecisionStrip thread={thread} />
      </div>
      <div className="nx-deal-command-dossier__comp">
        <CompIntelligenceModule thread={thread} snapshot={snapshot} />
      </div>
      <div className="nx-deal-command-dossier__buyer">
        <BuyerMatchingModule thread={thread} snapshot={snapshot} />
      </div>
      <div className="nx-deal-command-dossier__seller-grid">
        <ConversationBrainModule thread={thread} messages={messages} phase3={phase3} />
        <ContactIntelligenceCard thread={thread} snapshot={snapshot} intelligence={intelligence} />
        <TimelinePanel thread={thread} messages={messages} phase3={phase3} />
      </div>
      <div className="nx-deal-command-dossier__links">
        <LinkedRecordsCard thread={thread} />
      </div>
    </div>
    <CommandActionDock layoutMode={layoutMode} onOpenMap={onOpenMap} onOpenDossier={onOpenDossier} onOpenAi={onOpenAi} />
  </div>
)

// ── Raw Dossier Section ───────────────────────────────────────────────────────

function RawDossierField({ label, value }: { label: string; value: unknown }) {
  const [expanded, setExpanded] = useState(false)
  if (value === null || value === undefined) return null
  const isObj = typeof value === 'object'
  const display = isObj ? JSON.stringify(value, null, 2) : String(value)
  const isLong = display.length > 120 || display.includes('\n')
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--nx-text-muted, #888)', marginBottom: 2 }}>
        {label}
      </div>
      {isLong && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--nx-accent, #4a9eff)', padding: 0 }}
        >
          {isObj ? '{ ... } expand' : `${display.slice(0, 80)}… expand`}
        </button>
      ) : (
        <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--nx-text, #e0e0e0)', background: 'var(--nx-surface-2, rgba(255,255,255,0.05))', borderRadius: 4, padding: '4px 6px' }}>
          {display}
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              style={{ display: 'block', marginTop: 4, background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: 'var(--nx-text-muted, #888)', padding: 0 }}
            >
              collapse
            </button>
          )}
        </pre>
      )}
    </div>
  )
}

function RawDossierTable({ title, rows }: { title: string; rows: Record<string, unknown>[] }) {
  const [open, setOpen] = useState(false)
  if (rows.length === 0) return null
  return (
    <div style={{ marginBottom: 10 }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: 'var(--nx-text, #e0e0e0)', padding: '4px 0', display: 'flex', alignItems: 'center', gap: 4, width: '100%', textAlign: 'left' }}
      >
        <span style={{ opacity: 0.5 }}>{open ? '▾' : '▸'}</span>
        {title} <span style={{ opacity: 0.5, fontWeight: 400 }}>({rows.length})</span>
      </button>
      {open && rows.map((row, i) => (
        <div key={i} style={{ borderLeft: '2px solid var(--nx-accent, #4a9eff)', paddingLeft: 8, marginBottom: 8 }}>
          {Object.entries(row).map(([k, v]) => v !== null && v !== undefined && v !== '' ? (
            <RawDossierField key={k} label={k} value={v} />
          ) : null)}
        </div>
      ))}
    </div>
  )
}

function RawDossierRecord({ title, obj }: { title: string; obj: Record<string, unknown> | null }) {
  const [open, setOpen] = useState(false)
  if (!obj) return null
  const entries = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== '')
  if (entries.length === 0) return null
  return (
    <div style={{ marginBottom: 10 }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: 'var(--nx-text, #e0e0e0)', padding: '4px 0', display: 'flex', alignItems: 'center', gap: 4, width: '100%', textAlign: 'left' }}
      >
        <span style={{ opacity: 0.5 }}>{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && (
        <div style={{ borderLeft: '2px solid var(--nx-accent, #4a9eff)', paddingLeft: 8 }}>
          {entries.map(([k, v]) => <RawDossierField key={k} label={k} value={v} />)}
        </div>
      )}
    </div>
  )
}

function RawDossierSection({ dossier, loading }: { dossier: ThreadDossier | null; loading: boolean }) {
  if (loading) {
    return (
      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--nx-border, rgba(255,255,255,0.08))' }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--nx-text-muted, #888)', marginBottom: 8 }}>
          RAW DOSSIER
        </div>
        <div style={{ fontSize: 11, color: 'var(--nx-text-muted, #888)' }}>Loading full dossier…</div>
      </div>
    )
  }
  if (!dossier) return null
  const hasErrors = dossier.errors.length > 0

  return (
    <div style={{ padding: '12px 16px', borderTop: '1px solid var(--nx-border, rgba(255,255,255,0.08))' }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--nx-text-muted, #888)', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
        <span>RAW DOSSIER</span>
        {hasErrors && <span style={{ color: '#f59e0b', fontWeight: 400 }}>partial ({dossier.errors.length} warn)</span>}
      </div>

      <RawDossierRecord title="Master Owner" obj={dossier.master_owner} />
      <RawDossierRecord title="Property" obj={dossier.property} />
      <RawDossierRecord title="Prospect" obj={dossier.prospect} />
      <RawDossierRecord title="Inbox Thread State" obj={dossier.inbox_thread_state} />
      <RawDossierRecord title="Thread AI State" obj={dossier.thread_ai_state} />
      <RawDossierTable title="Send Queue" rows={dossier.send_queue} />
      <RawDossierTable title="Phones" rows={dossier.phones} />
      <RawDossierTable title="Emails" rows={dossier.emails} />
      <RawDossierTable title="Message Events" rows={dossier.message_events} />

      {hasErrors && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ fontSize: 10, color: 'var(--nx-text-muted, #888)', cursor: 'pointer' }}>Diagnostics</summary>
          <pre style={{ fontSize: 10, marginTop: 4, color: '#f59e0b', background: 'rgba(245,158,11,0.08)', borderRadius: 4, padding: '4px 6px', whiteSpace: 'pre-wrap' }}>
            {dossier.errors.join('\n')}
          </pre>
        </details>
      )}
    </div>
  )
}

export interface IntelligencePanelProps {
  thread: WorkflowThread | null
  threadContext?: ThreadContext | null
  intelligence?: ThreadIntelligenceRecord | null
  threadDossier?: ThreadDossier | null
  dossierLoading?: boolean
  panelMode?: Exclude<PanelMode, 'hidden'>
  layoutMode?: ViewLayoutMode
  isSuppressed?: boolean
  onCollapse?: () => void
  onOpenMap?: () => void
  onOpenDossier?: () => void
  onOpenAi?: () => void
  onStatusChange: (status: InboxStatus | 'sent_message') => void
  onStageChange: (stage: SellerStage) => void
  messages: ThreadMessage[]
}

export const IntelligencePanel = ({
  thread,
  threadContext,
  intelligence = null,
  threadDossier = null,
  dossierLoading = false,
  isSuppressed = false,
  panelMode = 'default',
  layoutMode = 'full',
  onCollapse,
  onOpenMap = () => undefined,
  onOpenDossier = () => undefined,
  onOpenAi = () => undefined,
  onStatusChange,
  onStageChange,
  messages,
}: IntelligencePanelProps) => {
  void threadContext
  void isSuppressed
  void onStatusChange
  void onStageChange

  if (!thread) {
    return (
      <aside className="nx-intelligence-panel">
        <div className="nx-inbox-loading-state">
          <Icon name="inbox" />
          <p>Select a thread to view intelligence</p>
        </div>
      </aside>
    )
  }

  const snapshot = useMemo(() => normalizePropertySnapshot(intelligence || null, thread, threadDossier), [intelligence, thread, threadDossier])
  const { data: phase3 } = usePhase3Intelligence(thread.threadKey)
  const panelClassMode = layoutMode === 'compact'
    ? 'compact'
    : layoutMode === 'medium'
    ? 'split'
    : 'workspace'
  return (
    <aside className={cls('nx-intelligence-panel', `is-mode-${panelClassMode}`, `is-layout-${layoutMode}`, `is-panel-${panelMode}`)}>
      <header className="nx-intel-header">
        <span className="nx-section-label">DEAL COMMAND DOSSIER</span>
        {onCollapse ? (
          <button type="button" className="nx-intel-collapse" onClick={onCollapse} title="Collapse panel">
            <Icon name="close" />
          </button>
        ) : null}
      </header>

      <div className="nx-intel-scroll-body">
        {layoutMode === 'compact' ? (
          <CompactDealIntelligenceCapsule thread={thread} snapshot={snapshot} messages={messages} />
        ) : layoutMode === 'medium' ? (
          <MediumDealWorkspace thread={thread} snapshot={snapshot} messages={messages} phase3={phase3} />
        ) : (
          <DealCommandDossier
            thread={thread}
            snapshot={snapshot}
            messages={messages}
            phase3={phase3}
            intelligence={intelligence}
            layoutMode={layoutMode}
            onOpenMap={onOpenMap}
            onOpenDossier={onOpenDossier}
            onOpenAi={onOpenAi}
          />
        )}
        <RawDossierSection dossier={threadDossier} loading={dossierLoading} />
      </div>
    </aside>
  )
}

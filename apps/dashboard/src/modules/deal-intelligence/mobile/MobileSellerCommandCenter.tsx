import { useEffect, useMemo, useRef, useState } from 'react'
import { EntityGraphPropertyVisual } from '../../entity-graph/mobile/EntityGraphPropertyVisual'
import { Icon } from '../../../shared/icons'
import type { IconName } from '../../../shared/icons'
import { useDealIntelligenceDossier } from '../../../domain/deal-intelligence/useDealIntelligenceDossier'
import type {
  ActivityEvent,
  DealIntelligenceDossier,
} from '../../../domain/deal-intelligence/deal-intelligence.types'
import { ENGINE_STAGE_DISPLAY_ORDER, ENGINE_STAGE_LABELS } from '../../../domain/deal-intelligence/deal-intelligence.types'
import { DealIntelligenceHeaderActions } from '../DealIntelligenceLeadStateBar'
import { MobileWorkflowControls } from './MobileWorkflowControls'
import {
  activityLabel,
  count,
  humanize,
  humanizeEmbeddedTokens,
  IDENTITY_ROLES,
  isCarrierName,
  money,
  phoneType,
  relativeTime,
  shortDate,
  splitAddress,
  text,
  type IdentityRole,
} from './mobile-seller-format'
import { DealDecisionSurface } from './decision/DealDecisionSurface'
import { CallActionLink } from '../../../domain/compliance/CallActionLink'
import { callGateFromDossier, type CallGateInput } from '../../../domain/compliance/call-action'
import './mobile-seller-command.css'
import './deal-intelligence-desktop.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')


/** "1 property", not "1 properties". */
const plural = (n: unknown, one: string, many: string): string | null => {
  const v = Number(n)
  if (!Number.isFinite(v)) return null
  return `${new Intl.NumberFormat('en-US').format(v)} ${v === 1 ? one : many}`
}

type Rec = Record<string, unknown> | undefined | null

/* ── primitives ─────────────────────────────────────────────────────────── */

/** label/value pair. Renders nothing when the value is absent, so sections
 *  collapse to what is actually known rather than to a grid of em-dashes. */
const Field = ({ label, value, tone }: { label: string; value: string | null; tone?: 'warn' | 'good' }) =>
  value ? (
    <div className={cls('msc-field', tone && `is-${tone}`)}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  ) : null

const FieldList = ({ children }: { children: React.ReactNode }) => {
  const items = Array.isArray(children) ? children.flat().filter(Boolean) : children
  if (Array.isArray(items) && items.length === 0) return null
  return <dl className="msc-fields">{items}</dl>
}

function Section({
  id, title, summary, icon, defaultOpen = false, loading = false, empty, children,
}: {
  id: string
  title: string
  /** Shown on the collapsed header — must say something useful on its own. */
  summary?: string | null
  icon: IconName
  defaultOpen?: boolean
  loading?: boolean
  empty?: string | null
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={cls('msc-section', open && 'is-open')} data-section={id}>
      <button
        type="button"
        className="msc-section__head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={icon} className="msc-section__icon" />
        <span className="msc-section__title">{title}</span>
        {summary ? <span className="msc-section__summary">{summary}</span> : null}
        <Icon name="chevron-down" className="msc-section__caret" />
      </button>
      {open ? (
        <div className="msc-section__body">
          {loading ? <SectionSkeleton /> : empty ? <p className="msc-empty">{empty}</p> : children}
        </div>
      ) : null}
    </section>
  )
}

const SectionSkeleton = () => (
  <div className="msc-skeleton" aria-hidden="true">
    <span /><span /><span />
  </div>
)

/* ── header ─────────────────────────────────────────────────────────────── */

function CommandHeader({
  sellerName, address, locality, contactability, callGate, threadKey, leadState, onPatched, onOpenConversation,
}: {
  sellerName: string
  address: string | null
  locality: string | null
  contactability: { label: string; tone: 'good' | 'warn' | 'bad' } | null
  callGate: CallGateInput
  threadKey: string
  leadState: React.ComponentProps<typeof MobileWorkflowControls>['data'] | null
  onPatched: () => void
  onOpenConversation?: (() => void) | null
}) {
  void threadKey
  const [overflow, setOverflow] = useState(false)
  return (
    <header className="msc-header">
      <div className="msc-header__identity">
        <h1 className="msc-header__name">{sellerName}</h1>
        {contactability ? (
          <span className={cls('msc-contactability', `is-${contactability.tone}`)}>
            <span className="msc-contactability__dot" aria-hidden="true" />
            {contactability.label}
          </span>
        ) : null}
      </div>
      {address ? (
        <p className="msc-header__address">
          {address}
          {locality ? <span className="msc-header__locality">{locality}</span> : null}
        </p>
      ) : null}

      {leadState ? <MobileWorkflowControls data={leadState} onPatched={onPatched} /> : null}

      <div className="msc-actions">
        <CallActionLink gate={callGate} className="msc-action" disabledClassName="is-disabled">
          <Icon name="phone" /><span>Call</span>
        </CallActionLink>
        <button
          type="button"
          className={cls('msc-action', !onOpenConversation && 'is-disabled')}
          onClick={() => onOpenConversation?.()}
          disabled={!onOpenConversation}
        >
          <Icon name="message" /><span>Message</span>
        </button>
        <button
          type="button"
          className={cls('msc-action', 'msc-action--more', overflow && 'is-open')}
          onClick={() => setOverflow((v) => !v)}
          aria-expanded={overflow}
        >
          <Icon name="more" /><span>More</span>
        </button>
      </div>

      {overflow && leadState ? (
        <div className="msc-overflow">
          {/* The real, already-wired star / pin / snooze / archive controls.
              They persist, so they stay — just demoted out of the primary row. */}
          <DealIntelligenceHeaderActions data={leadState} onPatched={onPatched} />
          <p className="msc-overflow__note">Star · Pin · Snooze 24h · Archive · Locks</p>
        </div>
      ) : null}
    </header>
  )
}

/* ── main ───────────────────────────────────────────────────────────────── */

/**
 * Everything the host surface already holds by the time the operator taps into
 * the detail. Rendering from this first is what makes identity, workflow state
 * and the headline deal numbers appear at ~10ms instead of waiting on the
 * dossier round trip.
 */
export interface MobileSellerSeed {
  sellerName?: string | null
  address?: string | null
  lifecycleStage?: string | null
  operationalStatus?: string | null
  leadTemperature?: string | null
  isStarred?: boolean | null
  isPinned?: boolean | null
  isArchived?: boolean | null
  estimatedValue?: number | null
  equityAmount?: number | null
  equityPercent?: number | null
  loanBalance?: number | null
  repairCost?: number | null
  phone?: string | null
}

/** A usable coordinate or nothing — the visual geocodes the address otherwise. */
const coord = (value: unknown): number | null => {
  const n = Number(value)
  return Number.isFinite(n) && Math.abs(n) > 0.0001 ? n : null
}

export interface MobileSellerCommandCenterProps {
  threadKey?: string
  propertyId?: string
  prospectId?: string
  masterOwnerId?: string
  canonicalE164?: string
  fallbackAddress?: string | null
  seed?: MobileSellerSeed | null
  /**
   * Returns to this thread's in-app conversation. Messaging MUST go through the
   * app: an `sms:` deep link would send from the operator's personal handset,
   * bypassing the TextGrid number pool, the send queue, contact windows and
   * suppression entirely.
   */
  onOpenConversation?: (() => void) | null
}

export function MobileSellerCommandCenter({
  threadKey, propertyId, prospectId, masterOwnerId, canonicalE164, fallbackAddress, seed, onOpenConversation,
}: MobileSellerCommandCenterProps) {
  const {
    dossier, phase, detailReady, error, refresh,
    runDecisionEngine, engineRunning, engineProgress, engineError,
  } = useDealIntelligenceDossier({ threadKey, propertyId, prospectId, masterOwnerId, canonicalE164 })

  /**
   * Each completed engine run bumps this so the decision surface refetches the
   * new canonical projection. The run itself is the existing canonical path
   * (run-engine route → ensurePropertyAcquisitionDecision); nothing here
   * computes or persists a decision.
   */
  const [engineRuns, setEngineRuns] = useState(0)
  const [subjectAddress, setSubjectAddress] = useState<string | null>(null)
  const wasRunningRef = useRef(false)
  useEffect(() => {
    if (wasRunningRef.current && !engineRunning) setEngineRuns((n) => n + 1)
    wasRunningRef.current = engineRunning
  }, [engineRunning])

  const d = dossier as DealIntelligenceDossier | null
  const property = d?.property
  const convo = d?.conversation_intelligence as Rec
  const phone = d?.phone as Rec
  const owner = d?.master_owner as Rec
  const prospect = d?.prospect as Rec
  const compliance = d?.compliance as Rec

  const fullAddress = text(property?.full_address) ?? text(seed?.address) ?? text(fallbackAddress) ?? subjectAddress
  const { street, locality } = splitAddress(fullAddress)

  const sellerName =
    text(prospect?.name)
    ?? text(owner?.display_name)
    ?? text(convo?.seller_display_name)
    ?? text(seed?.sellerName)
    ?? street
    ?? 'Unknown seller'


  const contactability = useMemo(() => {
    if (compliance?.is_suppressed) return { label: 'Suppressed', tone: 'bad' as const }
    const raw = text(compliance?.contactability_status) ?? text(convo?.contactability_status) ?? text(phone?.contactability_status)
    if (!raw) return null
    const norm = raw.toLowerCase()
    if (norm.includes('do_not') || norm.includes('dnc')) return { label: 'Do not text', tone: 'bad' as const }
    if (norm.includes('wrong')) return { label: 'Wrong number', tone: 'warn' as const }
    if (norm.includes('contactable') || norm.includes('active')) return { label: 'Contactable', tone: 'good' as const }
    return { label: humanize(raw) ?? raw, tone: 'warn' as const }
  }, [compliance?.is_suppressed, compliance?.contactability_status, convo?.contactability_status, phone?.contactability_status])

  const leadState = threadKey ? {
    threadKey,
    lifecycle_stage: text(convo?.lifecycle_stage) ?? text(seed?.lifecycleStage),
    operational_status: text(convo?.operational_status) ?? text(seed?.operationalStatus),
    lead_temperature: text(convo?.lead_temperature) ?? text(seed?.leadTemperature),
    is_starred: (convo?.is_starred as boolean | null) ?? seed?.isStarred ?? null,
    is_pinned: (convo?.is_pinned as boolean | null) ?? seed?.isPinned ?? null,
    is_archived: (convo?.is_archived as boolean | null) ?? seed?.isArchived ?? null,
    snoozed_until: text(convo?.snoozed_until),
    manual_stage_lock: convo?.manual_stage_lock as boolean | null,
    manual_temperature_lock: convo?.manual_temperature_lock as boolean | null,
  } : null

  /* ── people ────────────────────────────────────────────────────────── */
  const identities = useMemo(() => {
    const rows: Array<{ role: IdentityRole; name: string; detail: string | null }> = []
    const deed = text(property?.owner_name as string) ?? text(owner?.owner_name)
    if (deed) rows.push({ role: 'deed_owner', name: deed, detail: text(property?.owner_location as string) })
    const entity = text(owner?.display_name)
    if (entity && entity !== deed) {
      rows.push({
        role: 'entity_owner',
        name: entity,
        detail: [plural(owner?.property_count, 'property', 'properties'),
          humanize(owner?.owner_type)].filter(Boolean).join(' · ') || null,
      })
    }
    const pros = text(prospect?.name)
    if (pros && pros !== deed && pros !== entity) {
      const bothTenures = Boolean(prospect?.likely_owner) && Boolean(prospect?.likely_renter)
      rows.push({
        role: 'prospect',
        name: pros,
        detail: [
          bothTenures
            ? 'Tenure unclear — flagged both owner and renter'
            : prospect?.likely_owner ? 'Likely owner'
              : prospect?.likely_renter ? 'Likely renter' : null,
          humanize(prospect?.occupation),
        ].filter(Boolean).join(' · ') || null,
      })
    }
    const phoneOwner = text(phone?.phone_owner)
    if (phoneOwner && ![deed, entity, pros].includes(phoneOwner)
      && !isCarrierName(phoneOwner, phone?.carrier)) {
      rows.push({ role: 'phone_owner', name: phoneOwner, detail: text(phone?.carrier) })
    }
    return rows
  }, [property, owner, prospect, phone])

  const activityEvents = useMemo(() => {
    const list = (d?.activity_timeline ?? []) as ActivityEvent[]
    return [...list].sort((a, b) =>
      new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
  }, [d?.activity_timeline])

  const decisionPropertyId = text(propertyId) ?? text(property?.property_id as string) ?? null

  // Only when there is genuinely nothing — no dossier and no seed.
  // A property-only arrival has no thread, so no dossier — the decision
  // surface still has a subject and renders on its own.
  if (!d && !seed && !decisionPropertyId) {
    return (
      <div className="msc-root msc-root--boot">
        <div className="msc-boot">
          <h1 className="msc-boot__name">{text(fallbackAddress) ?? 'Opening deal'}</h1>
          <SectionSkeleton />
          {error ? <p className="msc-error">{error}</p> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="msc-root msc-root--decision">
      <CommandHeader
        sellerName={sellerName}
        address={street}
        locality={locality}
        contactability={contactability}
        callGate={callGateFromDossier(d, text(phone?.number) ?? text(canonicalE164) ?? text(seed?.phone))}
        threadKey={threadKey ?? ''}
        leadState={leadState}
        onPatched={() => void refresh(undefined, { background: true })}
        onOpenConversation={onOpenConversation}
      />

      {/* 2 — DECISION SURFACE: Decision · Evidence · Model, from the canonical
          engine projection + lineage + records. Replaces the old snapshot,
          decision block, property/financial, transactions and comps sections. */}
      {engineRunning ? (
        <div className="msc-decision is-running">
          <div className="msc-engine-run">
            <h2 className="msc-engine-run__title">Running decision engine</h2>
            <ol className="msc-engine-run__stages">
              {ENGINE_STAGE_DISPLAY_ORDER.map((stage) => {
                const match = engineProgress.find((s) => s.stage === stage)
                const status = match?.status ?? 'pending'
                return (
                  <li key={stage} className={cls('msc-engine-stage', `is-${status}`)}>
                    <span className="msc-engine-stage__dot" aria-hidden="true" />
                    {ENGINE_STAGE_LABELS[stage]}
                  </li>
                )
              })}
            </ol>
          </div>
        </div>
      ) : null}
      {engineError ? <p className="msc-error">{humanize(engineError)}</p> : null}
      <DealDecisionSurface
        propertyId={decisionPropertyId}
        threadKey={threadKey ?? null}
        refreshKey={engineRuns}
        onOpenConversation={onOpenConversation}
        onRunEngine={threadKey ? () => void runDecisionEngine() : null}
        engineBusy={engineRunning}
        onSubject={(subj) => setSubjectAddress(subj.address)}
      />

      {/* 3b — WHAT THE HOUSE LOOKS LIKE.
          Street View is RESTORED here. This is mobile Deal Intelligence: one
          property, rendered only once the operator has opened the intel sheet
          (`m-intel-open`), so the single maps/api/streetview request it makes
          IS the operator's intent. That is the opposite of the Inbox and
          Pipeline card surfaces, where one render meant hundreds of requests.

          Reused rather than reimplemented: EntityGraphPropertyVisual already
          wraps InteractiveStreetViewPanorama with a static-image tier, a
          stated-reason tier and a per-URL result cache — so there is one Street
          View path in the app and one place a Maps quota change is handled. */}
      {fullAddress ? (
        <div className="msc-visual">
          <EntityGraphPropertyVisual
            address={fullAddress}
            lat={coord(property?.latitude)}
            lng={coord(property?.longitude)}
          />
        </div>
      ) : null}

      {/* 4 — CONTACT & CONVERSATION */}
      <Section
        id="contact"
        title="Contact & conversation"
        icon="message"
        defaultOpen
        summary={[
          phone?.sms_eligible ? 'SMS eligible' : null,
          text(phone?.carrier),
          text(phone?.contact_window),
        ].filter(Boolean).join(' · ') || null}
        loading={!detailReady && phase !== 'full'}
      >
        <FieldList>
          <Field label="Phone" value={text(phone?.number)} />
          <Field label="Type" value={phoneType(phone?.type)} />
          <Field label="Carrier" value={text(phone?.carrier)} />
          <Field label="Best window" value={text(phone?.contact_window)} />
          <Field label="Timezone" value={text(phone?.timezone)} />
          <Field label="Language" value={humanize(convo?.language ?? prospect?.language)} />
          <Field label="Seller state" value={humanize(convo?.seller_state)} />
          <Field label="Last reply" value={relativeTime(convo?.last_seller_response_at)} />
          <Field label="Next follow-up" value={shortDate(convo?.next_follow_up_at)} />
          <Field
            label="Suppressed"
            value={compliance?.is_suppressed ? (text(phone?.suppression_reason) ?? 'Yes') : null}
            tone="warn"
          />
        </FieldList>
        {text(convo?.latest_inbound_summary) ? (
          <figure className="msc-quote">
            <figcaption>Latest inbound</figcaption>
            <blockquote>{text(convo?.latest_inbound_summary)}</blockquote>
          </figure>
        ) : null}
      </Section>

      {/* 6 — OWNERSHIP / PEOPLE */}
      <Section
        id="people"
        title="Ownership & people"
        icon="users"
        summary={identities.length ? `${identities.length} ${identities.length === 1 ? 'identity' : 'identities'}` : null}
        empty={identities.length ? null : 'No owner or contact identities resolved.'}
        loading={!detailReady && phase !== 'full'}
      >
        <ul className="msc-identities">
          {identities.map((row) => (
            <li key={`${row.role}-${row.name}`} className="msc-identity">
              <span className="msc-identity__role">{IDENTITY_ROLES[row.role].label}</span>
              <strong className="msc-identity__name">{row.name}</strong>
              {row.detail ? <span className="msc-identity__detail">{row.detail}</span> : null}
              <span className="msc-identity__hint">{IDENTITY_ROLES[row.role].hint}</span>
            </li>
          ))}
        </ul>
        {identities.length > 1 ? (
          <p className="msc-note">
            These are separate records and may be different people. Nothing here asserts that they are the same person.
          </p>
        ) : null}
      </Section>

      {/* 9 — INTELLIGENCE */}
      <Section
        id="owner-intel"
        title="Portfolio intelligence"
        icon="briefing"
        summary={[
          plural(owner?.property_count, 'property', 'properties'),
          money(owner?.portfolio_value, { compact: true }),
        ].filter(Boolean).join(' · ') || null}
        loading={!detailReady && phase !== 'full'}
        empty={owner && Object.keys(owner).length ? null : 'No portfolio record.'}
      >
        <FieldList>
          <Field label="Properties" value={count(owner?.property_count)} />
          <Field label="Total units" value={count(owner?.total_units)} />
          <Field label="Portfolio value" value={money(owner?.portfolio_value)} />
          <Field label="Portfolio debt" value={money(owner?.portfolio_loan_balance)} />
          <Field label="Portfolio equity" value={money(owner?.portfolio_equity)} />
          <Field label="Liens across portfolio" value={count(owner?.active_lien_count)} />
          <Field label="Tax-delinquent properties" value={count(owner?.tax_delinquent_count)} />
          <Field label="Priority tier" value={humanize(owner?.priority_tier)} />
        </FieldList>
      </Section>

      <Section
        id="prospect-intel"
        title="Prospect intelligence"
        icon="user"
        summary={[
          prospect?.likely_owner && prospect?.likely_renter
            ? 'Tenure unclear'
            : prospect?.likely_owner ? 'Likely owner'
              : prospect?.likely_renter ? 'Likely renter' : null,
          humanize(prospect?.occupation_group),
        ].filter(Boolean).join(' · ') || null}
        loading={!detailReady && phase !== 'full'}
        empty={prospect && Object.keys(prospect).length ? null : 'No prospect record.'}
      >
        <FieldList>
          <Field label="Name" value={text(prospect?.name)} />
          <Field label="Best email" value={text(prospect?.best_email)} />
          <Field label="Occupation" value={humanize(prospect?.occupation)} />
          <Field label="Household income" value={text(prospect?.household_income)} />
          <Field label="Net assets" value={text(prospect?.net_asset_value)} />
          <Field label="Age" value={count(prospect?.age)} />
          <Field label="Marital status" value={humanize(prospect?.marital_status)} />
        </FieldList>
      </Section>

      {/* 10 — ACTIVITY */}
      <Section
        id="activity"
        title="Activity"
        icon="activity"
        summary={activityEvents.length ? relativeTime(activityEvents[0]?.timestamp) : null}
        loading={!detailReady && phase !== 'full'}
        empty={activityEvents.length ? null : 'No recorded activity.'}
      >
        <ol className="msc-timeline">
          {activityEvents.slice(0, 25).map((e, i) => (
            <li key={`${e.type}-${i}`} className="msc-timeline__item">
              <span className="msc-timeline__when">{relativeTime(e.timestamp)}</span>
              <div>
                <strong>{activityLabel(e)}</strong>
                {e.detail ? (
                  <span className="msc-timeline__detail">{humanizeEmbeddedTokens(e.detail)}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </Section>

      {!detailReady ? (
        <p className="msc-tail-status" role="status">Loading remaining intelligence…</p>
      ) : null}
      {error ? <p className="msc-error">{error}</p> : null}
      <div className="msc-safe-bottom" aria-hidden="true" />
    </div>
  )
}

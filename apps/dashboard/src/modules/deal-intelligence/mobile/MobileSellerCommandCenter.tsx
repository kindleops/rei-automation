import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../../shared/icons'
import type { IconName } from '../../../shared/icons'
import { useDealIntelligenceDossier } from '../../../domain/deal-intelligence/useDealIntelligenceDossier'
import type {
  ActivityEvent,
  CompRecord,
  DealIntelligenceDossier,
} from '../../../domain/deal-intelligence/deal-intelligence.types'
import { ENGINE_STAGE_DISPLAY_ORDER, ENGINE_STAGE_LABELS } from '../../../domain/deal-intelligence/deal-intelligence.types'
import { DealIntelligenceHeaderActions } from '../DealIntelligenceLeadStateBar'
import { MobileWorkflowControls } from './MobileWorkflowControls'
import {
  activityLabel,
  compExclusionLabel,
  count,
  countRecorded,
  humanize,
  humanizeEmbeddedTokens,
  IDENTITY_ROLES,
  isCarrierName,
  money,
  moneyRecorded,
  percent,
  phoneType,
  relativeTime,
  shortDate,
  splitAddress,
  text,
  year,
  type IdentityRole,
} from './mobile-seller-format'
import './mobile-seller-command.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/** `p_limit` on `get_comp_candidates_for_subject`. */
const COMP_CANDIDATE_CAP = 100
/** `MAX_SELECTED_COMPS` in the acquisition engine. */
const ENGINE_COMP_LIMIT = 12

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
  sellerName, address, locality, contactability, phoneNumber, threadKey, leadState, onPatched, onOpenConversation,
}: {
  sellerName: string
  address: string | null
  locality: string | null
  contactability: { label: string; tone: 'good' | 'warn' | 'bad' } | null
  phoneNumber: string | null
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
        <a
          className={cls('msc-action', !phoneNumber && 'is-disabled')}
          href={phoneNumber ? `tel:${phoneNumber}` : undefined}
          aria-disabled={!phoneNumber}
        >
          <Icon name="phone" /><span>Call</span>
        </a>
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

  const [showAllComps, setShowAllComps] = useState(false)
  const [showFullAnalysis, setShowFullAnalysis] = useState(false)

  /**
   * The decision block swaps between the completed summary and the taller/shorter
   * running view. That reflow pulled everything below it upward and moved the
   * operator's scroll position mid-run. Freezing the block's height for the
   * duration of the run keeps the page still.
   */
  const decisionRef = useRef<HTMLDivElement | null>(null)
  const restingHeightRef = useRef<number | null>(null)
  const [frozenDecisionHeight, setFrozenDecisionHeight] = useState<number | null>(null)
  const wasRunningRef = useRef(false)

  useLayoutEffect(() => {
    // Keep the resting height current so the click handler can freeze it.
    if (!engineRunning) {
      const h = decisionRef.current?.getBoundingClientRect().height ?? null
      if (h && h > 0) restingHeightRef.current = h
    }
    if (!engineRunning && wasRunningRef.current) setFrozenDecisionHeight(null)
    wasRunningRef.current = engineRunning
  })

  /**
   * Freezing the height in an effect is one frame too late — the running view
   * paints at its own (shorter) height first, and the scroller has already moved
   * by the time the effect applies `min-height`. Setting it in the same batch as
   * the run means the first running paint is already the right size. The blur
   * matters too: these buttons unmount on run, and Chrome scrolls the container
   * when the focused element disappears.
   */
  const startEngine = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur()
    const h = decisionRef.current?.getBoundingClientRect().height ?? restingHeightRef.current
    if (h && h > 0) setFrozenDecisionHeight(h)
    void runDecisionEngine()
  }

  const d = dossier as DealIntelligenceDossier | null
  const property = d?.property
  const snap = d?.property_snapshot
  const decision = d?.decision_snapshot
  const engine = d?.acquisition_decision as Rec
  const convo = d?.conversation_intelligence as Rec
  const phone = d?.phone as Rec
  const owner = d?.master_owner as Rec
  const prospect = d?.prospect as Rec
  const comps = d?.comps
  const compliance = d?.compliance as Rec
  // property_detail carries county assessment + plain-English debt/market
  // position that the mobile surface previously never read.
  const detail = d?.property_detail as Record<string, Record<string, unknown>> | undefined
  const valuation = detail?.valuation_debt

  const fullAddress = text(property?.full_address) ?? text(seed?.address) ?? text(fallbackAddress)
  const { street, locality } = splitAddress(fullAddress)

  const sellerName =
    text(prospect?.name)
    ?? text(owner?.display_name)
    ?? text(convo?.seller_display_name)
    ?? text(seed?.sellerName)
    ?? street
    ?? 'Unknown seller'

  const engineAvailable = text(engine?.status) === 'available'

  const contactability = useMemo(() => {
    if (compliance?.is_suppressed) return { label: 'Suppressed', tone: 'bad' as const }
    const raw = text(convo?.contactability_status) ?? text(phone?.contactability_status)
    if (!raw) return null
    const norm = raw.toLowerCase()
    if (norm.includes('do_not') || norm.includes('dnc')) return { label: 'Do not text', tone: 'bad' as const }
    if (norm.includes('wrong')) return { label: 'Wrong number', tone: 'warn' as const }
    if (norm.includes('contactable') || norm.includes('active')) return { label: 'Contactable', tone: 'good' as const }
    return { label: humanize(raw) ?? raw, tone: 'warn' as const }
  }, [compliance?.is_suppressed, convo?.contactability_status, phone?.contactability_status])

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

  /* ── comps ─────────────────────────────────────────────────────────── */
  const compStats = useMemo(() => {
    const records = (comps?.records ?? []) as CompRecord[]
    const usable = records.filter((r) => r.included)
    const excluded = records.filter((r) => !r.included)
    const reasons = new Map<string, number>()
    for (const r of excluded) {
      const label = compExclusionLabel(r.exclusion_reason)
      reasons.set(label, (reasons.get(label) ?? 0) + 1)
    }
    const screened = comps?.qualification?.candidates_found ?? records.length
    return {
      records, usable, excluded, screened,
      // `get_comp_candidates_for_subject` is called with p_limit: 100, so a
      // screened count of exactly 100 is a truncation, not a total.
      capped: screened >= COMP_CANDIDATE_CAP,
      reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]),
    }
  }, [comps])

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

  /* ── transactions: only events that actually exist in the record ────── */
  const timeline = useMemo(() => {
    const events: Array<{ when: string | null; sort: number; title: string; detail: string | null }> = []
    const push = (when: unknown, title: string, detail: string | null) => {
      const s = text(when)
      const ts = s ? new Date(s).getTime() : NaN
      events.push({ when: shortDate(s), sort: Number.isNaN(ts) ? -Infinity : ts, title, detail })
    }
    if (snap?.last_sale_date || snap?.last_sale_price) {
      push(snap?.last_sale_date, 'Last recorded sale', [
        moneyRecorded(snap?.last_sale_price) ?? 'Price not recorded',
        humanize(snap?.last_sale_document_type),
      ].filter(Boolean).join(' · ') || null)
    }
    if (snap?.tax_year) {
      push(`${snap.tax_year}-12-31`, `${snap.tax_year} property tax`, money(snap?.tax_amount))
    }
    if (snap?.default_date) push(snap.default_date, 'Default recorded', null)
    return events.filter((e) => e.when).sort((a, b) => b.sort - a.sort)
  }, [snap])

  const activityEvents = useMemo(() => {
    const list = (d?.activity_timeline ?? []) as ActivityEvent[]
    return [...list].sort((a, b) =>
      new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
  }, [d?.activity_timeline])

  /* ── nothing at all yet ─────────────────────────────────────────────── */
  // These two fields resolve to the same sentence on most records; showing both
  // put the identical line in the snapshot and again in the decision block.
  const nextAction = humanize(decision?.recommended_next_action)
  const conversationAngle = humanize(engine?.recommended_conversation_angle)

  const heroValue = money(decision?.value ?? property?.value ?? snap?.value ?? seed?.estimatedValue)
  const equityPct = percent(
    decision?.equity_percentage ?? property?.equity_percentage ?? snap?.equity_percentage ?? seed?.equityPercent,
  )

  // Only when there is genuinely nothing — no dossier and no seed.
  if (!d && !seed) {
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
    <div className="msc-root">
      <CommandHeader
        sellerName={sellerName}
        address={street}
        locality={locality}
        contactability={contactability}
        phoneNumber={text(phone?.number) ?? text(canonicalE164) ?? text(seed?.phone)}
        threadKey={threadKey ?? ''}
        leadState={leadState}
        onPatched={() => void refresh(undefined, { background: true })}
        onOpenConversation={onOpenConversation}
      />

      {/* 2 — DEAL SNAPSHOT */}
      <div className="msc-snapshot">
        <div className="msc-snapshot__hero">
          <span className="msc-snapshot__label">Estimated value</span>
          <strong className="msc-snapshot__value">{heroValue ?? '—'}</strong>
          {equityPct ? <span className="msc-snapshot__equity">{equityPct} equity</span> : null}
        </div>
        <div className="msc-snapshot__grid">
          <div className="msc-metric">
            <span>Equity</span>
            <strong>{money(decision?.equity_amount ?? snap?.equity_amount ?? seed?.equityAmount, { compact: true }) ?? '—'}</strong>
          </div>
          <div className="msc-metric">
            <span>Debt</span>
            <strong>{money(snap?.total_loan_balance ?? seed?.loanBalance, { compact: true }) ?? '—'}</strong>
          </div>
          <div className="msc-metric">
            <span>Repairs</span>
            <strong>{money(decision?.repair_estimate ?? snap?.repair_estimate ?? seed?.repairCost, { compact: true }) ?? '—'}</strong>
          </div>
        </div>
        {nextAction ? (
          <p className="msc-snapshot__next">
            <Icon name="target" />
            {nextAction}
          </p>
        ) : null}
      </div>

      {/* 3 — ACQUISITION DECISION */}
      <div
        ref={decisionRef}
        className={cls('msc-decision', engineRunning && 'is-running')}
        style={frozenDecisionHeight ? { minHeight: frozenDecisionHeight } : undefined}
      >
        {engineRunning ? (
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
        ) : engineAvailable ? (
          <>
            <div className="msc-decision__head">
              <h2>Acquisition decision</h2>
              {text(engine?.computed_at) ? (
                <span className="msc-decision__age">{relativeTime(engine?.computed_at)}</span>
              ) : null}
            </div>
            <div className="msc-decision__lead">
              <div>
                <span className="msc-decision__label">Strategy</span>
                <strong className="msc-decision__strategy">
                  {humanize(engine?.best_strategy) ?? '—'}
                </strong>
              </div>
              <div className="msc-decision__confidence">
                <span className="msc-decision__label">Confidence</span>
                <strong>{percent(engine?.confidence) ?? '—'}</strong>
              </div>
            </div>
            <div className="msc-decision__offers">
              <div className="msc-offer is-primary">
                <span>Recommended offer</span>
                <strong>{money(engine?.recommended_cash_offer) ?? '—'}</strong>
              </div>
              <div className="msc-offer">
                <span>Floor</span>
                <strong>{money(engine?.minimum_acceptable_offer) ?? '—'}</strong>
              </div>
            </div>
            {money(engine?.valuation_low) && money(engine?.valuation_high) ? (
              <p className="msc-decision__range">
                Valuation {money(engine?.valuation_low, { compact: true })} – {money(engine?.valuation_high, { compact: true })}
                {money(engine?.valuation_mid) ? <em> · mid {money(engine?.valuation_mid, { compact: true })}</em> : null}
              </p>
            ) : null}
            {conversationAngle && conversationAngle !== nextAction ? (
              <p className="msc-decision__angle">{conversationAngle}</p>
            ) : null}

            <button
              type="button"
              className="msc-decision__expand"
              onClick={() => setShowFullAnalysis((v) => !v)}
              aria-expanded={showFullAnalysis}
            >
              {showFullAnalysis ? 'Hide full analysis' : 'View full analysis'}
              <Icon name="chevron-down" />
            </button>
            {showFullAnalysis ? (
              <FieldList>
                <Field label="AOS" value={count(engine?.aos_score) ? `${count(engine?.aos_score)} / 1000` : null} />
                <Field label="Decision tier" value={humanize(engine?.decision_tier)} />
                <Field label="Expected fee" value={money(engine?.expected_assignment_fee)} />
                <Field label="Investor ceiling" value={money(engine?.investor_ceiling_mid)} />
                <Field label="Owner situation" value={humanize(engine?.owner_situation_primary)} />
                <Field label="Seller pressure" value={count(engine?.seller_financial_pressure_score)} />
                <Field label="Forced-sale pressure" value={count(engine?.forced_sale_pressure_score)} />
                <Field label="Foreclosure risk" value={count(engine?.foreclosure_risk_score)} />
                <Field label="Repair burden" value={count(engine?.repair_burden_score)} />
                <Field label="Tax pain" value={count(engine?.tax_pain_score)} />
                <Field label="Sells in 90d" value={percent(engine?.transaction_probability_90)} />
                <Field label="Sells in 180d" value={percent(engine?.transaction_probability_180)} />
              </FieldList>
            ) : null}
            <button
              type="button"
              className="msc-decision__rerun"
              onClick={startEngine}
            >
              Re-run engine
            </button>
          </>
        ) : !detailReady ? (
          <div className="msc-decision__cta">
            <h2>Acquisition decision</h2>
            <SectionSkeleton />
          </div>
        ) : (
          <div className="msc-decision__cta">
            <h2>Acquisition decision</h2>
            <p>Not analysed yet. The engine computes strategy, offer stack and valuation from qualified comps.</p>
            <button
              type="button"
              className="msc-primary-btn"
              onClick={startEngine}
            >
              <Icon name="zap" /> Run decision engine
            </button>
          </div>
        )}
        {engineError ? <p className="msc-error">{humanize(engineError)}</p> : null}
      </div>

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

      {/* 5 — PROPERTY & FINANCIAL */}
      <Section
        id="property"
        title="Property & financial"
        icon="layers"
        summary={[
          humanize(property?.property_type),
          count(property?.bedrooms) && `${count(property?.bedrooms)}bd`,
          count(property?.square_feet) && `${count(property?.square_feet)} sqft`,
        ].filter(Boolean).join(' · ') || null}
      >
        <h4 className="msc-subhead">Property</h4>
        <FieldList>
          <Field label="Type" value={humanize(property?.property_type)} />
          <Field label="Beds / baths" value={[countRecorded(property?.bedrooms), countRecorded(property?.bathrooms)].filter(Boolean).join(' / ') || null} />
          <Field label="Living area" value={countRecorded(property?.square_feet) ? `${countRecorded(property?.square_feet)} sqft` : null} />
          <Field label="Year built" value={year(property?.year_built)} />
          <Field label="Condition" value={humanize(property?.condition)} />
          <Field label="Units" value={count(property?.units)} />
          <Field label="Owned for" value={snap?.ownership_years ? `${Number(snap.ownership_years).toFixed(1)} yrs` : null} />
        </FieldList>

        <h4 className="msc-subhead">Loans</h4>
        {money(snap?.total_loan_balance) || money(snap?.total_loan_amount) ? (
          <FieldList>
            <Field label="Balance" value={money(snap?.total_loan_balance)} />
            <Field label="Original amount" value={money(snap?.total_loan_amount)} />
            <Field label="Monthly payment" value={money(snap?.total_loan_payment)} />
          </FieldList>
        ) : (
          <p className="msc-empty">No loan data on record.</p>
        )}
        <FieldList>
          <Field label="Debt position" value={text(valuation?.debt_position)} />
        </FieldList>
        <p className="msc-note">Aggregate position only — lender, rate, origination and maturity are not in the dataset.</p>

        <h4 className="msc-subhead">Assessment</h4>
        {money(valuation?.assessed_total_value) ? (
          <FieldList>
            <Field label={`Assessed total${valuation?.assessed_year ? ` (${year(valuation.assessed_year)})` : ''}`} value={money(valuation?.assessed_total_value)} />
            <Field label="Assessed land" value={money(valuation?.assessed_land_value)} />
            <Field label="Assessed improvements" value={money(valuation?.assessed_improvement_value)} />
          </FieldList>
        ) : (
          <p className="msc-empty">No county assessment on record.</p>
        )}

        <h4 className="msc-subhead">Liens & taxes</h4>
        <FieldList>
          <Field label="Active lien" value={snap?.active_lien ? 'Yes' : snap?.active_lien === false ? 'None on record' : null} tone={snap?.active_lien ? 'warn' : undefined} />
          <Field label="Tax delinquent" value={snap?.tax_delinquent ? 'Yes' : snap?.tax_delinquent === false ? 'No' : null} tone={snap?.tax_delinquent ? 'warn' : undefined} />
          <Field label="Annual tax" value={money(snap?.tax_amount)} />
        </FieldList>
        {snap?.active_lien ? (
          <p className="msc-note">Lien flag only — type, amount, position and holder are not captured upstream.</p>
        ) : null}

        <h4 className="msc-subhead">Market</h4>
        <FieldList>
          <Field label="Market status" value={text(valuation?.market_status)} />
          <Field label="Market" value={text(property?.market)} />
        </FieldList>
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

      {/* 7 — TRANSACTIONS */}
      <Section
        id="transactions"
        title="Transactions"
        icon="file-text"
        summary={timeline.length ? `${timeline.length} recorded ${timeline.length === 1 ? 'event' : 'events'}` : null}
        empty={timeline.length ? null : 'No recorded transaction events.'}
      >
        <ol className="msc-timeline">
          {timeline.map((e, i) => (
            <li key={`${e.title}-${i}`} className="msc-timeline__item">
              <span className="msc-timeline__when">{e.when}</span>
              <div>
                <strong>{e.title}</strong>
                {e.detail ? <span className="msc-timeline__detail">{e.detail}</span> : null}
              </div>
            </li>
          ))}
        </ol>
        <p className="msc-note">
          Only the last recorded sale and tax year are stored per property — full deed, transfer and mortgage history is not in the dataset.
        </p>
      </Section>

      {/* 8 — COMPARABLE SALES */}
      <Section
        id="comps"
        title="Comparable sales"
        icon="stats"
        defaultOpen={compStats.usable.length > 0}
        loading={!detailReady && phase !== 'full'}
        summary={comps
          ? `${compStats.usable.length} usable · ${compStats.screened}${compStats.capped ? '+' : ''} screened`
          : null}
      >
        {compStats.usable.length === 0 ? (
          <p className="msc-empty">
            No usable comps. {compStats.screened} candidates were screened.
          </p>
        ) : (
          <ul className="msc-comps">
            {(showAllComps ? compStats.usable : compStats.usable.slice(0, 4)).map((c) => (
              <li key={c.id ?? c.address} className="msc-comp">
                <div className="msc-comp__row">
                  <strong>{moneyRecorded(c.sale_price) ?? 'Price n/a'}</strong>
                  <span>{shortDate(c.sale_date)}</span>
                </div>
                <p className="msc-comp__addr">{c.address}</p>
                <p className="msc-comp__meta">
                  {[
                    c.distance_miles != null ? `${Number(c.distance_miles).toFixed(1)} mi` : null,
                    countRecorded(c.sqft) ? `${countRecorded(c.sqft)} sqft` : null,
                    countRecorded(c.bedrooms) ? `${countRecorded(c.bedrooms)}bd` : null,
                    year(c.year_built) ? `built ${year(c.year_built)}` : null,
                    moneyRecorded(c.ppsf) ? `${moneyRecorded(c.ppsf)}/sqft` : null,
                  ].filter(Boolean).join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        )}

        {compStats.usable.length > 4 ? (
          <button type="button" className="msc-link-btn" onClick={() => setShowAllComps((v) => !v)}>
            {showAllComps ? 'Show fewer' : `Show all ${compStats.usable.length} usable comps`}
          </button>
        ) : null}

        {compStats.capped ? (
          <p className="msc-note">
            Candidate search is capped at {COMP_CANDIDATE_CAP}, so more comparable sales may exist.
            The acquisition engine ranks these and prices off its top {ENGINE_COMP_LIMIT}.
          </p>
        ) : null}

        {compStats.reasons.length ? (
          <details className="msc-reasons">
            <summary>{compStats.excluded.length} screened out</summary>
            <ul>
              {compStats.reasons.map(([label, n]) => (
                <li key={label}><span>{label}</span><strong>{n}</strong></li>
              ))}
            </ul>
          </details>
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

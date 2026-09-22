import { useMemo, useState, type ReactNode } from 'react'
import { MobileSheet } from '../../mobile/MobileSheet'
import { Icon, type IconName } from '../../../shared/icons'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

/**
 * PROPERTY INTELLIGENCE — the mobile dossier for the thread in view.
 *
 * PRESENTATION AND ORCHESTRATION ONLY. Every value here already travels on the
 * selected thread row (the inbox list returns 144 fields per thread) or on the
 * intelligence record the Conversation has already loaded. This component
 * fetches nothing, derives no new intelligence, and mutates nothing.
 *
 * WHY IT READS FROM THE ROW RATHER THAN /inbox/thread-dossier: that endpoint
 * answers with a different shape from the client's ThreadDossier type -- a
 * `diagnostics` envelope carrying seller_owner_intelligence, automation_decision
 * and automation_timeline -- and wiring a second shape in would be new
 * plumbing for data the Conversation already holds. When the caller does have
 * an intelligence record it is merged in; when it does not, the row alone is
 * enough for every section below.
 *
 * SEQUENCED, NOT DUMPED. The first screen answers "what is this property and
 * where is the deal", which is what an operator opens this for. Everything
 * heavier is collapsed: an accordion directory expanded by default is the
 * desktop habit this replaces.
 */

type Row = Record<string, unknown>

const clean = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim())

const pick = (row: Row, ...keys: string[]): string => {
  for (const k of keys) {
    const v = clean(row[k])
    if (v && v !== 'null' && v !== 'undefined') return v
  }
  return ''
}

/**
 * A number, or null.
 *
 * `zeroIsAbsent` matters for money: the canary thread carries
 * estimated_value=297000 but net_asset_value=0, and reading the fallback
 * produced a confident "$0" beside a real $297K property. A zero valuation is
 * not a valuation, so for those fields it is treated as missing and the fact
 * simply does not render -- which is the truthful answer.
 */
const num = (row: Row, keys: string[], zeroIsAbsent = false): number | null => {
  for (const k of keys) {
    const raw = row[k]
    if (raw === null || raw === undefined || raw === '') continue
    const n = Number(String(raw).replace(/[$,\s%]/g, ''))
    if (!Number.isFinite(n)) continue
    if (zeroIsAbsent && n === 0) continue
    return n
  }
  return null
}

const money = (n: number | null): string => {
  if (n === null) return ''
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1_000)}K`
  return `$${Math.round(n)}`
}

const whenLabel = (value: string): string => {
  if (!value) return ''
  const ms = new Date(value).getTime()
  if (!Number.isFinite(ms)) return ''
  const diff = Date.now() - ms
  const abs = Math.abs(diff)
  const mins = Math.round(abs / 60_000)
  if (mins < 60) return diff >= 0 ? `${mins}m ago` : `in ${mins}m`
  const hours = Math.round(abs / 3_600_000)
  if (hours < 48) return diff >= 0 ? `${hours}h ago` : `in ${hours}h`
  const days = Math.round(abs / 86_400_000)
  return diff >= 0 ? `${days}d ago` : `in ${days}d`
}

/** A labelled fact. Renders nothing when there is no value -- §3 truthful empty. */
const Fact = ({ label, value }: { label: string; value: ReactNode }) => {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className="nx-pis__fact">
      <span className="nx-pis__fact-label">{label}</span>
      <span className="nx-pis__fact-value">{value}</span>
    </div>
  )
}

/** A collapsed section. §2.F — deeper intelligence is disclosed, never dumped. */
const Section = ({
  title, subtitle, defaultOpen = false, children,
}: { title: string; subtitle?: string; defaultOpen?: boolean; children: ReactNode }) => {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={cls('nx-pis__section', open && 'is-open')}>
      <button
        type="button"
        className="nx-pis__section-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="nx-pis__section-title">{title}</span>
        {subtitle ? <span className="nx-pis__section-sub">{subtitle}</span> : null}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} strokeWidth={2} />
      </button>
      {open ? <div className="nx-pis__section-body">{children}</div> : null}
    </section>
  )
}

export interface PropertyIntelligenceAction {
  id: string
  label: string
  icon: IconName
  onSelect: () => void
}

export interface PropertyIntelligenceSheetProps {
  open: boolean
  onClose: () => void
  /** The selected thread row, exactly as the inbox list returns it. */
  thread: Row | null
  /** Whatever intelligence the Conversation already resolved, if any. */
  intelligence?: Row | null
  /** True while the Conversation is still hydrating this thread. */
  loading?: boolean
  /** Set when the thread could not be read -- rendered as an error, not as empty. */
  error?: string | null
  onRetry?: () => void
  /**
   * §4 — only actions with real handlers. The caller supplies them, so this
   * component can never paint a control that does nothing.
   */
  actions?: PropertyIntelligenceAction[]
}

export const PropertyIntelligenceSheet = ({
  open, onClose, thread, intelligence = null, loading = false, error = null, onRetry, actions = [],
}: PropertyIntelligenceSheetProps) => {
  /*
   * The thread row carries a nested `property_data` blob alongside its flat
   * columns, and the two do not always agree: the flat `estimated_value`
   * arrives as 0 on the client while property_data.estimated_value holds the
   * real 297000. Flattening the blob UNDER the row means a populated nested
   * value is used when the flat column is missing, while a genuine flat value
   * still wins. `prospect_data` is folded in for the same reason.
   */
  const row = useMemo<Row>(() => {
    const t = (thread ?? {}) as Row
    const nested = (key: string): Row => {
      const v = t[key]
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {}
    }
    /*
     * "Empty" has to include a STRING zero. `v !== 0` let "0" through, so the
     * flat column re-overwrote property_data's real 172000 with a stringified
     * zero and the valuation vanished again after the spread order was already
     * corrected. Compare numerically for anything number-like.
     */
    const isEmpty = (v: unknown) =>
      v === null || v === undefined || v === ''
      || (typeof v !== 'boolean' && v !== null && !Array.isArray(v) && typeof v !== 'object'
          && Number.isFinite(Number(v)) && Number(v) === 0)
    const flat = Object.fromEntries(Object.entries(t).filter(([, v]) => !isEmpty(v)))
    /*
     * ORDER IS THE WHOLE TRICK. The flat row is laid down FIRST (zeros and
     * all), the nested blobs overwrite it, and the row's genuinely non-zero
     * values are re-applied last. Spreading the flat row after the blobs
     * clobbered property_data.estimated_value=172000 with the flat column's 0
     * -- which is exactly how this rendered a property with no valuation.
     */
    return { ...(intelligence ?? {}), ...t, ...nested('prospect_data'), ...nested('property_data'), ...flat }
  }, [thread, intelligence])

  const address = pick(row, 'property_address_full', 'propertyAddressFull', 'property_address', 'propertyAddress', 'address')
  const city = pick(row, 'property_address_city', 'propertyAddressCity', 'city')
  const state = pick(row, 'property_address_state', 'propertyAddressState', 'state')
  const zip = pick(row, 'property_address_zip', 'zip')
  const locality = [city, state].filter(Boolean).join(', ') + (zip ? ` ${zip}` : '')

  const seller = pick(row, 'seller_display_name', 'sellerDisplayName', 'owner_display_name', 'owner_name', 'ownerName', 'prospect_full_name')
  const propertyType = pick(row, 'property_type')
  const units = num(row, ['units_count', 'unitsCount', 'units', 'number_of_units'], true)
  const beds = num(row, ['beds'], true); const baths = num(row, ['baths'], true); const sqft = num(row, ['sqft'], true)
  /*
   * Read the nested blob EXPLICITLY rather than relying on spread order.
   * The flat column arrives as a zero (sometimes a string "0") and kept
   * clobbering property_data's real value through three different merge
   * orderings. An explicit second lookup cannot be undone by a later spread.
   */
  const propertyBlob = (row.property_data && typeof row.property_data === 'object'
    ? row.property_data : {}) as Row
  const value = num(row, ['estimated_value', 'estimatedValue', 'net_asset_value', 'netAssetValue'], true)
    ?? num(propertyBlob, ['estimated_value', 'estimatedValue'], true)
  const equityPct = num(row, ['equity_percent', 'equityPercent'], true)
    ?? num(propertyBlob, ['equity_percent', 'equityPercent'], true)
  const equityAmt = num(row, ['equity_amount', 'equityAmount'], true)
    ?? num(propertyBlob, ['equity_amount', 'equityAmount'], true)
  const stage = pick(row, 'seller_stage', 'sellerStage', 'current_stage', 'currentStage', 'lifecycle_stage', 'acquisition_stage')
  const bucket = pick(row, 'inbox_bucket', 'inboxBucket', 'inbox_category', 'inboxCategory')

  // §2.B — who owns the next action, from canonical state only.
  const nextScheduled = pick(row, 'next_scheduled_for', 'nextScheduledFor', 'next_action_at', 'follow_up_at', 'followUpAt')
  const lastInbound = pick(row, 'last_inbound_at', 'lastInboundAt')
  const lastOutbound = pick(row, 'last_outbound_at', 'lastOutboundAt')
  const automationStatus = pick(row, 'automation_status', 'automation_lane')
  const delivery = pick(row, 'latest_delivery_status', 'latestDeliveryStatus', 'delivery_status', 'deliveryStatus')
  const suppressed = row.is_suppressed === true || bucket === 'suppressed'

  const owner = useMemo(() => {
    if (suppressed) return { who: 'Nobody — contact suppressed', detail: 'This contact has opted out.' }
    if (nextScheduled) return { who: 'Scheduled send', detail: `Next send ${whenLabel(nextScheduled)}` }
    if (bucket === 'new_replies') return { who: 'You', detail: 'The seller replied and is awaiting a response.' }
    if (bucket === 'priority') return { who: 'You', detail: 'High-intent thread flagged for operator attention.' }
    if (bucket === 'needs_review') return { who: 'You', detail: 'Flagged for manual review.' }
    if (bucket === 'waiting') return { who: 'Waiting on seller', detail: lastOutbound ? `Sent ${whenLabel(lastOutbound)}` : 'Awaiting a reply.' }
    if (bucket === 'follow_up' || automationStatus) return { who: 'Automated follow-up', detail: automationStatus || 'Follow-up sequence owns the next action.' }
    if (delivery === 'failed' || String(delivery).includes('fail')) return { who: 'You', detail: 'The last send failed.' }
    return { who: 'No action pending', detail: '' }
  }, [suppressed, nextScheduled, bucket, lastOutbound, automationStatus, delivery])

  const title = address || seller || 'Property intelligence'

  return (
    <MobileSheet
      open={open}
      onClose={onClose}
      title={title}
      subtitle={locality || seller || undefined}
      height="full"
      className="nx-pis"
    >
      {error ? (
        /* §3 — an error is an error, never an empty dossier. */
        <div className="nx-pis__error" role="status">
          <strong>Couldn’t load this property</strong>
          <span>{error}</span>
          <span className="nx-pis__error-note">Nothing is shown because nothing could be read.</span>
          {onRetry ? <button type="button" className="nx-pis__retry" onClick={onRetry}>Try again</button> : null}
        </div>
      ) : loading && !address && !seller ? (
        <div className="nx-pis__skeleton" aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => <div key={i} className="nx-pis__skeleton-row shimmer" />)}
        </div>
      ) : (
        <>
          {/* ── A. OVERVIEW ─────────────────────────────────────────────── */}
          <div className="nx-pis__overview">
            <div className="nx-pis__headline">
              {value !== null ? <span className="nx-pis__value">{money(value)}</span> : null}
              {equityPct !== null ? <span className="nx-pis__equity">{Math.round(equityPct)}% equity</span> : null}
            </div>
            <div className="nx-pis__facts">
              <Fact label="Type" value={propertyType} />
              <Fact label="Units" value={units !== null && units > 1 ? units : ''} />
              <Fact label="Beds" value={beds} />
              <Fact label="Baths" value={baths} />
              <Fact label="Sq ft" value={sqft !== null ? sqft.toLocaleString() : ''} />
              <Fact label="Stage" value={stage} />
            </div>
            {seller ? <div className="nx-pis__seller"><Icon name="user" size={14} /> {seller}</div> : null}
          </div>

          {/* ── B. CURRENT OPPORTUNITY ──────────────────────────────────── */}
          <section className="nx-pis__now">
            <h3 className="nx-pis__now-label">Next action</h3>
            <p className="nx-pis__now-owner">{owner.who}</p>
            {owner.detail ? <p className="nx-pis__now-detail">{owner.detail}</p> : null}
          </section>

          {/* ── C. CONTACT + OWNERSHIP ──────────────────────────────────── */}
          <Section title="Contact & ownership" defaultOpen>
            <div className="nx-pis__facts is-stacked">
              <Fact label="Seller" value={seller} />
              <Fact label="Owner" value={pick(row, 'owner_name', 'owner_display_name')} />
              <Fact label="Owner type" value={pick(row, 'owner_type_guess')} />
              <Fact label="Phone" value={pick(row, 'display_phone', 'best_phone', 'canonical_e164', 'seller_phone')} />
              <Fact label="Email" value={pick(row, 'prospect_best_email')} />
              <Fact label="Prospect" value={pick(row, 'prospect_full_name', 'prospect_name')} />
            </div>
          </Section>

          {/* ── D. PROPERTY + FINANCIAL ─────────────────────────────────── */}
          <Section title="Property & financial">
            <div className="nx-pis__facts is-stacked">
              <Fact label="Estimated value" value={money(value)} />
              <Fact label="Equity" value={equityAmt !== null ? money(equityAmt) : (equityPct !== null ? `${Math.round(equityPct)}%` : '')} />
              <Fact label="Net asset value" value={money(num(row, ['net_asset_value', 'netAssetValue'], true))} />
              <Fact label="Year built" value={pick(row, 'year_built')} />
              <Fact label="Condition" value={pick(row, 'building_condition')} />
              <Fact label="Portfolio value" value={money(num(row, ['portfolio_total_value', 'portfolioTotalValue'], true))} />
              <Fact label="Portfolio units" value={num(row, ['portfolio_total_units', 'portfolioTotalUnits'], true)} />
              <Fact label="Market" value={pick(row, 'market')} />
            </div>
          </Section>

          {/* ── E. RECENT ACTIVITY ──────────────────────────────────────── */}
          <Section title="Recent activity">
            <div className="nx-pis__facts is-stacked">
              <Fact label="Messages" value={num(row, ['message_count', 'messageCount'])} />
              <Fact label="Inbound" value={num(row, ['inbound_count', 'inboundCount'])} />
              <Fact label="Outbound" value={num(row, ['outbound_count', 'outboundCount'])} />
              <Fact label="Last inbound" value={whenLabel(lastInbound)} />
              <Fact label="Last outbound" value={whenLabel(lastOutbound)} />
              <Fact label="Delivery" value={delivery} />
              <Fact label="Next scheduled" value={whenLabel(nextScheduled)} />
            </div>
          </Section>

          {/* ── F. DEEPER INTELLIGENCE ──────────────────────────────────── */}
          {actions.length > 0 ? (
            <Section title="Deeper intelligence" subtitle={`${actions.length}`}>
              <div className="nx-pis__actions">
                {actions.map((a) => (
                  <button key={a.id} type="button" className="nx-pis__action" onClick={() => { onClose(); a.onSelect() }}>
                    <span className="nx-pis__action-icon"><Icon name={a.icon} size={17} strokeWidth={1.7} /></span>
                    <span>{a.label}</span>
                    <Icon name="chevron-right" size={15} strokeWidth={2} />
                  </button>
                ))}
              </div>
            </Section>
          ) : null}
        </>
      )}
    </MobileSheet>
  )
}

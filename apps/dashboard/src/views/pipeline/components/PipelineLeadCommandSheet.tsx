import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { useDealIntelligenceDossier } from '../../../domain/deal-intelligence/useDealIntelligenceDossier'
import { MobileWorkflowControls } from '../../../modules/deal-intelligence/mobile/MobileWorkflowControls'
import { useStreetViewAvailability } from '../../map/seller-card/use-street-view-availability'
import { useLeadThreadMessages } from './use-lead-thread-messages'
import type { PipelineOpportunity } from '../../../domain/pipeline/pipeline-opportunity.types'
import './pipeline-lead-command-sheet.css'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
type Rec = Record<string, unknown> | null | undefined

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s && s !== 'null' && s !== 'undefined' ? s : null
}
const humanize = (v: unknown): string | null => {
  const s = text(v)
  if (!s) return null
  if (!/[_-]/.test(s) && /[a-z]/.test(s)) return s
  const w = s.replace(/[_-]+/g, ' ').toLowerCase().trim()
  return w.charAt(0).toUpperCase() + w.slice(1)
}
const money = (v: unknown, compact = true): string | null => {
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return null
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    notation: compact && Math.abs(n) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: compact && Math.abs(n) >= 1_000_000 ? 1 : 0,
  }).format(n)
}
const pct = (v: unknown): string | null => {
  const n = Number(v)
  return Number.isFinite(n) ? `${Math.round(n)}%` : null
}
const rel = (v: unknown): string | null => {
  const s = text(v)
  if (!s) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  const mins = Math.round((Date.now() - d.getTime()) / 60_000)
  if (mins < 60) return `${Math.max(1, mins)}m ago`
  const h = Math.round(mins / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.round(h / 24)
  return days < 30 ? `${days}d ago` : `${Math.round(days / 30)}mo ago`
}

export interface PipelineLeadCommandSheetProps {
  opp: PipelineOpportunity
  onClose: () => void
  onOpenConversation: (threadKey: string) => void
  onOpenFullDetail: (opp: PipelineOpportunity) => void
  onWorkflowPatched?: () => void
}

/**
 * Lead Command Sheet.
 *
 * The intermediate surface between a Pipeline row (scan) and Seller Detail
 * (exhaustive dossier). It answers "should I act on this lead, and how" —
 * deliberately NOT a second dossier.
 *
 * Everything here composes existing canonical sources rather than adding new
 * ones: `useDealIntelligenceDossier` (summary phase first, so the sheet paints
 * from row seed then hydrates), `MobileWorkflowControls` for canonical PATCH,
 * and the Street View metadata gate from the map card.
 */
export function PipelineLeadCommandSheet({
  opp, onClose, onOpenConversation, onOpenFullDetail, onWorkflowPatched,
}: PipelineLeadCommandSheetProps) {
  const threadKey = text(opp.primary_thread_key)
  const propertyId = text(opp.primary_property_id) ?? text((opp as unknown as Rec)?.property_id as string)

  const { dossier, error: dossierError } = useDealIntelligenceDossier(
    { threadKey: threadKey ?? undefined, propertyId: propertyId ?? undefined },
    { enabled: Boolean(threadKey) },
  )

  // The SUMMARY payload already carries conversation_intelligence,
  // acquisition_decision and property_snapshot — it lands in ~1-2s while the full
  // build takes ~9s. Gating these blocks on `detailReady` (full) is what left them
  // skeletonised long enough to look permanently broken.
  const hasCore = Boolean(dossier)
  const d = dossier as Rec
  const property = (d?.property ?? null) as Rec
  const snap = (d?.property_snapshot ?? null) as Rec
  const convo = (d?.conversation_intelligence ?? null) as Rec
  const phone = (d?.phone ?? null) as Rec

  // Loads independently of the dossier — the sheet never waits on it.
  const thread = useLeadThreadMessages(threadKey, { enabled: Boolean(threadKey) })

  // The exchange, most recent last, capped at 3. More than that is the Inbox's
  // job; this is enough to know what was actually said before acting.
  const recent = useMemo(() => thread.messages.slice(-3), [thread.messages])
  const lastInbound = useMemo(
    () => [...thread.messages].reverse().find((m) => m.direction === 'inbound') ?? null,
    [thread.messages],
  )

  // `conversation_intelligence.last_seller_response_at` is null on threads that
  // demonstrably have inbound messages, so the real message timestamp is the
  // more trustworthy source when we have it.
  const sellerRepliedAt = lastInbound?.at ?? (convo?.last_seller_response_at as string | undefined) ?? null

  /** Intent/sentiment come only from the dossier — never inferred here. */
  const hasReading = Boolean(
    humanize(convo?.latest_intent as string)
    ?? humanize(convo?.reply_intent as string)
    ?? humanize(convo?.sentiment as string),
  )

  const cadence = useMemo(() => {
    const ms = thread.medianReplyMs
    if (ms === null || !Number.isFinite(ms) || ms <= 0) return null
    const mins = Math.round(ms / 60_000)
    if (mins < 60) return `${Math.max(1, mins)}m`
    const hrs = ms / 3_600_000
    if (hrs < 48) return `${hrs < 10 ? hrs.toFixed(1) : Math.round(hrs)}h`
    return `${Math.round(hrs / 24)}d`
  }, [thread.medianReplyMs])
  const engine = (d?.acquisition_decision ?? null) as Rec
  const compliance = (d?.compliance ?? null) as Rec

  // Row data is the seed: identity paints immediately, heavier blocks hydrate.
  const seller = text(opp.seller_display_name)
  const address = text(opp.property_address_full) ?? text(property?.full_address as string)
  const title = seller ?? address ?? 'Unidentified lead'

  const heroUrl = text(property?.street_view_url as string) ?? text((opp as unknown as Rec)?.streetview_image as string)
  const heroState = useStreetViewAvailability(heroUrl)

  const suppressed = Boolean(compliance?.is_suppressed) || Boolean(convo?.suppressed)
  const smsEligible = convo?.sms_eligible === true || phone?.sms_eligible === true
  const phoneNumber = text(phone?.number as string) ?? text(opp.primary_thread_key)

  /** One deterministic line: workflow + conversation + timing. No generated prose. */
  const attention = useMemo(() => {
    const bits: string[] = []
    if (suppressed) bits.push('Contact suppressed')
    else if (text(convo?.seller_state as string)?.toLowerCase().includes('needs_response')) bits.push('Needs reply')
    const due = text((opp as unknown as Rec)?.next_follow_up_at as string)
    if (due) {
      const dd = new Date(due)
      if (!Number.isNaN(dd.getTime()) && dd.getTime() <= Date.now()) bits.push('Follow-up due')
    }
    // Prefer the real inbound timestamp; `last_contact_at` covers our own
    // outbound too, so calling it a "reply" would be wrong on outreach-only
    // threads. Label it for what it is when that is all we have.
    const replied = rel(sellerRepliedAt)
    const touched = rel(opp.last_contact_at)
    if (replied && bits.length < 2) bits.push(`Last reply ${replied}`)
    else if (touched && bits.length < 2) bits.push(`Last activity ${touched}`)
    const eq = Number(snap?.equity_percentage ?? property?.equity_percentage)
    if (Number.isFinite(eq) && eq >= 80 && bits.length < 3) bits.push('High equity')
    return bits.length ? bits.join(' · ') : null
  }, [suppressed, convo, opp, snap, property])

  const leadState = threadKey ? {
    threadKey,
    lifecycle_stage: text((opp as unknown as Rec)?.canonical_lifecycle_stage as string) ?? text(convo?.lifecycle_stage as string),
    operational_status: text((opp as unknown as Rec)?.canonical_operational_status as string) ?? text(convo?.operational_status as string),
    lead_temperature: text((opp as unknown as Rec)?.canonical_lead_temperature as string) ?? text(convo?.lead_temperature as string),
  } : null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const [showAllSignals, setShowAllSignals] = useState(false)

  const signals = useMemo(() => {
    const out: string[] = []
    const yrs = Number(snap?.ownership_years)
    if (Number.isFinite(yrs) && yrs > 0) out.push(`Owned ${yrs.toFixed(1)} yrs`)
    if (text(property?.owner_location as string)?.toLowerCase().includes('absentee')) out.push('Absentee owner')
    if (snap?.active_lien) out.push('Active lien')
    if (snap?.tax_delinquent) out.push('Tax delinquent')
    const bal = Number(snap?.total_loan_balance)
    if (Number.isFinite(bal) && bal === 0) out.push('Free and clear')
    const eq = Number(snap?.equity_percentage ?? property?.equity_percentage)
    if (Number.isFinite(eq) && eq >= 80) out.push('High equity')
    return out
  }, [snap, property])

  return (
    <div className="plcs-root" role="dialog" aria-modal="true" aria-label={`Lead command — ${title}`}>
      <button type="button" className="plcs-scrim" aria-label="Close" onClick={onClose} />
      <div className="plcs-sheet">
        <div className="plcs-grip" aria-hidden="true" />

        <div className="plcs-scroll">
          {/* HERO — restrained; metadata-gated so Google's apology image never ships */}
          {heroState === 'available' && heroUrl ? (
            <div className="plcs-hero" style={{ backgroundImage: `url(${heroUrl})` }} aria-hidden="true" />
          ) : heroState === 'loading' ? (
            <div className="plcs-hero is-loading" aria-hidden="true" />
          ) : null}

          <header className="plcs-identity">
            <h2 className="plcs-title">{title}</h2>
            {seller && address ? <p className="plcs-addr">{address}</p> : null}
            {!seller && address ? <p className="plcs-addr is-note">Seller name unavailable</p> : null}
            <p className="plcs-facts">
              {[
                humanize(property?.property_type as string),
                Number(property?.bedrooms) ? `${property?.bedrooms}bd` : null,
                Number(property?.square_feet) ? `${Number(property?.square_feet).toLocaleString()} sqft` : null,
              ].filter(Boolean).join(' · ')}
            </p>
          </header>

          {leadState ? (
            <div className="plcs-workflow">
              <MobileWorkflowControls data={leadState} onPatched={onWorkflowPatched} />
            </div>
          ) : null}

          {/* Call and Message are the operator's real actions; Full Detail is an
              escape hatch and lives in the footer, not beside them. */}
          <div className="plcs-actions">
            <a className={cls('plcs-act', !phoneNumber && 'is-off')} href={phoneNumber ? `tel:${phoneNumber}` : undefined}>
              <Icon name="phone" /><span>Call</span>
            </a>
            <button type="button" className={cls('plcs-act', !threadKey && 'is-off')}
              onClick={() => threadKey && onOpenConversation(threadKey)} disabled={!threadKey}>
              <Icon name="message" /><span>Message</span>
            </button>
          </div>

          {attention ? (
            <p className={cls('plcs-attention', suppressed && 'is-blocked')}>{attention}</p>
          ) : null}

          {/* CONVERSATION */}
          <section className="plcs-block">
            <h3>Conversation</h3>
            {!hasCore ? (
              dossierError
                ? <p className="plcs-empty">Couldn’t load conversation.</p>
                : <div className="plcs-skel"><span /><span /></div>
            ) : recent.length || text(convo?.latest_inbound_summary as string) || text(convo?.seller_state as string) ? (
              <>
                {/* What the seller actually said is the point of this surface. */}
                {/* The seller's own words, verbatim from the thread when we have
                    it — the dossier summary is the fallback, not the source. */}
                {lastInbound?.body || text(convo?.latest_inbound_summary as string) ? (
                  <blockquote className="plcs-said">
                    “{lastInbound?.body ?? text(convo?.latest_inbound_summary as string)}”
                    {rel(sellerRepliedAt) ? <cite>Seller · {rel(sellerRepliedAt)}</cite> : null}
                  </blockquote>
                ) : null}

                {/* Preceding exchange, so the quote above has context. Only the
                    messages before the quoted one — repeating it would read as a
                    duplicate. */}
                {recent.length > 1 ? (
                  <ol className="plcs-thread">
                    {recent
                      .filter((m) => !(lastInbound && m.id === lastInbound.id))
                      .map((m) => (
                        <li key={m.id} className={cls('plcs-msg', `is-${m.direction}`)}>
                          <span className="plcs-msg__who">{m.direction === 'inbound' ? 'Seller' : 'You'}</span>
                          <p className="plcs-msg__body">{m.body}</p>
                        </li>
                      ))}
                  </ol>
                ) : thread.loading ? (
                  <div className="plcs-skel"><span /></div>
                ) : null}

                {/* The reading strip needs a trusted intent or sentiment to
                    justify itself. Cadence alone rendered here read as a stray
                    section heading, so on its own it joins the meta line. */}
                {[humanize(convo?.latest_intent as string) ?? humanize(convo?.reply_intent as string),
                  humanize(convo?.sentiment as string)].some(Boolean) ? (
                  <div className="plcs-read">
                    {(humanize(convo?.latest_intent as string) ?? humanize(convo?.reply_intent as string)) ? (
                      <div><span>Intent</span><strong>{humanize(convo?.latest_intent as string) ?? humanize(convo?.reply_intent as string)}</strong></div>
                    ) : null}
                    {humanize(convo?.sentiment as string) ? (
                      <div><span>Sentiment</span><strong>{humanize(convo?.sentiment as string)}</strong></div>
                    ) : null}
                    {/* Only shown with >=2 measured outbound->inbound pairs; one
                        gap is an anecdote, not a cadence. */}
                    {cadence ? (
                      <div><span>Replies in</span><strong>{cadence}</strong></div>
                    ) : null}
                  </div>
                ) : null}

                <p className="plcs-meta">
                  {[
                    humanize(convo?.language as string),
                    suppressed ? 'Suppressed' : smsEligible ? 'SMS eligible' : null,
                    text(phone?.contact_window as string),
                    !hasReading && cadence ? `Replies in ~${cadence}` : null,
                  ].filter(Boolean).join(' · ')}
                </p>

                {threadKey ? (
                  <button type="button" className="plcs-link" onClick={() => onOpenConversation(threadKey)}>
                    Open conversation →
                  </button>
                ) : null}
              </>
            ) : (
              <p className="plcs-empty">No conversation yet.</p>
            )}
          </section>

          {/* DEAL */}
          <section className="plcs-block">
            <h3>Deal</h3>
            {!hasCore ? (
              dossierError
                ? <p className="plcs-empty">Couldn’t load deal data.</p>
                : <div className="plcs-skel"><span /><span /></div>
            ) : (
              <>
                <dl className="plcs-facts-grid">
                  {[
                    ['Value', money(property?.value ?? snap?.value)],
                    ['Equity', money(snap?.equity_amount ?? property?.equity_amount)],
                    ['Debt', money(snap?.total_loan_balance)],
                    ['Repairs', money(snap?.repair_estimate ?? property?.repair_estimate)],
                  ].filter(([, v]) => v).map(([k, v]) => (
                    <div key={k as string}><dt>{k}</dt><dd>{v}</dd></div>
                  ))}
                </dl>
                {text(engine?.status as string) === 'available' ? (
                  <div className="plcs-engine">
                    <div><span>Strategy</span><strong>{humanize(engine?.best_strategy as string)}</strong></div>
                    <div><span>Offer</span><strong className="is-good">{money(engine?.recommended_cash_offer)}</strong></div>
                    <div><span>Confidence</span><strong>{pct(engine?.confidence)}</strong></div>
                  </div>
                ) : hasCore ? (
                  <p className="plcs-empty">Acquisition engine not run.</p>
                ) : null}
              </>
            )}
          </section>

          {/* SIGNALS */}
          {signals.length ? (
            <section className="plcs-block">
              <h3>Signals</h3>
              <ul className="plcs-signals">
                {(showAllSignals ? signals : signals.slice(0, 4)).map((sg) => <li key={sg}>{sg}</li>)}
              </ul>
              {signals.length > 4 ? (
                <button type="button" className="plcs-link" onClick={() => setShowAllSignals((v) => !v)}>
                  {showAllSignals ? 'Show fewer' : `Show all ${signals.length}`}
                </button>
              ) : null}
            </section>
          ) : null}

          <div className="plcs-safe" aria-hidden="true" />
        </div>

        <div className="plcs-footer">
          <button type="button" className="plcs-full" onClick={() => onOpenFullDetail(opp)}>
            Full Seller Detail →
          </button>
        </div>
      </div>
    </div>
  )
}

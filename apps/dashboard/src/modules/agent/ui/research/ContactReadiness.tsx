import { cx } from '../../../../shared/lc'
import { CONTACT_READINESS_META, ENTITY_REVIEW_REASON_LABELS, type ContactReadinessView } from '../../model/evidence-class'
import { setUi } from '../../runtime/agent-store'

/**
 * CONTACT READINESS (owner 10-09) — the contact EVIDENCE for a property, kept
 * apart from campaign eligibility. An entity whose relationship needs review
 * still shows the people and (masked) phones that exist; it is never shown
 * as "no contact". Eligibility is the campaign target graph's verdict and is
 * shown as its own line, never derived from the contact state.
 */
export function ContactReadinessCard({ cr, compact }: { cr: ContactReadinessView; compact?: boolean }) {
  const m = CONTACT_READINESS_META[cr.state]
  const showCounts = cr.state !== 'no_contact_found' && cr.state !== 'unknown'
  return (
    <section className={cx('agx-cr', `is-${m.tone}`, compact && 'is-compact')} aria-label="Contact readiness">
      <button type="button" className="agx-cr__head" onClick={() => setUi({ selectedFindingId: cr.finding_id, selectedSourceKey: null, inspectorTab: 'evidence', rightCollapsed: false })}>
        <CrGlyph tone={m.tone} />
        <span className="agx-cr__t"><span className="agx-cr__k">Contact readiness</span><b>{m.label}</b></span>
      </button>
      {!compact ? <p className="agx-cr__means">{m.means}</p> : null}
      {showCounts ? (
        <dl className="agx-cr__facts">
          <div><dt>People</dt><dd>{cr.people}{cr.resolved_people ? <small> · {cr.resolved_people} resolved</small> : null}{cr.vendor_linked_people ? <small> · {cr.vendor_linked_people} vendor-linked</small> : null}</dd></div>
          <div><dt>Phones</dt><dd>{cr.phones}{cr.masked_phones.length ? <small className="agx-cr__ph"> {cr.masked_phones.join(' · ')}</small> : null}</dd></div>
        </dl>
      ) : null}
      {cr.requires_review && !compact ? (
        <ul className="agx-cr__why">{(cr.review_reasons.length ? cr.review_reasons : ['review required']).map((r) => <li key={r}>{ENTITY_REVIEW_REASON_LABELS[r] ?? r}</li>)}</ul>
      ) : null}
      {cr.suppressed_by.length && !compact ? <ul className="agx-cr__why is-hold">{cr.suppressed_by.map((r) => <li key={r}>{r}</li>)}</ul> : null}
      <p className={cx('agx-cr__elig', cr.campaign_eligible === true && 'is-yes')}>
        <span>Campaign eligibility</span>
        <b>{cr.campaign_eligible === true ? 'Eligible' : cr.campaign_eligible === false ? 'Not eligible' : 'Unknown'}</b>
        <small>{cr.campaign_eligible === false && cr.campaign_reason ? `${cr.campaign_reason.replace(/_/g, ' ')} · ` : ''}campaign target graph’s verdict — contact evidence never upgrades it</small>
      </p>
      {!cr.review_checked && cr.state !== 'unknown' && !compact ? <p className="agx-muted">Entity-contact review flags could not be read this pass.</p> : null}
    </section>
  )
}

/** Small state mark for dense rows (triage). */
export function ContactReadinessMark({ cr }: { cr: ContactReadinessView | null }) {
  if (!cr) return <span className="agx-muted">—</span>
  const m = CONTACT_READINESS_META[cr.state]
  const short = { held_suppressed: 'Held', relationship_unresolved: 'Found · unresolved', vendor_associated_phone: 'Vendor phone', confirmed_relationship: 'Confirmed', no_contact_found: 'None found', unknown: 'Unavailable' }[cr.state]
  return <span className={cx('agx-crm', `is-${m.tone}`)} title={`${m.label}${cr.phones ? ` · ${cr.phones} phone(s)` : ''}`}><CrGlyph tone={m.tone} />{short}</span>
}

function CrGlyph({ tone }: { tone: string }) {
  switch (tone) {
    case 'hold': return <svg className="agx-crg" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" /><path d="M2.8 9.2 9.2 2.8" /></svg>
    case 'review': return <svg className="agx-crg" viewBox="0 0 12 12" aria-hidden="true"><circle cx="4.4" cy="4" r="2" /><path d="M1 10.4c.4-1.9 1.8-3 3.4-3s3 1.1 3.4 3" /><path d="M9.6 3.2v3M9.6 8.2v.1" /></svg>
    case 'vendor': return <svg className="agx-crg" viewBox="0 0 12 12" aria-hidden="true"><rect x="3.2" y="1.2" width="5.6" height="9.6" rx="1.4" /><path d="M5.4 9h1.2" /></svg>
    case 'ok': return <svg className="agx-crg" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" /><path d="M3.8 6.1 5.3 7.6 8.3 4.5" /></svg>
    case 'none': return <svg className="agx-crg" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" /><path d="M4 6h4" /></svg>
    default: return <svg className="agx-crg" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" strokeDasharray="1.8 1.6" /></svg>
  }
}

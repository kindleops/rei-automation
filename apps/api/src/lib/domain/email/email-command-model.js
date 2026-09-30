/**
 * EMAIL COMMAND READ MODEL — operational meaning, not a mailbox.
 *
 * Every thread gets ONE operating state, derived deterministically:
 *   needs_you        a human must act (needs_operator, draft awaiting approval,
 *                    reply on a thread the operator owns, identity ambiguous)
 *   failed           the last automated send failed / bounced
 *   system_handling  LeadCommand owes the next move and has it scheduled
 *                    (follow-up queued) or is processing a reply
 *   waiting          we did our part; the counterparty has the ball
 *   unresolved       inbound we could not attribute (not an alert)
 *   done             nothing pending on either side
 * "Operator unread" is tracked separately from "system unhandled": an email
 * the system handled correctly never nags just because nobody opened it.
 *
 * Business state comes from the owning authority (closing case, seller
 * conversation), never recomputed here.
 */

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const ts = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null }

const PENDING = new Set(['pending_send', 'scheduled', 'sending'])
const APPROVAL = new Set(['awaiting_approval'])

/**
 * The outbox state of ONE pending message — the only thing an "automation is
 * replying" marker may claim. Never inferred from the thread: read off the row.
 *   sending    claimed by the dispatcher, in flight right now
 *   retrying   a transport retry of the SAME message is waiting (retry_count > 0)
 *   held       deferred by the dispatcher's safety gate (e.g. sender unavailable)
 *   scheduled  planned for a future time
 *   queued     due now, waiting for the next dispatcher tick
 */
export function outboxStatus(q, now = Date.now()) {
  if (!q) return null
  if (q.queue_status === 'sending') return 'sending'
  const retryAt = ts(q.next_retry_at)
  if (Number(q.retry_count) > 0 && retryAt !== null) return 'retrying'
  if (retryAt !== null && retryAt > now && clean(q.failed_reason)) return 'held'
  const due = ts(q.scheduled_for) ?? ts(q.created_at)
  if (q.queue_status === 'scheduled' || (due !== null && due > now)) return 'scheduled'
  return 'queued'
}

/*
 * FAILURE CLASSES — what failed, whether anything will retry it, and whether a
 * person has to act. Classified from the stored reason codes and provider
 * events only (dispatcher, send-safety gate, provider normalisation, bounce
 * webhooks); an unrecognised code stays `unknown` rather than being guessed.
 */
const SAFETY_BLOCKS = {
  recipient_invalid: ['Invalid address', 'The recipient address is not a valid email address', 'Correct the address'],
  content_missing: ['No content', 'The automated email had no subject or body, so it was never sent', 'Check the template'],
  thread_unlinked: ['Not linked', 'The automated email had no conversation link, so it was never sent', 'Link the conversation'],
  stale_scheduled_message: ['Held — overdue', 'The email was badly overdue when its turn came, so it was held instead of sent late', 'Review it before sending'],
  recipient_identity_uncertain: ['Held — identity', 'Who this recipient is became uncertain, so the email was held', 'Confirm the recipient'],
  business_state_changed: ['Held — deal changed', 'The deal changed after this email was planned, so it was held', 'Review it against the deal'],
  title_contact_changed: ['Held — contact changed', 'The title contact changed after this email was planned, so it was held', 'Review the new contact'],
}
const TRANSPORT_RETRYABLE = new Set(['brevo_rate_limited', 'brevo_provider_unavailable', 'brevo_timeout', 'brevo_network_error'])
const SUPPRESSED = new Set(['recipient_suppressed', 'recipient_hard_bounced', 'recipient_soft_bounced_repeatedly'])

export function classifyFailure(q = {}, { events = [] } = {}) {
  const code = clean(q.failed_reason) || clean(q.cancel_reason) || null
  const bounce = events.find((e) => ['hard_bounce', 'invalid_address', 'soft_bounce', 'blocked'].includes(e.event_type)) || null
  const attempts = Number(q.retry_count) || 0
  const base = { code, attempts, at: q.updated_at || q.sent_at || null }
  if (bounce?.event_type === 'blocked') {
    return { ...base, class: 'blocked', label: 'Blocked by recipient', what: `The receiving mail system refused it${bounce.reason ? ` — ${bounce.reason}` : ''}`, retry: 'none', operator_must_act: true, action: 'Use another address or call' }
  }
  if (bounce?.event_type === 'soft_bounce') {
    return { ...base, class: 'delivery', label: 'Soft bounce', what: `Temporarily rejected by the receiving server${bounce.reason ? ` — ${bounce.reason}` : ''}`, retry: 'none', operator_must_act: false, action: 'Try again later or use another address' }
  }
  if (bounce || q.queue_status === 'bounced') {
    const reason = bounce?.reason || (q.queue_status === 'bounced' ? code : null)
    return { ...base, class: 'delivery', label: 'Hard bounce', what: `The receiving server rejected the address${reason ? ` — ${reason}` : ''}`, retry: 'none', operator_must_act: true, action: 'Find another address or call' }
  }
  if (SUPPRESSED.has(code)) {
    return { ...base, class: 'suppression', label: 'Suppressed address', what: 'This address bounced or unsubscribed before, so nothing is sent to it', retry: 'none', operator_must_act: true, action: 'Use another address or channel' }
  }
  if (code === 'transport_outcome_unknown') {
    return { ...base, class: 'transport', label: 'Outcome unknown', what: 'The send timed out — the provider may have accepted it. It is never re-sent automatically', retry: 'none', operator_must_act: true, action: 'Check it arrived before resending' }
  }
  if (code?.startsWith('dispatch_error')) {
    return { ...base, class: 'transport', label: 'Dispatch error', what: 'The dispatcher hit an internal error before the provider was reached', retry: 'none', operator_must_act: true, action: 'Resend after checking the dispatcher' }
  }
  if (TRANSPORT_RETRYABLE.has(code)) {
    return { ...base, class: 'transport', label: 'Provider unreachable', what: `Every delivery attempt failed (${code.replace(/^brevo_/, '').replace(/_/g, ' ')})`, retry: 'exhausted', operator_must_act: true, action: 'Resend once the provider recovers' }
  }
  if (code?.startsWith('brevo_')) {
    return { ...base, class: 'provider', label: 'Provider rejected', what: `The email provider refused the request (${code.replace(/^brevo_/, '').replace(/_/g, ' ')})`, retry: 'none', operator_must_act: true, action: 'Check the sender configuration' }
  }
  if (code && SAFETY_BLOCKS[code]) {
    const [label, what, action] = SAFETY_BLOCKS[code]
    return { ...base, class: 'blocked', label, what, retry: 'none', operator_must_act: true, action }
  }
  return { ...base, class: 'unknown', label: 'Failed', what: code ? `Failed with ${code.replace(/_/g, ' ')}` : 'Failed without a recorded reason', retry: 'none', operator_must_act: true, action: 'Review before resending' }
}

/** The failure that is still current on a thread: the newest failed attempt, unless a later send succeeded. */
export function currentFailure(outbound = [], { eventsByQueue = null } = {}) {
  const when = (q) => String(q.updated_at || q.sent_at || q.created_at || '')
  const failed = outbound.filter((q) => ['failed', 'bounced'].includes(q.queue_status) || (q.queue_status === 'cancelled' && SUPPRESSED.has(clean(q.cancel_reason))))
    .sort((a, b) => when(b).localeCompare(when(a)))[0]
  if (!failed) return null
  const laterOk = outbound.some((q) => ['sent', 'delivered'].includes(q.queue_status) && String(q.sent_at || '') > String(failed.sent_at || failed.updated_at || ''))
  if (laterOk) return null
  return classifyFailure(failed, { events: eventsByQueue?.get?.(failed.id) || [] })
}

export function deriveThreadState(thread = {}, { outbound = [], inboundUnhandled = 0 } = {}) {
  const pending = outbound.filter((q) => PENDING.has(q.queue_status)).sort((a, b) => String(a.scheduled_for).localeCompare(String(b.scheduled_for)))
  const approval = outbound.filter((q) => APPROVAL.has(q.queue_status) || (q.queue_status === 'draft' && q.approval_status === 'required'))
  const sentish = outbound.filter((q) => ['sent', 'delivered', 'failed', 'bounced'].includes(q.queue_status)).sort((a, b) => String(b.sent_at || b.updated_at).localeCompare(String(a.sent_at || a.updated_at)))
  const last = sentish[0] || null
  const next = pending[0] || null
  const lastInbound = ts(thread.last_inbound_at)
  const lastOutbound = ts(thread.last_outbound_at)
  const theyLast = lastInbound !== null && (lastOutbound === null || lastInbound > lastOutbound)

  let state
  if (thread.category === 'unresolved' && !thread.needs_operator) state = 'unresolved'
  else if (thread.needs_operator || approval.length || (thread.automation_state === 'taken_over' && theyLast)) state = 'needs_you'
  else if (last && ['failed', 'bounced'].includes(last.queue_status) && !pending.length) state = 'failed'
  else if (thread.automation_state === 'completed') state = 'done'
  else if (inboundUnhandled > 0 || (pending.length && thread.automation_state === 'active')) state = 'system_handling'
  else if (!theyLast && lastOutbound !== null) state = 'waiting'
  else if (theyLast) state = thread.automation_state === 'active' ? 'system_handling' : 'needs_you'
  else state = 'done'

  const ball = state === 'waiting' ? 'them' : state === 'done' || state === 'unresolved' ? null : state === 'system_handling' ? 'leadcommand' : 'you'
  const automation = thread.automation_state === 'taken_over' ? 'paused_you_own_it'
    : thread.automation_state === 'paused' ? 'paused'
      : state === 'failed' ? 'failed'
        : state === 'needs_you' ? 'needs_you'
          : next ? (next.queue_status === 'scheduled' || ts(next.scheduled_for) > Date.now() ? 'follow_up_scheduled' : 'sending')
            : state === 'waiting' ? 'waiting'
              : state === 'done' ? 'completed' : 'on'
  const status = outboxStatus(next)
  return {
    state,
    ball,
    automation,
    next: next ? {
      at: next.scheduled_for, action: next.action_key, sequence: next.sequence, why: next.reason || null, queue_id: next.id,
      status, attempts: Number(next.retry_count) || 0, held_reason: ['retrying', 'held'].includes(status) ? clean(next.failed_reason) || null : null,
    } : null,
    approvals: approval.map((q) => ({ queue_id: q.id, subject: q.subject, why: q.reason || null })),
    last_failure: state === 'failed' ? { code: last.failed_reason, at: last.updated_at } : null,
    // The failure that is still current (a later successful send clears it) —
    // also on a Needs-you thread, where the dispatcher flagged it for a person.
    failure: currentFailure(outbound),
    // Automation was running and handed the decision to a person. A reply on a
    // conversation the operator already owns is not an escalation.
    escalated: Boolean(thread.needs_operator) && thread.automation_state !== 'taken_over',
    // Who wrote the outbound messages on this conversation (any status).
    origin: {
      automated: outbound.filter((q) => clean(q.source) && q.source !== 'manual').length,
      manual: outbound.filter((q) => q.source === 'manual').length,
    },
    operator_unread: lastInbound !== null && (ts(thread.operator_read_at) === null || ts(thread.operator_read_at) < lastInbound),
  }
}

// A commitment date is a calendar date (stored at 00:00Z): format it in UTC so it never slips a day.
export const dueLabel = (v) => {
  const t = ts(v)
  return t === null ? String(v).slice(0, 10) : new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** Human line for "what are we waiting for / why are we talking" on a closing thread. */
export function closingContext(c = {}, leg = 'title') {
  if (!c || !c.closing_case_id) return null
  const has = (k) => ts(c[k]) !== null
  let waitingFor = null
  if (c.terminal_outcome) waitingFor = `Closing ${c.terminal_outcome}`
  else if (has('closed_at')) waitingFor = 'Closed'
  else if (leg === 'buyer') waitingFor = 'Buyer agreement / earnest money'
  else if (!has('title_acknowledged_at')) waitingFor = 'Title to acknowledge the order'
  else if (!has('title_commitment_received_at')) waitingFor = c.title_commitment_date ? `Title commitment · due ${dueLabel(c.title_commitment_date)}` : 'Title commitment'
  else if (!has('clear_to_close_at')) waitingFor = 'Clear to close'
  else if (!has('closing_date_confirmed_at')) waitingFor = 'Closing date confirmation'
  else waitingFor = 'Settlement statement / funding'
  return {
    kind: 'closing',
    closing_case_id: c.closing_case_id,
    property_address: c.property_address || null,
    waiting_for: waitingFor,
    scheduled_closing_date: c.scheduled_closing_date || null,
    closing_tz: c.closing_tz || null,
    automation_paused: Boolean(c.automation_paused_at),
    open: `/closing-desk?case=${encodeURIComponent(c.closing_case_id)}`,
  }
}

export const STAGE_LABEL = {
  ownership_confirmation: 'S1 Ownership', ownership_check: 'S1 Ownership', offer_interest: 'S2 Offer interest', asking_price: 'S3 Asking price',
  property_condition: 'S4 Condition', offer: 'S5 Offer', formal_contract: 'S6 Contract', disposition: 'S7 Disposition',
  under_contract: 'S8 Under contract', prepared_to_close: 'S9 Prepared to close', closed: 'S10 Closed',
}

export function sellerContext(conv = {}, opp = null, propertyAddress = null) {
  if (!conv && !opp) return null
  const facts = opp?.metadata?.seller_facts || {}
  const known = []
  const asking = facts.asking_price?.value?.amount ?? facts.asking_price?.amount ?? null
  if (asking) known.push({ key: 'asking_price', label: 'Asking', value: asking })
  for (const [k, label] of [['occupancy_status', 'Occupancy'], ['timeline', 'Timeline'], ['condition_summary', 'Condition']]) {
    const v = facts[k]?.value ?? null
    if (v && typeof v !== 'object') known.push({ key: k, label, value: v })
  }
  const stage = lower(conv?.seller_stage || conv?.lifecycle_stage || opp?.acquisition_stage)
  return {
    kind: 'seller',
    stage,
    stage_label: STAGE_LABEL[stage] || (stage ? stage.replace(/_/g, ' ') : null),
    seller_name: conv?.seller_display_name || null,
    property_address: propertyAddress,
    known_facts: known,
    sms_thread_key: conv?.thread_key || null,
    contactability: conv?.contactability_status || null,
    open_sms: conv?.thread_key ? `/inbox?thread=${encodeURIComponent(conv.thread_key)}` : null,
    open_deal: opp?.id ? `/deal-intelligence?opportunity=${encodeURIComponent(opp.id)}` : null,
  }
}

/** Compact engagement summary per message from its events (derived, never stored). */
export function engagementFromEvents(events = []) {
  const by = (t) => events.filter((e) => e.event_type === t).map((e) => e.event_at).sort()
  const opens = by('open_signal')
  const clicks = by('click')
  const humanOpens = events.filter((e) => e.event_type === 'open_signal' && e.signal_class === 'likely_human').length
  const bounce = events.find((e) => ['hard_bounce', 'soft_bounce', 'invalid_address', 'blocked'].includes(e.event_type)) || null
  return {
    sent_at: by('sent')[0] || null,
    accepted_at: by('accepted')[0] || null,
    delivered_at: by('delivered')[0] || null,
    open_signals: opens.length,
    likely_human_opens: humanOpens,
    first_open_at: opens[0] || null,
    last_open_at: opens[opens.length - 1] || null,
    clicks: clicks.length,
    first_click_at: clicks[0] || null,
    last_click_at: clicks[clicks.length - 1] || null,
    replied_at: by('replied')[0] || null,
    bounce: bounce ? { type: bounce.event_type, at: bounce.event_at, reason: bounce.reason || null } : null,
    unsubscribed_at: by('unsubscribed')[0] || null,
    complaint_at: by('complaint')[0] || null,
  }
}

/** One status word for a message, never claiming more than the provider proved. */
export function deliveryStatus(q = {}, eng = {}) {
  if (q.queue_status === 'cancelled') return 'cancelled'
  if (q.queue_status === 'superseded') return 'superseded'
  if (eng.replied_at) return 'replied'
  if (eng.bounce) return eng.bounce.type === 'soft_bounce' ? 'soft_bounced' : 'bounced'
  if (q.queue_status === 'failed') return 'failed'
  if (eng.delivered_at) return 'delivered'
  if (eng.accepted_at || q.queue_status === 'sent') return 'sent'
  if (q.queue_status === 'sending') return 'sending'
  if (q.queue_status === 'scheduled' || (q.queue_status === 'pending_send' && ts(q.scheduled_for) > Date.now())) return 'scheduled'
  if (q.queue_status === 'pending_send') return 'queued'
  if (q.queue_status === 'awaiting_approval') return 'awaiting_approval'
  return q.queue_status || 'unknown'
}

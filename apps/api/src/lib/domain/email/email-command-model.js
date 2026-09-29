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
  return {
    state,
    ball,
    automation,
    next: next ? { at: next.scheduled_for, action: next.action_key, sequence: next.sequence, why: next.reason || null, queue_id: next.id } : null,
    approvals: approval.map((q) => ({ queue_id: q.id, subject: q.subject, why: q.reason || null })),
    last_failure: state === 'failed' ? { code: last.failed_reason, at: last.updated_at } : null,
    operator_unread: lastInbound !== null && (ts(thread.operator_read_at) === null || ts(thread.operator_read_at) < lastInbound),
  }
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
  else if (!has('title_commitment_received_at')) waitingFor = c.title_commitment_date ? `Title commitment · due ${c.title_commitment_date.slice(0, 10)}` : 'Title commitment'
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

const STAGE_LABEL = {
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

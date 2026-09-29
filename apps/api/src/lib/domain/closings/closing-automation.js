/**
 * CLOSING AUTOMATION — keeps the normal path moving, pulls the operator in
 * only for exceptions.
 *
 *   planClosingAutomation()  PURE: from one closing's canonical records +
 *                            its email requests + the clock → what to request,
 *                            what to cancel, what to escalate, what to notify
 *   runClosingAutomation()   applies plans for every open closing; writes the
 *                            heartbeat. Invoked by the Cloudflare scheduler.
 *
 * Rules that are not negotiable:
 *   - every follow-up has a STOP condition, checked every tick; satisfied →
 *     pending requests are cancelled, never sent late
 *   - cadence is bounded (max per category); exhausted → ESCALATE (operator),
 *     then silence for that category
 *   - bounded catch-up: a follow-up whose moment passed more than
 *     catchUpHours ago is not sent — the gap escalates instead
 *   - terminal / closed / paused closings get nothing new
 *   - an email can't be chased before it was actually sent
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { emitNotificationFromBusinessEvent } from '@/lib/domain/notifications/notification-emitter.js'
import { getSystemValue, setSystemValues } from '@/lib/system-control.js'
import { cancelOpenEmailRequests, requestClosingEmail } from './closing-email-requests.js'

const H = 3_600_000
const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const ts = (v) => { if (!v) return null; const t = Date.parse(v); return Number.isFinite(t) ? t : null }
const arr = (v) => (Array.isArray(v) ? v : [])

/** Centralised cadence. Override any part via system_control `closing_automation_cadence` (JSON). */
export const DEFAULT_CADENCE = Object.freeze({
  catchUpHours: 12,
  title_ack: { afterHours: 24, everyHours: 24, max: 3 },
  title_commitment: { beforeDueHours: 24, everyHours: 24, max: 3, fallbackAfterOpenHours: 120 },
  clear_to_close: { beforeCloseHours: 72, everyHours: 24, max: 3 },
  settlement: { beforeCloseHours: 36, everyHours: 12, max: 3 },
  buyer_emd: { beforeDueHours: 24, everyHours: 24, max: 3 },
  buyer_agreement: { afterSentHours: 24, everyHours: 24, max: 3 },
})

export function mergeCadence(override) {
  const out = JSON.parse(JSON.stringify(DEFAULT_CADENCE))
  if (override && typeof override === 'object') {
    for (const [k, v] of Object.entries(override)) {
      if (v && typeof v === 'object' && out[k] && typeof out[k] === 'object') Object.assign(out[k], v)
      else if (k === 'catchUpHours' && Number.isFinite(Number(v))) out.catchUpHours = Number(v)
    }
  }
  return out
}

const CATEGORY_ACTION = {
  title_ack: 'title_followup',
  title_commitment: 'title_commitment_reminder',
  clear_to_close: 'clear_to_close_followup',
  settlement: 'settlement_request',
  buyer_emd: 'buyer_emd_reminder',
  buyer_agreement: 'buyer_agreement_followup',
}

const ESCALATION_MESSAGE = {
  title_ack: (n) => `Title company has not acknowledged the order after ${n} follow-ups`,
  title_commitment: (n) => `Title commitment still missing after ${n} reminders`,
  clear_to_close: (n) => `No clear to close from title after ${n} follow-ups`,
  settlement: (n) => `No settlement statement after ${n} requests`,
  buyer_emd: (n) => `Buyer EMD not received after ${n} reminders`,
  buyer_agreement: (n) => `Buyer has not signed the agreement after ${n} follow-ups`,
}

const LIVE_OFFER = (o) => ['selected', 'committed'].includes(lower(o.status))

/**
 * One follow-up loop. `start` = when the first follow-up becomes due; each
 * next one `everyHours` later, up to `max`. Returns the actions for this tick.
 */
function followUpLoop({ category, start, spec, now, cadence, requests, escalated, recipientEmail, payload = {} }) {
  const out = []
  if (start === null || escalated) return out
  const mine = requests.filter((r) => r.category === category && r.status !== 'cancelled')
  const done = mine.length
  if (done >= spec.max) {
    const lastDue = start + (spec.max - 1) * spec.everyHours * H
    if (now >= lastDue + spec.everyHours * H) out.push({ type: 'escalate', category, reason: 'cadence_exhausted', message: ESCALATION_MESSAGE[category](spec.max) })
    return out
  }
  const due = start + done * spec.everyHours * H
  if (now < due) return out
  if (now - due > cadence.catchUpHours * H) {
    // The moment passed long ago (worker down / date moved): do not blast a stale chase.
    out.push({ type: 'escalate', category, reason: 'stale_followup_not_sent', message: `${ESCALATION_MESSAGE[category](done)} — follow-up window missed` })
    return out
  }
  if (!recipientEmail) {
    out.push({ type: 'escalate', category, reason: 'no_recipient_address', message: `No ${category.startsWith('buyer') ? 'buyer' : 'title'} email on record — ${ESCALATION_MESSAGE[category](done).toLowerCase()}` })
    return out
  }
  out.push({ type: 'email', action: CATEGORY_ACTION[category], category, sequence: done + 1, dueAt: new Date(due).toISOString(), recipientEmail, payload })
  return out
}

export function planClosingAutomation({ closingCase: c = {}, offers = [], agreements = [], emdReceipts = [], requests = [], now = Date.now(), cadence = DEFAULT_CADENCE, automationEnabled = true } = {}) {
  const actions = []
  const voided = Boolean(c.provenance && c.provenance.voided === true)
  const terminal = Boolean(c.terminal_outcome) || voided || ['cancelled', 'declined'].includes(lower(c.contract_status))
  const closed = Boolean(c.closed_at) || lower(c.closing_status) === 'closed'
  const pending = arr(requests).filter((r) => r.status === 'pending_transport')

  if (terminal || closed || c.automation_paused_at || !automationEnabled) {
    if (pending.length && (terminal || closed || c.automation_paused_at)) actions.push({ type: 'cancel', categories: null, reason: terminal ? 'closing_terminated' : closed ? 'closing_closed' : 'automation_paused' })
    return { actions, state: terminal ? 'terminal' : closed ? 'closed' : c.automation_paused_at ? 'paused' : 'disabled' }
  }
  if (lower(c.contract_status) !== 'fully_executed') return { actions, state: 'awaiting_contract' }

  const escalations = (c.automation_state && c.automation_state.escalations) || {}
  const reqs = arr(requests)
  const titleEmail = clean(c.title_company_email) || null
  const titleOpen = reqs.find((r) => r.category === 'title_open')
  const titleSentAt = ts(c.title_intro_sent_at) ?? ts(titleOpen?.sent_at)
  const ack = ts(c.title_acknowledged_at) !== null
  const commitment = ts(c.title_commitment_received_at) !== null
  const ctc = ts(c.clear_to_close_at) !== null
  const closeAt = ts(c.scheduled_closing_date)
  const confirmed = ts(c.closing_date_confirmed_at) !== null
  const stop = (categories, reason) => {
    if (reqs.some((r) => categories.includes(r.category) && r.status === 'pending_transport')) actions.push({ type: 'cancel', categories, reason })
  }

  // 1 · Title open — once a title company is routed and the contract executed.
  if (!titleOpen && !c.title_intro_sent_at && titleEmail) {
    actions.push({ type: 'email', action: 'title_open', category: 'title_open', sequence: 1, dueAt: new Date(now).toISOString(), recipientEmail: titleEmail })
  } else if (!titleEmail && !clean(c.title_company_key) && lower(c.title_route_status) === 'title_route_unavailable' && !escalations.title_route) {
    actions.push({ type: 'escalate', category: 'title_route', reason: 'no_title_company', message: 'No title company routes this market — choose one' })
  }

  // 2 · Title acknowledgement — only after the order actually went out.
  if (ack || commitment || ctc) stop(['title_ack'], 'title_acknowledged')
  else actions.push(...followUpLoop({ category: 'title_ack', start: titleSentAt === null ? null : titleSentAt + cadence.title_ack.afterHours * H, spec: cadence.title_ack, now, cadence, requests: reqs, escalated: escalations.title_ack, recipientEmail: titleEmail }))

  // Title has gone silent and the operator owns it: later title chases stand
  // down (they would only escalate the same silence again).
  const titleUnresponsive = Boolean(escalations.title_ack)

  // 3 · Title commitment.
  if (commitment || ctc) stop(['title_commitment'], 'commitment_received')
  else if (!titleUnresponsive && (ack || titleSentAt !== null)) {
    const due = ts(c.title_commitment_date)
    const start = due !== null ? due - cadence.title_commitment.beforeDueHours * H
      : (ts(c.title_opened_date) ?? ts(c.title_acknowledged_at) ?? titleSentAt) + cadence.title_commitment.fallbackAfterOpenHours * H
    actions.push(...followUpLoop({ category: 'title_commitment', start, spec: cadence.title_commitment, now, cadence, requests: reqs, escalated: escalations.title_commitment, recipientEmail: titleEmail }))
    if (due !== null && now > due + 24 * H) actions.push({ type: 'notify', eventType: 'closing_milestone_overdue', key: `title_commitment_overdue:${new Date(now).toISOString().slice(0, 10)}`, title: `Title commitment overdue — ${c.property_address || 'closing'}` })
  }

  // 4 · Clear to close — once the commitment is in and a date exists.
  if (ctc) stop(['clear_to_close'], 'clear_to_close_received')
  else if (!titleUnresponsive && commitment && closeAt !== null) {
    actions.push(...followUpLoop({ category: 'clear_to_close', start: closeAt - cadence.clear_to_close.beforeCloseHours * H, spec: cadence.clear_to_close, now, cadence, requests: reqs, escalated: escalations.clear_to_close, recipientEmail: titleEmail }))
  }

  // 5 · Settlement statement — confirmed date, title clear, no statement yet.
  if (c.__has_statement) stop(['settlement'], 'statement_received')
  else if (!titleUnresponsive && ctc && confirmed && closeAt !== null) {
    actions.push(...followUpLoop({ category: 'settlement', start: closeAt - cadence.settlement.beforeCloseHours * H, spec: cadence.settlement, now, cadence, requests: reqs, escalated: escalations.settlement, recipientEmail: titleEmail }))
  }

  // 6 · Closing confirmation — one per confirmed date (a reschedule is a new one).
  if (confirmed && closeAt !== null && titleEmail) {
    const category = `closing_confirmation:${new Date(closeAt).toISOString()}`
    if (!reqs.some((r) => r.category === category)) actions.push({ type: 'email', action: 'closing_confirmation', category, sequence: 1, dueAt: new Date(now).toISOString(), recipientEmail: titleEmail })
  }

  // 7 · Buyer EMD.
  const offer = arr(offers).find((o) => lower(o.status) === 'committed') || arr(offers).find(LIVE_OFFER) || null
  const buyerEmail = clean(offer?.metadata?.buyer_email) || null
  if (offer) {
    const required = lower(offer.emd_status) !== 'not_required' && (Number(offer.emd_amount) > 0 || offer.emd_due_date)
    const received = arr(emdReceipts).some((r) => r.buyer_offer_id === offer.buyer_offer_id && ['received_unverified', 'verified'].includes(lower(r.status)))
    if (!required || received) stop(['buyer_emd'], received ? 'emd_received' : 'emd_not_required')
    else {
      const due = ts(offer.emd_due_date)
      const start = due !== null ? due - cadence.buyer_emd.beforeDueHours * H : (ts(offer.selected_at) ?? now) + cadence.buyer_emd.everyHours * H
      actions.push(...followUpLoop({ category: 'buyer_emd', start, spec: cadence.buyer_emd, now, cadence, requests: reqs, escalated: escalations.buyer_emd, recipientEmail: buyerEmail, payload: { amount: offer.emd_amount, due: offer.emd_due_date } }))
      if (due !== null && now > due + 24 * H) actions.push({ type: 'notify', eventType: 'closing_earnest_money_due', severity: 'critical', key: `emd_overdue:${new Date(now).toISOString().slice(0, 10)}`, title: `Buyer EMD overdue — ${c.property_address || 'closing'}` })
    }

    // 8 · Buyer agreement.
    const ag = arr(agreements).find((a) => a.buyer_offer_id === offer.buyer_offer_id && ['sent', 'viewed', 'counterparty_signed'].includes(lower(a.status)))
    const executed = arr(agreements).some((a) => a.buyer_offer_id === offer.buyer_offer_id && lower(a.status) === 'fully_executed')
    if (executed) stop(['buyer_agreement'], 'agreement_executed')
    else if (ag && ts(ag.sent_at) !== null) {
      actions.push(...followUpLoop({ category: 'buyer_agreement', start: ts(ag.sent_at) + cadence.buyer_agreement.afterSentHours * H, spec: cadence.buyer_agreement, now, cadence, requests: reqs, escalated: escalations.buyer_agreement, recipientEmail: buyerEmail }))
    }
  }

  // 9 · Closing at risk — confirmed date within 48h and still not clear.
  if (confirmed && closeAt !== null && closeAt - now <= 48 * H && closeAt > now && !ctc) {
    actions.push({ type: 'notify', eventType: 'closing_case_at_risk', key: `at_risk:${new Date(closeAt).toISOString()}`, title: `Closing at risk — ${c.property_address || 'closing'}` })
  }
  return { actions, state: 'active' }
}

/* ── executor ─────────────────────────────────────────────────────────── */

export async function runClosingAutomation({ now = Date.now(), dryRun = false } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const notify = deps.notify || emitNotificationFromBusinessEvent
  const readValue = deps.getSystemValue || getSystemValue
  const writeValues = deps.setSystemValues || setSystemValues
  const enabledRaw = await readValue('closing_automation_enabled').catch(() => null)
  const automationEnabled = String(enabledRaw ?? '').toLowerCase() === 'true'
  let cadence = DEFAULT_CADENCE
  try { const raw = await readValue('closing_automation_cadence'); if (raw) cadence = mergeCadence(typeof raw === 'string' ? JSON.parse(raw) : raw) } catch { /* default cadence */ }

  const { data: cases, error } = await db.from('closing_cases').select('*').is('closed_at', null).is('terminal_outcome', null).limit(300)
  if (error) throw error
  const summary = { scanned: 0, requested: 0, cancelled: 0, escalated: 0, notified: 0, skipped_paused: 0, errors: [] }
  for (const c of cases || []) {
    summary.scanned += 1
    try {
      const [offers, agreements, receipts, settlements, requests] = await Promise.all([
        c.opportunity_id ? db.from('buyer_offers').select('*').eq('opportunity_id', c.opportunity_id).limit(100).then((r) => r.data || []) : [],
        c.opportunity_id ? db.from('buyer_agreements').select('*').eq('opportunity_id', c.opportunity_id).limit(100).then((r) => r.data || []) : [],
        db.from('emd_receipts').select('*').eq('closing_case_id', c.closing_case_id).limit(100).then((r) => r.data || []),
        db.from('settlement_records').select('settlement_statement_reference, settlement_status').eq('closing_case_id', c.closing_case_id).limit(10).then((r) => r.data || []),
        db.from('closing_email_requests').select('*').eq('closing_case_id', c.closing_case_id).limit(500).then((r) => r.data || []),
      ])
      const closing = { ...c, __has_statement: settlements.some((s) => clean(s.settlement_statement_reference)) }
      const plan = planClosingAutomation({ closingCase: closing, offers, agreements, emdReceipts: receipts, requests, now, cadence, automationEnabled })
      if (plan.state === 'paused') summary.skipped_paused += 1
      if (dryRun) continue
      const escalations = { ...((c.automation_state && c.automation_state.escalations) || {}) }
      let escalationChanged = false
      for (const a of plan.actions) {
        if (a.type === 'email') {
          const r = await requestClosingEmail(db, c, { action: a.action, category: a.category, sequence: a.sequence, recipientEmail: a.recipientEmail, dueAt: a.dueAt, requestedBy: 'closing_automation', payload: a.payload })
          if (!r.duplicate) summary.requested += 1
        } else if (a.type === 'cancel') {
          summary.cancelled += await cancelOpenEmailRequests(db, c.closing_case_id, a.reason, a.categories)
        } else if (a.type === 'escalate' && !escalations[a.category]) {
          escalations[a.category] = { at: new Date(now).toISOString(), reason: a.reason, message: a.message }
          escalationChanged = true
          summary.escalated += 1
          await notify({ eventType: 'closing_party_unreachable', sourceEntityType: 'closing_case', sourceEntityId: c.closing_case_id, closingId: c.closing_case_id, propertyId: c.property_id, dealId: c.opportunity_id, title: `${a.message} — ${c.property_address || 'closing'}`, deduplicationKey: `closing_escalation:${c.closing_case_id}:${a.category}` })
          await db.from('closing_activity_events').insert({ closing_case_id: c.closing_case_id, event_type: 'automation_escalated', actor: 'closing_automation', source: 'closing_automation', detail: { category: a.category, reason: a.reason, message: a.message }, idempotency_key: `automation_escalated:${c.closing_case_id}:${a.category}` }).then(() => null, () => null)
        } else if (a.type === 'notify') {
          await notify({ eventType: a.eventType, severity: a.severity, sourceEntityType: 'closing_case', sourceEntityId: c.closing_case_id, closingId: c.closing_case_id, propertyId: c.property_id, dealId: c.opportunity_id, title: a.title, deduplicationKey: `${a.eventType}:${c.closing_case_id}:${a.key}` })
          summary.notified += 1
        }
      }
      if (escalationChanged) {
        await db.from('closing_cases').update({ automation_state: { ...(c.automation_state || {}), escalations } }).eq('closing_case_id', c.closing_case_id)
      }
    } catch (err) {
      summary.errors.push({ closing_case_id: c.closing_case_id, error: String(err?.message || err).slice(0, 200) })
    }
  }
  if (!dryRun) {
    await writeValues({
      closing_automation_heartbeat_at: new Date(now).toISOString(),
      closing_automation_last_summary: JSON.stringify({ ...summary, enabled: automationEnabled, errors: summary.errors.length }),
    }).catch(() => null)
  }
  return { ok: summary.errors.length === 0, enabled: automationEnabled, ...summary }
}

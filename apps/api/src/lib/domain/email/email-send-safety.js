/**
 * EMAIL SEND SAFETY — the last gate before a message leaves.
 *
 * Pure. Evaluated at DISPATCH time (not when the message was planned) against
 * fresh state, so a message that was right when scheduled but wrong now never
 * goes out: the seller answered by SMS at 9:59:59, the title company replied,
 * the closing was cancelled, the operator took over, the address bounced.
 *
 * Decisions:
 *   send       — go
 *   supersede  — the reason for this message is gone (answered / satisfied)
 *   cancel     — the conversation may not be contacted this way any more
 *   escalate   — needs a human (stale, identity uncertain, business changed)
 *   defer      — try again later (sender temporarily unavailable)
 *   fail       — cannot ever be sent as-is (bad recipient, broken template)
 */

const clean = (v) => String(v ?? '').trim()
const ts = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null }
const H = 3600e3

export const DEFAULT_STALE_AFTER_MS = 12 * H

const isEmail = (v) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(clean(v))

/** A follow-up/reminder exists to chase a reply; a reply since it was planned voids it. */
export function isChaseAction(row = {}) {
  const a = clean(row.action_key)
  return Number(row.sequence) > 1 || /followup|follow_up|reminder|nudge/.test(a)
}

// Transactional sources that are not part of a conversation thread (an
// appointment reminder has no email thread). Every other check still applies;
// their business revalidator decides whether the message is still wanted.
const THREADLESS_SOURCES = new Set(['scheduling'])

export function evaluateSendSafety({ row = {}, thread = null, suppression = null, sender = null, revalidation = null, alreadySent = false, compliance = null, now = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  const automated = clean(row.source) !== 'manual'
  const out = (decision, code, extra = {}) => ({ decision, code, ...extra })

  if (['required', 'rejected'].includes(clean(row.approval_status))) return out('defer', 'approval_pending')
  if (!isEmail(row.to_email)) return out('fail', 'recipient_invalid')
  if (!clean(row.subject) || !(clean(row.text_body) || clean(row.html_body) || clean(row.email_body))) return out('fail', 'content_missing')
  if (alreadySent) return out('supersede', 'duplicate_logical_message')

  if (automated && !(THREADLESS_SOURCES.has(clean(row.source)) && !row.thread_id)) {
    if (!thread) return out('fail', 'thread_unlinked')
    if (thread.automation_state === 'taken_over') return out('cancel', 'operator_took_over')
    if (thread.automation_state === 'paused') return out('cancel', 'automation_paused')
    if (thread.resolution_status && thread.resolution_status !== 'resolved') return out('escalate', 'recipient_identity_uncertain')
  }

  if (suppression?.suppressed) return out('cancel', 'recipient_suppressed', { suppression_reason: suppression.reason || null })
  if (suppression && suppression.ok === false) return out('defer', 'suppression_check_failed')

  if (revalidation) {
    if (revalidation.state === 'satisfied') return out('supersede', revalidation.reason || 'condition_satisfied')
    if (revalidation.state === 'cancelled') return out('cancel', revalidation.reason || 'business_cancelled')
    if (revalidation.state === 'changed') return out('escalate', revalidation.reason || 'business_state_changed')
    if (revalidation.state === 'error') return out('defer', revalidation.reason || 'revalidation_failed')
  }

  if (automated && thread && isChaseAction(row)) {
    const repliedAt = ts(thread.last_inbound_at)
    const plannedAt = ts(row.created_at)
    if (repliedAt !== null && plannedAt !== null && repliedAt > plannedAt) return out('supersede', 'counterparty_replied')
  }

  if (automated) {
    const due = ts(row.scheduled_for) ?? ts(row.created_at)
    if (due !== null && now - due > staleAfterMs) return out('escalate', 'stale_scheduled_message', { overdue_ms: now - due })
  }

  if (!sender?.ok) return out('defer', sender?.code || 'sender_unavailable')
  if (sender.sender?.daily_limit && sender.sender.messages_sent_today >= sender.sender.daily_limit) return out('defer', 'sender_daily_limit')
  // Lane-scoped automated mail never leaves without its unsubscribe + postal address.
  if (compliance?.required && !compliance.ok) return out('defer', compliance.code || 'sender_compliance_incomplete', { missing: compliance.missing || null })

  return out('send', 'ok')
}

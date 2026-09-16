/**
 * CALENDAR-MOBILE-LOCK-1 §8/§9/§14/§37 — one authority for "is this still work
 * that requires action?"
 *
 * This module already owned the status vocabulary for overdue, and that
 * vocabulary is the same question asked a different way. Keeping the two in
 * one place is deliberate: a second list would drift, and then an item could
 * be simultaneously "not overdue because it is cancelled" and "due soon".
 * Which is exactly what happened — evaluateDueSoon() looked only at the
 * timestamp, so a SUPPRESSED opportunity reported due_soon: true and
 * completion_state: 'scheduled', reading to the operator as live work.
 */
const COMPLETED_STATUSES = new Set([
  'delivered', 'sent', 'sending', 'ready', 'completed', 'executed', 'closed',
  'clear_to_close', 'signed', 'received', 'cancelled', 'canceled', 'suppressed',
]);

const SCHEDULED_STATUSES = new Set([
  'scheduled', 'queued', 'pending', 'waiting', 'held', 'approval', 'active',
]);

const FAILED_INCOMPLETE = new Set(['failed', 'blocked', 'retry', 'paused']);

function clean(value) {
  return String(value ?? '').trim().toLowerCase();
}

function ts(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * State-aware overdue evaluation. Historical completed SMS must not be overdue.
 */
export function evaluateOverdue(event = {}) {
  const status = clean(event.status);
  const type = clean(event.event_type || event.type);
  const startTs = ts(event.start_timestamp || event.timestamp);
  const completionState = clean(event.completion_state);
  const now = Date.now();

  if (!startTs || startTs >= now) {
    return { overdue: false, risk_state: 'on_track', reason: null };
  }

  if (completionState === 'completed' || COMPLETED_STATUSES.has(status)) {
    return { overdue: false, risk_state: 'completed', reason: null };
  }

  if (type === 'sms_sent' || type === 'sms_delivered' || type === 'inbound_reply' || type === 'positive_intent') {
    return { overdue: false, risk_state: 'historical', reason: 'completed_communication' };
  }

  if (type === 'scheduled_sms' || type === 'queue_retry') {
    if (COMPLETED_STATUSES.has(status)) {
      return { overdue: false, risk_state: 'completed', reason: null };
    }
    if (SCHEDULED_STATUSES.has(status) || FAILED_INCOMPLETE.has(status)) {
      return {
        overdue: true,
        risk_state: status === 'failed' ? 'failed' : 'overdue',
        reason: `queue_${status || 'scheduled'}_past_due`,
      };
    }
  }

  if (type === 'workflow_wake' || type === 'workflow_task' || type === 'seller_follow_up') {
    if (status === 'completed' || status === 'cancelled' || status === 'canceled') {
      return { overdue: false, risk_state: 'completed', reason: null };
    }
    if (SCHEDULED_STATUSES.has(status) || status === 'waiting' || status === 'pending') {
      return { overdue: true, risk_state: 'overdue', reason: 'workflow_timer_past_due' };
    }
  }

  if (type === 'offer_expiration' || type === 'contract_signature_deadline' || type === 'pipeline_next_action') {
    if (status === 'signed' || status === 'executed' || status === 'completed') {
      return { overdue: false, risk_state: 'completed', reason: null };
    }
    return { overdue: true, risk_state: 'deadline_missed', reason: 'deadline_past_due' };
  }

  if (SCHEDULED_STATUSES.has(status)) {
    return { overdue: true, risk_state: 'overdue', reason: 'scheduled_past_due' };
  }

  return { overdue: false, risk_state: 'historical', reason: null };
}

/**
 * Statuses that mean the underlying record is no longer actionable.
 *
 * `suppressed` and `dead` are acquisition-opportunity statuses: 156 and 348
 * rows respectively as of 2026-09-16, 28 and 1 of them carrying a
 * next_action_due. Those dates are real, but the work is not executable, so
 * they must not be counted as work or presented as on-track.
 *
 * §13 — this is NOT a judgement about "Not Interested". Not Interested is a
 * seller DISPOSITION and may legitimately carry future reactivation work;
 * only the statuses below, which mean the record itself is closed or held,
 * make an item non-actionable.
 */
const NON_ACTIONABLE_STATUSES = new Set([
  'completed', 'cancelled', 'canceled', 'suppressed', 'dead', 'closed',
  'executed', 'signed', 'delivered', 'sent', 'expired', 'archived',
]);

/** Event types that are records of something that already happened. */
const HISTORICAL_TYPES = new Set([
  'sms_sent', 'sms_delivered', 'sms_failed', 'inbound_reply', 'positive_intent',
  'offer_created', 'offer_sent', 'contract_sent', 'fully_executed_contract',
  'title_opened', 'buyer_packet_sent', 'underwriting_started',
  'underwriting_completed', 'dnc_suppression', 'wrong_number',
]);

export function isActionableEvent(event = {}) {
  const status = clean(event.status);
  const type = clean(event.event_type || event.type);
  const completionState = clean(event.completion_state);

  if (completionState === 'completed' || completionState === 'cancelled') return false;
  if (NON_ACTIONABLE_STATUSES.has(status)) return false;
  if (HISTORICAL_TYPES.has(type)) return false;
  return true;
}

/** Why an item is not actionable, for the UI to state plainly. */
export function describeNonActionable(event = {}) {
  const status = clean(event.status);
  const type = clean(event.event_type || event.type);
  if (isActionableEvent(event)) return null;
  if (status === 'suppressed') return 'suppressed';
  if (status === 'dead') return 'closed';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'completed') return 'completed';
  if (HISTORICAL_TYPES.has(type)) return 'historical';
  return status || 'not_actionable';
}

/**
 * Due soon now requires the item to still BE work. A cancelled or suppressed
 * row whose scheduled time happens to be near is not "due soon".
 */
export function evaluateDueSoon(event = {}, windowMs = 36 * 3600000) {
  const startTs = ts(event.start_timestamp || event.timestamp);
  if (!startTs) return false;
  if (!isActionableEvent(event)) return false;
  const now = Date.now();
  return startTs >= now && startTs - now <= windowMs;
}
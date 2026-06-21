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

export function evaluateDueSoon(event = {}, windowMs = 36 * 3600000) {
  const startTs = ts(event.start_timestamp || event.timestamp);
  if (!startTs) return false;
  const now = Date.now();
  return startTs >= now && startTs - now <= windowMs;
}
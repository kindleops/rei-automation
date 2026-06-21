/** Canonical acquisition opportunity dimensions — shared across Pipeline, Workflow, Inbox. */

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeKey(value) {
  return clean(value).toLowerCase().replace(/[\s-]+/g, '_');
}

export const ACQUISITION_STAGE_CODES = Object.freeze({
  NEEDS_REVIEW: 'needs_review',
  OWNERSHIP_CONFIRMATION: 'ownership_confirmation',
  INTEREST_QUALIFICATION: 'interest_qualification',
  PRICE_DISCOVERY: 'price_discovery',
  UNDERWRITING: 'underwriting',
  DECISION_AND_OFFER: 'decision_and_offer',
  CONTRACT_TO_CLOSE: 'contract_to_close',
});

export const ACQUISITION_STAGE_ORDER = Object.freeze([
  ACQUISITION_STAGE_CODES.NEEDS_REVIEW,
  ACQUISITION_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  ACQUISITION_STAGE_CODES.INTEREST_QUALIFICATION,
  ACQUISITION_STAGE_CODES.PRICE_DISCOVERY,
  ACQUISITION_STAGE_CODES.UNDERWRITING,
  ACQUISITION_STAGE_CODES.DECISION_AND_OFFER,
  ACQUISITION_STAGE_CODES.CONTRACT_TO_CLOSE,
]);

export const ACQUISITION_STAGE_LABELS = Object.freeze({
  [ACQUISITION_STAGE_CODES.NEEDS_REVIEW]: 'New / Needs Review',
  [ACQUISITION_STAGE_CODES.OWNERSHIP_CONFIRMATION]: 'Ownership Confirmation',
  [ACQUISITION_STAGE_CODES.INTEREST_QUALIFICATION]: 'Interest Qualification',
  [ACQUISITION_STAGE_CODES.PRICE_DISCOVERY]: 'Price Discovery',
  [ACQUISITION_STAGE_CODES.UNDERWRITING]: 'Underwriting',
  [ACQUISITION_STAGE_CODES.DECISION_AND_OFFER]: 'Decision & Offer',
  [ACQUISITION_STAGE_CODES.CONTRACT_TO_CLOSE]: 'Contract to Close',
});

export const OPPORTUNITY_STATUS_CODES = Object.freeze({
  ACTIVE: 'active',
  WAITING: 'waiting',
  PAUSED: 'paused',
  NURTURE: 'nurture',
  WON: 'won',
  LOST: 'lost',
  DEAD: 'dead',
  SUPPRESSED: 'suppressed',
  ARCHIVED: 'archived',
});

export const CONVERSATION_STATE_CODES = Object.freeze({
  NEEDS_REPLY: 'needs_reply',
  AWAITING_SELLER: 'awaiting_seller',
  SELLER_REPLIED: 'seller_replied',
  NEEDS_REVIEW: 'needs_review',
  NO_RECENT_ACTIVITY: 'no_recent_activity',
});

export const QUEUE_STATE_CODES = Object.freeze({
  NOT_QUEUED: 'not_queued',
  SCHEDULED: 'scheduled',
  QUEUED: 'queued',
  SENDING: 'sending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const WORKFLOW_STATE_CODES = Object.freeze({
  NOT_ENROLLED: 'not_enrolled',
  ACTIVE: 'active',
  WAITING: 'waiting',
  APPROVAL_REQUIRED: 'approval_required',
  BLOCKED: 'blocked',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const STAGE_ALIAS_MAP = Object.freeze({
  ownership_check: ACQUISITION_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  ownership: ACQUISITION_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  ownership_confirmation: ACQUISITION_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  interest_probe: ACQUISITION_STAGE_CODES.INTEREST_QUALIFICATION,
  interest: ACQUISITION_STAGE_CODES.INTEREST_QUALIFICATION,
  interest_qualification: ACQUISITION_STAGE_CODES.INTEREST_QUALIFICATION,
  consider_selling: ACQUISITION_STAGE_CODES.INTEREST_QUALIFICATION,
  price_discovery: ACQUISITION_STAGE_CODES.PRICE_DISCOVERY,
  asking_price: ACQUISITION_STAGE_CODES.PRICE_DISCOVERY,
  condition_details: ACQUISITION_STAGE_CODES.UNDERWRITING,
  underwriting_needed: ACQUISITION_STAGE_CODES.UNDERWRITING,
  underwriting: ACQUISITION_STAGE_CODES.UNDERWRITING,
  offer_pending: ACQUISITION_STAGE_CODES.DECISION_AND_OFFER,
  offer_sent: ACQUISITION_STAGE_CODES.DECISION_AND_OFFER,
  negotiation: ACQUISITION_STAGE_CODES.DECISION_AND_OFFER,
  offer_negotiation: ACQUISITION_STAGE_CODES.DECISION_AND_OFFER,
  decision_and_offer: ACQUISITION_STAGE_CODES.DECISION_AND_OFFER,
  contract_requested: ACQUISITION_STAGE_CODES.CONTRACT_TO_CLOSE,
  contract_sent: ACQUISITION_STAGE_CODES.CONTRACT_TO_CLOSE,
  title_closing: ACQUISITION_STAGE_CODES.CONTRACT_TO_CLOSE,
  closing: ACQUISITION_STAGE_CODES.CONTRACT_TO_CLOSE,
  contract_to_close: ACQUISITION_STAGE_CODES.CONTRACT_TO_CLOSE,
  needs_review: ACQUISITION_STAGE_CODES.NEEDS_REVIEW,
  new: ACQUISITION_STAGE_CODES.NEEDS_REVIEW,
});

const STAGE_INDEX = new Map(ACQUISITION_STAGE_ORDER.map((code, index) => [code, index]));
const TERMINAL_STATUSES = new Set([
  OPPORTUNITY_STATUS_CODES.WON,
  OPPORTUNITY_STATUS_CODES.LOST,
  OPPORTUNITY_STATUS_CODES.DEAD,
  OPPORTUNITY_STATUS_CODES.SUPPRESSED,
  OPPORTUNITY_STATUS_CODES.ARCHIVED,
]);

export function normalizeAcquisitionStageCode(value, fallback = ACQUISITION_STAGE_CODES.NEEDS_REVIEW) {
  const key = normalizeKey(value);
  if (!key) return fallback;
  if (STAGE_INDEX.has(key)) return key;
  if (STAGE_ALIAS_MAP[key]) return STAGE_ALIAS_MAP[key];
  if (key.includes('contract') || key.includes('closing') || key.includes('title')) {
    return ACQUISITION_STAGE_CODES.CONTRACT_TO_CLOSE;
  }
  if (key.includes('offer') || key.includes('negotiat')) {
    return ACQUISITION_STAGE_CODES.DECISION_AND_OFFER;
  }
  if (key.includes('underwrit') || key.includes('condition')) {
    return ACQUISITION_STAGE_CODES.UNDERWRITING;
  }
  if (key.includes('price') || key.includes('asking')) {
    return ACQUISITION_STAGE_CODES.PRICE_DISCOVERY;
  }
  if (key.includes('interest') || key.includes('consider')) {
    return ACQUISITION_STAGE_CODES.INTEREST_QUALIFICATION;
  }
  if (key.includes('ownership')) {
    return ACQUISITION_STAGE_CODES.OWNERSHIP_CONFIRMATION;
  }
  return fallback;
}

export function acquisitionStageLabel(code) {
  return ACQUISITION_STAGE_LABELS[normalizeAcquisitionStageCode(code)] ?? 'Unknown Stage';
}

export function normalizeOpportunityStatus(value, fallback = OPPORTUNITY_STATUS_CODES.ACTIVE) {
  const key = normalizeKey(value);
  if (!key) return fallback;
  if (Object.values(OPPORTUNITY_STATUS_CODES).includes(key)) return key;
  if (key === 'suppressed' || key === 'dnc') return OPPORTUNITY_STATUS_CODES.SUPPRESSED;
  if (key === 'dead' || key === 'closed') return OPPORTUNITY_STATUS_CODES.DEAD;
  if (key === 'awaiting_response' || key === 'waiting') return OPPORTUNITY_STATUS_CODES.WAITING;
  return fallback;
}

export function deriveConversationState(row = {}) {
  if (row.needs_review || row.conversation_needs_review) return CONVERSATION_STATE_CODES.NEEDS_REVIEW;
  if (row.unread || row.has_unread_reply) return CONVERSATION_STATE_CODES.NEEDS_REPLY;
  const lastInbound = row.last_inbound_at || row.lastInboundAt;
  const lastOutbound = row.last_outbound_at || row.lastOutboundAt;
  if (lastInbound && (!lastOutbound || new Date(lastInbound) > new Date(lastOutbound))) {
    return CONVERSATION_STATE_CODES.SELLER_REPLIED;
  }
  if (lastOutbound && (!lastInbound || new Date(lastOutbound) > new Date(lastInbound))) {
    return CONVERSATION_STATE_CODES.AWAITING_SELLER;
  }
  const lastActivity = row.last_activity_at || row.lastActivityAt || row.latest_message_at;
  if (!lastActivity) return CONVERSATION_STATE_CODES.NO_RECENT_ACTIVITY;
  const ageDays = (Date.now() - new Date(lastActivity).getTime()) / 86400000;
  if (ageDays >= 14) return CONVERSATION_STATE_CODES.NO_RECENT_ACTIVITY;
  return CONVERSATION_STATE_CODES.AWAITING_SELLER;
}

export function normalizeQueueState(value) {
  const key = normalizeKey(value);
  if (!key || key === 'unknown' || key === 'none') return QUEUE_STATE_CODES.NOT_QUEUED;
  if (Object.values(QUEUE_STATE_CODES).includes(key)) return key;
  if (key.includes('deliver')) return QUEUE_STATE_CODES.DELIVERED;
  if (key.includes('send')) return key === 'sending' ? QUEUE_STATE_CODES.SENDING : QUEUE_STATE_CODES.SENT;
  if (key.includes('queue')) return QUEUE_STATE_CODES.QUEUED;
  if (key.includes('sched')) return QUEUE_STATE_CODES.SCHEDULED;
  if (key.includes('fail')) return QUEUE_STATE_CODES.FAILED;
  if (key.includes('cancel')) return QUEUE_STATE_CODES.CANCELLED;
  return QUEUE_STATE_CODES.NOT_QUEUED;
}

export function normalizeWorkflowState(value) {
  const key = normalizeKey(value);
  if (!key) return WORKFLOW_STATE_CODES.NOT_ENROLLED;
  if (Object.values(WORKFLOW_STATE_CODES).includes(key)) return key;
  if (key.includes('approval')) return WORKFLOW_STATE_CODES.APPROVAL_REQUIRED;
  if (key.includes('block')) return WORKFLOW_STATE_CODES.BLOCKED;
  if (key.includes('pause')) return WORKFLOW_STATE_CODES.PAUSED;
  if (key.includes('complete')) return WORKFLOW_STATE_CODES.COMPLETED;
  if (key.includes('fail')) return WORKFLOW_STATE_CODES.FAILED;
  if (key.includes('wait')) return WORKFLOW_STATE_CODES.WAITING;
  if (key.includes('active')) return WORKFLOW_STATE_CODES.ACTIVE;
  return WORKFLOW_STATE_CODES.NOT_ENROLLED;
}

export function validateStageTransition({ fromStage, toStage, opportunityStatus, reason = '' }) {
  const from = normalizeAcquisitionStageCode(fromStage);
  const to = normalizeAcquisitionStageCode(toStage);
  if (from === to) return { ok: true, from, to };

  if (TERMINAL_STATUSES.has(normalizeOpportunityStatus(opportunityStatus))) {
    if (!clean(reason)) {
      return {
        ok: false,
        error: 'terminal_status_requires_reason',
        message: 'Closed opportunities require a reason to change stage.',
        from,
        to,
      };
    }
  }

  const fromIndex = STAGE_INDEX.get(from) ?? 0;
  const toIndex = STAGE_INDEX.get(to) ?? 0;
  const isBackward = toIndex < fromIndex;
  const skipCount = Math.abs(toIndex - fromIndex) - 1;

  if ((isBackward || skipCount > 0) && !clean(reason)) {
    return {
      ok: false,
      error: 'transition_reason_required',
      message: isBackward
        ? 'Moving backward requires a reason.'
        : 'Skipping stages requires a reason.',
      from,
      to,
      requires_reason: true,
    };
  }

  const warnings = [];
  if (from === ACQUISITION_STAGE_CODES.OWNERSHIP_CONFIRMATION
    && toIndex >= STAGE_INDEX.get(ACQUISITION_STAGE_CODES.UNDERWRITING)) {
    warnings.push('Skipping interest and price discovery stages.');
  }
  if (from === ACQUISITION_STAGE_CODES.DECISION_AND_OFFER
    && to === ACQUISITION_STAGE_CODES.CONTRACT_TO_CLOSE
    && !clean(reason)) {
    return {
      ok: false,
      error: 'contract_evidence_required',
      message: 'Negotiation → Contract requires approval or contract evidence.',
      from,
      to,
      requires_reason: true,
    };
  }

  return { ok: true, from, to, warnings, requires_approval: false };
}

export function buildOpportunityDedupeKey({
  master_owner_id,
  primary_property_id,
  portfolio_group_id,
  primary_thread_key,
}) {
  const owner = clean(master_owner_id);
  const property = clean(primary_property_id);
  const portfolio = clean(portfolio_group_id);
  const thread = clean(primary_thread_key);
  if (portfolio) return `portfolio:${portfolio}`;
  if (owner && property) return `owner:${owner}:property:${property}`;
  if (thread) return `thread:${thread}`;
  return null;
}

export function mapThreadStageToOpportunityStage(thread = {}) {
  const universal = normalizeKey(thread.universal_stage || thread.pipeline_stage);
  const status = normalizeKey(thread.universal_status || thread.inbox_bucket);
  if (status === 'dead' || status === 'suppressed') {
    return {
      stage: ACQUISITION_STAGE_CODES.NEEDS_REVIEW,
      status: status === 'dead' ? OPPORTUNITY_STATUS_CODES.DEAD : OPPORTUNITY_STATUS_CODES.SUPPRESSED,
    };
  }
  if (universal === 'closing' || universal === 'contract_sent' || universal === 'contract_requested') {
    return { stage: ACQUISITION_STAGE_CODES.CONTRACT_TO_CLOSE, status: OPPORTUNITY_STATUS_CODES.ACTIVE };
  }
  if (universal === 'offer_sent' || universal === 'negotiation' || universal === 'offer_pending') {
    return { stage: ACQUISITION_STAGE_CODES.DECISION_AND_OFFER, status: OPPORTUNITY_STATUS_CODES.ACTIVE };
  }
  if (universal === 'underwriting_needed' || universal === 'underwriting' || universal === 'condition_details') {
    return { stage: ACQUISITION_STAGE_CODES.UNDERWRITING, status: OPPORTUNITY_STATUS_CODES.ACTIVE };
  }
  if (universal === 'price_discovery' || universal === 'asking_price') {
    return { stage: ACQUISITION_STAGE_CODES.PRICE_DISCOVERY, status: OPPORTUNITY_STATUS_CODES.ACTIVE };
  }
  if (universal === 'interest_probe' || universal === 'seller_replied') {
    return { stage: ACQUISITION_STAGE_CODES.INTEREST_QUALIFICATION, status: OPPORTUNITY_STATUS_CODES.ACTIVE };
  }
  if (thread.last_inbound_at || status === 'seller_replied' || thread.inbox_bucket === 'new_replies') {
    return { stage: ACQUISITION_STAGE_CODES.INTEREST_QUALIFICATION, status: OPPORTUNITY_STATUS_CODES.ACTIVE };
  }
  if (thread.needs_review || thread.inbox_bucket === 'needs_review') {
    return { stage: ACQUISITION_STAGE_CODES.NEEDS_REVIEW, status: OPPORTUNITY_STATUS_CODES.ACTIVE };
  }
  return { stage: ACQUISITION_STAGE_CODES.OWNERSHIP_CONFIRMATION, status: OPPORTUNITY_STATUS_CODES.WAITING };
}

export function shouldPromoteThreadToOpportunity(thread = {}) {
  if (thread.manually_promoted) return true;
  if (thread.last_inbound_at) return true;
  if (thread.needs_review) return true;
  const bucket = normalizeKey(thread.inbox_bucket);
  if (['new_replies', 'needs_review', 'priority', 'follow_up'].includes(bucket)) return true;
  const status = normalizeKey(thread.universal_status);
  if ([
    'seller_replied', 'needs_review', 'hot_lead', 'negotiating', 'underwriting',
    'offer_needed', 'offer_sent', 'contract_requested', 'contract_sent', 'closing',
  ].includes(status)) return true;
  const stage = normalizeKey(thread.universal_stage);
  if ([
    'interest_probe', 'price_discovery', 'underwriting_needed', 'offer_pending',
    'offer_sent', 'negotiation', 'contract_requested', 'contract_sent', 'closing',
  ].includes(stage)) return true;
  const aos = Number(thread.final_acquisition_score);
  if (Number.isFinite(aos) && aos >= 70) return true;
  if (thread.not_interested || thread.opt_out || thread.wrong_number) return false;
  if (status === 'awaiting_response' && !thread.last_inbound_at) return false;
  if (status === 'outbound_sent' && !thread.last_inbound_at) return false;
  return false;
}
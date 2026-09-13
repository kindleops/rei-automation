/**
 * Universal pipeline registry — canonical stage/status/temperature dimensions.
 *
 * Source contracts:
 * - classify.js (stage hints, intent → stage routing)
 * - resolve-inbox-state-from-classification.js (inbox bucket + universal status)
 * - communications-engine/state-machine.js (10-stage operator conversation stages)
 * - negotiationEngine.js (TEMPERATURES)
 * - resolve-waiting-cold-state.js (waiting → cold outbound bands)
 */

import { TEMPERATURES } from '@/lib/automation/negotiationEngine.js';
import { CONVERSATION_STAGES } from '@/lib/domain/communications-engine/state-machine.js';
import { resolveOutboundReplyState } from '@/lib/domain/inbox/resolve-waiting-cold-state.js';

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeKey(value) {
  return clean(value).toLowerCase().replace(/[\s-/]+/g, '_');
}

/** 10 operator-facing acquisition stages (canonical codes). */
export const UNIVERSAL_STAGE_CODES = Object.freeze({
  OWNERSHIP_CONFIRMATION: 'ownership_confirmation',
  OFFER_INTEREST: 'offer_interest',
  ASKING_PRICE: 'asking_price',
  PROPERTY_CONDITION: 'property_condition',
  OFFER: 'offer',
  FORMAL_CONTRACT: 'formal_contract',
  UNDER_CONTRACT: 'under_contract',
  DISPOSITION: 'disposition',
  PREPARED_TO_CLOSE: 'prepared_to_close',
  CLOSED: 'closed',
});

export const UNIVERSAL_STAGE_ORDER = Object.freeze([
  UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  UNIVERSAL_STAGE_CODES.OFFER_INTEREST,
  UNIVERSAL_STAGE_CODES.ASKING_PRICE,
  UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION,
  UNIVERSAL_STAGE_CODES.OFFER,
  UNIVERSAL_STAGE_CODES.FORMAL_CONTRACT,
  // Canonical operational order (S7–S10): Dispo → Under Contract With Buyer →
  // Escrow → Closed. Code strings retained; only order + labels move.
  UNIVERSAL_STAGE_CODES.DISPOSITION,
  UNIVERSAL_STAGE_CODES.UNDER_CONTRACT,
  UNIVERSAL_STAGE_CODES.PREPARED_TO_CLOSE,
  UNIVERSAL_STAGE_CODES.CLOSED,
]);

export const UNIVERSAL_STAGE_LABELS = Object.freeze({
  [UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION]: 'Ownership Confirmation',
  [UNIVERSAL_STAGE_CODES.OFFER_INTEREST]: 'Offer Interest',
  [UNIVERSAL_STAGE_CODES.ASKING_PRICE]: 'Asking Price',
  [UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION]: 'Property Condition',
  [UNIVERSAL_STAGE_CODES.OFFER]: 'Offer',
  [UNIVERSAL_STAGE_CODES.FORMAL_CONTRACT]: 'Formal Contract',
  [UNIVERSAL_STAGE_CODES.DISPOSITION]: 'Dispo',
  [UNIVERSAL_STAGE_CODES.UNDER_CONTRACT]: 'Under Contract With Buyer',
  [UNIVERSAL_STAGE_CODES.PREPARED_TO_CLOSE]: 'Escrow',
  [UNIVERSAL_STAGE_CODES.CLOSED]: 'Closed',
});

/** Inbox bucket-aligned universal status codes. */
export const UNIVERSAL_STATUS_CODES = Object.freeze({
  PRIORITY: 'priority',
  WAITING: 'waiting',
  COLD: 'cold',
  FOLLOW_UP: 'follow_up',
  NEEDS_REVIEW: 'needs_review',
  UNKNOWN: 'unknown',
});

export const UNIVERSAL_STATUS_LABELS = Object.freeze({
  [UNIVERSAL_STATUS_CODES.PRIORITY]: 'Priority',
  [UNIVERSAL_STATUS_CODES.WAITING]: 'Waiting',
  [UNIVERSAL_STATUS_CODES.COLD]: 'Cold',
  [UNIVERSAL_STATUS_CODES.FOLLOW_UP]: 'Follow Up',
  [UNIVERSAL_STATUS_CODES.NEEDS_REVIEW]: 'Needs Review',
  [UNIVERSAL_STATUS_CODES.UNKNOWN]: 'Unknown',
});

export const UNIVERSAL_TEMPERATURE_CODES = Object.freeze({
  COLD: TEMPERATURES.COLD,
  WARMING: TEMPERATURES.WARMING,
  ENGAGED: TEMPERATURES.ENGAGED,
  HOT: TEMPERATURES.HOT,
  DEAD: TEMPERATURES.DEAD,
  UNKNOWN: 'unknown',
});

export const UNIVERSAL_TEMPERATURE_LABELS = Object.freeze({
  [UNIVERSAL_TEMPERATURE_CODES.COLD]: 'Cold',
  [UNIVERSAL_TEMPERATURE_CODES.WARMING]: 'Warming',
  [UNIVERSAL_TEMPERATURE_CODES.ENGAGED]: 'Engaged',
  [UNIVERSAL_TEMPERATURE_CODES.HOT]: 'Hot',
  [UNIVERSAL_TEMPERATURE_CODES.DEAD]: 'Dead',
  [UNIVERSAL_TEMPERATURE_CODES.UNKNOWN]: 'Unknown',
});

/** Backward-compatible aliases used by legacy pipeline + tests. */
export const ACQUISITION_STAGE_CODES = Object.freeze({
  NEEDS_REVIEW: UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  OWNERSHIP_CONFIRMATION: UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  INTEREST_QUALIFICATION: UNIVERSAL_STAGE_CODES.OFFER_INTEREST,
  PRICE_DISCOVERY: UNIVERSAL_STAGE_CODES.ASKING_PRICE,
  UNDERWRITING: UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION,
  DECISION_AND_OFFER: UNIVERSAL_STAGE_CODES.OFFER,
  CONTRACT_TO_CLOSE: UNIVERSAL_STAGE_CODES.FORMAL_CONTRACT,
});

export const ACQUISITION_STAGE_ORDER = UNIVERSAL_STAGE_ORDER;

export const ACQUISITION_STAGE_LABELS = UNIVERSAL_STAGE_LABELS;

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
  // communications-engine/state-machine.js conversation stages
  ownership_confirmation: UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  offer_interest_confirmation: UNIVERSAL_STAGE_CODES.OFFER_INTEREST,
  seller_price_discovery: UNIVERSAL_STAGE_CODES.ASKING_PRICE,
  condition_timeline_discovery: UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION,
  condition_discovery: UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION,
  offer_positioning: UNIVERSAL_STAGE_CODES.OFFER,
  negotiation: UNIVERSAL_STAGE_CODES.OFFER,
  verbal_acceptance_lock: UNIVERSAL_STAGE_CODES.FORMAL_CONTRACT,
  contract_out: UNIVERSAL_STAGE_CODES.FORMAL_CONTRACT,
  signed_closing: UNIVERSAL_STAGE_CODES.UNDER_CONTRACT,
  closed_dead_outcome: UNIVERSAL_STAGE_CODES.CLOSED,

  // negotiationEngine.js + classify.js thread stages
  ownership_check: UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  ownership: UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  consider_selling: UNIVERSAL_STAGE_CODES.OFFER_INTEREST,
  interest_probe: UNIVERSAL_STAGE_CODES.OFFER_INTEREST,
  interest: UNIVERSAL_STAGE_CODES.OFFER_INTEREST,
  interest_qualification: UNIVERSAL_STAGE_CODES.OFFER_INTEREST,
  offer_interest: UNIVERSAL_STAGE_CODES.OFFER_INTEREST,
  seller_replied: UNIVERSAL_STAGE_CODES.OFFER_INTEREST,
  identity_question: UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  price_discovery: UNIVERSAL_STAGE_CODES.ASKING_PRICE,
  asking_price: UNIVERSAL_STAGE_CODES.ASKING_PRICE,
  condition_details: UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION,
  condition_collection: UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION,
  underwriting_needed: UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION,
  underwriting: UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION,
  property_condition: UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION,
  offer_pending: UNIVERSAL_STAGE_CODES.OFFER,
  offer_sent: UNIVERSAL_STAGE_CODES.OFFER,
  offer_negotiation: UNIVERSAL_STAGE_CODES.OFFER,
  decision_and_offer: UNIVERSAL_STAGE_CODES.OFFER,
  contract_requested: UNIVERSAL_STAGE_CODES.FORMAL_CONTRACT,
  contract_sent: UNIVERSAL_STAGE_CODES.FORMAL_CONTRACT,
  formal_contract: UNIVERSAL_STAGE_CODES.FORMAL_CONTRACT,
  title_closing: UNIVERSAL_STAGE_CODES.PREPARED_TO_CLOSE,
  closing: UNIVERSAL_STAGE_CODES.PREPARED_TO_CLOSE,
  prepared_to_close: UNIVERSAL_STAGE_CODES.PREPARED_TO_CLOSE,
  under_contract: UNIVERSAL_STAGE_CODES.UNDER_CONTRACT,
  disposition: UNIVERSAL_STAGE_CODES.DISPOSITION,
  contract_to_close: UNIVERSAL_STAGE_CODES.FORMAL_CONTRACT,
  needs_review: UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  new: UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  dead: UNIVERSAL_STAGE_CODES.CLOSED,
  suppressed: UNIVERSAL_STAGE_CODES.CLOSED,
  wrong_number: UNIVERSAL_STAGE_CODES.CLOSED,
  not_interested: UNIVERSAL_STAGE_CODES.CLOSED,
  awaiting_response: UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION,
});

const STAGE_INDEX = new Map(UNIVERSAL_STAGE_ORDER.map((code, index) => [code, index]));

const OPERATOR_LABEL_STAGE_MAP = Object.freeze({
  [normalizeKey(CONVERSATION_STAGES.OWNERSHIP_CONFIRMATION)]: UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  [normalizeKey(CONVERSATION_STAGES.OFFER_INTEREST_CONFIRMATION)]: UNIVERSAL_STAGE_CODES.OFFER_INTEREST,
  [normalizeKey(CONVERSATION_STAGES.SELLER_PRICE_DISCOVERY)]: UNIVERSAL_STAGE_CODES.ASKING_PRICE,
  [normalizeKey(CONVERSATION_STAGES.CONDITION_TIMELINE_DISCOVERY)]: UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION,
  [normalizeKey(CONVERSATION_STAGES.OFFER_POSITIONING)]: UNIVERSAL_STAGE_CODES.OFFER,
  [normalizeKey(CONVERSATION_STAGES.NEGOTIATION)]: UNIVERSAL_STAGE_CODES.OFFER,
  [normalizeKey(CONVERSATION_STAGES.VERBAL_ACCEPTANCE_LOCK)]: UNIVERSAL_STAGE_CODES.FORMAL_CONTRACT,
  [normalizeKey(CONVERSATION_STAGES.CONTRACT_OUT)]: UNIVERSAL_STAGE_CODES.FORMAL_CONTRACT,
  [normalizeKey(CONVERSATION_STAGES.SIGNED_CLOSING)]: UNIVERSAL_STAGE_CODES.UNDER_CONTRACT,
  [normalizeKey(CONVERSATION_STAGES.CLOSED_DEAD_OUTCOME)]: UNIVERSAL_STAGE_CODES.CLOSED,
});

const TERMINAL_OPPORTUNITY_STATUSES = new Set([
  OPPORTUNITY_STATUS_CODES.WON,
  OPPORTUNITY_STATUS_CODES.LOST,
  OPPORTUNITY_STATUS_CODES.DEAD,
  OPPORTUNITY_STATUS_CODES.SUPPRESSED,
  OPPORTUNITY_STATUS_CODES.ARCHIVED,
]);

const TERMINAL_STAGE_CODES = new Set([UNIVERSAL_STAGE_CODES.CLOSED]);

function normalizeLegacyBucket(bucket = '') {
  const normalized = normalizeKey(bucket);
  if (normalized === 'waiting_on_seller') return UNIVERSAL_STATUS_CODES.WAITING;
  return normalized;
}

export function normalizeUniversalStageCode(value, fallback = UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION) {
  const key = normalizeKey(value);
  if (!key) return fallback;
  if (STAGE_INDEX.has(key)) return key;
  if (STAGE_ALIAS_MAP[key]) return STAGE_ALIAS_MAP[key];
  if (OPERATOR_LABEL_STAGE_MAP[key]) return OPERATOR_LABEL_STAGE_MAP[key];

  if (key.includes('disposition')) return UNIVERSAL_STAGE_CODES.DISPOSITION;
  if (key.includes('prepared') || key.includes('clear_to_close')) {
    return UNIVERSAL_STAGE_CODES.PREPARED_TO_CLOSE;
  }
  if (key.includes('under_contract') || key.includes('signed')) {
    return UNIVERSAL_STAGE_CODES.UNDER_CONTRACT;
  }
  if (key.includes('contract') || key.includes('closing') || key.includes('title')) {
    return key.includes('under') ? UNIVERSAL_STAGE_CODES.UNDER_CONTRACT : UNIVERSAL_STAGE_CODES.FORMAL_CONTRACT;
  }
  if (key.includes('offer') || key.includes('negotiat')) return UNIVERSAL_STAGE_CODES.OFFER;
  if (key.includes('underwrit') || key.includes('condition')) return UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION;
  if (key.includes('price') || key.includes('asking')) return UNIVERSAL_STAGE_CODES.ASKING_PRICE;
  if (key.includes('interest') || key.includes('consider')) return UNIVERSAL_STAGE_CODES.OFFER_INTEREST;
  if (key.includes('ownership')) return UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION;
  if (key.includes('closed') || key.includes('dead')) return UNIVERSAL_STAGE_CODES.CLOSED;

  return fallback;
}

export function normalizeAcquisitionStageCode(value, fallback = UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION) {
  return normalizeUniversalStageCode(value, fallback);
}

export function universalStageLabel(code) {
  return UNIVERSAL_STAGE_LABELS[normalizeUniversalStageCode(code)] ?? 'Unknown Stage';
}

export function acquisitionStageLabel(code) {
  return universalStageLabel(code);
}

export function normalizeUniversalStatusCode(value, fallback = UNIVERSAL_STATUS_CODES.UNKNOWN) {
  const key = normalizeLegacyBucket(value);
  if (!key) return fallback;
  if (Object.values(UNIVERSAL_STATUS_CODES).includes(key)) return key;

  if (['priority', 'hot_lead', 'active', 'active_conversation', 'new_replies', 'seller_replied'].includes(key)) {
    return UNIVERSAL_STATUS_CODES.PRIORITY;
  }
  if (['waiting', 'awaiting_response', 'outbound_sent'].includes(key)) {
    return UNIVERSAL_STATUS_CODES.WAITING;
  }
  if (['cold', 'cold_reactivation', 'no_recent_activity'].includes(key)) return UNIVERSAL_STATUS_CODES.COLD;
  if (['follow_up', 'follow_up_due'].includes(key)) return UNIVERSAL_STATUS_CODES.FOLLOW_UP;
  if (['needs_review', 'manual_review'].includes(key)) return UNIVERSAL_STATUS_CODES.NEEDS_REVIEW;
  if (['dead', 'suppressed', 'dnc', 'wrong_number', 'not_interested'].includes(key)) {
    return UNIVERSAL_STATUS_CODES.UNKNOWN;
  }

  return fallback;
}

export function normalizeUniversalTemperatureCode(value, fallback = UNIVERSAL_TEMPERATURE_CODES.UNKNOWN) {
  const key = normalizeKey(value);
  if (!key) return fallback;
  if (Object.values(UNIVERSAL_TEMPERATURE_CODES).includes(key)) return key;
  if (key === 'warm') return UNIVERSAL_TEMPERATURE_CODES.WARMING;
  return fallback;
}

export function universalStatusLabel(code) {
  return UNIVERSAL_STATUS_LABELS[normalizeUniversalStatusCode(code)] ?? 'Unknown';
}

export function universalTemperatureLabel(code) {
  return UNIVERSAL_TEMPERATURE_LABELS[normalizeUniversalTemperatureCode(code)] ?? 'Unknown';
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

function deriveStageFromIntent(thread = {}) {
  const intent = normalizeKey(thread.primary_intent || thread.reply_intent || thread.latest_intent || thread.normalized_intent);
  if (!intent) return null;

  if (['ownership_confirmed', 'who_is_this'].includes(intent)) {
    return UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION;
  }
  if (['seller_interested', 'latent_interest', 'consider_selling'].includes(intent)) {
    return UNIVERSAL_STAGE_CODES.OFFER_INTEREST;
  }
  if (['asking_price_provided', 'asks_offer'].includes(intent)) {
    return intent === 'asking_price_provided'
      ? UNIVERSAL_STAGE_CODES.ASKING_PRICE
      : UNIVERSAL_STAGE_CODES.OFFER;
  }
  if (['condition_disclosed', 'tenant_occupied'].includes(intent)) {
    return UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION;
  }
  if (['callback_requested'].includes(intent)) return UNIVERSAL_STAGE_CODES.OFFER_INTEREST;
  if (['property_correction', 'unclear', 'hostile_or_legal'].includes(intent)) {
    return UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION;
  }
  return null;
}

/**
 * Derive universal stage from thread truth — never blanket-map inbound to Offer Interest.
 * Sources: deal_thread_state.universal_stage, conversation_stage, intent hints, outbound baseline.
 */
export function mapThreadToUniversalStage(thread = {}) {
  const terminalStatus = normalizeKey(thread.universal_status || thread.inbox_bucket);
  if (['dead', 'suppressed', 'wrong_number', 'not_interested', 'dnc'].includes(terminalStatus)
    || thread.wrong_number || thread.opt_out || thread.not_interested) {
    return UNIVERSAL_STAGE_CODES.CLOSED;
  }

  const candidates = [
    thread.universal_stage,
    thread.pipeline_stage,
    thread.conversation_stage,
    thread.seller_stage,
    thread.stage_hint,
    thread.current_stage,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeKey(candidate);
    if (!normalized || normalized === 'unknown') continue;
    if (STAGE_ALIAS_MAP[normalized] || STAGE_INDEX.has(normalized) || OPERATOR_LABEL_STAGE_MAP[normalized]) {
      return normalizeUniversalStageCode(candidate);
    }
  }

  const intentStage = deriveStageFromIntent(thread);
  if (intentStage) return intentStage;

  const lastInbound = thread.last_inbound_at;
  const lastOutbound = thread.last_outbound_at;
  const sellerReplied = lastInbound && (!lastOutbound || new Date(lastInbound) > new Date(lastOutbound));

  if (sellerReplied) {
    if (thread.needs_review || normalizeLegacyBucket(thread.inbox_bucket) === UNIVERSAL_STATUS_CODES.NEEDS_REVIEW) {
      return UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION;
    }
    return UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION;
  }

  if (lastOutbound && (!lastInbound || new Date(lastOutbound) > new Date(lastInbound))) {
    return UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION;
  }

  return UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION;
}

/**
 * Map inbox bucket + waiting/cold resolver output to universal status.
 * Source: resolve-inbox-state-from-classification.js + resolve-waiting-cold-state.js
 */
export function mapThreadToUniversalStatus(thread = {}) {
  if (thread.wrong_number || thread.not_interested) return UNIVERSAL_STATUS_CODES.UNKNOWN;
  if (thread.opt_out) return UNIVERSAL_STATUS_CODES.UNKNOWN;

  const bucket = normalizeLegacyBucket(
    thread.inbox_bucket || thread.inbox_category || thread.resolved_inbox_bucket,
  );
  if (bucket && Object.values(UNIVERSAL_STATUS_CODES).includes(bucket)) return bucket;

  if (bucket === 'new_replies' || bucket === 'priority') return UNIVERSAL_STATUS_CODES.PRIORITY;
  if (bucket === 'needs_review') return UNIVERSAL_STATUS_CODES.NEEDS_REVIEW;
  if (bucket === 'follow_up') return UNIVERSAL_STATUS_CODES.FOLLOW_UP;
  if (bucket === 'cold' || bucket === 'dead' || bucket === 'suppressed') return UNIVERSAL_STATUS_CODES.COLD;

  const outboundState = resolveOutboundReplyState({
    lastOutboundAt: thread.last_outbound_at || thread.latest_message_at,
    lastInboundAt: thread.last_inbound_at,
    latestDeliveryStatus: thread.latest_delivery_status || thread.latest_provider_delivery_status,
  });

  if (outboundState.inbox_bucket === 'waiting') return UNIVERSAL_STATUS_CODES.WAITING;
  if (outboundState.automation_lane === 'cold_reactivation') return UNIVERSAL_STATUS_CODES.COLD;

  const universalStatus = normalizeKey(thread.universal_status);
  if (universalStatus) return normalizeUniversalStatusCode(universalStatus);

  if (thread.needs_review) return UNIVERSAL_STATUS_CODES.NEEDS_REVIEW;
  if (thread.last_inbound_at) return UNIVERSAL_STATUS_CODES.PRIORITY;

  return UNIVERSAL_STATUS_CODES.UNKNOWN;
}

/** Map lead_temperature only — no fabrication when absent. */
export function mapThreadToUniversalTemperature(thread = {}) {
  const raw = thread.lead_temperature ?? thread.temperature ?? null;
  if (raw == null || clean(raw) === '') return UNIVERSAL_TEMPERATURE_CODES.UNKNOWN;
  return normalizeUniversalTemperatureCode(raw, UNIVERSAL_TEMPERATURE_CODES.UNKNOWN);
}

export function validateStageTransition({ fromStage, toStage, opportunityStatus, reason = '' }) {
  const from = normalizeUniversalStageCode(fromStage);
  const to = normalizeUniversalStageCode(toStage);
  if (from === to) return { ok: true, from, to };

  if (TERMINAL_OPPORTUNITY_STATUSES.has(normalizeOpportunityStatus(opportunityStatus))) {
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

  if (TERMINAL_STAGE_CODES.has(from) && to !== UNIVERSAL_STAGE_CODES.CLOSED && !clean(reason)) {
    return {
      ok: false,
      error: 'terminal_stage_requires_reason',
      message: 'Reopening a closed stage requires a reason.',
      from,
      to,
      requires_reason: true,
    };
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
  if (from === UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION
    && toIndex >= STAGE_INDEX.get(UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION)) {
    warnings.push('Skipping interest, price, and condition stages.');
  }
  if (from === UNIVERSAL_STAGE_CODES.OFFER
    && to === UNIVERSAL_STAGE_CODES.FORMAL_CONTRACT
    && !clean(reason)) {
    return {
      ok: false,
      error: 'contract_evidence_required',
      message: 'Offer → Formal Contract requires approval or contract evidence.',
      from,
      to,
      requires_reason: true,
    };
  }

  return { ok: true, from, to, warnings, requires_approval: false };
}

export function validateStatusTransition({ fromStatus, toStatus, reason = '' }) {
  const from = normalizeUniversalStatusCode(fromStatus);
  const to = normalizeUniversalStatusCode(toStatus);
  if (from === to) return { ok: true, from, to };

  const coldLike = new Set([UNIVERSAL_STATUS_CODES.COLD, UNIVERSAL_STATUS_CODES.UNKNOWN]);
  if (coldLike.has(from) && to === UNIVERSAL_STATUS_CODES.PRIORITY && !clean(reason)) {
    return {
      ok: false,
      error: 'reactivation_reason_required',
      message: 'Cold → Priority requires a reactivation reason.',
      from,
      to,
      requires_reason: true,
    };
  }

  return { ok: true, from, to };
}

export function validateTemperatureTransition({ fromTemperature, toTemperature, reason = '' }) {
  const from = normalizeUniversalTemperatureCode(fromTemperature);
  const to = normalizeUniversalTemperatureCode(toTemperature);
  if (from === to) return { ok: true, from, to };

  if (from === UNIVERSAL_TEMPERATURE_CODES.DEAD && to !== UNIVERSAL_TEMPERATURE_CODES.DEAD && !clean(reason)) {
    return {
      ok: false,
      error: 'temperature_reactivation_reason_required',
      message: 'Reviving a dead temperature requires a reason.',
      from,
      to,
      requires_reason: true,
    };
  }

  return { ok: true, from, to };
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

function mapUniversalStatusToOpportunityStatus(universalStatus, thread = {}) {
  const status = normalizeUniversalStatusCode(universalStatus);
  if (thread.wrong_number || thread.not_interested || status === UNIVERSAL_STATUS_CODES.UNKNOWN) {
    if (thread.opt_out) return OPPORTUNITY_STATUS_CODES.SUPPRESSED;
    if (thread.wrong_number || thread.not_interested) return OPPORTUNITY_STATUS_CODES.DEAD;
  }
  if (status === UNIVERSAL_STATUS_CODES.WAITING || status === UNIVERSAL_STATUS_CODES.COLD) {
    return OPPORTUNITY_STATUS_CODES.WAITING;
  }
  if (status === UNIVERSAL_STATUS_CODES.FOLLOW_UP) return OPPORTUNITY_STATUS_CODES.NURTURE;
  return OPPORTUNITY_STATUS_CODES.ACTIVE;
}

export function mapThreadStageToOpportunityStage(thread = {}) {
  const stage = mapThreadToUniversalStage(thread);
  const universalStatus = mapThreadToUniversalStatus(thread);
  return {
    stage,
    status: mapUniversalStatusToOpportunityStatus(universalStatus, thread),
    universal_status: universalStatus,
    universal_temperature: mapThreadToUniversalTemperature(thread),
  };
}

/**
 * Why a thread is (or is not) in the current acquisition pipeline.
 *
 * Every reason here names a CURRENT-system acquisition event. None of them is a
 * score, because a score is a priority, not a membership: a real conversation
 * with a low score belongs in the pipeline, and a high historical score with no
 * conversation does not.
 */
export const PIPELINE_ADMISSION_REASONS = Object.freeze({
  MANUAL_OPERATOR_ENROLLMENT: 'manual_operator_enrollment',
  SELLER_INBOUND: 'seller_inbound',
  OPERATOR_REVIEW_REQUESTED: 'operator_review_requested',
  SELLER_ENGAGEMENT: 'seller_engagement',
  ACQUISITION_STAGE_IN_PROGRESS: 'acquisition_stage_in_progress',
  ACTIVE_ACQUISITION_OPPORTUNITY: 'active_acquisition_opportunity',
  ASKING_PRICE_CAPTURED: 'asking_price_captured',
  ACTIVE_CAMPAIGN_TARGET: 'active_campaign_target',
  /** Not admitted. Terminal seller disposition with no current engagement. */
  TERMINAL_DISPOSITION: 'terminal_disposition',
  /** Not admitted. Historical score only — review, never active workflow. */
  LEGACY_PIPELINE_CANDIDATE: 'legacy_pipeline_candidate',
  /** Not admitted. */
  NO_CURRENT_ACQUISITION_EVIDENCE: 'no_current_acquisition_evidence',
});

const ENGAGED_UNIVERSAL_STATUSES = new Set([
  'seller_replied', 'needs_review', 'hot_lead', 'negotiating', 'underwriting',
  'offer_needed', 'offer_sent', 'contract_requested', 'contract_sent', 'closing',
]);

const IN_PROGRESS_STAGES = new Set([
  'interest_probe', 'price_discovery', 'underwriting_needed', 'offer_pending',
  'offer_sent', 'negotiation', 'contract_requested', 'contract_sent', 'closing',
  'offer_interest', 'asking_price', 'property_condition', 'formal_contract',
]);

const ENGAGED_INBOX_BUCKETS = new Set(['new_replies', 'needs_review', 'priority', 'follow_up']);

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * THE admission predicate for the current V2 acquisition pipeline.
 *
 * WHY THIS REPLACED A SCORE COMPARISON.
 * Admission used to end with `final_acquisition_score >= 70`. That column is a
 * Podio-era import on `properties`, surfaced through `inbox_threads_hydrated`,
 * and it decided membership in a pipeline it predates. It was reachable only by
 * accident: the two production callers pass a synthesised object and a
 * `deal_thread_state` row, and NEITHER carries the column, so the branch has
 * never fired. But `inbox_threads_hydrated` is the one row shape that does carry
 * it — and of its 8,887 threads, 1,949 have the score at 70+ with no inbound at
 * all, against 999 with a real inbound. One call site passing a hydrated row
 * would have admitted twice as many threads on a legacy import as the system has
 * ever had conversations.
 *
 * ORDERING IS LOAD-BEARING. Terminal disposition is checked AFTER the positive
 * signals, exactly as before: a seller who replied and then opted out still
 * belongs in the pipeline, because suppression is something the pipeline has to
 * carry, not a reason to forget the conversation happened.
 *
 * @param {object} context thread state, synthesised transition, or workflow row
 * @returns {{eligible: boolean, reason: string, evidence: object, source: string,
 *            legacy_pipeline_candidate: boolean}}
 */
export function shouldEnterAcquisitionPipeline(context = {}) {
  const source = clean(context.admission_source) || 'thread_state';
  const status = normalizeKey(context.universal_status);
  const stage = normalizeKey(context.universal_stage);
  const bucket = normalizeLegacyBucket(context.inbox_bucket);
  const legacyScore = num(context.final_acquisition_score);
  // Recorded so a legacy-only thread is classifiable for review. It never
  // contributes to `eligible`.
  const legacyCandidate = legacyScore !== null && legacyScore >= 70;

  const admit = (reason, evidence) => ({
    eligible: true,
    reason,
    evidence,
    source,
    legacy_pipeline_candidate: legacyCandidate,
  });
  const deny = (reason, evidence) => ({
    eligible: false,
    reason,
    evidence,
    source,
    legacy_pipeline_candidate: legacyCandidate,
  });

  if (context.manually_promoted === true || context.manual_enrollment === true) {
    return admit(PIPELINE_ADMISSION_REASONS.MANUAL_OPERATOR_ENROLLMENT, { manually_promoted: true });
  }

  // A seller actually said something. `deal_thread_state` has no
  // `last_inbound_at`, so the direction columns are the only inbound evidence
  // the workflow path ever sees.
  //
  // `latest_message_direction` only proves an inbound when the LAST message was
  // inbound: 65 threads have a real seller reply followed by an outbound and are
  // invisible to it. `has_seller_inbound` is the explicit escape hatch for a
  // caller that already knows — the predicate stays pure and never issues its
  // own query to find out.
  const inboundAt = context.last_inbound_at || null;
  const latestDirection = normalizeKey(context.latest_message_direction || context.direction);
  if (inboundAt || latestDirection === 'inbound' || context.has_seller_inbound === true) {
    return admit(PIPELINE_ADMISSION_REASONS.SELLER_INBOUND, {
      last_inbound_at: inboundAt,
      latest_message_direction: latestDirection || null,
      has_seller_inbound: context.has_seller_inbound === true || null,
    });
  }

  if (context.needs_review === true) {
    return admit(PIPELINE_ADMISSION_REASONS.OPERATOR_REVIEW_REQUESTED, { needs_review: true });
  }

  if (ENGAGED_INBOX_BUCKETS.has(bucket)) {
    return admit(PIPELINE_ADMISSION_REASONS.SELLER_ENGAGEMENT, { inbox_bucket: bucket });
  }

  if (ENGAGED_UNIVERSAL_STATUSES.has(status)) {
    return admit(PIPELINE_ADMISSION_REASONS.SELLER_ENGAGEMENT, { universal_status: status });
  }

  if (IN_PROGRESS_STAGES.has(stage)) {
    return admit(PIPELINE_ADMISSION_REASONS.ACQUISITION_STAGE_IN_PROGRESS, { universal_stage: stage });
  }

  // A seller-stated price is an acquisition interaction by itself. It could not
  // have been captured without one.
  const askingPrice = num(context.asking_price);
  if (askingPrice !== null && askingPrice > 0) {
    return admit(PIPELINE_ADMISSION_REASONS.ASKING_PRICE_CAPTURED, { asking_price: askingPrice });
  }

  if (clean(context.opportunity_id) || clean(context.acquisition_opportunity_id)) {
    return admit(PIPELINE_ADMISSION_REASONS.ACTIVE_ACQUISITION_OPPORTUNITY, {
      opportunity_id: clean(context.opportunity_id) || clean(context.acquisition_opportunity_id),
    });
  }

  if (clean(context.campaign_target_id) && normalizeKey(context.campaign_target_state) !== 'cancelled') {
    return admit(PIPELINE_ADMISSION_REASONS.ACTIVE_CAMPAIGN_TARGET, {
      campaign_target_id: clean(context.campaign_target_id),
    });
  }

  if (context.not_interested || context.opt_out || context.wrong_number) {
    return deny(PIPELINE_ADMISSION_REASONS.TERMINAL_DISPOSITION, {
      not_interested: context.not_interested === true,
      opt_out: context.opt_out === true,
      wrong_number: context.wrong_number === true,
    });
  }

  // Reached only with a legacy score and nothing current. Classified for review,
  // NOT enrolled: no V2 automation, no cadence, no seller fact is invented from
  // the number. The score stays exactly what it is — historical data.
  if (legacyCandidate) {
    return deny(PIPELINE_ADMISSION_REASONS.LEGACY_PIPELINE_CANDIDATE, {
      final_acquisition_score: legacyScore,
      disposition: 'legacy_unenrolled',
    });
  }

  return deny(PIPELINE_ADMISSION_REASONS.NO_CURRENT_ACQUISITION_EVIDENCE, {
    universal_status: status || null,
    universal_stage: stage || null,
  });
}

/** Boolean face of `shouldEnterAcquisitionPipeline` for existing callers. */
export function shouldPromoteThreadToOpportunity(thread = {}) {
  return shouldEnterAcquisitionPipeline(thread).eligible;
}
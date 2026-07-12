/**
 * Universal Lead State Registry — single canonical source for lifecycle, operational,
 * temperature, disposition, and contactability dimensions across all platform surfaces.
 *
 * Do not duplicate enum values in components. Import from here (API) or the dashboard mirror.
 */

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeKey(value) {
  return clean(value).toLowerCase().replace(/[\s-/]+/g, '_');
}

// ─── Lifecycle stages (10) ───────────────────────────────────────────────────

export const LIFECYCLE_STAGE_CODES = Object.freeze({
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

export const LIFECYCLE_STAGE_ORDER = Object.freeze([
  LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
  LIFECYCLE_STAGE_CODES.ASKING_PRICE,
  LIFECYCLE_STAGE_CODES.PROPERTY_CONDITION,
  LIFECYCLE_STAGE_CODES.OFFER,
  LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT,
  // Canonical operational order (S7–S10): Dispo → Under Contract With Buyer →
  // Escrow → Closed. The string VALUES are unchanged (disposition,
  // under_contract, prepared_to_close) so the acquisition_opportunities
  // acquisition_stage CHECK constraint stays satisfied and no string-keyed
  // consumer breaks; only the ordinal position and display label move. A
  // literal code rename (under_contract → under_contract_with_buyer,
  // prepared_to_close → escrow) is a proposed, unapplied migration
  // (docs/automation/PROPOSED_stage_code_rename_migration.md).
  LIFECYCLE_STAGE_CODES.DISPOSITION,
  LIFECYCLE_STAGE_CODES.UNDER_CONTRACT,
  LIFECYCLE_STAGE_CODES.PREPARED_TO_CLOSE,
  LIFECYCLE_STAGE_CODES.CLOSED,
]);

export const LIFECYCLE_STAGE_META = Object.freeze({
  [LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION]: { number: 1, label: 'Ownership Check', shortLabel: 'S1', color: '#aab3c5', icon: 'shield-check' },
  [LIFECYCLE_STAGE_CODES.OFFER_INTEREST]: { number: 2, label: 'Interest Probe', shortLabel: 'S2', color: '#64d2ff', icon: 'message-circle' },
  [LIFECYCLE_STAGE_CODES.ASKING_PRICE]: { number: 3, label: 'Asking Price', shortLabel: 'S3', color: '#bf5af2', icon: 'dollar-sign' },
  [LIFECYCLE_STAGE_CODES.PROPERTY_CONDITION]: { number: 4, label: 'Property Condition', shortLabel: 'S4', color: '#ff9f0a', icon: 'home' },
  [LIFECYCLE_STAGE_CODES.OFFER]: { number: 5, label: 'Offer', shortLabel: 'S5', color: '#ff453a', icon: 'file-text' },
  [LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT]: { number: 6, label: 'Formal Contract', shortLabel: 'S6', color: '#ff9f0a', icon: 'file-signature' },
  // S7 Dispo, S8 Under Contract With Buyer, S9 Escrow (code strings retained;
  // see LIFECYCLE_STAGE_ORDER note and the proposed code-rename migration).
  [LIFECYCLE_STAGE_CODES.DISPOSITION]: { number: 7, label: 'Dispo', shortLabel: 'S7', color: '#5ac8fa', icon: 'users' },
  [LIFECYCLE_STAGE_CODES.UNDER_CONTRACT]: { number: 8, label: 'Under Contract With Buyer', shortLabel: 'S8', color: '#34c759', icon: 'check-circle' },
  [LIFECYCLE_STAGE_CODES.PREPARED_TO_CLOSE]: { number: 9, label: 'Escrow', shortLabel: 'S9', color: '#30d158', icon: 'flag' },
  [LIFECYCLE_STAGE_CODES.CLOSED]: { number: 10, label: 'Closed', shortLabel: 'S10', color: '#7d8797', icon: 'lock' },
});

// ─── Operational statuses (9) ──────────────────────────────────────────────────

export const OPERATIONAL_STATUS_CODES = Object.freeze({
  NOT_CONTACTED: 'not_contacted',
  SCHEDULED: 'scheduled',
  NEW_REPLY: 'new_reply',
  ACTIVE_COMMUNICATION: 'active_communication',
  WAITING_ON_SELLER: 'waiting_on_seller',
  FOLLOW_UP_DUE: 'follow_up_due',
  NEEDS_REVIEW: 'needs_review',
  SNOOZED: 'snoozed',
  PAUSED: 'paused',
});

export const OPERATIONAL_STATUS_ORDER = Object.freeze([
  OPERATIONAL_STATUS_CODES.NOT_CONTACTED,
  OPERATIONAL_STATUS_CODES.SCHEDULED,
  OPERATIONAL_STATUS_CODES.NEW_REPLY,
  OPERATIONAL_STATUS_CODES.ACTIVE_COMMUNICATION,
  OPERATIONAL_STATUS_CODES.WAITING_ON_SELLER,
  OPERATIONAL_STATUS_CODES.FOLLOW_UP_DUE,
  OPERATIONAL_STATUS_CODES.NEEDS_REVIEW,
  OPERATIONAL_STATUS_CODES.SNOOZED,
  OPERATIONAL_STATUS_CODES.PAUSED,
]);

export const OPERATIONAL_STATUS_META = Object.freeze({
  [OPERATIONAL_STATUS_CODES.NOT_CONTACTED]: { label: 'Not Contacted', color: '#94a3b8', icon: 'circle-dashed' },
  [OPERATIONAL_STATUS_CODES.SCHEDULED]: { label: 'Scheduled', color: '#5bb6ff', icon: 'calendar' },
  [OPERATIONAL_STATUS_CODES.NEW_REPLY]: { label: 'New Reply', color: '#0a84ff', icon: 'inbox' },
  [OPERATIONAL_STATUS_CODES.ACTIVE_COMMUNICATION]: { label: 'Active Communication', color: '#30d158', icon: 'messages-square' },
  [OPERATIONAL_STATUS_CODES.WAITING_ON_SELLER]: { label: 'Waiting on Seller', color: '#ffd60a', icon: 'clock' },
  [OPERATIONAL_STATUS_CODES.FOLLOW_UP_DUE]: { label: 'Follow-Up Due', color: '#ff9f43', icon: 'alarm-clock' },
  [OPERATIONAL_STATUS_CODES.NEEDS_REVIEW]: { label: 'Needs Review', color: '#ff9f43', icon: 'alert-triangle' },
  [OPERATIONAL_STATUS_CODES.SNOOZED]: { label: 'Snoozed', color: '#a78bfa', icon: 'moon' },
  [OPERATIONAL_STATUS_CODES.PAUSED]: { label: 'Paused', color: '#7d8797', icon: 'pause-circle' },
});

// ─── Lead temperature (4) ────────────────────────────────────────────────────

export const LEAD_TEMPERATURE_CODES = Object.freeze({
  UNSCORED: 'unscored',
  COLD: 'cold',
  WARM: 'warm',
  HOT: 'hot',
});

export const LEAD_TEMPERATURE_ORDER = Object.freeze([
  LEAD_TEMPERATURE_CODES.UNSCORED,
  LEAD_TEMPERATURE_CODES.COLD,
  LEAD_TEMPERATURE_CODES.WARM,
  LEAD_TEMPERATURE_CODES.HOT,
]);

export const LEAD_TEMPERATURE_META = Object.freeze({
  [LEAD_TEMPERATURE_CODES.UNSCORED]: { label: 'Unscored', color: '#94a3b8' },
  [LEAD_TEMPERATURE_CODES.COLD]: { label: 'Cold', color: '#5ac8fa' },
  [LEAD_TEMPERATURE_CODES.WARM]: { label: 'Warm', color: '#ff9f43' },
  [LEAD_TEMPERATURE_CODES.HOT]: { label: 'Hot', color: '#ff6b35' },
});

// ─── Disposition ─────────────────────────────────────────────────────────────

export const DISPOSITION_CODES = Object.freeze({
  INTERESTED: 'interested',
  NOT_INTERESTED: 'not_interested',
  WRONG_PERSON: 'wrong_person',
  WRONG_NUMBER: 'wrong_number',
  REFERRED: 'referred',
  SOLD: 'sold',
  DUPLICATE: 'duplicate',
  UNQUALIFIED: 'unqualified',
  NO_RESPONSE: 'no_response',
  NONE: 'none',
});

export const DISPOSITION_ORDER = Object.freeze(Object.values(DISPOSITION_CODES));

export const DISPOSITION_META = Object.freeze({
  [DISPOSITION_CODES.INTERESTED]: { label: 'Interested', color: '#30d158' },
  [DISPOSITION_CODES.NOT_INTERESTED]: { label: 'Not Interested', color: '#7d8797' },
  [DISPOSITION_CODES.WRONG_PERSON]: { label: 'Wrong Person', color: '#ff9f43' },
  [DISPOSITION_CODES.WRONG_NUMBER]: { label: 'Wrong Number', color: '#ff453a' },
  [DISPOSITION_CODES.REFERRED]: { label: 'Referred', color: '#5ac8fa' },
  [DISPOSITION_CODES.SOLD]: { label: 'Sold', color: '#34c759' },
  [DISPOSITION_CODES.DUPLICATE]: { label: 'Duplicate', color: '#94a3b8' },
  [DISPOSITION_CODES.UNQUALIFIED]: { label: 'Unqualified', color: '#7d8797' },
  [DISPOSITION_CODES.NO_RESPONSE]: { label: 'No Response', color: '#aab3c5' },
  [DISPOSITION_CODES.NONE]: { label: 'None', color: '#64748b' },
});

// ─── Contactability ──────────────────────────────────────────────────────────

export const CONTACTABILITY_CODES = Object.freeze({
  CONTACTABLE: 'contactable',
  OPTED_OUT: 'opted_out',
  DNC: 'dnc',
  PROVIDER_BLACKLISTED: 'provider_blacklisted',
  INVALID_NUMBER: 'invalid_number',
  DO_NOT_TEXT: 'do_not_text',
});

export const CONTACTABILITY_ORDER = Object.freeze(Object.values(CONTACTABILITY_CODES));

export const CONTACTABILITY_META = Object.freeze({
  [CONTACTABILITY_CODES.CONTACTABLE]: { label: 'Contactable', color: '#30d158', blocksSend: false },
  [CONTACTABILITY_CODES.OPTED_OUT]: { label: 'Opted Out', color: '#ff453a', blocksSend: true },
  [CONTACTABILITY_CODES.DNC]: { label: 'DNC', color: '#ff453a', blocksSend: true },
  [CONTACTABILITY_CODES.PROVIDER_BLACKLISTED]: { label: 'Provider Blacklisted', color: '#ff6b64', blocksSend: true },
  [CONTACTABILITY_CODES.INVALID_NUMBER]: { label: 'Invalid Number', color: '#ff9f43', blocksSend: true },
  [CONTACTABILITY_CODES.DO_NOT_TEXT]: { label: 'Do Not Text', color: '#ff453a', blocksSend: true },
});

export const BLOCKING_CONTACTABILITY = new Set(
  Object.entries(CONTACTABILITY_META)
    .filter(([, meta]) => meta.blocksSend)
    .map(([code]) => code),
);

// ─── Archive scope ───────────────────────────────────────────────────────────

export const ARCHIVE_SCOPE_CODES = Object.freeze({
  CONVERSATION: 'conversation',
  LEAD: 'lead',
});

// ─── Source attribution ──────────────────────────────────────────────────────

export const STATE_SOURCE_CODES = Object.freeze({
  AI: 'ai',
  MANUAL: 'manual',
  SYSTEM: 'system',
  AUTOPILOT: 'autopilot',
});

// ─── Legacy stage alias map ──────────────────────────────────────────────────

const LIFECYCLE_STAGE_ALIAS_MAP = Object.freeze({
  ownership_check: LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  ownership_confirmed: LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
  ownership: LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  identity_question: LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  interest_probe: LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
  interest: LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
  consider_selling: LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
  seller_response: LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
  interest_qualification: LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
  pricing: LIFECYCLE_STAGE_CODES.ASKING_PRICE,
  price_discovery: LIFECYCLE_STAGE_CODES.ASKING_PRICE,
  asking_price: LIFECYCLE_STAGE_CODES.ASKING_PRICE,
  condition: LIFECYCLE_STAGE_CODES.PROPERTY_CONDITION,
  condition_details: LIFECYCLE_STAGE_CODES.PROPERTY_CONDITION,
  condition_collection: LIFECYCLE_STAGE_CODES.PROPERTY_CONDITION,
  property_condition: LIFECYCLE_STAGE_CODES.PROPERTY_CONDITION,
  offer_reveal: LIFECYCLE_STAGE_CODES.OFFER,
  offer_sent: LIFECYCLE_STAGE_CODES.OFFER,
  offer_pending: LIFECYCLE_STAGE_CODES.OFFER,
  negotiation: LIFECYCLE_STAGE_CODES.OFFER,
  offer_negotiation: LIFECYCLE_STAGE_CODES.OFFER,
  contract_sent: LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT,
  contract_path: LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT,
  contract_requested: LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT,
  formal_contract: LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT,
  under_contract: LIFECYCLE_STAGE_CODES.UNDER_CONTRACT,
  // Forward-compatible alias for the proposed S8 code rename (Under Contract
  // With Buyer). Resolves before the CHECK-constraint migration is applied.
  under_contract_with_buyer: LIFECYCLE_STAGE_CODES.UNDER_CONTRACT,
  buyer_under_contract: LIFECYCLE_STAGE_CODES.UNDER_CONTRACT,
  disposition: LIFECYCLE_STAGE_CODES.DISPOSITION,
  dispo: LIFECYCLE_STAGE_CODES.DISPOSITION,
  closing: LIFECYCLE_STAGE_CODES.PREPARED_TO_CLOSE,
  prepared_to_close: LIFECYCLE_STAGE_CODES.PREPARED_TO_CLOSE,
  // Forward-compatible alias for the proposed S9 code rename (Escrow).
  escrow: LIFECYCLE_STAGE_CODES.PREPARED_TO_CLOSE,
  title_closing: LIFECYCLE_STAGE_CODES.PREPARED_TO_CLOSE,
  closed: LIFECYCLE_STAGE_CODES.CLOSED,
  dead: LIFECYCLE_STAGE_CODES.CLOSED,
  follow_up: LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
  s1_ownership: LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  s2_interest: LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
  s3_pricing: LIFECYCLE_STAGE_CODES.ASKING_PRICE,
  s4_condition: LIFECYCLE_STAGE_CODES.PROPERTY_CONDITION,
  s5_offer: LIFECYCLE_STAGE_CODES.OFFER,
  s6_negotiation: LIFECYCLE_STAGE_CODES.OFFER,
  s7_follow_up: LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
  s8_closing: LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT,
  waiting: LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
  needs_response: LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
  s1: LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  s2: LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
});

const OPERATIONAL_STATUS_ALIAS_MAP = Object.freeze({
  open: OPERATIONAL_STATUS_CODES.NOT_CONTACTED,
  not_contacted: OPERATIONAL_STATUS_CODES.NOT_CONTACTED,
  scheduled: OPERATIONAL_STATUS_CODES.SCHEDULED,
  queued: OPERATIONAL_STATUS_CODES.SCHEDULED,
  new_reply: OPERATIONAL_STATUS_CODES.NEW_REPLY,
  new_replies: OPERATIONAL_STATUS_CODES.NEW_REPLY,
  needs_reply: OPERATIONAL_STATUS_CODES.NEW_REPLY,
  active: OPERATIONAL_STATUS_CODES.ACTIVE_COMMUNICATION,
  active_communication: OPERATIONAL_STATUS_CODES.ACTIVE_COMMUNICATION,
  seller_replied: OPERATIONAL_STATUS_CODES.ACTIVE_COMMUNICATION,
  waiting: OPERATIONAL_STATUS_CODES.WAITING_ON_SELLER,
  waiting_on_seller: OPERATIONAL_STATUS_CODES.WAITING_ON_SELLER,
  awaiting_response: OPERATIONAL_STATUS_CODES.WAITING_ON_SELLER,
  follow_up: OPERATIONAL_STATUS_CODES.FOLLOW_UP_DUE,
  follow_up_due: OPERATIONAL_STATUS_CODES.FOLLOW_UP_DUE,
  needs_review: OPERATIONAL_STATUS_CODES.NEEDS_REVIEW,
  manual_review: OPERATIONAL_STATUS_CODES.NEEDS_REVIEW,
  snoozed: OPERATIONAL_STATUS_CODES.SNOOZED,
  paused: OPERATIONAL_STATUS_CODES.PAUSED,
  offer_sent: OPERATIONAL_STATUS_CODES.WAITING_ON_SELLER,
  contract_sent: OPERATIONAL_STATUS_CODES.WAITING_ON_SELLER,
  under_contract: OPERATIONAL_STATUS_CODES.ACTIVE_COMMUNICATION,
  closed: OPERATIONAL_STATUS_CODES.PAUSED,
  suppressed: OPERATIONAL_STATUS_CODES.PAUSED,
  read: OPERATIONAL_STATUS_CODES.ACTIVE_COMMUNICATION,
  unread: OPERATIONAL_STATUS_CODES.NEW_REPLY,
  dead: OPERATIONAL_STATUS_CODES.PAUSED,
});

const TEMPERATURE_ALIAS_MAP = Object.freeze({
  unscored: LEAD_TEMPERATURE_CODES.UNSCORED,
  unknown: LEAD_TEMPERATURE_CODES.UNSCORED,
  cold: LEAD_TEMPERATURE_CODES.COLD,
  warming: LEAD_TEMPERATURE_CODES.WARM,
  warm: LEAD_TEMPERATURE_CODES.WARM,
  engaged: LEAD_TEMPERATURE_CODES.WARM,
  hot: LEAD_TEMPERATURE_CODES.HOT,
  dead: LEAD_TEMPERATURE_CODES.COLD,
  priority: LEAD_TEMPERATURE_CODES.HOT,
});

const DISPOSITION_ALIAS_MAP = Object.freeze({
  interested: DISPOSITION_CODES.INTERESTED,
  not_interested: DISPOSITION_CODES.NOT_INTERESTED,
  wrong_person: DISPOSITION_CODES.WRONG_PERSON,
  wrong_number: DISPOSITION_CODES.WRONG_NUMBER,
  referred: DISPOSITION_CODES.REFERRED,
  sold: DISPOSITION_CODES.SOLD,
  duplicate: DISPOSITION_CODES.DUPLICATE,
  unqualified: DISPOSITION_CODES.UNQUALIFIED,
  no_response: DISPOSITION_CODES.NO_RESPONSE,
  none: DISPOSITION_CODES.NONE,
  null: DISPOSITION_CODES.NONE,
  '': DISPOSITION_CODES.NONE,
});

const CONTACTABILITY_ALIAS_MAP = Object.freeze({
  contactable: CONTACTABILITY_CODES.CONTACTABLE,
  opted_out: CONTACTABILITY_CODES.OPTED_OUT,
  opt_out: CONTACTABILITY_CODES.OPTED_OUT,
  dnc: CONTACTABILITY_CODES.DNC,
  do_not_contact: CONTACTABILITY_CODES.DNC,
  provider_blacklisted: CONTACTABILITY_CODES.PROVIDER_BLACKLISTED,
  invalid_number: CONTACTABILITY_CODES.INVALID_NUMBER,
  do_not_text: CONTACTABILITY_CODES.DO_NOT_TEXT,
  suppressed: CONTACTABILITY_CODES.OPTED_OUT,
});

const STAGE_INDEX = new Map(LIFECYCLE_STAGE_ORDER.map((code, index) => [code, index]));

export function normalizeLifecycleStage(value, fallback = LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION) {
  const key = normalizeKey(value);
  if (!key) return fallback;
  if (STAGE_INDEX.has(key)) return key;
  if (LIFECYCLE_STAGE_ALIAS_MAP[key]) return LIFECYCLE_STAGE_ALIAS_MAP[key];
  if (key.includes('contract') && key.includes('under')) return LIFECYCLE_STAGE_CODES.UNDER_CONTRACT;
  if (key.includes('contract') || key.includes('closing')) return LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT;
  if (key.includes('offer') || key.includes('negotiat')) return LIFECYCLE_STAGE_CODES.OFFER;
  if (key.includes('condition') || key.includes('underwrit')) return LIFECYCLE_STAGE_CODES.PROPERTY_CONDITION;
  if (key.includes('price') || key.includes('asking')) return LIFECYCLE_STAGE_CODES.ASKING_PRICE;
  if (key.includes('interest') || key.includes('consider')) return LIFECYCLE_STAGE_CODES.OFFER_INTEREST;
  if (key.includes('ownership')) return LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION;
  if (key.includes('disposition') || key === 'dispo') return LIFECYCLE_STAGE_CODES.DISPOSITION;
  if (key.includes('prepared') || key.includes('clear_to_close') || key.includes('escrow')) return LIFECYCLE_STAGE_CODES.PREPARED_TO_CLOSE;
  if (key.includes('closed') || key.includes('dead')) return LIFECYCLE_STAGE_CODES.CLOSED;
  return fallback;
}

export function normalizeOperationalStatus(value, fallback = OPERATIONAL_STATUS_CODES.NOT_CONTACTED) {
  const key = normalizeKey(value);
  if (!key) return fallback;
  if (OPERATIONAL_STATUS_ORDER.includes(key)) return key;
  if (OPERATIONAL_STATUS_ALIAS_MAP[key]) return OPERATIONAL_STATUS_ALIAS_MAP[key];
  return fallback;
}

export function normalizeLeadTemperature(value, fallback = LEAD_TEMPERATURE_CODES.UNSCORED) {
  const key = normalizeKey(value);
  if (!key) return fallback;
  if (LEAD_TEMPERATURE_ORDER.includes(key)) return key;
  if (TEMPERATURE_ALIAS_MAP[key]) return TEMPERATURE_ALIAS_MAP[key];
  return fallback;
}

export function normalizeDisposition(value, fallback = DISPOSITION_CODES.NONE) {
  const key = normalizeKey(value);
  if (!key) return fallback;
  if (DISPOSITION_ORDER.includes(key)) return key;
  if (DISPOSITION_ALIAS_MAP[key]) return DISPOSITION_ALIAS_MAP[key];
  return fallback;
}

export function normalizeContactability(value, fallback = CONTACTABILITY_CODES.CONTACTABLE) {
  const key = normalizeKey(value);
  if (!key) return fallback;
  if (CONTACTABILITY_ORDER.includes(key)) return key;
  if (CONTACTABILITY_ALIAS_MAP[key]) return CONTACTABILITY_ALIAS_MAP[key];
  return fallback;
}

export function lifecycleStageLabel(code) {
  const normalized = normalizeLifecycleStage(code);
  return LIFECYCLE_STAGE_META[normalized]?.label ?? 'Unknown Stage';
}

export function lifecycleStageNumber(code) {
  const normalized = normalizeLifecycleStage(code);
  return LIFECYCLE_STAGE_META[normalized]?.number ?? null;
}

export function operationalStatusLabel(code) {
  const normalized = normalizeOperationalStatus(code);
  return OPERATIONAL_STATUS_META[normalized]?.label ?? 'Unknown Status';
}

export function leadTemperatureLabel(code) {
  const normalized = normalizeLeadTemperature(code);
  return LEAD_TEMPERATURE_META[normalized]?.label ?? 'Unscored';
}

export function dispositionLabel(code) {
  const normalized = normalizeDisposition(code);
  return DISPOSITION_META[normalized]?.label ?? 'None';
}

export function contactabilityLabel(code) {
  const normalized = normalizeContactability(code);
  return CONTACTABILITY_META[normalized]?.label ?? 'Contactable';
}

export function contactabilityBlocksSend(code) {
  return BLOCKING_CONTACTABILITY.has(normalizeContactability(code));
}

export function isAllowedLifecycleTransition(fromCode, toCode) {
  const from = normalizeLifecycleStage(fromCode);
  const to = normalizeLifecycleStage(toCode);
  if (from === to) return true;
  const fromIdx = STAGE_INDEX.get(from) ?? 0;
  const toIdx = STAGE_INDEX.get(to) ?? 0;
  return toIdx >= fromIdx || to === LIFECYCLE_STAGE_CODES.CLOSED;
}

/** Canonical patchable field names on inbox_thread_state / property lead state. */
export const UNIVERSAL_LEAD_STATE_PATCH_FIELDS = Object.freeze([
  'lifecycle_stage',
  'operational_status',
  'lead_temperature',
  'disposition',
  'contactability_status',
  'next_action',
  'next_action_at',
  'follow_up_at',
  'stage_source',
  'status_source',
  'temperature_source',
  'disposition_source',
  'contactability_source',
  'manual_stage_lock',
  'manual_temperature_lock',
  'snoozed_until',
  'snooze_reason',
  'archived_at',
  'archive_scope',
  'archive_reason',
  'paused_reason',
  'is_archived',
  'is_read',
  'is_pinned',
  'is_starred',
  'updated_by',
]);

/** Backward-compatible aliases written by legacy UI paths. */
export const LEGACY_FIELD_ALIASES = Object.freeze({
  seller_stage: 'lifecycle_stage',
  conversation_status: 'operational_status',
  temperature: 'lead_temperature',
  stage: 'lifecycle_stage',
  status: 'operational_status',
});

export function normalizePatchToCanonical(patch = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(patch || {})) {
    const canonicalKey = LEGACY_FIELD_ALIASES[key] || key;
    if (
      !UNIVERSAL_LEAD_STATE_PATCH_FIELDS.includes(canonicalKey) &&
      !['autopilot_mode', 'assigned_user', 'manual_review', 'master_owner_id', 'property_id'].includes(canonicalKey)
    ) {
      continue;
    }
    if (canonicalKey === 'lifecycle_stage') normalized.lifecycle_stage = normalizeLifecycleStage(value);
    else if (canonicalKey === 'operational_status') normalized.operational_status = normalizeOperationalStatus(value);
    else if (canonicalKey === 'lead_temperature') normalized.lead_temperature = normalizeLeadTemperature(value);
    else if (canonicalKey === 'disposition') normalized.disposition = normalizeDisposition(value);
    else if (canonicalKey === 'contactability_status') normalized.contactability_status = normalizeContactability(value);
    else normalized[canonicalKey] = value;
  }
  return normalized;
}
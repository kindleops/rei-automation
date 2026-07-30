/**
 * Offerr Evaluation Spine — canonical domain contracts.
 *
 * Offerr is the private direct-to-seller acquisition channel. This module owns
 * the vocabulary and validated shapes for the internal evaluation spine:
 *
 *   seller-submitted address -> property resolution -> internal evaluation
 *   -> preliminary (non-binding) seller range OR review/unsupported outcome.
 *
 * Boundary rules encoded here:
 *   - Seller-provided facts are CLAIMS. They are carried as a separate overlay
 *     envelope (source: 'seller_claimed', verified: false) and never mutate the
 *     canonical property record.
 *   - No result produced by this spine is an offer. Outcomes use the
 *     OFFERR_OUTCOMES vocabulary; ranges are always preliminary/non-binding.
 *   - No seller contact information is required or accepted at intake for the
 *     internal evaluation (contact enrichment is explicitly deferred).
 *
 * Validation follows repo convention: hand-rolled coercion, no schema library.
 */

export const OFFERR_SPINE_VERSION = 'offerr-evaluation-spine-v1';

export const OFFERR_FLAG_KEY = 'offerr_evaluation_enabled';

/** Deterministic property-resolution statuses (documented in docs/offerr). */
export const OFFERR_RESOLUTION_STATUSES = Object.freeze({
  RESOLVED: 'RESOLVED',
  AMBIGUOUS: 'AMBIGUOUS',
  NOT_FOUND: 'NOT_FOUND',
  UNSUPPORTED: 'UNSUPPORTED',
});

/** Deterministic evaluation outcomes. None of these is a binding offer. */
export const OFFERR_OUTCOMES = Object.freeze({
  INSTANT_RANGE_ELIGIBLE: 'INSTANT_RANGE_ELIGIBLE',
  CONDITIONAL_RANGE: 'CONDITIONAL_RANGE',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  UNSUPPORTED: 'UNSUPPORTED',
});

/** Seller-safe confidence labels (never raw internal confidence numbers). */
export const OFFERR_CONFIDENCE_LABELS = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
});

/** Seller-safe next-step vocabulary. */
export const OFFERR_NEXT_STEPS = Object.freeze({
  SCHEDULE_VERIFICATION: 'schedule_walkthrough_verification',
  VERIFY_CONDITION_DETAILS: 'verify_property_condition_details',
  CONFIRM_PROPERTY_ADDRESS: 'confirm_property_address',
  CONFIRM_PROPERTY_IDENTITY: 'confirm_property_identity',
  INTERNAL_REVIEW: 'internal_review',
  NOT_SERVICEABLE: 'not_serviceable_manual_follow_up',
});

/**
 * Asset families the Offerr spine may evaluate autonomously. Everything else
 * fails closed to UNSUPPORTED (no automatic range). Values must match
 * ASSET_FAMILIES in @/lib/acquisition/modelConstants.js.
 */
export const OFFERR_SUPPORTED_ASSET_FAMILIES = Object.freeze([
  'RESIDENTIAL_SINGLE',
  'SMALL_MULTI',
]);

/** How long a preliminary range stays presentable before re-evaluation. */
export const OFFERR_EVALUATION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export const OFFERR_INTAKE_LIMITS = Object.freeze({
  address_min_length: 8,
  address_max_length: 240,
  idempotency_key_min_length: 8,
  idempotency_key_max_length: 128,
  source_max_length: 64,
  repairs_notes_max_length: 500,
  max_request_bytes: 32_768,
});

const CONDITION_VALUES = Object.freeze(['excellent', 'good', 'fair', 'poor']);
const OCCUPANCY_VALUES = Object.freeze(['owner_occupied', 'tenant_occupied', 'vacant', 'unknown']);
const REPAIR_LEVELS = Object.freeze(['none', 'cosmetic', 'moderate', 'major']);
const TIMELINE_VALUES = Object.freeze(['asap', '30_days', '60_days', '90_days_plus', 'exploring']);
const SELLER_FACT_KEYS = Object.freeze(['condition', 'occupancy', 'repairs', 'timeline', 'asking_price']);

function clean(value) {
  return String(value ?? '').trim();
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a submitted address for deterministic comparison. Mirrors
 * normalizeAddressSearch in entity-graph-normalize.js (lowercase, punctuation
 * to spaces, collapsed whitespace) so Offerr matching stays aligned with the
 * repo's only existing address-search normalization.
 */
export function normalizeOfferrAddress(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Wrap a seller-provided value as an unverified claim envelope. */
function sellerClaim(value, receivedAt) {
  return {
    value,
    source: 'seller_claimed',
    verified: false,
    received_at: receivedAt,
  };
}

/**
 * Normalize optional seller-confirmed facts into the overlay envelope.
 * Unknown keys and out-of-vocabulary values are validation errors (fail
 * closed) rather than silently dropped.
 */
export function normalizeSellerFacts(rawFacts, { receivedAt } = {}) {
  const errors = [];
  const facts = {};

  if (rawFacts === null || rawFacts === undefined) {
    return { ok: true, errors, facts };
  }
  if (typeof rawFacts !== 'object' || Array.isArray(rawFacts)) {
    return { ok: false, errors: ['seller_facts_must_be_object'], facts: {} };
  }

  for (const key of Object.keys(rawFacts)) {
    if (!SELLER_FACT_KEYS.includes(key)) {
      errors.push(`seller_facts_unknown_key:${key}`);
    }
  }

  const condition = clean(rawFacts.condition).toLowerCase();
  if (rawFacts.condition !== undefined) {
    if (CONDITION_VALUES.includes(condition)) {
      facts.condition = sellerClaim(condition, receivedAt);
    } else {
      errors.push('seller_facts_invalid_condition');
    }
  }

  const occupancy = clean(rawFacts.occupancy).toLowerCase();
  if (rawFacts.occupancy !== undefined) {
    if (OCCUPANCY_VALUES.includes(occupancy)) {
      facts.occupancy = sellerClaim(occupancy, receivedAt);
    } else {
      errors.push('seller_facts_invalid_occupancy');
    }
  }

  if (rawFacts.repairs !== undefined) {
    const repairs = rawFacts.repairs;
    const level = clean(typeof repairs === 'object' && repairs !== null ? repairs.level : repairs).toLowerCase();
    const notes = clean(typeof repairs === 'object' && repairs !== null ? repairs.notes : '');
    if (!REPAIR_LEVELS.includes(level)) {
      errors.push('seller_facts_invalid_repairs_level');
    } else if (notes.length > OFFERR_INTAKE_LIMITS.repairs_notes_max_length) {
      errors.push('seller_facts_repairs_notes_too_long');
    } else {
      facts.repairs = sellerClaim({ level, notes: notes || null }, receivedAt);
    }
  }

  const timeline = clean(rawFacts.timeline).toLowerCase();
  if (rawFacts.timeline !== undefined) {
    if (TIMELINE_VALUES.includes(timeline)) {
      facts.timeline = sellerClaim(timeline, receivedAt);
    } else {
      errors.push('seller_facts_invalid_timeline');
    }
  }

  if (rawFacts.asking_price !== undefined) {
    const askingPrice = num(rawFacts.asking_price);
    if (askingPrice === null || askingPrice <= 0 || askingPrice >= 100_000_000) {
      errors.push('seller_facts_invalid_asking_price');
    } else {
      facts.asking_price = sellerClaim(askingPrice, receivedAt);
    }
  }

  return { ok: errors.length === 0, errors, facts };
}

/**
 * Validate and normalize an Offerr intake request.
 *
 * @param {object} input
 * @param {string} input.address - Raw seller-submitted address (required).
 * @param {string} input.idempotency_key - Caller idempotency key (required).
 * @param {object} [input.seller_facts] - Optional seller-confirmed facts.
 * @param {string} [input.source] - Intake source label (default 'internal').
 * @param {object} [options]
 * @param {Date}   [options.now] - Injectable clock.
 * @param {Function} [options.generateRequestId] - Injectable id factory.
 * @returns {{ ok: boolean, errors: string[], intake: object|null }}
 */
export function normalizeOfferrIntake(input = {}, options = {}) {
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();
  const errors = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['intake_must_be_object'], intake: null };
  }

  const rawAddress = clean(input.address ?? input.submitted_address);
  if (rawAddress.length < OFFERR_INTAKE_LIMITS.address_min_length) {
    errors.push('address_required_min_8_chars');
  }
  if (rawAddress.length > OFFERR_INTAKE_LIMITS.address_max_length) {
    errors.push('address_too_long');
  }

  const normalizedAddress = normalizeOfferrAddress(rawAddress);
  if (normalizedAddress && !/\d/.test(normalizedAddress)) {
    // A resolvable street address needs at least a street number.
    errors.push('address_missing_street_number');
  }

  const idempotencyKey = clean(input.idempotency_key ?? input.idempotencyKey);
  if (
    idempotencyKey.length < OFFERR_INTAKE_LIMITS.idempotency_key_min_length ||
    idempotencyKey.length > OFFERR_INTAKE_LIMITS.idempotency_key_max_length
  ) {
    errors.push('idempotency_key_required_8_to_128_chars');
  }

  const source = clean(input.source) || 'internal';
  if (source.length > OFFERR_INTAKE_LIMITS.source_max_length) {
    errors.push('source_too_long');
  }

  const factsResult = normalizeSellerFacts(input.seller_facts ?? input.sellerFacts, {
    receivedAt: createdAt,
  });
  errors.push(...factsResult.errors);

  if (errors.length > 0) {
    return { ok: false, errors, intake: null };
  }

  const generateRequestId =
    options.generateRequestId ?? (() => globalThis.crypto.randomUUID());

  return {
    ok: true,
    errors: [],
    intake: {
      request_id: generateRequestId(),
      idempotency_key: idempotencyKey,
      raw_submitted_address: rawAddress,
      normalized_submitted_address: normalizedAddress,
      seller_facts: factsResult.facts,
      has_seller_facts: Object.keys(factsResult.facts).length > 0,
      source,
      spine_version: OFFERR_SPINE_VERSION,
      created_at: createdAt,
    },
  };
}

export default {
  OFFERR_SPINE_VERSION,
  OFFERR_FLAG_KEY,
  OFFERR_RESOLUTION_STATUSES,
  OFFERR_OUTCOMES,
  OFFERR_CONFIDENCE_LABELS,
  OFFERR_NEXT_STEPS,
  OFFERR_SUPPORTED_ASSET_FAMILIES,
  OFFERR_EVALUATION_TTL_MS,
  OFFERR_INTAKE_LIMITS,
  normalizeOfferrAddress,
  normalizeSellerFacts,
  normalizeOfferrIntake,
};

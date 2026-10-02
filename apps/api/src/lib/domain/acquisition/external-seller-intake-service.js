import crypto from 'node:crypto';

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { normalizeOfferrAddress } from '@/lib/domain/offerr/offerr-contracts.js';
import { resolveOfferrSubjectProperty } from '@/lib/domain/offerr/offerr-property-resolution.js';
import { isValidUsPhone, normalizePhone } from '@/lib/utils/phones.js';

export const EXTERNAL_SELLER_INTAKE_SCHEMA = 'pco-intake/v1';
export const PROMINENT_SOURCE_APPLICATION = 'prominent_cash_offer';
export const PROMINENT_SOURCE_CHANNEL = 'web_seller_intake';
export const EXTERNAL_INTAKE_MAX_BYTES = 32_768;

const ATTRIBUTION_KEYS = [
  'canonical_path',
  'landing_path',
  'referrer',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
];

function clean(value) {
  return String(value ?? '').trim();
}

function optional(value, max = 500) {
  const result = clean(value);
  if (!result) return null;
  return result.slice(0, max);
}

function normalizeEmail(value) {
  const email = clean(value).toLowerCase();
  return email || null;
}

function splitDisplayName(name) {
  const parts = clean(name).split(/\s+/).filter(Boolean);
  return {
    first_name: parts[0] || null,
    last_name: parts.length > 1 ? parts.slice(1).join(' ') : null,
  };
}

function buildAttribution(source = {}) {
  return Object.fromEntries(
    ATTRIBUTION_KEYS.map((key) => [key, optional(source?.[key], key === 'referrer' ? 1_000 : 240)])
      .filter(([, value]) => value !== null),
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

export function buildExternalIntakePayloadHash(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex');
}

function validateDate(value) {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Normalize the public PCO envelope into the only shape accepted by the
 * canonical external-intake writer. This function never writes and never logs
 * seller PII. Seller-entered property facts remain explicitly unverified.
 */
export function normalizeExternalSellerIntake(input = {}, { now = new Date() } = {}) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['intake_must_be_object'], intake: null };
  }

  if (clean(input.schema_version) !== EXTERNAL_SELLER_INTAKE_SCHEMA) {
    errors.push('unsupported_schema_version');
  }

  const idempotencyKey = clean(input.idempotency_key);
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    errors.push('invalid_idempotency_key');
  }

  const seller = input.seller && typeof input.seller === 'object' && !Array.isArray(input.seller)
    ? input.seller
    : {};
  const property = input.property && typeof input.property === 'object' && !Array.isArray(input.property)
    ? input.property
    : {};
  const context = property.context && typeof property.context === 'object' && !Array.isArray(property.context)
    ? property.context
    : {};
  const consent = input.consent && typeof input.consent === 'object' && !Array.isArray(input.consent)
    ? input.consent
    : {};

  const sellerDisplayName = clean(seller.name);
  if (sellerDisplayName.length < 2 || sellerDisplayName.length > 160) errors.push('invalid_seller_name');

  const normalizedPhone = normalizePhone(seller.phone);
  if (!isValidUsPhone(seller.phone) || !normalizedPhone) errors.push('invalid_seller_phone');

  const email = normalizeEmail(seller.email);
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    errors.push('invalid_seller_email');
  }

  const address = clean(property.address);
  if (address.length < 8 || address.length > 240) errors.push('invalid_property_address');

  const submittedAt = validateDate(input.client?.submitted_at) || now.toISOString();
  const consentCapturedAt = validateDate(consent.captured_at);
  if (consent.contact_requested !== true) errors.push('contact_consent_required');
  if (!consentCapturedAt) errors.push('invalid_consent_timestamp');

  const name = splitDisplayName(sellerDisplayName);
  const normalizedAddress = normalizeOfferrAddress(address);
  const attribution = buildAttribution(input.source);
  const propertyType = optional(context.property_type, 120);
  const condition = optional(context.condition, 120);
  const situation = optional(context.situation, 160);
  const timeline = optional(context.timeline, 120);
  const note = optional(context.note, 1_000);

  const draft = {
    schema_version: EXTERNAL_SELLER_INTAKE_SCHEMA,
    source_application: PROMINENT_SOURCE_APPLICATION,
    source_channel: PROMINENT_SOURCE_CHANNEL,
    idempotency_key: idempotencyKey,
    seller_display_name: sellerDisplayName,
    seller_first_name: name.first_name,
    seller_last_name: name.last_name,
    seller_phone: normalizedPhone || null,
    seller_email: email,
    property_address: address,
    normalized_address: normalizedAddress,
    property_type: propertyType,
    property_condition: condition,
    seller_situation: situation,
    selling_timeline: timeline,
    seller_note: note,
    attribution,
    consent: {
      contact_requested: true,
      captured_at: consentCapturedAt,
      policy_version: optional(consent.policy_version, 80),
      disclosure_version: optional(consent.disclosure_version, 80),
    },
    client_metadata: {
      submitted_at: submittedAt,
      user_agent_class: optional(input.client?.user_agent_class, 40),
    },
  };

  if (errors.length) return { ok: false, errors, intake: null };
  return {
    ok: true,
    errors: [],
    intake: {
      ...draft,
      payload_hash: buildExternalIntakePayloadHash(draft),
    },
  };
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function propertyMatchKey({ propertyId, normalizedAddress }) {
  const basis = propertyId ? `property:${propertyId}` : `address:${normalizedAddress}`;
  return crypto.createHash('sha256').update(basis).digest('hex');
}

async function resolveProperty(intake, deps, client) {
  const resolver = deps.resolveProperty ?? resolveOfferrSubjectProperty;
  const result = await resolver(
    { rawAddress: intake.property_address, normalizedAddress: intake.normalized_address },
    { ...deps, db: client },
  );
  const propertyId = result?.status === 'RESOLVED' ? clean(result.property_id) || null : null;
  return {
    property_id: propertyId,
    resolution_status: result?.status || 'NOT_ATTEMPTED',
    resolution_reason: result?.reason || null,
  };
}

/**
 * Canonical writer for trusted external seller-acquisition surfaces. The only
 * database mutation is the single RPC, whose transaction owns idempotency,
 * identity matching, opportunity creation, and initial inbox state.
 */
export async function ingestExternalSellerIntake(input, deps = {}) {
  const logger = deps.logger;
  const normalized = input?.payload_hash ? { ok: true, intake: input, errors: [] } : normalizeExternalSellerIntake(input, deps);
  if (!normalized.ok) return { ok: false, failure_code: 'invalid_external_seller_intake', validation_errors: normalized.errors };

  const client = db(deps);
  const intake = normalized.intake;
  const resolved = await resolveProperty(intake, deps, client);
  const params = {
    p_schema_version: intake.schema_version,
    p_source_application: intake.source_application,
    p_source_channel: intake.source_channel,
    p_idempotency_key: intake.idempotency_key,
    p_payload_hash: intake.payload_hash,
    p_seller_display_name: intake.seller_display_name,
    p_seller_first_name: intake.seller_first_name,
    p_seller_last_name: intake.seller_last_name,
    p_seller_phone: intake.seller_phone,
    p_seller_email: intake.seller_email,
    p_property_address: intake.property_address,
    p_property_match_key: propertyMatchKey({ propertyId: resolved.property_id, normalizedAddress: intake.normalized_address }),
    p_property_id: resolved.property_id,
    p_property_type: intake.property_type,
    p_property_condition: intake.property_condition,
    p_seller_situation: intake.seller_situation,
    p_selling_timeline: intake.selling_timeline,
    p_seller_note: intake.seller_note,
    p_attribution: intake.attribution,
    p_consent: intake.consent,
    p_client_metadata: { ...intake.client_metadata, property_resolution: resolved },
    p_submitted_at: intake.client_metadata.submitted_at,
  };

  logger?.info?.('external_seller_intake.received', {
    source_application: intake.source_application,
    source_channel: intake.source_channel,
    schema_version: intake.schema_version,
    property_resolution_status: resolved.resolution_status,
  });

  const { data, error } = await client.rpc('ingest_external_seller_intake', params);
  if (error) {
    logger?.error?.('external_seller_intake.persistence_failed', {
      source_application: intake.source_application,
      error_code: error.code || null,
    });
    return { ok: false, failure_code: 'external_intake_persistence_failed' };
  }

  if (!data?.ok) {
    logger?.warn?.('external_seller_intake.rejected', {
      source_application: intake.source_application,
      failure_code: data?.failure_code || 'unknown',
    });
    return data || { ok: false, failure_code: 'external_intake_rejected' };
  }

  logger?.info?.(data.idempotent_replay ? 'external_seller_intake.idempotent_replay' : (data.matched_existing ? 'external_seller_intake.matched_existing' : 'external_seller_intake.accepted'), {
    source_application: intake.source_application,
    submission_id: data.submission_id || null,
    lead_id: data.lead_id || null,
    matched_existing: Boolean(data.matched_existing),
  });
  return data;
}

export default {
  normalizeExternalSellerIntake,
  ingestExternalSellerIntake,
  buildExternalIntakePayloadHash,
};

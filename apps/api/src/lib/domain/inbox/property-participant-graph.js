/**
 * Canonical property-centered participant graph contract.
 *
 * Materialization policy (shadow branch):
 * - Current: read-only SQL view `property_participant_graph` (see PROPOSED migration).
 * - Expected query pattern: filter by property_id, order participants by last_message_at DESC.
 * - Indexes relied on: message_events(property_id), phones(canonical_e164),
 *   seller_contact_referrals(property_id, review_status).
 * - Benchmark threshold: introduce `property_participant_graph_mv` only if p95 property
 *   inbox load exceeds 500ms with >5k participants per property.
 * - Required refresh strategy if materialized later: REFRESH MATERIALIZED VIEW CONCURRENTLY
 *   triggered on message_events insert and seller_contact_referrals review_status change.
 * - Do not duplicate state prematurely; the view remains the canonical read projection.
 *
 * UI rules:
 * - property/opportunity is the permanent conversation container
 * - each phone number has its own SMS thread (never merge cross-number bubbles)
 * - participant selection must never silently change outbound recipient
 */

export const PARTICIPANT_RELATIONSHIPS = Object.freeze([
  "master_owner",
  "probable_owner",
  "respondent",
  "respondent_non_owner",
  "referred_contact",
  "signer",
  "tenant",
  "agent",
  "representative",
  "wrong_number",
]);

export const PROPERTY_PARTICIPANT_FIELDS = Object.freeze([
  "participant_id",
  "property_id",
  "master_owner_id",
  "prospect_id",
  "phone_id",
  "canonical_e164",
  "display_name",
  "relationship_to_property",
  "identity_class",
  "ownership_confidence",
  "contact_source",
  "referral_source_event_id",
  "referral_source_thread_key",
  "contact_status",
  "suppression_status",
  "suppression_scope",
  "universal_stage",
  "granular_stage",
  "last_message_at",
  "unread_count",
  "safe_to_contact",
  "safe_to_contact_reason",
  "is_current_participant",
  "is_primary_owner_record",
  "is_referred_contact",
]);

export function normalizePropertyParticipantRow(row = {}) {
  return {
    participant_id: row.participant_id || null,
    property_id: row.property_id || null,
    master_owner_id: row.master_owner_id || null,
    prospect_id: row.prospect_id || null,
    phone_id: row.phone_id || null,
    canonical_e164: row.canonical_e164 || null,
    display_name: row.display_name || null,
    relationship_to_property: row.relationship_to_property || "respondent",
    identity_class: row.identity_class || "unknown",
    ownership_confidence:
      typeof row.ownership_confidence === "number" ? row.ownership_confidence : null,
    contact_source: row.contact_source || "inbound_sms",
    referral_source_event_id: row.referral_source_event_id || null,
    referral_source_thread_key: row.referral_source_thread_key || null,
    contact_status: row.contact_status || "active",
    suppression_status: row.suppression_status || "active",
    suppression_scope: row.suppression_scope || "none",
    universal_stage: row.universal_stage || null,
    granular_stage: row.granular_stage || null,
    last_message_at: row.last_message_at || null,
    unread_count: Number.isFinite(Number(row.unread_count)) ? Number(row.unread_count) : 0,
    safe_to_contact: row.safe_to_contact !== false,
    safe_to_contact_reason: row.safe_to_contact_reason || null,
    is_current_participant: Boolean(row.is_current_participant),
    is_primary_owner_record: Boolean(row.is_primary_owner_record),
    is_referred_contact: Boolean(row.is_referred_contact),
  };
}

/**
 * Read API response contract for property conversation container.
 */
export function buildPropertyParticipantGraphResponse({
  property_id = null,
  participants = [],
  selected_participant_id = null,
  activity_timeline = [],
} = {}) {
  const normalized = (Array.isArray(participants) ? participants : []).map(normalizePropertyParticipantRow);
  const selected =
    normalized.find((row) => row.participant_id === selected_participant_id) ||
    normalized.find((row) => row.is_primary_owner_record) ||
    normalized[0] ||
    null;

  if (selected) {
    for (const row of normalized) {
      row.is_current_participant = row.participant_id === selected.participant_id;
    }
  }

  return {
    property_id,
    participants: normalized,
    selected_participant: selected,
    selected_outbound_recipient: selected
      ? {
          participant_id: selected.participant_id,
          canonical_e164: selected.canonical_e164,
          display_name: selected.display_name,
          relationship_to_property: selected.relationship_to_property,
          safe_to_contact: selected.safe_to_contact,
          safe_to_contact_reason: selected.safe_to_contact_reason,
        }
      : null,
    activity_timeline: Array.isArray(activity_timeline) ? activity_timeline : [],
    thread_grouping_rules: {
      container: "property",
      thread_key: "canonical_e164",
      never_merge_cross_phone_timelines: true,
    },
    participant_selection_rules: {
      explicit_selection_required: true,
      silent_recipient_change_forbidden: true,
      composer_must_display: [
        "display_name",
        "canonical_e164",
        "relationship_to_property",
        "safe_to_contact",
      ],
    },
    dedupe_rules: {
      phone_dedupe_key: "canonical_e164",
      referral_dedupe_key: "source_event_id:referred_phone_e164:property_id",
      property_scoped_suppression_only: true,
      global_invalidation_forbidden: true,
    },
  };
}

export default buildPropertyParticipantGraphResponse;
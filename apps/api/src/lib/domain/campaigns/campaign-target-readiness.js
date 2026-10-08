/**
 * ONE PER-ROW READINESS TRUTH for a campaign_target_graph row — extracted
 * verbatim from campaign-automation-service.js so Entity Graph's "SMS
 * eligible" column can answer with the SAME rule the target builder applies,
 * without importing the automation service (and the SMS engine with it).
 */
import { evaluatePreSendEligibility } from '@/lib/domain/outbound/presend-eligibility-engine.js'
import { clean } from '@/lib/domain/queue/queue-control-safety.js'

// campaign_target_graph.queue_eligible is a purely mechanical messaging-
// mechanics flag (sms_eligible/suppression/wrong_number/pending_touch/
// active_queue/sender_covered) — it carries no owner-identity, timezone, or
// phone-ownership-ambiguity signal. buildCampaignTargets only ever receives
// queue_eligible=true rows, so status/target_status must not be derived from
// queue_eligible alone or every graph-sourced target is marked 'ready'
// regardless of identity/timezone/ambiguity. Reuses the same canonical,
// fail-closed identity policy createCampaignQueuePlan already gates on
// (evaluatePreSendEligibility -> isIdentityEligibleForLiveOutbound) so the
// two layers cannot silently drift apart.
export function resolveCampaignTargetReadiness(row = {}) {
  /**
   * IDENTITY LINKAGE, READ FROM THE CANONICAL SCHEMA.
   *
   * This required `master_owner_id` AND `prospect_id` AND `phone_id` AND
   * `canonical_e164` together. Three of those four are legacy identifiers from
   * the retired `public.phones` export, and the canonical graph builder
   * deliberately leaves them NULL — its own comment says
   * "prospect_id / phone_id do not exist anywhere in the seller schema, so they
   * stay NULL provenance rather than being manufactured from the stale
   * public.phones export (which covers only 37.7% of the modern corpus)".
   *
   * Measured 2026-09-15 across all 169,797 graph rows:
   *   prospect_id       0
   *   phone_id          0
   *   master_owner_id   41,532  (26% of Individual, 12.5% of Corporate — legacy, not entity-only)
   *   seller_person_key 138,680
   *   canonical_e164    136,127
   *
   * So the gate was not strict, it was BROKEN CLOSED: no graph-sourced target
   * could ever be campaign-ready, which is exactly what production showed.
   *
   * Person identity is now `seller_person_key`
   * (seller.property_owner_resolution_v1.individual_key, via
   * COALESCE(sel_person_key, individual_key)), with the legacy prospect ids
   * still accepted so older rows that do carry them keep working. The phone is
   * `canonical_e164`, which the builder joins from seller.owner_phone ON THE
   * SAME individual_key — so the number provably belongs to the resolved
   * person rather than being the property's first available phone.
   *
   * `master_owner_id` is provenance "where applicable", not a gate: it is
   * absent on three quarters of rows across every ownership shape, and its
   * absence says nothing about whether a real person is reachable.
   *
   * Nothing else is relaxed. queue_eligible still carries sms_eligible /
   * suppression / wrong_number / pending_prior_touch / active_queue_item /
   * sender_covered, and identity_alignment, timezone and phone-ownership
   * ambiguity are all still enforced below.
   */
  const personKey = clean(row.seller_person_key)
    || clean(row.prospect_id)
    || clean(row.canonical_prospect_id)
  const phoneKey = clean(row.canonical_e164) || clean(row.phone_id)
  const hasLinkage = Boolean(personKey && phoneKey)
  const hasTimezone = Boolean(clean(row.timezone))
  const ambiguousPhone = Boolean(row.ambiguous_phone_ownership)
  const eligibility = evaluatePreSendEligibility(
    { identity_alignment: { status: clean(row.identity_alignment) || 'unknown' } },
    {}
  )

  const blockReason = !row.queue_eligible
    ? clean(row.queue_block_reason || 'graph_not_queue_eligible')
    : !hasLinkage
      ? 'missing_identity_linkage'
      /**
       * An entity-owned property whose person link the canonical source flags
       * for review has no defensible contact, so it stays blocked however well
       * the rest of the linkage resolves. seller.property_entity_contact_v1
       * raises this via ENT_ROLE_UNCORROBORATED / ENT_NO_REGISTRY_LINK, and
       * 19,346 queue-eligible entity contacts carry it.
       */
      : row.entity_contact_requires_review === true
        ? 'entity_contact_requires_review'
      : !eligibility.eligible
        ? clean(eligibility.reason) || 'identity_not_verified'
        : !hasTimezone
          ? 'missing_timezone'
          : ambiguousPhone
            ? 'ambiguous_phone_ownership'
            : null

  return { ready: blockReason === null, blockReason }
}

import { clean, lower } from "@/lib/utils/strings.js";
import {
  calculateOwnerProspectAlignment,
  isIdentityEligibleForLiveOutbound,
  normalizeMatchingFlags,
} from "@/lib/identity/ownerProspectAlignment.js";

/**
 * Pre-Send Eligibility Engine
 * ===========================
 *
 * A single, deterministic gate that every outbound feeder / queue / campaign
 * selection path can call before a cold message is auto-sent. It answers three
 * questions for a candidate contact point:
 *
 *   1. Is auto-send allowed?        → `eligible` / `hard_block` / `block_reason`
 *   2. How confident are we that
 *      this person is the owner?     → `ownership_confidence` (0–100) + `band`
 *   3. If this contact is wrong,
 *      who is the next-best owner
 *      contact point on the owner?   → `selectNextBestOwnerContact()`
 *
 * The headline safety rule is deterministic and non-negotiable for auto-send:
 *
 *     likely_renting === true  AND  likely_owner !== true   →  HARD BLOCK
 *
 * In production data every `likely_renting=true` prospect also has
 * `likely_owner=false`, so this is the precise wrong-party population. We still
 * encode both conditions explicitly so a future `renting + owner` edge case
 * (e.g. an owner who also rents elsewhere) is NOT blocked by mistake.
 *
 * The engine is pure (no I/O). Callers that need the owner's *other* contact
 * points fetch them and pass the array into `selectNextBestOwnerContact`.
 */

export const BLOCK_REASONS = Object.freeze({
  RENTER_NOT_OWNER: "RENTER_NOT_OWNER",
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
  OWNERSHIP_NOT_CONFIRMED: "OWNERSHIP_NOT_CONFIRMED",
});

export const OWNERSHIP_BANDS = Object.freeze({
  OWNER_VERIFIED: "owner_verified",
  OWNER_PROBABLE: "owner_probable",
  WEAK: "weak",
  RENTER: "renter",
  UNKNOWN: "unknown",
});

// Deterministic confidence floor for a confirmed renter-not-owner. Kept well
// below every auto-send threshold so it can never be selected as a contact.
const RENTER_CONFIDENCE = 5;

function asTriBool(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value === "true" || value === "t" || value === 1 || value === "1") return true;
  if (value === "false" || value === "f" || value === 0 || value === "0") return false;
  return null; // unknown / absent
}

/**
 * Normalizes a heterogeneous candidate row (feeder table, queue row, campaign
 * candidate, manual send target) into the fields the engine reasons over.
 * Accepts both snake_case (DB rows) and the camelCase the identity layer uses.
 */
export function normalizeOwnershipSignals(contact = {}) {
  const likely_owner = asTriBool(
    contact.likely_owner ?? contact.likelyOwner
  );
  const likely_renting = asTriBool(
    contact.likely_renting ?? contact.likelyRenting
  );
  const matching_flags = clean(
    contact.matching_flags ?? contact.matchingFlags ?? contact.prospect_matching_flags
  );
  const person_flags_text = clean(
    contact.person_flags_text ?? contact.personFlagsText
  );

  return { likely_owner, likely_renting, matching_flags, person_flags_text };
}

/**
 * Deterministically scores ownership confidence on a 0–100 scale from the
 * explicit ownership signals plus name/phone identity alignment.
 *
 * The function is monotonic and explainable: every adjustment appends a signal
 * string so the score can be audited. A confirmed renter-not-owner short-
 * circuits to a hard floor.
 *
 * @returns {{ confidence:number, band:string, signals:string[],
 *             likely_owner:(boolean|null), likely_renting:(boolean|null),
 *             normalized_linkage:string, alignment:object }}
 */
export function scoreOwnershipConfidence(contact = {}, deps = {}) {
  const { likely_owner, likely_renting, matching_flags, person_flags_text } =
    normalizeOwnershipSignals(contact);

  const normalized_linkage = normalizeMatchingFlags(matching_flags || person_flags_text);

  // Alignment can be supplied pre-computed (feeder already runs it) to avoid
  // recomputation; otherwise derive it from the contact's identity inputs.
  const alignment =
    deps.alignment ||
    (contact.identity_alignment && clean(contact.identity_alignment.status)
      ? contact.identity_alignment
      : calculateOwnerProspectAlignment(buildAlignmentInput(contact)));

  const signals = [];

  // ── Deterministic renter-not-owner floor ────────────────────────────────
  if (likely_renting === true && likely_owner !== true) {
    signals.push("renter_not_owner");
    return {
      confidence: RENTER_CONFIDENCE,
      band: OWNERSHIP_BANDS.RENTER,
      signals,
      likely_owner,
      likely_renting,
      normalized_linkage,
      alignment,
    };
  }

  let confidence = 50;

  if (likely_owner === true) {
    confidence = Math.max(confidence, 70);
    signals.push("likely_owner_true");
  } else if (likely_owner === false) {
    confidence -= 10;
    signals.push("likely_owner_false");
  }

  // Matching-flags linkage signal.
  switch (normalized_linkage) {
    case "linked_to_company":
    case "likely_owner":
      confidence += 15;
      signals.push(`linkage:${normalized_linkage}`);
      break;
    case "likely_linked_to_company":
    case "potentially_linked_to_company":
    case "potential_owner":
      confidence += 5;
      signals.push(`linkage:${normalized_linkage}`);
      break;
    case "tenant":
      confidence -= 40;
      signals.push("linkage:tenant");
      break;
    case "unrelated":
      confidence -= 50;
      signals.push("linkage:unrelated");
      break;
    default:
      break;
  }

  // Name / phone identity alignment (already 0–100, blended in as a modifier).
  switch (lower(alignment?.status)) {
    case "verified":
      confidence += 25;
      signals.push("identity_verified");
      break;
    case "probable":
    case "entity_company_linked":
    case "entity_company_probable":
    case "entity_operator_probable":
      confidence += 15;
      signals.push(`identity_${lower(alignment.status)}`);
      break;
    case "household_associated":
      confidence += 10;
      signals.push("identity_household_associated");
      break;
    case "mismatch":
      confidence -= 40;
      signals.push("identity_mismatch");
      break;
    case "weak":
      confidence -= 5;
      signals.push("identity_weak");
      break;
    default:
      break;
  }

  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  let band = OWNERSHIP_BANDS.UNKNOWN;
  if (confidence >= 80) band = OWNERSHIP_BANDS.OWNER_VERIFIED;
  else if (confidence >= 60) band = OWNERSHIP_BANDS.OWNER_PROBABLE;
  else if (confidence >= 40) band = OWNERSHIP_BANDS.WEAK;
  else band = OWNERSHIP_BANDS.UNKNOWN;

  return {
    confidence,
    band,
    signals,
    likely_owner,
    likely_renting,
    normalized_linkage,
    alignment,
  };
}

/**
 * Maps a heterogeneous contact row into the input shape expected by
 * `calculateOwnerProspectAlignment`. Tolerant of both DB and camelCase fields.
 */
function buildAlignmentInput(contact = {}) {
  return {
    masterOwnerName: contact.masterOwnerName ?? contact.owner_display_name ?? contact.display_name,
    ownerDisplayName: contact.owner_display_name ?? contact.ownerDisplayName,
    ownerName: contact.owner_name ?? contact.ownerName,
    prospectFullName: contact.prospect_full_name ?? contact.prospectFullName ?? contact.prospect_display_name,
    phoneFullName: contact.phone_full_name ?? contact.phoneFullName,
    phoneOwner: contact.phone_owner ?? contact.phoneOwner,
    cnam: contact.prospect_cnam ?? contact.cnam,
    likelyOwner: contact.likely_owner ?? contact.likelyOwner,
    likelyRenting: contact.likely_renting ?? contact.likelyRenting,
    matchingFlags: contact.matching_flags ?? contact.matchingFlags ?? contact.prospect_matching_flags,
    personFlagsText: contact.person_flags_text ?? contact.personFlagsText,
    bestPhoneScore: contact.best_phone_score ?? contact.bestPhoneScore,
    contactScoreFinal: contact.contact_score_final ?? contact.contactScoreFinal,
    linkedPropertyIdsText: contact.linked_property_ids_text ?? contact.linkedPropertyIdsText,
    joinedPropertySource: contact.joined_property_source ?? contact.joinedPropertySource,
    smsEligible: contact.sms_eligible ?? contact.smsEligible,
    canonicalProspectId: contact.canonical_prospect_id ?? contact.canonicalProspectId,
    primaryProspectId: contact.primary_prospect_id ?? contact.primaryProspectId,
    normalizedPhoneId: contact.normalized_phone_id ?? contact.phone_id,
    bestPhoneId: contact.best_phone_id ?? contact.bestPhoneId,
    phoneId: contact.phone_id ?? contact.phoneId,
    sellerFullName: contact.seller_full_name ?? contact.sellerFullName,
    sellerFirstName: contact.seller_first_name ?? contact.sellerFirstName,
  };
}

/**
 * The canonical pre-send eligibility decision for a single contact point.
 *
 * Order of evaluation (deterministic, fail-closed):
 *   1. Renter-not-owner hard block (the headline rule).
 *   2. Identity alignment policy (existing wrong-party / unverified gate).
 *   3. Ownership-confidence floor for auto-send.
 *
 * @param {object} contact  candidate / queue / campaign / manual-send row
 * @param {object} options  policy knobs:
 *   - allow_renter_override: bypass rule (1) — used only for explicit operator
 *       sends after manual review. Never set for cold auto-send.
 *   - identity_gate_mode / allow_weak_identity_outbound / allow_identity_unknown:
 *       passed through to `isIdentityEligibleForLiveOutbound`.
 *   - min_ownership_confidence: floor for auto-send (default 0 = disabled; the
 *       identity gate is the primary authority, this is an optional tightener).
 * @returns {{ eligible:boolean, hard_block:boolean, block_reason:(string|null),
 *             reason:string, ownership_confidence:number, ownership_band:string,
 *             ownership_signals:string[], alignment:object,
 *             likely_owner:(boolean|null), likely_renting:(boolean|null) }}
 */
export function evaluatePreSendEligibility(contact = {}, options = {}) {
  const scored = scoreOwnershipConfidence(contact, {});
  const { likely_owner, likely_renting } = scored;

  const base = {
    ownership_confidence: scored.confidence,
    ownership_band: scored.band,
    ownership_signals: scored.signals,
    alignment: scored.alignment,
    likely_owner,
    likely_renting,
  };

  // ── Rule 1: renter-not-owner hard block ─────────────────────────────────
  if (likely_renting === true && likely_owner !== true) {
    if (options.allow_renter_override === true) {
      return {
        ...base,
        eligible: true,
        hard_block: false,
        block_reason: null,
        reason: "renter_not_owner_overridden",
      };
    }
    return {
      ...base,
      eligible: false,
      hard_block: true,
      block_reason: BLOCK_REASONS.RENTER_NOT_OWNER,
      reason: "renter_not_owner_blocked",
    };
  }

  // ── Rule 2: identity alignment policy ───────────────────────────────────
  const identity_policy = isIdentityEligibleForLiveOutbound(scored.alignment, options);
  if (!identity_policy.eligible) {
    const isMismatch =
      identity_policy.reason === "identity_mismatch" ||
      Boolean(scored.alignment?.hardBlock);
    return {
      ...base,
      eligible: false,
      hard_block: isMismatch,
      block_reason: isMismatch
        ? BLOCK_REASONS.IDENTITY_MISMATCH
        : BLOCK_REASONS.OWNERSHIP_NOT_CONFIRMED,
      reason: identity_policy.reason,
    };
  }

  // ── Rule 3: optional ownership-confidence floor ─────────────────────────
  const floor = Number(options.min_ownership_confidence) || 0;
  if (floor > 0 && scored.confidence < floor) {
    return {
      ...base,
      eligible: false,
      hard_block: false,
      block_reason: BLOCK_REASONS.OWNERSHIP_NOT_CONFIRMED,
      reason: `ownership_confidence_below_floor:${floor}`,
    };
  }

  return {
    ...base,
    eligible: true,
    hard_block: false,
    block_reason: null,
    reason: identity_policy.reason,
  };
}

/**
 * Selects the next-best owner contact point for a single owner from a set of
 * candidate contact points (e.g. all SMS-reachable phones on the master owner).
 *
 * Pure ranking: the caller is responsible for fetching the alternates. Each
 * contact is run through `evaluatePreSendEligibility`; only eligible,
 * SMS-eligible, non-hard-blocked contacts are considered. The winner is the one
 * with the highest ownership confidence, breaking ties by `best_phone_score`.
 *
 * @param {object[]} contacts  alternate contact points for the same owner
 * @param {object} options     same policy knobs as `evaluatePreSendEligibility`,
 *                             plus `exclude_phone_ids` (Set|Array) and
 *                             `min_ownership_confidence`.
 * @returns {{ selected:(object|null), ranked:object[], reason:string }}
 *   `selected` is the original contact object augmented with `_eligibility`.
 */
export function selectNextBestOwnerContact(contacts = [], options = {}) {
  const exclude = new Set(
    Array.isArray(options.exclude_phone_ids)
      ? options.exclude_phone_ids.map((id) => clean(id))
      : options.exclude_phone_ids instanceof Set
        ? [...options.exclude_phone_ids].map((id) => clean(id))
        : []
  );

  const evaluated = [];
  for (const contact of Array.isArray(contacts) ? contacts : []) {
    const phone_id = clean(contact?.phone_id ?? contact?.phoneId ?? contact?.best_phone_id);
    if (phone_id && exclude.has(phone_id)) continue;

    const sms_ok = asTriBool(contact?.sms_eligible ?? contact?.smsEligible) !== false;
    const has_number = Boolean(clean(contact?.canonical_e164 ?? contact?.canonicalE164));

    const eligibility = evaluatePreSendEligibility(contact, options);
    evaluated.push({ contact, phone_id, sms_ok, has_number, eligibility });
  }

  const eligible = evaluated
    .filter((e) => e.eligibility.eligible && !e.eligibility.hard_block && e.sms_ok && e.has_number)
    .sort((a, b) => {
      const conf =
        b.eligibility.ownership_confidence - a.eligibility.ownership_confidence;
      if (conf !== 0) return conf;
      const score =
        (Number(b.contact?.best_phone_score) || 0) -
        (Number(a.contact?.best_phone_score) || 0);
      return score;
    });

  const ranked = eligible.map((e) => ({
    ...e.contact,
    _eligibility: e.eligibility,
  }));

  if (ranked.length === 0) {
    return { selected: null, ranked, reason: "no_eligible_owner_contact" };
  }

  return { selected: ranked[0], ranked, reason: "next_best_owner_selected" };
}
